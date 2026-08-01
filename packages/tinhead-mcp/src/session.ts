/**
 * `tinhead-mcp` — one connected session: token in, tool table out.
 *
 * The whole chain lives here so `server.ts` can stay a transport binding and
 * nothing else: token → `grantAuth` → bundle → DEK + scope → verified corpus →
 * tools.
 *
 * **Freshness policy, stated because it is a real trade.** Reads are served
 * from a corpus held for `READ_TTL_MS`; writes ALWAYS re-read first, because a
 * push needs the current manifest counter as its CAS base and a stale one is a
 * guaranteed conflict. So an agent can walk a branch cheaply, and every write
 * it makes is against what the account holds right now.
 */

import { cryptoReady, wipe } from '../../../src/crypto';
import { grantAuthFor, openGrantBundle } from '../../../src/agent/grants';
import { OpenedGrant } from '../../../src/agent/types';
import { uuid4 } from '../../../src/db/persistence';
import { Corpus, DoorApi, pullCorpus } from './corpus';
import { GatewayOptions, createGateway, fetchBundle } from './gateway';
import { Tool, readTools } from './tools';
import { writeTools } from './writeTools';

/** How long a read may be served from the held corpus. A walk is many calls. */
export const READ_TTL_MS = 20_000;

export interface Session {
  tools: Tool[];
  grant: OpenedGrant;
  /**
   * The held corpus, on the read policy. Exposed for the RESOURCE list, which
   * needs the tree's shape rather than any one tool's answer — and reads it
   * through the same TTL as every tool, so `@` and a tool call in the same
   * breath cannot disagree about what is there.
   */
  corpus(): Promise<Corpus>;
  /** Drop the key. Called when the transport closes. */
  close(): void;
}

export interface SessionInput {
  api: DoorApi;
  grant: OpenedGrant;
  name: string;
  now?: () => number;
  newId?: () => string;
}

/** Build the tool table over an already-opened grant. Used by the tests directly. */
export function createSession(input: SessionInput): Session {
  const now = input.now ?? Date.now;
  let held: Corpus | null = null;
  let heldAt = 0;

  const read = async (): Promise<Corpus> => {
    if (held && now() - heldAt < READ_TTL_MS) return held;
    held = await pullCorpus(input.api, input.grant);
    heldAt = now();
    return held;
  };
  const fresh = async (): Promise<Corpus> => {
    held = await pullCorpus(input.api, input.grant);
    heldAt = now();
    return held;
  };

  return {
    grant: input.grant,
    corpus: read,
    tools: [
      ...readTools({ name: input.name, scope: input.grant.scope, corpus: read }),
      ...writeTools({
        api: input.api,
        grant: input.grant,
        corpus: fresh,
        newId: input.newId ?? uuid4,
        now,
      }),
      // A read-only grant is not SHOWN a door it cannot open. Note what this
      // deliberately does not do: hide the write tools from a `write: true`
      // grant that has been given no branches yet. That grant can write — it
      // just has nowhere to write yet — and hiding the tools would have the
      // agent report "I can only read", which is the wrong thing for the person
      // to hear. Shown, they refuse with the sentence that names the fix.
    ].filter((t) => input.grant.scope.write || t.annotations.readOnlyHint),
    close() {
      wipe(input.grant.dek);
      held = null;
    },
  };
}

/**
 * Connect for real: redeem the token at the gateway, open the bundle locally,
 * and build the session.
 *
 * The token is used twice — once to derive `grantAuth` for the wire and once to
 * unwrap the bundle — and is not retained by anything here afterwards. A
 * read-only grant gets a tool table with **no write tools present at all**,
 * rather than write tools that refuse: a model should not be shown a door it
 * cannot open.
 */
export async function connect(opts: {
  baseUrl: string;
  grantId: string;
  token: string;
  name?: string;
  fetchImpl?: typeof fetch;
}): Promise<Session> {
  await cryptoReady;
  const gw: GatewayOptions = {
    baseUrl: opts.baseUrl,
    grantId: opts.grantId,
    auth: grantAuthFor(opts.token),
    fetchImpl: opts.fetchImpl,
  };
  const bundle = await fetchBundle(gw);
  const grant = openGrantBundle(opts.token, bundle);
  return createSession({ api: createGateway(gw), grant, name: opts.name ?? 'this agent' });
}
