import { DOTS, isSealed } from './sealed';
import { BODY_MAX, ContextId, DEPTH_MAX, ThoughtNode } from './types';

export type NodeMap = Map<string, ThoughtNode>;

const isLive = (n: ThoughtNode | undefined): n is ThoughtNode =>
  !!n && n.deletedAt === null;

const isVisible = (n: ThoughtNode | undefined): n is ThoughtNode =>
  isLive(n) && n.archivedAt === null;

const isDead = (n: ThoughtNode | undefined): n is ThoughtNode => !!n && n.deletedAt !== null;

/**
 * The level order (SPEC v1.1 amdt 4): pinned first in pin order, then active
 * thoughts by last visit, completed sunk to the bottom. Shared by the live list
 * and the deleted bin, so a deleted level reads exactly as it did in life.
 */
function byLevelOrder(a: ThoughtNode, b: ThoughtNode): number {
  const ga = levelGroup(a);
  const gb = levelGroup(b);
  if (ga !== gb) return ga - gb;
  if (ga === 0) return a.pinnedAt! - b.pinnedAt!; // first pinned stays first
  return withinGroup('recent', a, b);
}

/**
 * Visible children of a context: pinned first (in pin order), then active
 * thoughts by recency (last visited first), completed thoughts sink to the
 * bottom (also by recency). Archived subtrees are hidden entirely.
 */
export function childrenOf(nodes: NodeMap, context: ContextId): ThoughtNode[] {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (n.parentId === context && isVisible(n)) out.push(n);
  }
  out.sort(byLevelOrder);
  return out;
}

// ---------------------------------------------------------------------------
// Per-list sort modes. A level remembers one of three orders (settings key
// `listSortKey`, mirrored via [sync] `listSort`). The default `recent` IS
// `childrenOf` above; the other two re-order the active middle (and the
// completed tail) while pins keep leading and completed keep sinking — the same
// group split `byLevelOrder` uses, so the two never drift.
// ---------------------------------------------------------------------------

export type SortMode = 'recent' | 'created' | 'alpha';
export const SORT_MODES: readonly SortMode[] = ['recent', 'created', 'alpha'];
// Order of creation is the DEFAULT (amdt 19) — the most useful resting order: a
// list reads top-to-bottom in the sequence it was built, and a grown list keeps
// the model's own order. A level with no `listSort` setting sorts this way.
export const DEFAULT_SORT: SortMode = 'created';

/** Coerce a stored / wire value to a known mode; anything else reads as the default. */
export function parseSortMode(raw: string | null | undefined): SortMode {
  return raw === 'recent' || raw === 'created' || raw === 'alpha' ? raw : DEFAULT_SORT;
}

/** Cycle recent → created → alpha → recent — the sort control's one action. */
export function nextSortMode(m: SortMode): SortMode {
  return SORT_MODES[(SORT_MODES.indexOf(m) + 1) % SORT_MODES.length];
}

/** Pinned lead (0), active next (1), completed sink (2) — the grouping every mode keeps. */
function levelGroup(n: ThoughtNode): number {
  return n.pinnedAt !== null ? 0 : n.completedAt !== null ? 2 : 1;
}

/**
 * Order WITHIN one group for a mode (pins are never reordered by it — see
 * `levelComparator`). `created` is oldest-first with a stable id tiebreak;
 * `alpha` is by the shown title (real, else the body-derived pseudo-title),
 * case-insensitive; `recent` is last-visited-first, exactly as `byLevelOrder`.
 */
function withinGroup(mode: SortMode, a: ThoughtNode, b: ThoughtNode): number {
  switch (mode) {
    case 'created':
      // Authored order, NOT wall-clock. A grown/seeded batch stamps `createdAt`
      // DESCENDING by index (`buildSeedNodes`: child 0 is newest, so recency shows
      // the model's first item on top) while `sort` ASCENDS by index — so `sort` is
      // the honest creation sequence, and ordering by `createdAt` here would read a
      // model's ordered list backwards. `createdAt` then `id` only break ties for
      // legacy/loose rows where `sort` collides (typed thoughts have a real clock).
      return a.sort - b.sort || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    case 'alpha':
      return (
        displayTitle(a).toLowerCase().localeCompare(displayTitle(b).toLowerCase()) ||
        a.createdAt - b.createdAt
      );
    default:
      return b.accessedAt - a.accessedAt || b.createdAt - a.createdAt;
  }
}

/** The comparator `orderedChildren` sorts by for the non-default modes. */
function levelComparator(mode: SortMode) {
  return (a: ThoughtNode, b: ThoughtNode): number => {
    const ga = levelGroup(a);
    const gb = levelGroup(b);
    if (ga !== gb) return ga - gb;
    if (ga === 0) return a.pinnedAt! - b.pinnedAt!; // pins keep their manual order in every mode
    return withinGroup(mode, a, b);
  };
}

/**
 * Visible children of a context, ordered for the list view under its chosen sort
 * mode. `recent` returns exactly `childrenOf` (the default path is left
 * untouched); `created` / `alpha` re-order the active + completed groups while
 * pins still lead in pin order. Only the LevelList reads this — search, compile,
 * stats and the bin keep the recency order via `childrenOf` / `byLevelOrder`.
 */
export function orderedChildren(nodes: NodeMap, context: ContextId, mode: SortMode): ThoughtNode[] {
  if (mode === 'recent') return childrenOf(nodes, context);
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (n.parentId === context && isVisible(n)) out.push(n);
  }
  out.sort(levelComparator(mode));
  return out;
}

/**
 * SPEC-SYNC §7.2 — the three conflict groups, as the fields each one owns. One authority,
 * read by BOTH `restamp` (which derives the stamps) and `mergeByGroup` (which spends
 * them), so a field can never be stamped by one group and merged by another.
 */
export const CONFLICT_GROUPS = {
  content: ['title', 'body', 'extras', 'suggestions', 'editedAt'],
  structure: ['parentId', 'sort'],
  flags: [
    'pinnedAt',
    'taskAt',
    'completedAt',
    'archivedAt',
    'whenDay',
    'whenTime',
    'whenRepeat',
    'whenAlert',
  ],
} as const satisfies Record<string, readonly (keyof ThoughtNode)[]>;

type ConflictGroup = keyof typeof CONFLICT_GROUPS;
const GROUP_STAMP: Record<ConflictGroup, 'contentAt' | 'structureAt' | 'flagsAt'> = {
  content: 'contentAt',
  structure: 'structureAt',
  flags: 'flagsAt',
};

function sameField(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * SPEC-SYNC §7.2 — stamp whichever conflict groups actually CHANGED between `prev` and
 * `next`, at `now`. Derived by diffing rather than declared by the caller, deliberately:
 * sixteen mutation sites in [store] would otherwise each have to know which group they
 * belong to, and the one that got it wrong would merge on a stale clock and lose work
 * silently. A site that forgets to call this at all leaves the stamps as they were, which
 * the merge reads as un-mergeable and resolves the old way — degraded, never wrong.
 *
 * `prev` undefined = a creation: every group is stamped, because all of it is new.
 */
export function restamp(prev: ThoughtNode | undefined, next: ThoughtNode, now: number): ThoughtNode {
  const out = { ...next };
  for (const g of Object.keys(CONFLICT_GROUPS) as ConflictGroup[]) {
    const changed =
      !prev || CONFLICT_GROUPS[g].some((f) => !sameField(prev[f], next[f]));
    if (changed) out[GROUP_STAMP[g]] = now;
  }
  return out;
}

/**
 * SPEC-SYNC §7.2 — resolve a live/live conflict per GROUP instead of per node.
 *
 * `local` is this device's version, `remote` the peer's. For each group the later stamp
 * wins; a group where either side is UNSTAMPED (a pre-§7.2 build, or a site that did not
 * restamp) falls back to keeping local, which is exactly the whole-node rule this
 * replaces — so a mixed fleet degrades gracefully instead of merging on a fiction. Ties
 * keep local too: the tie-break has to be deterministic and "the device you are holding
 * wins" is the one a person can predict.
 *
 * Returns local unchanged when nothing was taken, so callers can skip a write.
 */
export function mergeByGroup(local: ThoughtNode, remote: ThoughtNode): ThoughtNode {
  let out = local;
  let took = false;
  for (const g of Object.keys(CONFLICT_GROUPS) as ConflictGroup[]) {
    const stamp = GROUP_STAMP[g];
    const mine = local[stamp];
    const theirs = remote[stamp];
    if (mine === null || theirs === null || theirs <= mine) continue;
    if (!took) {
      out = { ...local };
      took = true;
    }
    for (const f of CONFLICT_GROUPS[g]) {
      (out as unknown as Record<string, unknown>)[f] = remote[f];
    }
    out[stamp] = theirs;
  }
  // The node clock follows whatever was taken, so the merged result out-dates both
  // parents on the wire and cannot be undone by either side re-pushing its own.
  if (took) out.updatedAt = Math.max(local.updatedAt, remote.updatedAt);
  return out;
}

/**
 * Live thoughts whose parent is dead or missing — the leftovers of the
 * cross-device race (2026-07-29): one device moves, creates, or restores a
 * thought INTO a branch while another deletes that branch. The delete stamps
 * the subtree as the deleting device knew it, so the late arrival converges
 * live under a dead parent — rendered in no level (a dead parent's level is
 * unreachable), found only by search, and stranded for good once the 30-day
 * sweep hard-deletes the parent. This is the detector for the invariant the
 * bin leans on (see the Gotcha: "a live thought's ancestors are always live").
 *
 * Only the TOPMOST such node qualifies by construction — an orphan's own live
 * children have a live parent — so re-homing what this returns repairs each
 * whole subtree by reference. Deterministic order (createdAt, then id) keeps
 * the repair's root appends stable. Consumer: [store] `sweepOrphans`.
 *
 * A parent that is MISSING from the map is a different claim from one that is
 * dead, and by default this does not make it (2026-07-30). The map is whatever
 * this device holds *right now*: a peer pushes node rows one at a time and
 * advances the manifest last, so a flush cut by sleep, signal or backgrounding
 * routinely leaves children on the server whose parent has not been written
 * yet. Sweeping on `!parent` re-homes those to the top level, stamps the repair
 * with a winning `updatedAt`, and publishes it — a thought vanishing out of the
 * branch someone is typing into, with nothing deleted anywhere. (The push path
 * learned the same lesson one day earlier: an id absent from the map is an
 * adoption gap, never a deletion.) So the missing case is opt-in, and the
 * caller must supply EVIDENCE that the parent is gone rather than late —
 * [sync]'s reconcile seat passes the verified manifest, the one authority on
 * what the account actually holds.
 */
export function orphanedRoots(
  nodes: NodeMap,
  /** Evidence that a parent absent from `nodes` is gone for good, not merely late. */
  missingParentIsGone?: (parentId: string) => boolean
): ThoughtNode[] {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (!isLive(n) || n.parentId === null) continue;
    const parent = nodes.get(n.parentId);
    if (parent ? parent.deletedAt !== null : missingParentIsGone?.(n.parentId)) out.push(n);
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

/**
 * The most-recently-visited thoughts across the WHOLE tree (SPEC v1.1 amdt 19) —
 * visible nodes by `accessedAt` (last visit; creation counts as one), newest
 * first, capped at `limit`. Backs the top bar's "latest" jump list; context-blind
 * (the sheet marks where you are), so it can include the current context.
 */
export function recentlyVisited(nodes: NodeMap, limit = 20): ThoughtNode[] {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (isVisible(n)) out.push(n);
  }
  out.sort((a, b) => b.accessedAt - a.accessedAt || b.createdAt - a.createdAt);
  return out.slice(0, limit);
}

/** Live-but-archived nodes (the archive shelf), most recently archived first. */
export function archivedNodes(nodes: NodeMap): ThoughtNode[] {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (isLive(n) && n.archivedAt !== null) out.push(n);
  }
  out.sort((a, b) => b.archivedAt! - a.archivedAt!);
  return out;
}

/** True when the node or any ancestor is archived (hidden from search). */
export function isUnderArchive(nodes: NodeMap, id: string): boolean {
  let cur = nodes.get(id);
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (cur.archivedAt !== null) return true;
    cur = cur.parentId === null ? undefined : nodes.get(cur.parentId);
  }
  return false;
}

export function liveNode(nodes: NodeMap, id: string | null): ThoughtNode | null {
  if (id === null) return null;
  const n = nodes.get(id);
  return isLive(n) ? n : null;
}

/** Path from a top-level node down to `id`, excluding root. Empty if id is null/missing. */
export function pathTo(nodes: NodeMap, id: ContextId): ThoughtNode[] {
  const path: ThoughtNode[] = [];
  let cur = id === null ? null : nodes.get(id);
  let guard = 0;
  while (cur && guard++ < 1000) {
    path.unshift(cur);
    cur = cur.parentId === null ? undefined : nodes.get(cur.parentId);
  }
  return path;
}

export function depthOf(nodes: NodeMap, id: ContextId): number {
  return pathTo(nodes, id).length;
}

/** Live children INCLUDING archived ones — structural walks (delete/archive). */
function liveChildrenOf(nodes: NodeMap, context: ContextId): ThoughtNode[] {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (n.parentId === context && isLive(n)) out.push(n);
  }
  return out;
}

/**
 * All live ids in the subtree rooted at `id` (inclusive), archived included —
 * deleting or archiving a parent must take its whole subtree with it.
 */
export function subtreeIds(nodes: NodeMap, id: string): string[] {
  const out: string[] = [];
  const walk = (nid: string) => {
    if (out.length > 100_000) return; // recursion guard
    out.push(nid);
    for (const c of liveChildrenOf(nodes, nid)) walk(c.id);
  };
  if (liveNode(nodes, id)) walk(id);
  return out;
}

/**
 * When this thought last changed — its own `editedAt`, plus, for everything in
 * its visible subtree, both edits AND arrivals. `null` = nothing has happened
 * here since it was written.
 *
 * **A child being added counts.** Putting a thought inside another changes what
 * that thought IS, even though nobody rewrote a word of it — a list you added
 * to has changed, and it is the commonest way a branch changes at all. So a
 * descendant contributes its `createdAt` as well as its `editedAt`, and a
 * thought's OWN `createdAt` never counts for itself: being written is not being
 * changed, which is what keeps "never edited" answerable.
 *
 * Note what still does not count: everything that is not words or contents —
 * pinning, completing, designating, archiving. That is the whole point of the
 * separate field ([model] `editedAt`). Nor does REMOVING a child: a deleted
 * thought leaves no stamp behind, so a branch you empty falls back to whatever
 * else is in it rather than reporting the deletion.
 */
export function lastEdited(nodes: NodeMap, id: string): number | null {
  const n = nodes.get(id);
  if (!n) return null;
  let max = n.editedAt;
  const later = (t: number | null) => {
    if (t !== null && (max === null || t > max)) max = t;
  };
  for (const c of childrenOf(nodes, id)) {
    later(c.createdAt); // it arriving IS a change to this thought
    later(lastEdited(nodes, c.id));
  }
  return max;
}

/**
 * How long an edit stays worth saying on a ROW. Past it the badge goes away
 * entirely rather than ageing into `2wk`/`3mo`: the badge answers "has this
 * changed lately?", and everything older than a few days answers no. It also
 * means the badge only ever reads `now` · `Nm` · `Nh` · `1d` · `2d` · `3d`.
 */
export const EDIT_BADGE_MAX_AGE = 3 * 24 * 60 * 60 * 1000;

/**
 * The row badge, or `null` for no badge at all — never edited, or edited longer
 * ago than `EDIT_BADGE_MAX_AGE`. The expanded view deliberately does NOT use
 * this: there you asked, so the age is never withheld ([components] `LastEdited`).
 */
export function editedBadge(edited: number | null, now: number): string | null {
  if (edited === null) return null;
  if (now - edited > EDIT_BADGE_MAX_AGE) return null;
  return timeAgo(edited, now);
}

export interface LevelRowStats {
  /** Visible thoughts inside, ALL depths (SPEC v1.1 amdt 17 — the badge total). */
  total: number;
  /** Open tasks inside, all depths: `taskAt` set, `completedAt` null (amdt 17). */
  open: number;
  /** Latest edit here or anywhere inside (`lastEdited`); null = never edited. */
  edited: number | null;
}

/** An open task: designated, not yet checked off (SPEC v1.1 amdt 17). */
export function isOpenTask(n: ThoughtNode): boolean {
  return n.taskAt !== null && n.completedAt === null;
}

/**
 * Per-row stats for one level, computed in a single pass over the node map —
 * per-row recursive walks made large lists O(N × subtree) and visibly slow.
 */
export function levelStats(nodes: NodeMap, ids: string[]): Map<string, LevelRowStats> {
  const byParent = new Map<string | null, ThoughtNode[]>();
  for (const n of nodes.values()) {
    if (!isVisible(n)) continue;
    const list = byParent.get(n.parentId);
    if (list) list.push(n);
    else byParent.set(n.parentId, [n]);
  }
  // `lastEdited`, memoized over the same single pass — a per-row recursive walk
  // made large lists O(N × subtree) and visibly slow.
  const editedMemo = new Map<string, number | null>();
  const edited = (id: string): number | null => {
    const memo = editedMemo.get(id);
    if (memo !== undefined) return memo;
    const n = nodes.get(id);
    if (!n) return null;
    let max = n.editedAt;
    const later = (t: number | null) => {
      if (t !== null && (max === null || t > max)) max = t;
    };
    for (const c of byParent.get(id) ?? []) {
      // A child ARRIVING changes its parent; a thought's own creation never
      // changes itself. The asymmetry is what makes this memoizable — the
      // `createdAt` is contributed by the parent, never inside the child's
      // own answer, so one cached value per node serves every reader.
      later(c.createdAt);
      later(edited(c.id));
    }
    editedMemo.set(id, max);
    return max;
  };
  // Whole-subtree counts, memoized the same way: what's inside (all depths,
  // visible only) and how much of it is still to do.
  const countMemo = new Map<string, { total: number; open: number }>();
  const counts = (id: string): { total: number; open: number } => {
    const memo = countMemo.get(id);
    if (memo !== undefined) return memo;
    let total = 0;
    let open = 0;
    for (const c of byParent.get(id) ?? []) {
      const inner = counts(c.id);
      total += 1 + inner.total;
      open += (isOpenTask(c) ? 1 : 0) + inner.open;
    }
    const out = { total, open };
    countMemo.set(id, out);
    return out;
  };
  const out = new Map<string, LevelRowStats>();
  for (const id of ids) {
    out.set(id, { ...counts(id), edited: edited(id) });
  }
  return out;
}

/** Minimalist time-ago: now · 5m · 3h · 2d · 1wk · 4mo · 1yr. */
export function timeAgo(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (d < 30) return `${w}wk`;
  const mo = Math.floor(d / 30);
  if (d < 365) return `${mo}mo`;
  return `${Math.floor(d / 365)}yr`;
}

export interface SubtreeStats {
  thoughts: number;
  levels: number;
}

/** `«n» thoughts · «d» levels` — n includes the target; a lone node is 1/1. */
export function subtreeStats(nodes: NodeMap, id: string): SubtreeStats {
  let thoughts = 0;
  let levels = 0;
  const walk = (nid: string, depth: number) => {
    thoughts += 1;
    if (depth > levels) levels = depth;
    for (const c of childrenOf(nodes, nid)) walk(c.id, depth + 1);
  };
  if (liveNode(nodes, id)) walk(id, 1);
  return { thoughts, levels };
}

/**
 * "The thoughts inside it" — every live id under `id`, excluding `id` itself.
 * The set a children-only delete takes, and the count the confirm sheet shows.
 */
export function descendantIds(nodes: NodeMap, id: string): string[] {
  return subtreeIds(nodes, id).slice(1); // subtreeIds always leads with `id`
}

/**
 * How deep the live subtree at `id` runs — a lone thought is 1, a thought with
 * one level of children 2, and so on. Archived branches count: a move takes
 * them along, so the depth gate must see them. 0 for a dead or missing id.
 */
export function subtreeHeight(nodes: NodeMap, id: string): number {
  let height = 0;
  const walk = (nid: string, depth: number) => {
    if (depth > 1000) return; // recursion guard, as elsewhere
    if (depth > height) height = depth;
    for (const c of liveChildrenOf(nodes, nid)) walk(c.id, depth + 1);
  };
  if (liveNode(nodes, id)) walk(id, 1);
  return height;
}

export type MoveRefusal = 'inside' | 'here' | 'deep' | 'archived';

/**
 * C1 / SPEC amdt 29 — may this set of thoughts re-home under `dest`? `null` =
 * yes. The carry bar reads it to grey `Move here` (and say why on a tap);
 * `moveNodes` re-checks it as the gate. The reasons, checked in rank order:
 *
 *  - `inside`: dest is a carried thought, or sits inside one — a thought
 *    cannot move into itself. Walked UP from dest (O(depth)), not down the
 *    subtrees.
 *  - `here`: every carried thought already lives at dest — nothing would move.
 *  - `archived`: dest rests in an archived branch (its own or an ancestor's) —
 *    landing there would make a visible thought invisible, and the archive's
 *    one verb is restore.
 *  - `deep`: the tallest carried subtree would put its deepest thought past
 *    `DEPTH_MAX`.
 *
 * Dead/missing carried ids are ignored (the set can shrink under a carry —
 * a delete on this device, a sync from another); an all-dead set refuses
 * nothing, because the caller cancels the carry instead. Dest must be the
 * root or a live thought — `moveNodes` guards that precondition itself.
 */
export function moveRefusal(nodes: NodeMap, ids: string[], dest: ContextId): MoveRefusal | null {
  const roots = ids
    .map((id) => liveNode(nodes, id))
    .filter((n): n is ThoughtNode => n !== null);
  if (roots.length === 0) return null;
  const carried = new Set(roots.map((n) => n.id));
  if (dest !== null && pathTo(nodes, dest).some((n) => carried.has(n.id))) return 'inside';
  if (roots.every((n) => n.parentId === dest)) return 'here';
  if (dest !== null && isUnderArchive(nodes, dest)) return 'archived';
  let tallest = 0;
  for (const n of roots) tallest = Math.max(tallest, subtreeHeight(nodes, n.id));
  if (depthOf(nodes, dest) + tallest > DEPTH_MAX) return 'deep';
  return null;
}

/**
 * One multi-select operation's reach (SPEC v1.1 amdt 16): the union of the
 * selected live subtrees, deduped — a selected thought sitting inside another
 * selected thought's subtree counts once. `inside` is what the union holds
 * beyond the selected thoughts themselves: the count the delete confirm names,
 * and zero exactly when the selection is all leaves (no confirm needed).
 */
export function selectionSubtree(
  nodes: NodeMap,
  ids: string[]
): { unionIds: string[]; inside: number } {
  const roots = new Set<string>();
  for (const id of ids) {
    if (liveNode(nodes, id)) roots.add(id);
  }
  const union = new Set<string>();
  for (const id of roots) {
    for (const sid of subtreeIds(nodes, id)) union.add(sid);
  }
  return { unionIds: [...union], inside: union.size - roots.size };
}

// ---------------------------------------------------------------------------
// The deleted bin (SPEC v1.1 amdt 14). Deleted thoughts keep their shape — the
// same parentId, the same order — so the bin can be browsed like the live tree.
// ---------------------------------------------------------------------------

/**
 * One entry per DELETE — the head of each thing the user threw away, newest
 * first (the bin is a regret queue, not an archive). A thought that went down
 * with its parent (same stamp) isn't an entry: it's inside that parent's
 * deleted tree and comes back with it. A thought deleted SEPARATELY from a
 * parent that later died too is still its own entry, because it was its own
 * decision and takes its own restore — the bin shows it with its parent struck
 * through, since that parent is now in here as well.
 *
 * The rows therefore line up 1:1 with `deleteOpIds` / `pendingUndo`: an entry
 * is exactly one Undo that got away.
 */
export function deletedRoots(nodes: NodeMap): ThoughtNode[] {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (!isDead(n)) continue;
    const parent = n.parentId === null ? undefined : nodes.get(n.parentId);
    if (isDead(parent) && parent.deletedAt === n.deletedAt) continue;
    out.push(n);
  }
  out.sort((a, b) => b.deletedAt! - a.deletedAt!);
  return out;
}

/** Deleted children of a deleted thought, ordered as they were in life. */
export function deletedChildrenOf(nodes: NodeMap, context: string): ThoughtNode[] {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (n.parentId === context && isDead(n)) out.push(n);
  }
  out.sort(byLevelOrder);
  return out;
}

/**
 * Deleted thoughts inside a bin entry, all depths — the bin row's badge total,
 * so its count pill means the same thing a live row's does (amdt 17: the badge
 * counts the whole inside, not the first level).
 */
export function deletedSubtreeCount(nodes: NodeMap, id: string): number {
  let total = 0;
  const walk = (nid: string, depth: number) => {
    if (depth > 1000) return; // recursion guard, as elsewhere
    for (const c of deletedChildrenOf(nodes, nid)) {
      total += 1;
      walk(c.id, depth + 1);
    }
  };
  walk(id, 0);
  return total;
}

/**
 * The ids ONE delete removed: `id` plus the descendants stamped in the same
 * operation (`deleteSubtree` stamps a whole subtree with one `Date.now()`).
 * A thought deleted separately, earlier, carries a different stamp and stays
 * deleted — restoring a parent must not silently resurrect it. This is exactly
 * the set `pendingUndo` holds, which is why one Undo and one Restore agree.
 */
export function deleteOpIds(nodes: NodeMap, id: string): string[] {
  const root = nodes.get(id);
  if (!isDead(root)) return [];
  const stamp = root.deletedAt;
  const byParent = new Map<string | null, ThoughtNode[]>();
  for (const n of nodes.values()) {
    if (!isDead(n) || n.deletedAt !== stamp) continue;
    const list = byParent.get(n.parentId);
    if (list) list.push(n);
    else byParent.set(n.parentId, [n]);
  }
  const out: string[] = [];
  const walk = (nid: string) => {
    if (out.length > 100_000) return; // recursion guard
    out.push(nid);
    for (const c of byParent.get(nid) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

export interface OriginCrumb {
  id: string;
  title: string;
  /** False when this ancestor is itself deleted — the bin strikes it through. */
  live: boolean;
}

export interface Origin {
  /** Ancestors root-first, root-exclusive. Empty = the thought was top-level. */
  crumbs: OriginCrumb[];
  /** True when an ancestor is hard-gone, so the chain never reaches root. */
  broken: boolean;
  /** The original parent still exists and is live, so Restore needs no target. */
  intact: boolean;
}

/**
 * Where a deleted thought came from. `pathTo` can't answer this: it walks live
 * or dead alike and stops silently at a missing id, so it can't tell "top-level"
 * from "its parent was swept". Only the DIRECT parent decides `intact` — a live
 * thought's ancestors are always live too (a delete stamps the whole subtree,
 * and a restore only ever lands under a live parent), so a live parent implies
 * a live chain all the way to root.
 */
export function originOf(nodes: NodeMap, node: ThoughtNode): Origin {
  const crumbs: OriginCrumb[] = [];
  const intact = node.parentId === null || isLive(nodes.get(node.parentId));
  let pid = node.parentId;
  let guard = 0;
  while (pid !== null && guard++ < 1000) {
    const p = nodes.get(pid);
    if (!p) return { crumbs, broken: true, intact };
    crumbs.unshift({ id: p.id, title: displayTitle(p), live: p.deletedAt === null });
    pid = p.parentId;
  }
  return { crumbs, broken: false, intact };
}

/**
 * Another live sibling already wears this thought's title — so a restore has
 * just produced two identical-looking rows and the restored one needs a mark
 * (SPEC v1.1 amdt 14). Duplicate titles are legal everywhere (SPEC §4); this
 * only asks whether THIS one is currently ambiguous.
 */
export function hasLiveTwin(nodes: NodeMap, id: string): boolean {
  const node = nodes.get(id);
  if (!isVisible(node)) return false;
  const title = displayTitle(node);
  for (const n of nodes.values()) {
    if (n.id !== id && n.parentId === node.parentId && isVisible(n) && displayTitle(n) === title) {
      return true;
    }
  }
  return false;
}

export function countDescendants(nodes: NodeMap, id: string): number {
  return descendantIds(nodes, id).length;
}

/** Display title: real title, else first ~60 chars of body as a pseudo-title. */
export function displayTitle(n: Pick<ThoughtNode, 'title' | 'body'>): string {
  const t = (n.title ?? '').trim();
  if (t) return t;
  // SPEC-PRIVATE §4 — a covered body is never a label. The write surfaces will
  // not let the ONLY identifying text be covered (a title is asked for first),
  // so this is the defensive half: a row that arrived this way from the wire, or
  // from a build before that rule, shows dots rather than a `priv1:` token.
  if (isSealed(n.body)) return DOTS;
  const b = (n.body ?? '').trim().replace(/\s+/g, ' ');
  if (b.length <= 60) return b;
  return b.slice(0, 60).trimEnd() + '…';
}

/** True when a node uses a pseudo-title (render italic). */
export function hasPseudoTitle(n: Pick<ThoughtNode, 'title'>): boolean {
  return !(n.title ?? '').trim();
}

/**
 * The text that HEADS a list row (`NodeRow`). A titled thought heads with its
 * title; a title-less thought heads with its body IN FULL — not `displayTitle`'s
 * 60-char pseudo-title, because the body is the whole thought and the row clamps
 * the heading to its own line budget (`NodeRow` `PREVIEW_MAX_LINES`) rather than
 * a single-label ellipsis. The 60-char pseudo-title stays right for single-label
 * surfaces (search, crumbs, a11y) that have room for only one line; the list
 * heading, which has room for several, shows the whole body.
 */
export function rowHeading(n: Pick<ThoughtNode, 'title' | 'body'>): string {
  const title = (n.title ?? '').trim();
  if (title) return title;
  return isSealed(n.body) ? DOTS : (n.body ?? ''); // SPEC-PRIVATE §4, as displayTitle
}

/**
 * Next `sort` for a thought appended to a sibling list — one past the current
 * MAX, so `sort` stays a monotonic authored-order ordinal (the `created` sort
 * mode reads it; grow's `buildSeedNodes` extends it a batch at a time). Max, not
 * the last element: callers pass `childrenOf`, which hands siblings back in
 * RECENCY order whose last entry is the OLDEST — usually the lowest `sort` — so
 * `last + 1` collided on nearly every append and left `sort` near-useless as a
 * sequence. Empty list → 1, as before.
 */
export function appendSort(siblings: ThoughtNode[]): number {
  let max = 0;
  for (const s of siblings) if (s.sort > max) max = s.sort;
  return max + 1;
}

/**
 * Fractional value for inserting at `index` among `values` (ascending, already
 * excluding the moved entry): before-first extends down, after-last extends up,
 * anywhere else is the midpoint. The one piece of ordering math `sortForInsert`
 * and `arrangePlacement` share — halving can exhaust float precision or meet
 * equal neighbours, so callers must check the answer actually SITS between its
 * neighbours and renumber when it doesn't (see `arrangePlacement`).
 */
function insertBetween(values: number[], index: number): number {
  if (values.length === 0) return 1;
  if (index <= 0) return values[0] - 1;
  if (index >= values.length) return values[values.length - 1] + 1;
  return (values[index - 1] + values[index]) / 2;
}

/**
 * Fractional sort value for dropping at `targetIndex` within `siblings`
 * (siblings given in current sort order, already excluding the moved node).
 */
export function sortForInsert(siblings: ThoughtNode[], targetIndex: number): number {
  return insertBetween(siblings.map((s) => s.sort), targetIndex);
}

/** One row's new ordering value — an arrange placement's write plan entry. */
export interface ArrangeUpdate {
  id: string;
  sort?: number;
  pinnedAt?: number;
}

/**
 * SPEC amdt 30 — one arrange placement: the lifted row takes the tapped row's
 * place. Pure planning, no writes: returns the minimal set of `{id, sort?}` /
 * `{id, pinnedAt?}` updates (usually one), or `null` when there is nothing to
 * do (unknown/dead ids, another level, alone in its lane, or already exactly
 * where the tap asked).
 *
 * The DISPLACEMENT rule, which is how a drag reads: moving down lands after the
 * target, moving up lands before it — so the lifted row occupies the target's
 * visual slot and the target shifts toward where the lifted one came from.
 * Tapping the first row means "make it first", the last row "make it last".
 *
 * Lanes: pins lead, active follow, completed sink (`levelGroup`), in arrange
 * mode as in every mode — so a placement stays within the lifted row's own
 * lane, and a tap on another lane CLAMPS to this lane's nearest end (lifting
 * an active row onto a pin means "as high as it goes", which is the top of the
 * active lane). Within the pin lane the order IS `pinnedAt` (asc), so that is
 * the field written there — arranging pins is how pin order finally becomes
 * editable — and `sort` is written in the other two.
 *
 * When the fractional value can't sit strictly between its neighbours (equal
 * values from a batch write, or float halving exhausted), the whole lane
 * renumbers in its new order instead: `sort` as 1..n (the `appendSort`
 * convention), `pinnedAt` as its own min + i (still a plausible past stamp, so
 * a future pin — stamped `Date.now()` — keeps landing last).
 */
export function arrangePlacement(
  nodes: NodeMap,
  context: ContextId,
  liftedId: string,
  targetId: string
): ArrangeUpdate[] | null {
  if (liftedId === targetId) return null;
  const lifted = nodes.get(liftedId);
  const target = nodes.get(targetId);
  if (!isVisible(lifted) || !isVisible(target)) return null;
  if (lifted.parentId !== context || target.parentId !== context) return null;

  const lane = levelGroup(lifted);
  const laneRows = orderedChildren(nodes, context, 'created').filter(
    (n) => levelGroup(n) === lane
  );
  const rest = laneRows.filter((n) => n.id !== liftedId);
  if (rest.length === 0) return null; // alone in its lane — nowhere else to be

  const targetLane = levelGroup(target);
  let index: number;
  if (targetLane < lane) {
    index = 0; // a higher lane: as high as this lane goes
  } else if (targetLane > lane) {
    index = rest.length; // a lower lane: as low as this lane goes
  } else {
    const from = laneRows.findIndex((n) => n.id === liftedId);
    const to = laneRows.findIndex((n) => n.id === targetId);
    const ti = rest.findIndex((n) => n.id === targetId);
    index = from < to ? ti + 1 : ti; // displacement: take the target's slot
  }
  // Inserting back at its own position is the one placement that changes nothing.
  if (index === laneRows.findIndex((n) => n.id === liftedId)) return null;

  const field: 'sort' | 'pinnedAt' = lane === 0 ? 'pinnedAt' : 'sort';
  // Pins always carry a stamp (levelGroup 0 ⇔ pinnedAt set), so the `?? 0`
  // never actually answers; it is here for the type alone.
  const valueOf = (n: ThoughtNode) => (field === 'sort' ? n.sort : n.pinnedAt ?? 0);
  const values = rest.map(valueOf);
  const v = insertBetween(values, index);
  const sits =
    (index === 0 || v > values[index - 1]) && (index === rest.length || v < values[index]);
  if (sits) return [{ id: liftedId, [field]: v }];

  // Renumber the lane in its new order — the fallback for equal or exhausted
  // values. `sort` restarts at 1 (lanes never compare against each other, and
  // `appendSort` takes the level-wide max, so future appends still land after);
  // `pinnedAt` keeps its own earliest stamp as the base so the lane stays a
  // plausible past and future pins keep landing last.
  const newLane = [...rest.slice(0, index), lifted, ...rest.slice(index)];
  const base = field === 'sort' ? 1 : Math.min(...newLane.map(valueOf));
  return newLane
    .map((n, i) => ({ id: n.id, [field]: base + i }) as ArrangeUpdate)
    .filter((u) => {
      const n = nodes.get(u.id)!;
      return (field === 'sort' ? n.sort : n.pinnedAt) !== (field === 'sort' ? u.sort : u.pinnedAt);
    });
}

export interface SearchHit {
  node: ThoughtNode;
  titleHit: boolean;
}

/** Case-insensitive substring search over live, un-archived nodes; title hits rank first. */
export function searchNodes(nodes: NodeMap, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const n of nodes.values()) {
    if (!isLive(n)) continue;
    if (isUnderArchive(nodes, n.id)) continue;
    const inTitle = (n.title ?? '').toLowerCase().includes(q);
    // SPEC-PRIVATE §6 — a covered field is not matched. Its stored form is a
    // `priv1:` token, so it could never match the words inside it anyway; the
    // skip is what stops a search for `priv1` listing every covered thought,
    // and what makes the rule true rather than incidentally true.
    const inBody =
      (!isSealed(n.body) && (n.body ?? '').toLowerCase().includes(q)) ||
      n.extras.some((x) => !isSealed(x) && x.toLowerCase().includes(q));
    if (inTitle || inBody) hits.push({ node: n, titleHit: inTitle });
  }
  hits.sort(
    (a, b) =>
      Number(b.titleHit) - Number(a.titleHit) || b.node.updatedAt - a.node.updatedAt
  );
  return hits;
}

/** At least one field non-empty after trim — title, detail, or any extra (amdt 18). */
export function isCommittable(title: string, body: string, extras: readonly string[] = []): boolean {
  return (
    title.trim().length > 0 ||
    body.trim().length > 0 ||
    extras.some((x) => x.trim().length > 0)
  );
}

/**
 * Commit-time shape for the detail fields (SPEC v1.1 amdt 18): the detail is an
 * ordered list, `body` is its first entry. Each field is trimmed and capped,
 * empties drop out, and the first survivor becomes the body — so clearing the
 * detail in an edit promotes the first extra rather than orphaning it, and
 * `extras.length > 0` always implies `body !== null`. Every node write
 * (`createNode`, `updateNode`, preset seeding) funnels through this.
 */
export function normalizeDetails(
  body: string,
  extras: readonly string[]
): { body: string | null; extras: string[] } {
  const fields = [body, ...extras]
    .map((f) => f.trim().slice(0, BODY_MAX))
    .filter((f) => f.length > 0);
  return { body: fields[0] ?? null, extras: fields.slice(1) };
}

/**
 * SPEC-AGENT §1.5 (the write half) — carry a thought's COVERED fields through a
 * detail rewrite by a caller that could not see them.
 *
 * `detailText` omits sealed fields, by design: it is the read every non-app
 * surface takes, and a secret must not walk out through it. The cost is that a
 * caller which reads a detail and writes it back holds an INCOMPLETE list — and
 * `updateNode` replaces `body` + `extras` wholesale. So a correct agent doing the
 * obvious thing (read the detail, add a line, save) deletes every seal on that
 * thought: permanently, with no bin entry (an edit is not a delete) and no
 * edit-undo, to a field it was never allowed to read in the first place.
 *
 * The app never had this bug, because its edit form keeps a sealed field at its
 * index and passes the token through untouched ([components] `ExtraFields`).
 * This is that rule as a function, for every caller that is not a person looking
 * at a form.
 *
 * `next` is the caller's intended list of VISIBLE fields. Each sealed field
 * returns to the absolute index it held, ascending, clamped to the end — so "the
 * covered one was the third field" stays true, including when it was the body.
 * Anything in `next` that already looks sealed is DROPPED: a caller that cannot
 * read a token cannot legitimately author one, and passing it through would
 * either duplicate the real field or plant one nothing can ever open.
 *
 * Empties are kept deliberately — dropping them is `normalizeDetails`' job, and
 * doing it here would shift the very indices this exists to hold. Run the result
 * through it as every other write path does.
 */
export function preserveSealed(
  existing: Pick<ThoughtNode, 'body' | 'extras'>,
  next: { body: string; extras: readonly string[] }
): { body: string; extras: string[] } {
  const visible = [next.body, ...next.extras].filter((f) => !isSealed(f));
  const old = [existing.body ?? '', ...existing.extras];
  const out = [...visible];
  for (let i = 0; i < old.length; i++) {
    if (isSealed(old[i])) out.splice(Math.min(i, out.length), 0, old[i]);
  }
  return { body: out[0] ?? '', extras: out.slice(1) };
}

/**
 * The whole detail as one text — body and extras as paragraphs, in order.
 * Compile reads this so every target sees the full detail with no renderer
 * changes; a node without extras yields exactly its body (goldens unmoved).
 */
export function detailText(n: Pick<ThoughtNode, 'body' | 'extras'>): string | null {
  // SPEC-PRIVATE §6 — covered fields are OMITTED, not placeholdered. This is
  // compile's gather, and what compile makes goes to a clipboard, a file, and a
  // model; the one door a secret must not walk through is the one the user opens
  // for a different reason. Everything downstream of here inherits the rule for
  // free — the refine pass, grow, the two asks, the compile shelf.
  const fields = [n.body ?? '', ...n.extras].filter(
    (f) => f.trim().length > 0 && !isSealed(f)
  );
  return fields.length ? fields.join('\n\n') : null;
}

/**
 * The detail fields a list row previews UNDER its title, in order (SPEC §12 +
 * amdt 18) — the caller renders EACH as its own clamped line-group, so one long
 * field never starves the others. With a real title the whole detail (body +
 * extras) previews; with no title `displayTitle` already shows the body AS the
 * pseudo-title, so only the EXTRA fields remain — returning them is what keeps a
 * title-less thought's extras (the phone number under the name) from vanishing
 * instead of being dropped as a re-print of the body. Empty array = nothing to
 * preview, so the row draws no preview. NodeRow reads this; the dim styling +
 * per-field line clamp stay the caller's (a pseudo-title must not read as real).
 */
export function previewFields(n: Pick<ThoughtNode, 'title' | 'body' | 'extras'>): string[] {
  const fields = hasPseudoTitle(n) ? n.extras : [n.body ?? '', ...n.extras];
  return fields.filter((f) => f.trim().length > 0);
}
