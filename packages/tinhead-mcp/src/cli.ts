#!/usr/bin/env node
/**
 * `tinhead-mcp` — the command line. Three things and no more.
 *
 *   tinhead-mcp login    paste ONE setup code from Tinhead. Nothing else to type.
 *   tinhead-mcp forget   take a connection off this machine, code and all.
 *   tinhead-mcp          connect and serve on stdio (what an MCP client runs)
 *
 * **NOTHING HERE EVER ECHOES AN ARGUMENT.** `login` takes none, `forget` refuses
 * a wrong one by listing the ids it does know, and an unrecognised command is
 * answered without naming it. The reason is one shape of mistake: a person whose
 * first instinct is to paste the setup code onto the command line, whose scrollback
 * would then hold the one perishable secret this product ever shows.
 *
 * **Why `login` takes no argument.** It used to take the connection id and read
 * the token on stdin — two opaque strings from one screen, both 40-odd
 * characters of base64-looking noise, neither saying which was which. The
 * founder swapped them on his first attempt, then passed the token as BOTH, and
 * the gateway's honest answer ("this grant was not accepted") named neither
 * mistake. A label would have made the wrong string easier to find; deleting the
 * choice makes the mistake unreachable. So the app emits one self-describing
 * code (`src/agent/setupCode.ts`) that carries the id, the gateway address and
 * the token together, and this command's entire interface is "paste it".
 *
 * The code inherits the token's handling — shown once, kept by nobody — because
 * the other two parts are explicitly not secrets (§4.5: they are what the MCP
 * config file carries in the clear).
 *
 * **Nothing in THIS file calls `process.exit`.** It set an exit code and killed
 * the process mid-teardown, and libuv said so on Windows —
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — after a failed
 * connect, which is precisely the moment somebody is trying to read the error.
 * `process.exitCode` plus a return leaves the same status behind and lets the
 * loop drain. Note what that claim does not cover: `server.ts`'s SIGINT handler
 * still exits outright, so Ctrl+C during a live session is the same shape and
 * has not been fixed.
 */

import { createInterface } from 'node:readline';
import { cryptoReady } from '../../../src/crypto';
import { grantAuthFor } from '../../../src/agent/grants';
import { SetupCode, SetupCodeError, decodeSetupCode } from '../../../src/agent/setupCode';
import { connect } from './session';
import {
  TokenStore,
  forgetGrant,
  listGrants,
  loadToken,
  purgeCodeShapedNames,
  rememberGrant,
  stateDir,
  storeToken,
} from './keychain';
import { GatewayError } from './gateway';
import { NOT_YET_GRANTED } from './scope';
import { serve } from './server';
import { claudeAddCommand, configBlock } from './setupHints';

const say = (s: string) => process.stderr.write(`${s}\n`);

/** What each backend is called out loud. The enum names are for the code. */
const STORE_NAMES: Record<Exclude<TokenStore, 'file'>, string> = {
  keychain: 'macOS keychain',
  dpapi: 'Windows credential store (DPAPI)',
  libsecret: 'Linux keyring (libsecret)',
};

/** Every failure path goes through here, so none of them can reintroduce `exit`. */
function fail(...lines: string[]): void {
  for (const l of lines) say(l);
  process.exitCode = 1;
}

/**
 * One line from the person. On a TTY the readline interface owns stdin, and it
 * has to be fully detached before this returns: `rl.close()` starts an async
 * teardown, and anything that ended the process during it produced the libuv
 * assertion above. So we wait for `close` to actually fire and then let go of
 * stdin, which is also what stops it holding the loop open afterwards.
 */
async function readStdin(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>((r) => rl.question(prompt, r));
  await new Promise<void>((done) => {
    rl.once('close', () => done());
    rl.close();
  });
  process.stdin.pause();
  process.stdin.unref?.();
  return answer.trim();
}

/**
 * The ONE command that finishes setup on Claude Code — the step this used to
 * leave as "add this JSON to your MCP client config".
 *
 * Hand-merging a JSON block into a file you have to find first is the step every
 * other MCP product has deleted, and it is the step most likely to be got wrong:
 * the file may not exist, it may already have an `mcpServers` key to merge into
 * rather than replace, and getting it wrong fails later, inside a client, with an
 * error nobody connects back to this.
 *
 * Shape is `claude mcp add [options] <name> -- <command> [args...]`; `--transport
 * stdio` is passed explicitly even though stdio is the default, because the
 * documented form wants an option between the last `--env` and the name, and one
 * command that always works beats two that differ by a flag.
 *
 * It carries no secret. The token is in the OS store and the address is in
 * `connections.json`, so this line is safe in scrollback, in a screenshot, and in
 * a support thread — which is exactly why setup can be one copied line at all.
 */
/**
 * `claudeAddCommand` and `configBlock` live in `setupHints.ts` — pure, no
 * imports, and therefore unit-testable. They are the last instruction a person
 * reads before this works or does not, and the Windows form of the first one was
 * wrong for every user until somebody ran it.
 */

async function login(args: string[]): Promise<void> {
  if (args.length > 0) {
    // Someone following the old instructions. Say what replaced them rather
    // than accepting an id and then having no address to go with it.
    return fail(
      '`login` takes no argument any more — Tinhead now gives you ONE setup code that carries the',
      'connection, its address and its code together.',
      '',
      'Run `tinhead-mcp login` with nothing after it and paste the code when asked.',
      'In Tinhead: Settings › Plugins › MCP.'
    );
  }

  const raw = await readStdin('paste your setup code from Tinhead (it is shown once): ');
  let code: SetupCode;
  try {
    code = decodeSetupCode(raw);
  } catch (err) {
    // `decodeSetupCode` names the likely mis-pastes by what they are, so its
    // sentence is the whole message — do not wrap it in a second one.
    return fail(err instanceof SetupCodeError ? err.message : String(err), 'nothing was stored.');
  }

  // The shape is proved HERE, not minutes later inside an MCP client where
  // nobody sees the error. `grantAuthFor` runs the same `decodeToken` the first
  // connect would.
  await cryptoReady;
  try {
    grantAuthFor(code.token);
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err), 'nothing was stored.');
  }

  const where = await storeToken(code.grantId, code.token);
  if (where === 'file') {
    // §4.5 — the fallback announces itself. Always.
    say(`WARNING: no OS keychain was available, so the code is in a plain file under ${stateDir()}.`);
    say('Anything running as you can read it. Install libsecret (Linux) for the keychain path.');
  } else {
    say(`stored in the ${STORE_NAMES[where]}.`);
  }
  await rememberGrant({ grantId: code.grantId, url: code.url });

  // The old setup's leak is a FILE, so it outlives the code path that made it.
  // This is the moment to take it out: the person is here, and this is the last
  // time they will run a setup that could have left one.
  const purged = await purgeCodeShapedNames();
  if (purged > 0) {
    // Never the name — the name is the secret, and printing it here would put
    // it in the scrollback the file was the problem for.
    say(
      `\ncleaned up ${purged} file(s) left by the old setup, whose NAME was a code in the clear.` +
        '\nIf those connections still exist in Tinhead, revoke them: Settings › Plugins › MCP.'
    );
  }

  // With one connection there is nothing to choose between, so the block that
  // works is the one with nothing in it — this process reads its own state. A
  // second connection makes the choice real, and then the block must name one.
  const all = await listGrants();
  const pick = all.length > 1 ? code.grantId : null;

  // Numbered, because there ARE two steps left and the one people miss is the
  // second: a connection with no branches connects perfectly and then reaches
  // nothing, which reads as a broken install rather than an unfinished one.
  say('\nTwo steps left.\n');
  say('1. Register it with your agent — run this:\n');
  say(`     ${claudeAddCommand(pick)}\n`);
  say('   Using a different MCP client? Add this to its config instead:\n');
  say(
    configBlock(pick)
      .split('\n')
      .map((l) => `     ${l}`)
      .join('\n')
  );
  say(
    pick
      ? `\n   This machine now holds ${all.length} connections, so both forms name which one to ` +
          'use. That id is not a secret.'
      : '\n   No settings and no secrets in either: this machine already knows which connection ' +
          'that is and where it lives.'
  );
  say(
    '\n2. Give it something to work on — in Tinhead, open the thought you want it to work in and\n' +
      '   choose Options › Give access. Until then it connects fine and reaches NOTHING.\n' +
      '   You can add and remove branches any time; none of the above changes.'
  );
}

/**
 * `forget` — take a connection off this machine.
 *
 * **It never echoes its argument.** Everything else here treats a pasted code as
 * the one thing that must not reach scrollback, and an error like "no connection
 * called <what you typed>" would put one there the first time somebody pastes a
 * setup code at this command instead of at `login`. So a wrong argument is
 * answered with the ids this machine DOES know — those are not secret (§4.5) —
 * and never with what was typed.
 *
 * With no argument it lists and asks, which is also the only way to reach a
 * connection whose id you do not have to hand.
 */
async function forget(args: string[]): Promise<void> {
  if (args.length > 1) {
    return fail('usage: tinhead-mcp forget [<connection id>]');
  }
  const all = await listGrants();
  if (all.length === 0) {
    return fail('this machine has no connections stored, so there is nothing to forget.');
  }

  const known = (): string[] => ['It knows these:', ...all.map((g) => `  ${g.grantId}  (${g.url})`)];
  let target = args[0]?.trim() ?? '';

  if (!target) {
    say('Connections stored on this machine:\n');
    all.forEach((g, i) => say(`  ${i + 1}. ${g.grantId}\n     ${g.url}`));
    const answer = await readStdin('\nforget which one? (a number, or blank to cancel): ');
    if (!answer) {
      say('nothing was forgotten.');
      return;
    }
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > all.length) {
      // The answer is not echoed either: a person who pastes a code at a prompt
      // asking for a number has made exactly the mistake worth not printing.
      return fail(`that is not one of 1-${all.length}. Nothing was forgotten.`);
    }
    target = all[n - 1].grantId;
  } else if (!all.some((g) => g.grantId === target)) {
    return fail('this machine has no connection with that id.', ...known());
  }

  const removed = await forgetGrant(target);
  say(
    removed
      ? `forgotten: ${target}\nIts stored code has been deleted from this machine. The connection ` +
          'itself still exists in Tinhead until you take it back there (Settings › Plugins).'
      : 'there was no such connection, but any stored code under that id has been deleted.'
  );

  const left = await listGrants();
  if (left.length === 1) {
    say(
      `\nOne connection left (${left[0].grantId}), so this machine no longer needs TINHEAD_GRANT ` +
        'in its MCP config — you can remove it.'
    );
  }
}

/**
 * Which connection this process is. Environment first — both variables together
 * are the escape hatch for someone running two accounts out of one config —
 * then what `login` stored, which is the ordinary case and needs no environment
 * at all.
 *
 * `TINHEAD_GRANT` alone is the useful middle: it picks among the stored
 * connections, and the address comes from the one it picked.
 *
 * An EMPTY variable is an absent one. MCP client configs are generated and
 * hand-edited, and `"TINHEAD_URL": ""` is an ordinary thing to find in one — read
 * literally it would override a good stored address with nothing and fail at the
 * fetch, blaming a gateway that was never asked.
 *
 * The stored address is checked for https (`listGrants`) and this one is not, on
 * purpose: `connections.json` is written by this tool and a person has no reason
 * to edit it, so a rewritten URL there is suspicious. An environment variable is
 * the person, this run, in the file they are already editing — and it is the
 * only way to point the door at a gateway on a local machine.
 */
async function resolveConnection(): Promise<{ grantId: string; baseUrl: string } | null> {
  const envGrant = process.env.TINHEAD_GRANT?.trim() || undefined;
  const envUrl = process.env.TINHEAD_URL?.trim() || undefined;
  if (envGrant && envUrl) return { grantId: envGrant, baseUrl: envUrl };

  const stored = await listGrants();
  if (envGrant) {
    const hit = stored.find((g) => g.grantId === envGrant);
    if (hit) return { grantId: envGrant, baseUrl: hit.url };
    fail(
      `TINHEAD_GRANT names a connection this machine has never logged in to (${envGrant}).`,
      'Run `tinhead-mcp login` and paste the setup code for it, or remove TINHEAD_GRANT to use',
      'whichever connection is stored here.'
    );
    return null;
  }

  if (stored.length === 0) {
    fail(
      'no connection is stored on this machine yet.',
      'In Tinhead: Settings › Plugins › MCP gives you a setup code. Then run `tinhead-mcp login`',
      'and paste it.'
    );
    return null;
  }
  if (stored.length === 1) return { grantId: stored[0].grantId, baseUrl: envUrl ?? stored[0].url };

  fail(
    `this machine holds ${stored.length} connections, so it cannot tell which one you mean:`,
    ...stored.map((g) => `  ${g.grantId}  (${g.url})`),
    '',
    // Named here because a DEAD row is the common reason for this refusal: one
    // revoked connection makes every live one on the machine ambiguous, and the
    // person reading this is the one who can say which is which.
    'If one of those is finished with, `tinhead-mcp forget` takes it off this machine — and if it',
    'leaves exactly one, nothing below is needed at all.',
    '',
    'Otherwise set TINHEAD_GRANT to the one you want, in your MCP client config. This block names',
    'the most recent login — put whichever id you meant in its place:',
    configBlock(stored[stored.length - 1].grantId)
  );
  return null;
}

/** What a connected grant can actually do, said without overstating either half. */
function banner(scope: { branches: readonly string[]; reads: string; write: boolean }): string[] {
  const { branches, reads, write } = scope;
  const everything = reads === 'everything';
  const n = branches.length;
  if (n === 0) {
    // The old line said "reads 0 branch(es)" and then "connected", which reads
    // as a working connection with a rounding error rather than the normal
    // waiting state it is.
    if (!everything) return ['connected, but it has no branch yet.', NOT_YET_GRANTED];
    return [
      'connected — it reads your whole tree.',
      write
        ? 'It cannot change anything yet: writing is always limited to the branches you give it. ' +
          'In Tinhead, open a thought and choose “Options › Give access”.'
        : 'Read-only.',
    ];
  }
  return [
    `connected — ${everything ? 'reads your whole tree' : `reads ${n} branch(es)`}, ` +
      `${write ? `may write inside ${n} branch(es)` : 'read-only'}.`,
  ];
}

async function serveDefault(): Promise<void> {
  const conn = await resolveConnection();
  if (!conn) return; // `resolveConnection` has already said why

  const stored = await loadToken(conn.grantId);
  if (!stored) {
    return fail(
      `no code is stored for connection ${conn.grantId} on this machine.`,
      'Make a fresh setup code in Tinhead (Settings › Plugins › MCP) and run `tinhead-mcp login`.'
    );
  }
  if (stored.from === 'file') {
    say(`note: this grant's code is in a plain file under ${stateDir()} (no OS keychain here).`);
  }

  let session;
  try {
    session = await connect({
      baseUrl: conn.baseUrl,
      grantId: conn.grantId,
      token: stored.token,
      name: 'this agent',
    });
  } catch (err) {
    // Both of these came out of stored state the person cannot see, so a bare
    // `fetch failed` leaves them nothing to check. Name them.
    //
    // A 401/403 is the gateway saying this grant is revoked or paused, which is
    // terminal for the connection rather than for this attempt — so the way out
    // is said HERE, in the message somebody is already reading, rather than left
    // for them to find. Only for those two: a 429 or a network blip is not a
    // reason to delete anything.
    const refused = err instanceof GatewayError && (err.status === 401 || err.status === 403);
    return fail(
      `could not connect as ${conn.grantId} to ${conn.baseUrl}`,
      String(err instanceof Error ? err.message : err),
      ...(refused
        ? [
            '',
            'If that connection is finished with, take it off this machine:',
            '  npx tinhead-mcp forget',
            'It deletes the stored code too, and stops a dead connection making the live ones here',
            'ambiguous.',
          ]
        : [])
    );
  }
  for (const line of banner(session.grant.scope)) say(line);
  await serve(session);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'login') return login(rest);
  if (cmd === 'forget') return forget(rest);
  if (cmd !== undefined) {
    // The unknown command is NOT echoed. Someone whose first instinct is to
    // paste their setup code as an argument lands exactly here, and naming it
    // back would put the one perishable secret this product shows into their
    // scrollback — which is the whole reason `login` takes no argument.
    return fail(
      'no such command.',
      'usage: tinhead-mcp login   |   tinhead-mcp forget [<connection id>]   |   tinhead-mcp'
    );
  }
  return serveDefault();
}

main().catch((err) => {
  fail(String(err instanceof Error ? err.message : err));
});
