import { CompileRecord, Draft, ThoughtNode } from '../model/types';

/**
 * SPEC §13.1 — all persistence flows through this interface.
 * Native: SQLite (SQLCipher). Web: IndexedDB (unencrypted, documented compromise).
 *
 * Sync bookkeeping (SPEC-SYNC §10): a parallel `node_sync` store (one row per synced
 * node) + a `sync_meta` KV (manifest counter anchor, enable flag). Once sync has ever
 * been enabled (`setSyncTracking(true)`), every node upsert marks its `node_sync` row
 * dirty IN THE SAME transaction — that is the §7 apply-time-revalidation contract:
 * `applyRemoteIfClean` can then be a single conditional write with no window in which
 * a user edit lands unmarked. The one exception is an `accessedAt`-only touch
 * (`syncSilent`) — accessedAt is device-local and never synced (SPEC-SYNC §4).
 */
export interface Persistence {
  /** Open the store, run migrations, sweep old tombstones, load everything. */
  init(): Promise<PersistedState>;
  upsertNode(node: ThoughtNode, opts?: UpsertOpts): Promise<void>;
  upsertNodes(nodes: ThoughtNode[], opts?: UpsertOpts): Promise<void>;
  /** Removes rows AND their `node_sync` bookkeeping (bookkeeping never outlives its node). */
  hardDelete(ids: string[]): Promise<void>;
  setDraft(draft: Draft): Promise<void>;
  clearDraft(contextId: string): Promise<void>;
  setSetting(key: string, value: string | null): Promise<void>;

  // ---- compile history (SPEC-COMPILE §7, v1 — local-only, never synced) ----
  /** Insert or update one taken compile (updates re-take the same artifact). */
  putCompile(rec: CompileRecord): Promise<void>;
  deleteCompiles(ids: string[]): Promise<void>;

  // ---- sync bookkeeping (SPEC-SYNC §10) ----
  /** While on, node upserts also mark `node_sync.dirty = 1` (same transaction). */
  setSyncTracking(on: boolean): void;
  getSyncMarks(): Promise<SyncMark[]>;
  putSyncMarks(marks: SyncMark[]): Promise<void>;
  deleteSyncMarks(ids: string[]): Promise<void>;
  /**
   * §7 apply-time revalidation: write the pulled node + its clean mark IFF the node is
   * not locally dirty — one atomic step (a dirty flip during the fetch window diverts
   * to the conflict resolver). `force` is for tombstone adoption only (delete
   * precedence is absolute: a tombstone clobbers even a dirty local edit).
   */
  applyRemoteIfClean(node: ThoughtNode, mark: SyncMark, force?: boolean): Promise<boolean>;
  /**
   * The bulk twin — SAME per-row contract (the dirty re-read and the conditional
   * write share one atomic step; `force` per row for tombstones), ONE storage
   * transaction for the whole batch. Exists for first hydration: an empty device
   * adopting its corpus paid one transaction per thought, which on native SQLite is
   * one fsync per thought. Returns applied flags aligned by index; a batch that
   * fails wholesale rejects (callers retry on the next reconcile — same posture as
   * a failed single apply).
   */
  applyRemoteManyIfClean(rows: RemoteApply[]): Promise<boolean[]>;
  getSyncMeta(key: string): Promise<string | null>;
  setSyncMeta(key: string, value: string | null): Promise<void>;
}

/** One row of a bulk §7 apply — the same triple `applyRemoteIfClean` takes. */
export interface RemoteApply {
  node: ThoughtNode;
  mark: SyncMark;
  /** Tombstone adoption only — delete precedence is absolute. */
  force?: boolean;
}

export interface UpsertOpts {
  /** accessedAt-only write: never dirty-marks (device-local field, SPEC-SYNC §4). */
  syncSilent?: boolean;
}

/** One `node_sync` row (SPEC-SYNC §10). `syncedVersion` 0 = never pushed. */
export interface SyncMark {
  id: string;
  syncedVersion: number;
  syncedSeq: number;
  dirty: boolean;
  keyId: string;
}

export interface PersistedState {
  nodes: ThoughtNode[];
  drafts: Draft[];
  settings: Record<string, string>;
  compiles: CompileRecord[];
}

/**
 * The compile-history shelf keeps the newest N takes; `recordCompile` prunes
 * past it in the same mutation. Said to the user in COPY (`compilesNote`) —
 * a silent cap would lie by omission, exactly like the bin's 30 days.
 */
export const COMPILE_HISTORY_CAP = 50;

/**
 * Tombstones older than this are hard-deleted on launch — so this is also how
 * long a deleted thought stays recoverable in `Settings › Deleted` (SPEC v1.1
 * amdt 14), and the window a device can be offline without missing a delete.
 * 24h was enough when a tombstone's only job was outliving the undo toast; the
 * bin is a promise the app has to keep, so it is quoted to the user in COPY.
 * The sweep NEVER reaps a tombstone whose `node_sync` row is dirty (an un-pushed
 * delete must survive to reach the server — SPEC-SYNC §8); free-tier tombstones
 * have no `node_sync` row and sweep exactly as before.
 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function uuid4(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for JS engines without crypto.randomUUID — ids need uniqueness, not secrecy.
  let out = '';
  for (const ch of 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx') {
    if (ch === 'x') out += Math.floor(Math.random() * 16).toString(16);
    else if (ch === 'y') out += (8 + Math.floor(Math.random() * 4)).toString(16);
    else out += ch;
  }
  return out;
}
