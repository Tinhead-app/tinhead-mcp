/**
 * `tinhead-mcp` — the gateway client. SPEC-AGENT §4.3.
 *
 * The door authenticates with `grantAuth` and nothing else: no Supabase
 * session, no refresh token, no account credential of any kind in a config
 * file. One secret, one revocation, one identity — which is what §5 already
 * claimed the token was, and what a refresh token would have quietly broken.
 *
 * **Everything crossing this boundary is ciphertext or a MAC.** The gateway is
 * an authenticator standing in front of the same RPCs a phone calls, not a
 * reader: it holds no DEK, and the manifest MAC it relays was computed here.
 *
 * `grantAuth` travels in the BODY, never a path or a query string — those end
 * up in access logs, proxy logs and browser history. The token itself never
 * travels at all (§4.1).
 */

import { GrantBundle } from '../../../src/agent/types';
import {
  BatchPushResult,
  NodeMeta,
  PushRow,
  RemoteManifest,
  RemoteNode,
  SYNC_PROTOCOL,
} from '../../../src/sync/types';
import { DoorApi } from './corpus';

/** The gateway said no, and said why in words the user can act on. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface GatewayOptions {
  /** e.g. `https://<project>.supabase.co/functions/v1/grant_gateway` */
  baseUrl: string;
  grantId: string;
  /** Derived fresh from the token at startup; never persisted. */
  auth: string;
  fetchImpl?: typeof fetch;
}

async function call<T>(o: GatewayOptions, op: string, args: unknown): Promise<T> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(o.baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantId: o.grantId, auth: o.auth, op, args }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // The three the user can actually do something about get their own words.
    if (res.status === 401 || res.status === 403) {
      throw new GatewayError(
        'this grant was not accepted — it may have been revoked, or paused in Tinhead at ' +
          'Settings › Plugins. Nothing was read or written.',
        res.status
      );
    }
    if (res.status === 429) {
      throw new GatewayError('too many requests — wait a moment and try again.', res.status);
    }
    // §12.9 — the account's protocol floor rose above what this build speaks.
    // It gets its own sentence because it is the one refusal that CANNOT
    // succeed on retry: unmapped, it read as a generic server fault and the
    // door would keep pushing at a door that will never open. The remedy is a
    // newer package, and only the person can apply it.
    if (res.status === 409 && text.includes('sync_protocol_below_floor')) {
      throw new GatewayError(
        'this version of tinhead-mcp is older than your thoughts require. Update it ' +
          '(`npm i -g tinhead-mcp@latest`, or clear the npx cache) and connect again. ' +
          'Nothing was written.',
        res.status
      );
    }
    throw new GatewayError(`the Tinhead server said no (${res.status}) ${text}`.trim(), res.status);
  }
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok) throw new GatewayError(body.error ?? 'the request failed', res.status);
  return body.data as T;
}

/** Redeem the token for the wrapped bundle (§4.3). The only call before the DEK exists. */
export async function fetchBundle(o: GatewayOptions): Promise<GrantBundle> {
  return call<GrantBundle>(o, 'open', {});
}

/**
 * The four server calls the door makes, over the gateway. The shape is [sync]'s
 * own `SyncApi` subset, so this and `FakeSync` are interchangeable — which is
 * exactly how the whole door is tested against a live engine.
 */
export function createGateway(o: GatewayOptions): DoorApi {
  return {
    fetchManifest: () => call<RemoteManifest | null>(o, 'manifest', {}),
    fetchNodeMeta: () => call<NodeMeta[]>(o, 'meta', {}),
    fetchNodes: (ids?: string[]) => call<RemoteNode[]>(o, 'nodes', { ids }),
    casPushBatch: (rows: PushRow[], payload: string, keyId: string, baseCounter: number) =>
      // §12.9 — the door DECLARES the protocol it speaks, exactly as
      // `supabaseSync.casPushBatch` does. It is not a courtesy: the door links
      // the app's own `encodePayload`, so it speaks whatever this build speaks,
      // and the gateway's fallback for a door that says nothing is a hardcoded
      // 3. The day the floor rises, an undeclared door is refused for speaking a
      // version it in fact speaks.
      call<BatchPushResult>(o, 'push', {
        rows,
        payload,
        keyId,
        baseCounter,
        protocol: SYNC_PROTOCOL,
      }),
  };
}
