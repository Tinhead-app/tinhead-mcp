/**
 * [core] SPEC-AGENT §11 — the RULES of a mutation, pure and platform-free.
 *
 * Every function here takes the current `NodeMap` and returns the node rows a
 * write would produce, or null/[] when the write is refused or is a no-op. It
 * persists nothing, sets no state, and knows about no store: `appStore` calls it
 * and then persists + sets state, `tinhead-mcp` calls it and then persists +
 * pushes. That is the whole point — the invariants live once.
 *
 * **What this file owns** (the review's corrected §11): which fields each verb
 * touches, the caps, and the restamp discipline. What it does NOT own, because
 * [model] already does: `restamp` itself, `normalizeDetails`, `appendSort`, the
 * depth arithmetic. And what it must never own, because they are the caller's:
 * DB-first ordering, dirty-marking, drafts, undo toasts, the pulse.
 *
 * **The `now` and the `id` are arguments, never generated here.** A pure module
 * that reads a clock is not pure, and the door and the app mint ids from
 * different places. Callers pass both.
 */

import {
  NodeMap,
  appendSort,
  childrenOf,
  depthOf,
  liveNode,
  normalizeDetails,
  preserveSealed,
  restamp,
  subtreeIds,
} from '../model/tree';
import { isSealed } from '../model/sealed';
import {
  ContextId,
  DEPTH_MAX,
  TITLE_MAX,
  ThoughtNode,
  WhenRepeat,
} from '../model/types';

export interface CreateInput {
  title: string;
  body: string;
  extras?: readonly string[];
  task?: boolean;
  pin?: boolean;
  whenDay?: string | null;
}

/**
 * §1.5, the CREATE half. `updateThought`'s `preserveSealed` stops a caller that
 * cannot read a covered field from destroying it; this stops the same caller
 * from AUTHORING one.
 *
 * A `priv1:` token is recognised by shape ([model] `isSealed`), so any caller
 * that can write free text can plant something the app will render as covered
 * and nothing will ever open — a field the user cannot read, cannot fix, and did
 * not create. `preserveSealed` already drops sealed-looking text on the update
 * path for exactly this reason; create had no equivalent and SPEC-AGENT §18
 * ticked the row anyway.
 *
 * **Off by default, and it has to be.** The app's own private capture passes a
 * genuine `sealField(...)` result straight through `createNode` → here, so an
 * unconditional filter would destroy every privately captured field at the
 * moment it was committed. Only a caller that cannot legitimately hold a seal
 * asks for this — today that is `tinhead-mcp`, and it always asks.
 */
export interface CreateOptions {
  dropSealed?: boolean;
}

/**
 * Build the node a capture would land. Null when there is nothing to commit or
 * the level is at `DEPTH_MAX`.
 *
 * The stamps are the interesting part and every one of them is a decision made
 * elsewhere and honoured here: a creation stamps ALL THREE conflict groups
 * (§7.2 — all of it is new), `editedAt` stays null (written is not edited —
 * the badge's whole premise), `accessedAt` is now (creation counts as a visit),
 * and a capture-time pin takes `now` so a fresh pin sorts last among pins,
 * exactly as `togglePin` would.
 */
export function createThought(
  nodes: NodeMap,
  context: ContextId,
  input: CreateInput,
  at: { now: number; id: string },
  opts: CreateOptions = {}
): ThoughtNode | null {
  const t = input.title.trim().slice(0, TITLE_MAX);
  // §1.5 — a caller that cannot read a seal cannot author one either.
  const body = opts.dropSealed && isSealed(input.body) ? '' : input.body;
  const extras = opts.dropSealed
    ? (input.extras ?? []).filter((e) => !isSealed(e))
    : (input.extras ?? []);
  // amdt 18: the detail is an ordered list — empties drop, the first survivor
  // is the body, so an extras-only capture still commits.
  const d = normalizeDetails(body, extras);
  if (!t && !d.body) return null;
  if (depthOf(nodes, context) >= DEPTH_MAX) return null;

  const { now, id } = at;
  return {
    id,
    parentId: context,
    contentAt: now,
    structureAt: now,
    flagsAt: now,
    title: t || null,
    body: d.body,
    extras: d.extras,
    suggestions: [],
    sort: appendSort(childrenOf(nodes, context)),
    createdAt: now,
    updatedAt: now,
    editedAt: null,
    deletedAt: null,
    accessedAt: now,
    pinnedAt: input.pin ? now : null,
    taskAt: input.task ? now : null,
    completedAt: null,
    archivedAt: null,
    whenDay: input.whenDay ?? null,
    whenTime: null,
    whenRepeat: null,
    whenAlert: null,
  };
}

export interface UpdatePatch {
  title?: string;
  body?: string;
  extras?: readonly string[];
}

export interface UpdateOptions {
  /**
   * **SPEC-AGENT §1.5, the write half.** Set by a caller that could not SEE the
   * thought's covered fields — which is every caller that read the detail
   * through `detailText`, i.e. every non-UI client. It re-inserts each sealed
   * field at the index it held, so a blind read-modify-write cannot destroy one.
   *
   * The app's edit form passes `false` and must keep doing so: it can see the
   * tokens, it holds them at their index deliberately, and it is the one caller
   * entitled to decide a covered field's fate (removing one is a thing a person
   * may do and an agent may not). The operation is idempotent for a caller that
   * already carries its tokens, so this is a floor, never a contradiction.
   */
  preserveSealed?: boolean;
}

/**
 * Apply an edit. Null when there is nothing to write — either the thought is
 * gone, the edit would empty it, or **the words did not actually change**.
 *
 * That last one is load-bearing and easy to lose: opening an edit form and
 * saving it untouched must not restamp the thought, or every read through the
 * card reports itself as a change, here and on every other device.
 */
export function updateThought(
  nodes: NodeMap,
  id: string,
  patch: UpdatePatch,
  now: number,
  opts: UpdateOptions = {}
): ThoughtNode | null {
  const existing = nodes.get(id);
  if (!existing) return null;

  const title =
    patch.title !== undefined ? patch.title.trim().slice(0, TITLE_MAX) || null : existing.title;

  let body = patch.body !== undefined ? patch.body : (existing.body ?? '');
  let extras: readonly string[] = patch.extras !== undefined ? patch.extras : existing.extras;
  if (opts.preserveSealed) {
    const kept = preserveSealed(existing, { body, extras });
    body = kept.body;
    extras = kept.extras;
  }
  const d = normalizeDetails(body, extras);
  if (title === null && d.body === null) return null; // never save an empty thought

  const same =
    title === existing.title &&
    d.body === existing.body &&
    d.extras.length === existing.extras.length &&
    d.extras.every((x, i) => x === existing.extras[i]);
  if (same) return null;

  return restamp(
    existing,
    {
      ...existing,
      title,
      body: d.body,
      extras: d.extras,
      updatedAt: now,
      // THE one write that means "the words changed" ([model] `editedAt`).
      // Pin, complete, task, archive, delete, restore and `setSuggestions` all
      // bump `updatedAt` and none of them is an edit.
      editedAt: now,
    },
    now
  );
}

/**
 * Tick or untick the box. Null when the thought is gone.
 *
 * A checked box is a done task whichever build checked it (amdt 17), so the
 * designation is backfilled BOTH ways — un-completing always reopens to an empty
 * box, even for rows completed before `taskAt` existed.
 */
export function completeThought(nodes: NodeMap, id: string, done: boolean, now: number): ThoughtNode | null {
  const node = liveNode(nodes, id);
  if (!node) return null;
  if (done === (node.completedAt !== null)) return null; // already there
  return restamp(
    node,
    { ...node, taskAt: node.taskAt ?? now, completedAt: done ? now : null, updatedAt: now },
    now
  );
}

/**
 * Designate a thought a task, or take the designation away. Null when there is
 * nothing to change.
 *
 * "Not a task" strips ALL task evidence — an entry cannot refuse the
 * designation and keep wearing the checked box.
 */
export function setTask(nodes: NodeMap, id: string, task: boolean, now: number): ThoughtNode | null {
  const n = liveNode(nodes, id);
  if (!n) return null;
  const changes = task ? n.taskAt === null : n.taskAt !== null || n.completedAt !== null;
  if (!changes) return null;
  return task
    ? restamp(n, { ...n, taskAt: now, updatedAt: now }, now)
    : restamp(n, { ...n, taskAt: null, completedAt: null, updatedAt: now }, now);
}

export interface WhenPatch {
  /** A day key (SPEC-CALENDAR §3), or null to clear the whole family. */
  day: string | null;
  /** Minutes since midnight, as [model] stores it — not a formatted string. */
  time?: number | null;
  repeat?: WhenRepeat | null;
}

/**
 * Set (or clear) a thought's when. Null when the thought is gone.
 *
 * Clearing the day clears the family — a time, a repeat or an alert without a
 * day is a claim about nothing (SPEC-CALENDAR §3).
 *
 * **`restamp` here is a FIX, not a transcription** (2026-07-31, found by this
 * extraction). `appStore.setWhen` built its updated node by hand and never
 * restamped, while `placeWeek` — the other writer of `whenDay` — did. The when
 * family is in the `flags` conflict group ([model] `CONFLICT_GROUPS`), so an
 * unstamped `flagsAt` reads to §7.2's merge as "un-mergeable, keep local": a
 * date set on one device could be silently reverted by another device's older
 * flags, and the user would never see a conflict, only a date that came back
 * wrong. One verb forgetting one stamp is exactly the failure a mutation core
 * exists to make impossible, and it was found the first time these rules were
 * written down in one place.
 */
export function setWhen(nodes: NodeMap, id: string, when: WhenPatch, now: number): ThoughtNode | null {
  const node = liveNode(nodes, id);
  if (!node) return null;
  const day = when.day;
  return restamp(
    node,
    {
      ...node,
      whenDay: day,
      whenTime: day === null ? null : when.time !== undefined ? when.time : node.whenTime,
      whenRepeat: day === null ? null : when.repeat !== undefined ? when.repeat : node.whenRepeat,
      whenAlert: day === null ? null : node.whenAlert,
      updatedAt: now, // the sync clock — a when is synced state (§7)
    },
    now
  );
}

/**
 * Soft-delete a thought and everything inside it — the one delete this app has.
 * Returns every stamped row (empty when the id is not live).
 *
 * They share one stamp on purpose: one operation, one undo, and the bin lists
 * one entry for the set.
 */
export function deleteThought(nodes: NodeMap, id: string, now: number): ThoughtNode[] {
  if (!liveNode(nodes, id)) return [];
  return stampDeleted(nodes, subtreeIds(nodes, id), now);
}

/**
 * Stamp an arbitrary set as deleted — the shape the app's own bin needs, where
 * one gesture can take a thought, a level's contents, or a whole selection.
 * `deleteThought` above is this over one subtree; there is one implementation
 * so the two can never disagree about what a delete writes.
 */
export function stampDeleted(nodes: NodeMap, ids: readonly string[], now: number): ThoughtNode[] {
  return ids
    .map((id) => nodes.get(id))
    .filter((n): n is ThoughtNode => !!n)
    .map((n) => restamp(n, { ...n, deletedAt: now, updatedAt: now }, now));
}
