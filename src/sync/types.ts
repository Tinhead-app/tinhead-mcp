/**
 * SPEC-SYNC.md §10 — the server surface for E2EE thought sync. Only src/sync and
 * src/auth touch the network; components never do. Two implementations satisfy it:
 * `createSupabaseSync` (real) and `createFakeSync` (in-memory, real crypto, faked net).
 *
 * The engine drives pulls off the DEK-MAC'd manifest (§7): `fetchNodeMeta` supplies the
 * claimed id→(version,deleted) set, the manifest MAC binds it (counter inside the MAC),
 * and ciphertext is fetched only for ids whose manifest version advanced. Still owed
 * beyond this layer: the §12.5 reap job (`reapNodes`), the §6d–§6k admin flows, native.
 */

/** One keyring row: the DEK wrapped under a passphrase-KEK and a recovery-KEK. */
export interface KeyringRow {
  keyId: string;
  isCurrent: boolean;
  passAlg: string;
  passParams: { opslimit: number; memlimit: number };
  passSalt: string;
  wrappedDekPass: string;
  passCheck: string;
  recAlg: string;
  recParams: { opslimit: number; memlimit: number };
  recSalt: string;
  wrappedDekRecovery: string;
  recCheck: string;
  dekCheck: string;
}

/** One node row as stored server-side — ciphertext is opaque. */
export interface RemoteNode {
  id: string;
  ciphertext: string;
  keyId: string;
  version: number;
  deleted: boolean;
  /** Server-assigned fetch cursor (never an ordering authority — §7). */
  seq: number;
  /** Server-assigned; ms epoch. Used to stamp a pulled tombstone's local `deletedAt`. */
  updatedAt: number;
}

/** The lightweight per-row facts the manifest MAC binds (§7). */
export interface NodeMeta {
  id: string;
  version: number;
  deleted: boolean;
  keyId: string;
  seq: number;
  updatedAt: number;
}

/** The account's manifest row — `payload` is the DEK-subkey MAC (counter bound inside). */
export interface RemoteManifest {
  keyId: string;
  counter: number;
  payload: string;
}

/** One shelf-channel row (SPEC-SYNC §4.2/§4.3 — compiles and custom presets share the
 *  shape): ciphertext opaque, no version column. */
export interface RemoteCompile {
  id: string;
  ciphertext: string;
  keyId: string;
  /** Server-assigned; ms epoch. The channel's only change signal (no manifest). */
  updatedAt: number;
  /**
   * §4.4 (2026-07-30) — an EXPLICIT tombstone. Before this, a shelf deletion was the
   * absence of a row, and absence is not evidence: a device holding a populated book
   * against an emptied local list published the erasure of the whole channel, and every
   * peer adopted it. Deletions are now rows that say so, and absence means "I have never
   * heard of this", which is a reason to ASK rather than to destroy.
   */
  deleted: boolean;
}

/** One entry in a shelf channel's listing — its whole change signal (§4.2/§4.3/§4.4). */
export interface ShelfListing {
  id: string;
  keyId: string;
  updatedAt: number;
  deleted: boolean;
}

/** cas_push_node result: applied=false + `row` means a version conflict (row = current). */
export interface CasResult {
  applied: boolean;
  row: RemoteNode | null;
}

/** One row offered to `casPushBatch` (§12.10). `baseVersion` 0 means "expect no row". */
export interface PushRow {
  id: string;
  ciphertext: string;
  keyId: string;
  version: number;
  deleted: boolean;
  baseVersion: number;
}

/**
 * §12.10 — the atomic push result. `applied` means every row AND the manifest advance
 * landed in one transaction; anything else means NOTHING landed and `conflicts` says
 * why, so the caller can rebase without a second fetch. A conflict is either the
 * server's current row (someone else wrote it) or `{id, gone: true}` (the row was
 * reaped — resolve by delete precedence, never as a create). `counterConflict` means a
 * peer advanced the manifest; re-read and retry.
 */
export interface BatchPushResult {
  applied: boolean;
  counterConflict: boolean;
  /** Server counter after a successful apply, or the current one on a counter conflict. */
  counter: number | null;
  /** Server-assigned seq per applied id (bookkeeping needs it; no second fetch). */
  seqs: Record<string, number>;
  conflicts: (RemoteNode | { id: string; gone: true })[];
}

/** Narrow a conflict entry — a reaped id carries no row to rebase onto. */
export function isGone(c: RemoteNode | { id: string; gone: true }): c is { id: string; gone: true } {
  return (c as { gone?: boolean }).gone === true;
}

/** cas_put_manifest result: applied=false + `counter` means conflict (counter = current). */
export interface ManifestCasResult {
  applied: boolean;
  counter: number | null;
}

export interface SyncApi {
  fetchKeyring(): Promise<KeyringRow[]>;
  /** Upsert keyring rows (batch — §6e/§6k re-wraps touch every key_id row at once). */
  putKeyringRows(rows: KeyringRow[]): Promise<void>;
  /**
   * §6j reset: erase this account's nodes + keyring. The manifest row is deliberately
   * KEPT — its counter must continue monotonically across the reset epoch (§7).
   */
  wipeSync(): Promise<void>;
  /** The account's manifest row, or null if none exists yet (v1 accounts / first enable). */
  fetchManifest(): Promise<RemoteManifest | null>;
  /** CAS write: applies iff the stored counter equals baseCounter (0 = no row yet). */
  casPutManifest(payload: string, keyId: string, baseCounter: number): Promise<ManifestCasResult>;
  /** Lightweight meta for ALL rows (RLS-scoped) — the set the manifest MAC binds. */
  fetchNodeMeta(): Promise<NodeMeta[]>;
  /**
   * §12.11 — meta for rows whose server `seq` is ABOVE `sinceSeq`, oldest first. The
   * incremental verified reconcile's whole read: `seq` is stamped by the server on every
   * insert AND update, so this is exactly "what changed since I last caught up". It can
   * never report a row that was DELETED server-side, which is why the caller proves its
   * result against the manifest MAC rather than trusting it, and falls back to the full
   * read when the proof fails.
   */
  fetchNodeMetaSince(sinceSeq: number): Promise<NodeMeta[]>;
  /** Ciphertext rows; `ids` narrows the fetch (omit for all rows). */
  fetchNodes(ids?: string[]): Promise<RemoteNode[]>;
  casPushNode(
    id: string,
    ciphertext: string,
    keyId: string,
    newVersion: number,
    deleted: boolean,
    baseVersion: number
  ): Promise<CasResult>;
  /**
   * §12.10 — write rows AND advance the manifest in ONE server transaction. This is the
   * push path; `casPushNode` remains only for the §6-era single-row callers and older
   * builds. All-or-nothing by necessity: the manifest MAC is computed client-side over
   * the predicted post-apply set, so a partial apply would publish a manifest describing
   * a set that never existed.
   */
  casPushBatch(
    rows: PushRow[],
    payload: string,
    keyId: string,
    baseCounter: number
  ): Promise<BatchPushResult>;
  /**
   * §12.5 — client-driven reap: hard-delete long-dead tombstone rows. The caller
   * (the unlocked engine) removes the same ids from the manifest it maintains, so
   * peers read the verified absence as authorized removal (§8). Client-driven on
   * purpose: a server cron can't recompute the DEK-MAC'd manifest.
   */
  reapNodes(ids: string[]): Promise<void>;

  // §4.2/§4.3 — the shelf channels (no manifest, no versions; deliberately a
  // weaker tier than thoughts — see the spec sections for the accepted threats).
  /** The (id, keyId, updatedAt, deleted) list — a channel's whole change signal. */
  fetchCompileList(): Promise<ShelfListing[]>;
  fetchCompiles(ids: string[]): Promise<RemoteCompile[]>;
  /** Upsert one row; returns the server's updated_at (ms) so bookkeeping can
   *  remember the state it just made true without a second fetch. */
  putCompileRow(id: string, ciphertext: string, keyId: string, deleted?: boolean): Promise<number>;
  /** §4.4 — publish tombstones. Not a DELETE: a peer must be able to SEE the deletion. */
  deleteCompileRows(ids: string[], keyId: string): Promise<void>;
  /** §4.3 — the custom-preset channel, same contract over `preset_rows`. */
  fetchPresetList(): Promise<ShelfListing[]>;
  fetchPresets(ids: string[]): Promise<RemoteCompile[]>;
  putPresetRow(id: string, ciphertext: string, keyId: string, deleted?: boolean): Promise<number>;
  deletePresetRows(ids: string[], keyId: string): Promise<void>;
}

/**
 * §12.9 — the protocol this build speaks, declared on every WRITE to the §7 core
 * (`cas_push_node` / `cas_put_manifest`). The server refuses writes below its floor
 * (`sync_config.min_protocol`), because a stale client's writes can regress
 * invariants only newer clients maintain — the 1,291-row incident: a pre-paging
 * bundle's truncated view kept publishing manifests that bound part of the corpus,
 * and every current device correctly alarmed. History: 1 = the unpaged era
 * (implicit — those builds send no protocol at all and resolve to the RPC default
 * 0); 2 = row paging + the §4.1 cargo guard; 3 = the §12.10 atomic push (rows and
 * the manifest in one transaction, so this build can never leave the set ahead of
 * the manifest). Bump ONLY with a §12.9 spec entry, and raise the server floor only
 * when a shipped fix is invariant-critical — raising it to 3 refuses every device
 * that has not been rebuilt, which is an operational decision, not a code one.
 */
export const SYNC_PROTOCOL = 3;

/**
 * A write the server refused for being below the protocol floor. The engine maps
 * this to the `outdated` park (capture continues, edits queue dirty, everything
 * flushes after the app updates) — never to the network-retry path, which would
 * hammer a refusal that cannot succeed.
 */
export class ProtocolFloorError extends Error {}
