/** SPEC-CALENDAR §3 — the four repeat words; a rule you can say in one word. */
export type WhenRepeat = 'daily' | 'weekly' | 'monthly' | 'yearly';
const WHEN_REPEAT_WORDS = new Set(['daily', 'weekly', 'monthly', 'yearly']);
/** `YYYY-MM-DD`, a real calendar day (armour for `whenDay` — wire/storage data). */
const DAY_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** One thought. The user-facing word is "thought"; the code word is "node". */
export interface ThoughtNode {
  id: string;
  parentId: string | null; // null = top-level (child of root)
  title: string | null; // ≤ 200 chars
  body: string | null; // ≤ 100,000 chars
  /**
   * Further detail fields after `body` (SPEC v1.1 amdt 18), in order, each
   * ≤ 100,000 chars. The detail is an ordered list and `body` is simply its
   * first entry, so extras exist only when `body` does — `normalizeDetails`
   * ([model]/tree) enforces that at every write (empties drop, the first
   * survivor is the body). Empty array = no extra fields (never null).
   */
  extras: string[];
  sort: number; // legacy manual ordering; lists now sort by recency
  createdAt: number; // epoch ms
  updatedAt: number;
  /**
   * When this thought's own WORDS last changed — title, body or extras — and
   * nothing else. `null` until the first edit, which is what makes "has this
   * been edited since it was written?" answerable at all.
   *
   * It exists because `updatedAt` cannot answer that question and never could:
   * it is the sync conflict clock, so pinning, completing, designating a task,
   * archiving, deleting, restoring and a grow writing suggestions all bump it.
   * A row you merely pinned would otherwise read as freshly edited. Only
   * `updateNode` writes this one ([store]).
   */
  editedAt: number | null;
  /**
   * SPEC-SYNC §7.2 (2026-07-30) — the three CONFLICT CLOCKS.
   *
   * `updatedAt` is one clock for a thought that changes in three unrelated ways, so a
   * whole-node last-write-wins had to discard two of them: edit a title on the laptop
   * while the phone moves the thought, and whichever pushed last erased the other's
   * intent — silently, and in a personal-corpus app that is loss of work, not a
   * preference reverting. Each group now carries its own stamp and merges independently:
   *
   * - `contentAt`  — title, body, extras, suggestions (the words)
   * - `structureAt`— parentId, sort (where it lives)
   * - `flagsAt`    — pinned/task/completed/archived and the whole `when` family
   *
   * `deletedAt` is deliberately NOT among them: delete precedence is absolute (§7) and
   * settled before any merge runs. `accessedAt` never syncs at all.
   *
   * NULL means "written by a build that did not stamp this group", and the merge treats
   * a missing stamp on EITHER side as un-mergeable and keeps local — exactly the old
   * whole-node rule. That is what makes the fleet safe to update one device at a time,
   * and what makes a mutation site that forgets to re-stamp degrade to yesterday's
   * behaviour instead of merging on a stale clock. Set by [model] `restamp`, which
   * DERIVES them by diffing rather than trusting each call site to know its own group.
   */
  contentAt: number | null;
  structureAt: number | null;
  flagsAt: number | null;
  deletedAt: number | null; // tombstone; null = live
  /** Last time the user visited (descended into) this thought; creation counts. */
  accessedAt: number;
  /** Pinned to the top of its level; value orders pins (first pinned first). */
  pinnedAt: number | null;
  /**
   * Designated a task (SPEC v1.1 amdt 17). `taskAt` set + `completedAt` null =
   * an OPEN task (the empty box mark, counted by the parent's badge). Completing
   * backfills it, so un-completing reopens the task instead of erasing it.
   */
  taskAt: number | null;
  /** Checked off as a task. */
  completedAt: number | null;
  /** Archived (with its whole subtree) — hidden from lists, search, compile. */
  archivedAt: number | null;
  /**
   * [expand] Grown follow-up asks — the model's short tappable suggestions left
   * on this branch when it was grown (SPEC-AI §3.13). Syncs WITH the thought
   * (E2EE payload key `sug`), never compiled (not a detail field). Empty array =
   * none (never null); a tapped suggestion is removed. Whole-mode grows only.
   */
  suggestions: string[];
  /**
   * SPEC-CALENDAR §3 — the day this thought lands on, as a FLOATING CIVIL DATE
   * (`YYYY-MM-DD`), never an instant: `monday 7:00` means monday seven o'clock
   * wherever the account wakes up, so no timezone exists to get wrong and DST
   * cannot move it. Set = this thought is dated (the Dates lens shows it);
   * null = the common case. For a repeating thought this is the series ANCHOR —
   * the first occurrence. Occurrences are computed ([model] when.ts), never
   * materialized. Syncs as payload key `wd`, omitted while null.
   */
  whenDay: string | null;
  /**
   * Minutes into the day (0..1439) — the optional time on `whenDay`. Null = a
   * day without a time (dated first, timed later — the founder's two-step).
   * Meaningful only with `whenDay`; cleared with it. Payload key `wt`.
   */
  whenTime: number | null;
  /**
   * The repeat rule, sayable in one word (SPEC-CALENDAR §3): occurrences run
   * from the `whenDay` anchor forward, monthly/yearly clamping short months
   * (the 31st lands on the last day; Feb 29 lands on Feb 28 off-leap).
   * Meaningful only with `whenDay`; cleared with it. Payload key `wr`.
   */
  whenRepeat: WhenRepeat | null;
  /**
   * DORMANT — the SPEC-CALENDAR §8.1 notification seam. Minutes BEFORE the
   * occurrence's moment that a device alert should fire (0 = at the moment).
   * No UI writes it and nothing schedules from it yet; it exists now so the
   * field rides the same fleet rebuild as its siblings and the notification
   * layer inherits a synced field instead of forcing a second one. The alert
   * itself will be content-free (founder, 2026-07-29): it says something came
   * due, never what — no thought words ever reach the notification shade.
   * Meaningful only with `whenDay`; cleared with it. Payload key `wa`.
   */
  whenAlert: number | null;
  /**
   * Sync-payload keys written by a NEWER build than this one (SPEC-SYNC §4.1) —
   * carried verbatim so a stale client can never strip a field it cannot see.
   * Absent = none. Never read, never shown; the [sync] engine collects it at
   * decode, re-emits it at push, and graduates keys into real fields once an
   * app update makes them known.
   */
  unknownPayload?: Record<string, unknown>;
}

/**
 * SPEC-CALENDAR §3/§7 armour — a `whenDay` that isn't a REAL calendar day is
 * null (wire/storage/envelope JSON is data, not trusted structure; and a
 * shape-valid `2026-02-31` would make Date arithmetic roll into March).
 */
const validDayKey = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY_KEY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  return d <= new Date(y, m, 0).getDate();
};

/** Fill fields added after Phase 1 for rows persisted by older builds. */
export function normalizeNode(n: Partial<ThoughtNode> & Pick<ThoughtNode, 'id'>): ThoughtNode {
  // SPEC-CALENDAR §3 — the when family, armoured as a family: without a valid
  // day the other three are meaningless and read as null whatever they claim.
  const whenDay = validDayKey(n.whenDay) ? n.whenDay : null;
  const wholeMinute = (v: unknown, max: number): number | null =>
    whenDay !== null && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
      ? v
      : null;
  return {
    parentId: null,
    title: null,
    body: null,
    sort: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...n,
    accessedAt: n.accessedAt ?? n.updatedAt ?? n.createdAt ?? 0,
    // Absent in every row written before this field, and it must stay absent:
    // back-filling it from `updatedAt` would declare the whole existing corpus
    // "edited", which is the one thing it is supposed to be able to deny.
    editedAt: n.editedAt ?? null,
    // SPEC-SYNC §7.2 — absent in every row written before the conflict clocks, and it
    // must stay absent: a back-filled stamp is a claim about WHEN a group last changed,
    // and inventing one would merge on a fiction. Null means "un-mergeable, keep local".
    contentAt: n.contentAt ?? null,
    structureAt: n.structureAt ?? null,
    flagsAt: n.flagsAt ?? null,
    pinnedAt: n.pinnedAt ?? null,
    taskAt: n.taskAt ?? null,
    completedAt: n.completedAt ?? null,
    archivedAt: n.archivedAt ?? null,
    // Absent in rows/payloads written before amdt 18. Rows arrive from storage
    // AND the sync wire, so armour the shape: strings only, blanks dropped.
    extras: Array.isArray(n.extras)
      ? n.extras.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    // [expand] grown suggestions (SPEC-AI §3.13) — same armour as extras: absent
    // in rows/payloads from before this field; strings only, blanks dropped.
    suggestions: Array.isArray(n.suggestions)
      ? n.suggestions.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    // SPEC-CALENDAR §3 — absent in rows/payloads written before the when
    // family existed; the armour above is the one authority on their shape.
    whenDay,
    whenTime: wholeMinute(n.whenTime, 1439),
    whenRepeat:
      whenDay !== null && typeof n.whenRepeat === 'string' && WHEN_REPEAT_WORDS.has(n.whenRepeat)
        ? n.whenRepeat
        : null,
    // §8.1 dormant alert seam — minutes before the moment; bounded to four
    // weeks of lead so a corrupt cell can't schedule an alert years early.
    whenAlert: wholeMinute(n.whenAlert, 40_320),
    // §4.1 cargo — same armour rationale: a plain non-empty object or nothing.
    unknownPayload:
      n.unknownPayload &&
      typeof n.unknownPayload === 'object' &&
      !Array.isArray(n.unknownPayload) &&
      Object.keys(n.unknownPayload).length > 0
        ? n.unknownPayload
        : undefined,
  };
}

/** The virtual root context is represented by null. */
export type ContextId = string | null;

export const ROOT: ContextId = null;

export const TITLE_MAX = 200;
export const BODY_MAX = 100_000;
export const DEPTH_MAX = 100;

export interface Draft {
  contextId: string; // node id or 'root'
  title: string;
  body: string;
  /** Staged extra detail fields (amdt 18) — raw, exactly as typed (may hold empties). */
  extras: string[];
  updatedAt: number;
}

export const draftKey = (context: ContextId): string => context ?? 'root';

/**
 * Per-list sort preference key (see [model] `SortMode`). Like `draftKey`, the
 * null root becomes `root`; every context — root or a node id — gets its own
 * `listSort:<context>` row. The `:` makes it a node-scoped key, so it is
 * device-local by construction UNLESS it is composed onto a wire key: the whole
 * set travels as the single `listSort` mirror ([sync] settingsKeys), exactly the
 * way the many `compile.dials:<targetId>` rows ride the composed `compile.dials`.
 */
export const listSortKey = (context: ContextId): string => `listSort:${context ?? 'root'}`;

/**
 * One taken compile (SPEC-COMPILE §7 "compile history"): a snapshot recorded
 * when an artifact leaves the pane — copy, share, or save file. The record
 * stands alone: it survives the thought's deletion, and it never carries the
 * postscript (§5.3 — the postscript is never persisted). Since 2026-07-22 the
 * shelf follows the account through the E2EE §4.2 channel while sync is
 * unlocked (SPEC-SYNC — ciphertext only, like the thoughts it was rendered
 * from); with sync off it stays local like drafts and custom presets.
 */
export interface CompileRecord {
  id: string;
  /** The compiled thought at take time — may no longer exist. */
  nodeId: string;
  targetId: string;
  /** `displayTitle` of the thought at take time. */
  title: string;
  /** The artifact as taken (refined text + its footer when refined). */
  text: string;
  /** True when the taken text came out of a refine pass. */
  refined: boolean;
  takenAt: number;
}

/**
 * Settings key marking a thought as put back from the bin (SPEC v1.1 amdt 14).
 * Local-only and unsynced, like a preset's `hint:` — settings sync mirrors only
 * theme + font. The mark renders only while `hasLiveTwin` says the restore is
 * actually ambiguous, so it costs nothing to leave the key behind.
 */
export const restoredKey = (nodeId: string): string => `restored:${nodeId}`;

/**
 * How many thoughts this person has captured.
 *
 * **It has no consumer today, deliberately.** It was built to graduate the
 * capture rail out of its words after ten captures ([components]); that idea
 * lasted a day — the marks read worse alone than with them — and the reading
 * side was removed while the counting side was kept, because "how far in is
 * this person" is a question a quiet app will want to answer more than once
 * (a first-run line, a nudge that should only ever fire early) and a counter
 * is worth nothing unless it has been running all along. Do not delete it to
 * tidy up: restarting it later would give every existing user a zero.
 *
 * A COUNT of acts, not of live thoughts: bumped where `firstNodeCreated` is set
 * (one per `createNode`, one per `createMany` — a paste split is one act of
 * capture however many rows it lands) and never decremented, so deleting
 * everything you wrote does not roll it back. Nothing here is undone by tidying.
 *
 * No `:` — it is a whole-account setting, and it rides the wire as itself
 * ([sync] settingsKeys, max-merged rather than last-write-wins: a count only
 * ever goes up, and a quiet second device must not be able to talk the one you
 * actually use back down).
 */
export const CAPTURE_COUNT_KEY = 'captureCount';
