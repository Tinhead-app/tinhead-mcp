/**
 * [mcp] SPEC-AGENT §5 — the grant record, shared by both sides of the door.
 *
 * This module and `grants.ts` are the ONE implementation of the grant protocol:
 * the app mints, `tinhead-mcp` opens, and both import from here. A second
 * implementation of a key protocol is the same class of bug §1.4 forbids for
 * mutations, reached through a different door.
 *
 * Pure by contract — no store, no React, no network, no platform. The package
 * that gets published imports this file.
 */

/** What a grant may READ. Scope is enforced by the door, never by the server — see `GrantScope`. */
export type GrantReads = 'branch' | 'everything';

/**
 * §5 — the one dial the SERVER enforces.
 *
 * **`here` was removed on 2026-07-31 (founder call), because nothing enforced
 * it.** `grant_open` and `grant_user` only ever filtered `availability <> 'off'`,
 * so a connection set to "only while Tinhead is open" authorized exactly what
 * `always` did — while the surface sold it as the safer choice. A control that
 * does nothing is worse than no control, and implementing it would have meant a
 * presence heartbeat whose failure mode is an agent that stops working when the
 * phone is force-killed. A stored or served `here` now reads as `off`
 * (`coerceAvailability`): fail CLOSED, never silently promote to `always`.
 */
export type GrantAvailability = 'off' | 'always';

export const AVAILABILITIES: readonly GrantAvailability[] = ['off', 'always'];

/**
 * Anything that is not a value THIS build enforces becomes `off`. That covers
 * the retired `here`, a typo in a hand-edited record, and whatever a future
 * build invents — in every case the safe reading is "do not serve".
 */
export function coerceAvailability(v: unknown): GrantAvailability {
  return v === 'always' ? 'always' : 'off';
}

/** Cycle off → always → off. The surface's one action. */
export function nextAvailability(a: GrantAvailability): GrantAvailability {
  return a === 'always' ? 'off' : 'always';
}

/**
 * What a grant is allowed to do.
 *
 * **Two halves, held under two different keys** — SPEC-AGENT §4.2/§4.2b.
 *
 * The obvious design puts the scope in the row next to the blob, where the
 * server serves it in the clear; then a server that cannot read one word of the
 * corpus can still widen `reads` to `everything` and flip `write` on, and the
 * door would believe it. So the scope is sealed. What CHANGED on 2026-07-31 is
 * which key seals it: not `grantWrap` (frozen at issue, because the app never
 * keeps the token) but the account DEK, which the app holds whenever the vault
 * is open. That is what lets `branches` grow and shrink over the life of one
 * connection without re-issuing a code — the product shape the founder asked
 * for, where Settings makes the connection and the tree hands it branches.
 *
 * **Branch scope CANNOT be server-enforced, and that is structural rather than
 * lazy:** `parentId` is inside the ciphertext (SPEC-SYNC §4 — tree shape stays
 * private), so the server does not know which rows are under which thought and
 * could not filter by branch if it wanted to. This is the mechanism behind §8's
 * concession that scope is policy rather than cryptography. The one dial the
 * server DOES enforce is `availability: off`, because refusing to serve a bundle
 * needs no plaintext.
 */
export interface GrantScope {
  /**
   * The thoughts this grant is rooted at, each covering everything beneath it.
   * **Empty means the connection reaches NOTHING** — which is the ordinary state
   * of a freshly made connection, and the reason a code can be issued before any
   * branch exists. It is never a synonym for the root.
   */
  branches: readonly string[];
  /** May it write inside `branches`. Writes are never wider, even with `reads: everything`. */
  write: boolean;
  reads: GrantReads;
}

/** The empty scope: a connection that exists and reaches nothing. The narrow default everywhere. */
export const EMPTY_SCOPE: GrantScope = { branches: [], write: false, reads: 'branch' };

/**
 * The record the app keeps and `Settings › Plugins` lists. **Device-local by
 * construction** — grants are credentials, excluded from the [sync] mirror
 * registry (default-deny) and from the §27 backup envelope. A grant on the
 * laptop must not authorize the phone.
 */
export interface Grant extends GrantScope {
  id: string;
  /** What the plugin is called. The plugin names itself; there is no name field. */
  name: string;
  /**
   * The account this grant was minted under.
   *
   * The record is device-local, and a device outlives a sign-in. Without this,
   * signing out and signing in as someone else showed THEM a connection that was
   * not theirs: the surface listed it, "Take it back" reached zero rows under
   * the new account's RLS, and the record was forgotten locally while the row it
   * named went on serving the first account's DEK. Empty for a record written
   * before this field existed, which reads as "belongs to nobody" and is
   * therefore shown to nobody.
   */
  userId: string;
  availability: GrantAvailability;
  /** The DEK epoch this grant was minted against; a §6j reset moves it and the grant dies. */
  keyId: string;
  createdAt: number;
  /**
   * When the code was issued — **`null` means the connection has been set up but
   * no code exists yet.** A connection with no code has no server row, so there
   * is nothing to revoke and nothing to redeem.
   *
   * Note what this no longer gates: the SCOPE. Before 2026-07-31 the branch was
   * frozen at issue because it was sealed under a token the app had forgotten,
   * so every option went read-only the moment a code appeared. The scope now
   * rides its own seal under the account DEK (§4.2b) and moves freely for the
   * life of the connection.
   */
  issuedAt: number | null;
  /**
   * Bumped on every scope re-seal, and carried in the sealed AAD so a served
   * blob cannot be relabelled. Starts at 1.
   */
  scopeRev: number;
  /** Stamped by the gateway on each connect; `null` until first used. */
  lastUsed: number | null;
}

/**
 * What the SERVER stores. Note what is absent: the token, the branch list in the
 * clear, and anything readable. `authHash` is a keyed hash of the value the door
 * sends, so a dump yields no replayable credential either (§4.2 step 4).
 */
export interface GrantRow {
  id: string;
  authHash: string;
  /** The sealed DEK, under a token-derived key the server never receives. */
  wrapped: string;
  salt: string;
  keyId: string;
  /** The sealed scope, under the ACCOUNT DEK — rewritable without the token (§4.2b). */
  scope: string;
  scopeRev: number;
  /** The one dial the server enforces — `off` refuses before any bundle is served. */
  availability: GrantAvailability;
}

/** What the gateway returns at connect time (§4.3). Opaque without the token. */
export interface GrantBundle {
  id: string;
  userId: string;
  keyId: string;
  wrapped: string;
  salt: string;
  /** Absent only for a grant minted before §4.2b, whose scope is inside `wrapped`. */
  scope?: string | null;
  scopeRev?: number | null;
}

/** What opening a bundle yields — the key and the scope that rode with it. */
export interface OpenedGrant {
  dek: Uint8Array;
  scope: GrantScope;
  keyId: string;
  userId: string;
}
