/**
 * `tinhead-mcp` — where the token lives at rest. SPEC-AGENT §4.5.
 *
 * The spec's first draft promised "no long-lived secret in a config file" and
 * then specified exactly that: MCP servers are configured by env vars and args
 * in `.mcp.json` / `claude_desktop_config.json` — plaintext, routinely committed
 * to repos and synced to clouds, and a WORSE home than the app's own DEK cache,
 * which is sealed. So the config carries the grant id and the OS carries the
 * token.
 *
 * **No native dependency, on purpose.** A keychain binding means a postinstall
 * build step, which is the classic supply-chain vector for exactly this kind of
 * package (§8). Each backend below is one command to a tool the OS already
 * ships, and a reader can check what it does in a line:
 *
 * | platform | mechanism |
 * |---|---|
 * | macOS  | `security` → the login keychain |
 * | Windows | PowerShell DPAPI (`ConvertFrom-SecureString`), user-scoped, ciphertext at rest |
 * | Linux  | `secret-tool` → libsecret, when it is installed |
 *
 * **THE TOKEN IS NEVER AN ARGUMENT. On any platform.** It used to be on two of
 * them, and the file contradicted itself about it: the Linux branch explained
 * that argv is readable and then the macOS branch passed `-w <token>` while the
 * Windows branch interpolated the token INTO a PowerShell script. That is worse
 * than `ps` output on Windows — the command line lands in 4688 process-creation
 * audit events and the script text in 4104 ScriptBlock logs, both of which are
 * collected and shipped off the machine by ordinary endpoint tooling. Note the
 * trap in the obvious fix: piping the whole script into `powershell -Command -`
 * does NOT help, because 4104 logs the block however it arrives. **The script
 * has to be a constant and the secret has to be data on stdin**, which is what
 * `psSecret` below does.
 *
 * **The fallback is announced, never silent.** Where none of these works the
 * token goes to a file in the state dir and the process SAYS SO on stderr at
 * every start. A quiet downgrade would be the same lie the config file was.
 *
 * **A store is PROVED before it is claimed.** `storeToken` reads the value back
 * through the same call `loadToken` will make, and only then reports a backend;
 * the alternative is telling someone "stored in the keychain" on the strength of
 * an exit code, which is the one sentence here that must not be a guess (the
 * macOS path in particular cannot be tested on the dev machine). A store nothing
 * can read is not a store — it is a plaintext fallback that has not admitted
 * itself yet, and the next start would say "no token stored" instead.
 *
 * **Exactly one copy exists.** Whichever place wins, the OTHER is removed: a
 * successful keychain write deletes any plaintext file left by an earlier
 * fallback, and a fallback deletes the keychain entry it could not replace.
 * Both directions were bugs. `loadToken` prefers the keychain, so a stale entry
 * there shadowed a freshly pasted code forever (an unopenable grant, with
 * nothing on screen to explain it), and a plaintext token from one bad night
 * outlived every later login.
 *
 * **The NAME is derived, never the caller's string** (`storeKey`). DPAPI seals
 * the contents of a file; it has nothing to say about what the file is called.
 * When the old two-argument setup let a token be passed where an id belonged,
 * that token was written into a filename in the clear — an unsealed copy of the
 * secret, sitting beside the sealed one. Hashing the id makes that class
 * unreachable however the caller is confused, and takes path separators and
 * every other filename hazard with it.
 *
 * That is the class closed going forward; the instances it already wrote are
 * still on disk, and nothing would ever ask for them again (no connection names
 * a token as its id), so they would sit there forever. `purgeCodeShapedNames`
 * takes them out at the next login.
 *
 * **The state dir also holds a non-secret sibling** (`connections.json`): which
 * connections this machine has and which gateway each talks to. It lives here
 * because it is the other half of the same answer — `stateDir()` is one place —
 * and it means the MCP client config needs no environment at all.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SERVICE = 'tinhead-mcp';

/** Long enough for a cold PowerShell start, short enough not to hang a login. */
const SPAWN_TIMEOUT_MS = 15_000;

/**
 * Run a command that takes NO secret and prints one. Bounded by the same timeout
 * as `feed`, because a keychain read can meet a GUI prompt and a hung `login` is
 * indistinguishable from a broken one.
 */
async function readOut(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout.trim();
}

export function stateDir(): string {
  const home = homedir();
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), SERVICE);
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', SERVICE);
  return join(process.env.XDG_STATE_HOME ?? join(home, '.local', 'state'), SERVICE);
}

/** How the token was actually stored — the caller announces a `file`. */
export type TokenStore = 'keychain' | 'dpapi' | 'libsecret' | 'file';

/**
 * The name a grant is stored UNDER, in every backend. A digest, not the id.
 *
 * This is a naming scheme and not a security boundary — the id is not secret
 * and nothing depends on the hash being hard to invert. What it buys is that no
 * caller-supplied string reaches the filesystem or an argv verbatim, so a token
 * handed in where an id belonged cannot land in a filename, a `security -s`
 * argument or a 4688 audit event.
 */
function storeKey(grantId: string): string {
  return createHash('sha256').update(grantId, 'utf8').digest('hex').slice(0, 32);
}

/**
 * What a pre-digest login called the same grant, or `null` when that string was
 * never safe to use as one. Read on miss and migrated; see `loadToken`.
 *
 * The guard matters: legacy names came from the caller, so a stored id
 * containing a separator would make this the very path-traversal read that
 * `storeKey` exists to prevent.
 */
function legacyKey(grantId: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(grantId) ? grantId : null;
}

/**
 * Run a command with a secret on STDIN and take its stdout. The argv is whatever
 * the caller passes and must never contain the secret; that rule is the whole
 * point of this helper existing.
 *
 * A non-zero exit rejects. An EMPTY stdout does not — `secret-tool store` says
 * nothing on success — so every caller that expects a value checks for one, and
 * must: a silently failing PowerShell one-liner exits 0 with no output, and
 * passing that on would hand the caller an empty string as if it were a token.
 */
function feed(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timed out`));
    }, SPAWN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `${cmd} exited ${code}`));
      resolve(out.trim());
    });
    child.stdin.on('error', () => {}); // a child that died first must not crash us
    child.stdin.end(input);
  });
}

/**
 * A CONSTANT PowerShell script over a secret on stdin. Both scripts below are
 * string literals with no interpolation — that is the property, and the reason
 * they are declared here rather than built at the call site.
 */
function psSecret(script: string, input: string): Promise<string> {
  return feed('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);
}

/** Read the token from stdin, DPAPI-seal it under this Windows account, print the ciphertext. */
const PS_PROTECT =
  '$t = [Console]::In.ReadToEnd().Trim(); ' +
  'ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString';

/** Read the ciphertext from stdin, unseal it, print the token. */
const PS_UNPROTECT =
  '$s = [Console]::In.ReadToEnd().Trim() | ConvertTo-SecureString; ' +
  '[System.Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
  '[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';

async function ensureDir(): Promise<string> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * The two on-disk files, and why they cannot share a name. They did, and a
 * failed DPAPI decrypt fell through to the plaintext reader — which happily
 * returned the CIPHERTEXT as if it were the token, so the failure surfaced as an
 * unopenable grant instead of a decrypt error.
 */
async function dpapiPath(key: string): Promise<string> {
  return join(await ensureDir(), `${key}.dpapi`);
}
async function plainPath(key: string): Promise<string> {
  return join(await ensureDir(), `${key}.token`);
}

/** The announced fallback: the token, in a file, with the tightest mode the OS honours. */
async function storeInFile(key: string, token: string): Promise<TokenStore> {
  const p = await plainPath(key);
  // `mode` is a no-op on Windows (NTFS ACLs are not POSIX bits); the file there
  // is protected by the user profile's own ACL and nothing more, which is what
  // the warning at the call site says.
  await writeFile(p, token, { encoding: 'utf8', mode: 0o600 });
  await chmod(p, 0o600).catch(() => {});
  return 'file';
}

/** Which backend this platform tries first. The one `readPrimary` reads from. */
function primaryStore(): Exclude<TokenStore, 'file'> {
  const os = platform();
  return os === 'darwin' ? 'keychain' : os === 'win32' ? 'dpapi' : 'libsecret';
}

/** A DPAPI blob that exists and will not open here. Terminal — see `loadToken`. */
class SealedUnreadable extends Error {}

/** Put the token in the platform's own store. Throws when it will not take it. */
async function putPrimary(key: string, token: string): Promise<void> {
  const os = platform();
  if (os === 'darwin') {
    // `-w` with NO value: the password is read from stdin rather than argv, so
    // it stays out of `ps` and out of the shell history of whoever ran this.
    await feed(
      'security',
      ['add-generic-password', '-U', '-a', SERVICE, '-s', `${SERVICE}:${key}`, '-w'],
      `${token}\n`
    ).catch(async () =>
      // Some `security` builds prompt on /dev/tty for a bare `-w` instead of
      // reading the pipe. Its batch mode always reads stdin, and the secret is
      // still DATA on stdin rather than an argument, so the property holds. It
      // is interpolated into a command LINE there, which is only safe because a
      // grant token is url-safe base64 (`[A-Za-z0-9_-]`, [crypto]) — no space,
      // quote or newline can end the argument early. The CLI has already proved
      // the shape (`grantAuthFor`) before this runs, and `key` is a hex digest.
      feed('security', [], `add-generic-password -U -a ${SERVICE} -s ${SERVICE}:${key} -w ${token}\n`)
    );
    return;
  }
  if (os === 'win32') {
    // DPAPI, user-scoped: only this Windows account on this machine can read
    // it back, and what lands on disk is ciphertext.
    const enc = await psSecret(PS_PROTECT, token);
    if (!enc) throw new Error('DPAPI produced nothing');
    await writeFile(await dpapiPath(key), enc, { encoding: 'utf8', mode: 0o600 });
    return;
  }
  // secret-tool takes the secret on STDIN, never argv — an argument would be
  // readable in `ps` output for as long as the call lasts.
  await feed('secret-tool', ['store', '--label', SERVICE, 'service', SERVICE, 'grant', key], token);
}

/**
 * Read the platform store back. `null` means nothing is stored there; a THROW
 * means something is and this machine cannot read it, which the two callers
 * treat differently — `storeToken` falls back, `loadToken` stops.
 */
async function readPrimary(key: string): Promise<string | null> {
  const os = platform();
  if (os === 'darwin') {
    return (await readOut('security', [
      'find-generic-password', '-a', SERVICE, '-s', `${SERVICE}:${key}`, '-w',
    ])) || null;
  }
  if (os === 'win32') {
    let enc: string;
    try {
      enc = (await readFile(await dpapiPath(key), 'utf8')).trim();
    } catch {
      return null; // never sealed here — the plaintext fallback may still hold it
    }
    if (!enc) return null;
    let token: string;
    try {
      token = await psSecret(PS_UNPROTECT, enc);
    } catch {
      throw new SealedUnreadable('the stored token will not unseal on this machine');
    }
    if (!token) throw new SealedUnreadable('DPAPI returned nothing for a sealed token');
    return token;
  }
  return (await readOut('secret-tool', ['lookup', 'service', SERVICE, 'grant', key])) || null;
}

/** Best-effort: leave nothing behind in the store that did not win. */
async function forgetPrimary(key: string): Promise<void> {
  const os = platform();
  try {
    if (os === 'darwin') {
      await readOut('security', [
        'delete-generic-password', '-a', SERVICE, '-s', `${SERVICE}:${key}`,
      ]);
    } else if (os === 'win32') {
      await rm(await dpapiPath(key), { force: true });
    } else {
      await readOut('secret-tool', ['clear', 'service', SERVICE, 'grant', key]);
    }
  } catch {
    // Nothing there, or no tool to ask — either way there is nothing to shadow.
  }
}

async function forgetFile(key: string): Promise<void> {
  await rm(await plainPath(key), { force: true }).catch(() => {});
}

/** Every home a name could have. Used to retire a legacy name completely. */
async function forgetUnder(key: string): Promise<void> {
  await forgetPrimary(key);
  await forgetFile(key);
}

/** `storeToken`, under an already-derived name. */
async function storeUnder(key: string, token: string): Promise<TokenStore> {
  const backend = primaryStore();
  try {
    await putPrimary(key, token);
    if ((await readPrimary(key)) !== token) {
      throw new Error(`the ${backend} store took the code and did not give it back`);
    }
    await forgetFile(key);
    return backend;
  } catch {
    // Fall through to the announced file — and take the half-written or stale
    // entry with us, because `loadUnder` would prefer it to the file.
    await forgetPrimary(key);
  }
  return storeInFile(key, token);
}

/**
 * `loadToken`, under an already-derived name.
 *
 * `sealed` reports a blob that exists here and will not open — the caller must
 * know that separately from "nothing stored", because the two need different
 * sentences. It is REPORTED rather than printed: this runs twice (derived name,
 * then the legacy one), and a warning printed from in here fired on the first
 * attempt and was then contradicted by the second one succeeding.
 */
async function loadUnder(key: string): Promise<{
  found: { token: string; from: TokenStore } | null;
  sealed: boolean;
}> {
  let sealed = false;
  try {
    const token = await readPrimary(key);
    if (token) return { found: { token, from: primaryStore() }, sealed };
  } catch (err) {
    // Intentionally does NOT fall through to the plaintext reader on a sealed
    // blob: the one thing that must not happen is handing back ciphertext as if
    // it were a token. DPAPI is user- and machine-bound, so this is a copied
    // profile, a rebuilt machine or a corrupt file.
    if (err instanceof SealedUnreadable) return { found: null, sealed: true };
    // No item, or no tool to ask with: the announced file may still hold it.
  }
  try {
    const token = (await readFile(await plainPath(key), 'utf8')).trim();
    return { found: token ? { token, from: 'file' } : null, sealed };
  } catch {
    return { found: null, sealed };
  }
}

/**
 * Store the token for a grant. Returns which backend actually took it — proved
 * by reading it back, never assumed from an exit code.
 */
export async function storeToken(grantId: string, token: string): Promise<TokenStore> {
  const backend = await storeUnder(storeKey(grantId), token);
  // An earlier login's copy under the plain id is the same shadowing bug as a
  // plaintext file beside a keychain entry, so it goes the same way: out.
  const legacy = legacyKey(grantId);
  if (legacy) await forgetUnder(legacy);
  return backend;
}

/**
 * Read a grant's token back. Null when there is none stored, or none readable.
 *
 * A token stored under the pre-digest name is read, moved to the derived one and
 * the old copy deleted — a login made before `storeKey` existed keeps working,
 * once, and is not left lying in two places afterwards.
 */
export async function loadToken(grantId: string): Promise<{ token: string; from: TokenStore } | null> {
  const key = storeKey(grantId);
  const now = await loadUnder(key);
  if (now.found) return now.found;

  const legacy = legacyKey(grantId);
  const old = legacy ? await loadUnder(legacy) : { found: null, sealed: false };
  if (old.found && legacy) {
    const from = await storeUnder(key, old.found.token);
    await forgetUnder(legacy);
    return { token: old.found.token, from };
  }

  // Said only once both names have been tried, and only when a blob was really
  // there: "there is a secret here and this machine is not the one that sealed
  // it" is a different problem from "you have not logged in", and telling
  // someone the wrong one costs them the fix.
  if (now.sealed || old.sealed) {
    process.stderr.write(
      `this machine cannot unseal the stored code for connection ${grantId} (a DPAPI secret does ` +
        'not travel between Windows accounts or machines). Run `tinhead-mcp login` again with ' +
        'a fresh setup code from Tinhead.\n'
    );
  }
  return null;
}

/**
 * A name that is a grant CODE. 32 bytes of base64url is exactly 43 characters,
 * and a code is the only 32-byte thing that ever reached this directory.
 */
const CODE_SHAPED = /^[A-Za-z0-9_-]{43}$/;

/**
 * Take out the files the OLD setup named after a code, and say how many.
 *
 * This is not hygiene, it is the leak itself: one is on the founder's disk right
 * now — `WKGe….dpapi`, 43 characters of plaintext secret as a filename, written
 * the night he pasted his token where the id belonged. `storeKey` stops the next
 * one; nothing would ever ask for THAT one again (no connection names a code as
 * its id), so without this it sits there for good.
 *
 * Safe by shape, not by luck: a grant id is a `uuid4` from the app (36
 * characters, hyphens at 8/13/18/23) and a derived name is 32 hex, so neither
 * can be 43 base64url characters. Only a code can.
 *
 * The caller must not print what was removed. The name is the secret.
 */
export async function purgeCodeShapedNames(): Promise<number> {
  const dir = stateDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const base = name.replace(/\.(dpapi|token)$/, '');
    if (base === name || !CODE_SHAPED.test(base)) continue;
    try {
      await rm(join(dir, name), { force: true });
      removed++;
    } catch {
      // A file we cannot delete is a file we should still not name out loud.
    }
  }
  return removed;
}

// ------------------------------------------------------- the non-secret half

/** One connection this machine has logged in to. Neither field is a secret (§4.5). */
export interface StoredGrant {
  grantId: string;
  /** The `grant_gateway` endpoint the setup code named. */
  url: string;
}

const CONNECTIONS = 'connections.json';

/**
 * The connections this machine knows, newest login last.
 *
 * A non-https entry is dropped rather than repaired: this file decides where a
 * credential is SENT, and the only way one gets in is an edit by hand, so the
 * charitable reading of a rewritten URL is not the safe one. (`decodeSetupCode`
 * makes the same check on the way in.)
 */
export async function listGrants(): Promise<StoredGrant[]> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir(), CONNECTIONS), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray((parsed as { connections?: unknown })?.connections)
      ? ((parsed as { connections: unknown[] }).connections)
      : [];
    return rows
      .map((r) => r as { grantId?: unknown; url?: unknown })
      .filter(
        (r): r is StoredGrant =>
          typeof r.grantId === 'string' &&
          !!r.grantId &&
          typeof r.url === 'string' &&
          /^https:\/\/[^\s]+$/i.test(r.url)
      )
      .map((r) => ({ grantId: r.grantId, url: r.url }));
  } catch {
    return [];
  }
}

/** Record a connection, replacing any earlier row for the same grant. */
export async function rememberGrant(grant: StoredGrant): Promise<void> {
  const rest = (await listGrants()).filter((g) => g.grantId !== grant.grantId);
  const dir = await ensureDir();
  await writeFile(
    join(dir, CONNECTIONS),
    `${JSON.stringify({ connections: [...rest, grant] }, null, 2)}\n`,
    'utf8'
  );
}
