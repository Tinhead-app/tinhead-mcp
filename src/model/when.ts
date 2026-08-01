/**
 * [model] when.ts — SPEC-CALENDAR §4: the pure calendar math.
 *
 * The Dates lens is COMPUTED, never stored: these functions read the node map
 * and answer; no occurrence is ever materialized as a node, no result is ever
 * persisted, and nothing here writes. A sibling of `facts.ts` in every way —
 * pure, jest-pinned, and silent where it cannot be sure (`parseTimeText`
 * returns null for anything it does not recognize; it never guesses).
 *
 * A when is a FLOATING CIVIL DATE (`YYYY-MM-DD`) plus optional minutes — a
 * calendar square, not an instant — so all arithmetic here is calendar
 * arithmetic. Date objects are used only as a day-calculator, constructed from
 * parts AT NOON so a zone whose midnight goes missing (a DST spring-forward at
 * 00:00 exists in real zones) can never shift a civil day, and only ever read
 * back as Y/M/D/weekday. No instant is stored, parsed, or compared.
 *
 * The terse user-facing day words (`today`, `wed`, `aug 12`) live HERE, not in
 * copy.ts, on `timeAgo`'s precedent — the model owns the badge dialects.
 */

import type { ThoughtNode, WhenRepeat } from './types';
import { type NodeMap, isUnderArchive, displayTitle } from './tree';

// ------------------------------------------------------------------ day-key arithmetic

export interface DayParts {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

export const dayParts = (key: string): DayParts => {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
};

export const partsToKey = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Noon, so a missing or doubled midnight (DST) can never move a civil day. */
const dateOf = (key: string): Date => {
  const { y, m, d } = dayParts(key);
  return new Date(y, m - 1, d, 12);
};

/** The device's local civil date for an epoch-ms instant — the one "today". */
export const todayKey = (now: number): string => {
  const dt = new Date(now);
  return partsToKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
};

export const daysInMonth = (y: number, m: number): number => new Date(y, m, 0).getDate();

/** 0 = monday .. 6 = sunday (SPEC-CALENDAR §13.4 — the week starts on monday). */
export const weekdayOf = (key: string): number => (dateOf(key).getDay() + 6) % 7;

export const addDays = (key: string, n: number): string => {
  const dt = dateOf(key);
  dt.setDate(dt.getDate() + n);
  return partsToKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
};

/** Whole days from `a` to `b` (positive when `b` is later). Noon-anchored, so exact. */
export const dayDiff = (a: string, b: string): number =>
  Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / 86_400_000);

// ------------------------------------------------------------------ occurrences (§3 clamps)

/**
 * The day-of-month a monthly/yearly rule lands on in a given month: the
 * anchor's day, clamped to the month's length — the 31st lands on Feb 28/29,
 * and (the yearly Feb-29 case) leap day lands on Feb 28 off-leap.
 */
const clampedDom = (anchorD: number, y: number, m: number): number =>
  Math.min(anchorD, daysInMonth(y, m));

/** Does this thought land on this day? False for the undated and for days before the anchor. */
export function occursOn(n: ThoughtNode, day: string): boolean {
  if (n.whenDay === null) return false;
  if (day < n.whenDay) return false; // lexicographic IS chronological for day keys
  if (day === n.whenDay) return true;
  const a = dayParts(n.whenDay);
  const t = dayParts(day);
  switch (n.whenRepeat) {
    case 'daily':
      return true;
    case 'weekly':
      return weekdayOf(day) === weekdayOf(n.whenDay);
    case 'monthly':
      return t.d === clampedDom(a.d, t.y, t.m);
    case 'yearly':
      return t.m === a.m && t.d === clampedDom(a.d, t.y, t.m);
    default:
      return false;
  }
}

/**
 * The soonest occurrence on/after `fromDay` — null for the undated and for a
 * singular when already passed. Closed-form per rule; never a day walk.
 */
export function nextOccurrence(n: ThoughtNode, fromDay: string): string | null {
  if (n.whenDay === null) return null;
  if (n.whenDay >= fromDay) return n.whenDay; // the anchor is the first occurrence
  const a = dayParts(n.whenDay);
  const f = dayParts(fromDay);
  switch (n.whenRepeat) {
    case 'daily':
      return fromDay;
    case 'weekly':
      return addDays(fromDay, (weekdayOf(n.whenDay) - weekdayOf(fromDay) + 7) % 7);
    case 'monthly': {
      const thisMonth = partsToKey(f.y, f.m, clampedDom(a.d, f.y, f.m));
      if (thisMonth >= fromDay) return thisMonth;
      const y = f.m === 12 ? f.y + 1 : f.y;
      const m = f.m === 12 ? 1 : f.m + 1;
      return partsToKey(y, m, clampedDom(a.d, y, m));
    }
    case 'yearly': {
      const thisYear = partsToKey(f.y, a.m, clampedDom(a.d, f.y, a.m));
      if (thisYear >= fromDay) return thisYear;
      return partsToKey(f.y + 1, a.m, clampedDom(a.d, f.y + 1, a.m));
    }
    default:
      return null; // singular, and its day has passed
  }
}

// ------------------------------------------------------------------ the lens (§4/§6)

/** The lens sees exactly what search sees: live, un-archived, not under an archive. */
const lensVisible = (nodes: NodeMap, n: ThoughtNode): boolean =>
  n.deletedAt === null && n.archivedAt === null && !isUnderArchive(nodes, n.id);

/** Every dated thought the lens may show, unordered. The one corpus scan here. */
const datedNodes = (nodes: NodeMap): ThoughtNode[] => {
  const out: ThoughtNode[] = [];
  for (const n of nodes.values()) {
    if (n.whenDay !== null && lensVisible(nodes, n)) out.push(n);
  }
  return out;
};

/** The dates door's existence predicate — early-exits on the first dated thought. */
export function hasWhens(nodes: NodeMap): boolean {
  for (const n of nodes.values()) {
    if (n.whenDay !== null && lensVisible(nodes, n)) return true;
  }
  return false;
}

/**
 * One day's order (§6.3): timeless entries lead (a day-level commitment
 * outranks an hour-level one), timed follow by time, completed sink ghosted at
 * the bottom in the same order — and within every rung, capture order
 * (`createdAt`, id tiebreak) keeps it stable.
 */
function byDayOrder(a: ThoughtNode, b: ThoughtNode): number {
  const ga = a.completedAt !== null ? 1 : 0;
  const gb = b.completedAt !== null ? 1 : 0;
  if (ga !== gb) return ga - gb;
  const ta = a.whenTime === null ? -1 : a.whenTime;
  const tb = b.whenTime === null ? -1 : b.whenTime;
  if (ta !== tb) return ta - tb;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface DayEntries {
  day: string;
  entries: ThoughtNode[];
}

/**
 * The agenda (§6.3): the next `limit` days ON/AFTER `fromDay` that hold at
 * least one occurrence, in day order. Singular whens are collected directly
 * (any distance into the future — no horizon constant exists or is needed);
 * a repeat contributes one occurrence per day as generation walks, capped at
 * `limit` per node because `limit` distinct days can never need more.
 * O(dated × limit); dated thoughts are a sliver of any corpus.
 */
export function agendaDays(nodes: NodeMap, fromDay: string, limit: number): DayEntries[] {
  const buckets = new Map<string, ThoughtNode[]>();
  for (const n of datedNodes(nodes)) {
    let day = nextOccurrence(n, fromDay);
    let left = limit;
    while (day !== null && left-- > 0) {
      const b = buckets.get(day);
      if (b) b.push(n);
      else buckets.set(day, [n]);
      if (n.whenRepeat === null) break;
      day = nextOccurrence(n, addDays(day, 1));
    }
  }
  return [...buckets.keys()]
    .sort()
    .slice(0, limit)
    .map((day) => ({ day, entries: buckets.get(day)!.sort(byDayOrder) }));
}

/**
 * The past (§6.3 `earlier`): days BEFORE `beforeDay` that held SINGULAR whens,
 * newest first. A repeating thought lives in the forward lens by definition —
 * it always has a next — so its past occurrences are not replayed here.
 */
export function earlierDays(nodes: NodeMap, beforeDay: string, limit: number): DayEntries[] {
  const buckets = new Map<string, ThoughtNode[]>();
  for (const n of datedNodes(nodes)) {
    if (n.whenRepeat !== null) continue;
    if (n.whenDay! >= beforeDay) continue;
    const b = buckets.get(n.whenDay!);
    if (b) b.push(n);
    else buckets.set(n.whenDay!, [n]);
  }
  return [...buckets.keys()]
    .sort()
    .reverse()
    .slice(0, limit)
    .map((day) => ({ day, entries: buckets.get(day)!.sort(byDayOrder) }));
}

/** One day's entries in day order — the day level, and the grid's descend. */
export function dayEntries(nodes: NodeMap, day: string): ThoughtNode[] {
  return datedNodes(nodes)
    .filter((n) => occursOn(n, day))
    .sort(byDayOrder);
}

/** Which days of a month hold occurrences — the walker's and the grid's ink dots. */
export function daysWithWhens(nodes: NodeMap, y: number, m: number): Set<string> {
  const dated = datedNodes(nodes);
  const out = new Set<string>();
  const last = daysInMonth(y, m);
  for (let d = 1; d <= last; d++) {
    const key = partsToKey(y, m, d);
    if (dated.some((n) => occursOn(n, key))) out.add(key);
  }
  return out;
}

/** Occurrences per month of a year — the year level's twelve count pills. */
export function monthCounts(nodes: NodeMap, y: number): number[] {
  const dated = datedNodes(nodes);
  const out: number[] = [];
  for (let m = 1; m <= 12; m++) {
    let count = 0;
    const last = daysInMonth(y, m);
    for (let d = 1; d <= last; d++) {
      const key = partsToKey(y, m, d);
      for (const n of dated) if (occursOn(n, key)) count++;
    }
    out.push(count);
  }
  return out;
}

// ------------------------------------------------------------------ time text (§5.1)

/**
 * The lenient time read: `7`, `07`, `7:30`, `19:30`, `7am`, `7:30 pm` — bare
 * hours read as 24h. Anything else is null: the facts.ts rule — the failure
 * mode is silence, never a wrong guess. Never writes, never normalizes input.
 */
export function parseTimeText(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

/** `7:00` / `19:30` — 24h until §13.5 says otherwise. */
export const fmtTime = (minutes: number): string =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------ the words (§5.4/§6.3)

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAYS_SHORT = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const MONTH_WORDS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTHS_SHORT = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/**
 * The row's forward badge (§5.4) — `timeAgo`'s twin, and governed by the same
 * restraint: null for the undated AND for a singular when that has passed (the
 * badge answers "coming up?", and past answers no — the date itself is still in
 * the When pane and in `earlier`). The time joins only on the day itself.
 */
export function whenWord(n: ThoughtNode, now: number): string | null {
  const today = todayKey(now);
  const next = nextOccurrence(n, today);
  if (next === null) return null;
  const diff = dayDiff(today, next);
  if (diff === 0) return n.whenTime !== null ? `today ${fmtTime(n.whenTime)}` : 'today';
  if (diff === 1) return 'tomorrow';
  const p = dayParts(next);
  if (diff < 7) return WEEKDAYS_SHORT[weekdayOf(next)];
  const word = `${MONTHS_SHORT[p.m - 1]} ${p.d}`;
  return p.y === dayParts(today).y ? word : `${word} ${p.y}`;
}

/**
 * A day group's section word (§6.3): `today` · `tomorrow` · the full weekday
 * inside a week · `wed aug 5` beyond it · the year appended across one.
 */
export function dayLabel(day: string, today: string): string {
  const diff = dayDiff(today, day);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff > 1 && diff < 7) return WEEKDAYS[weekdayOf(day)];
  const p = dayParts(day);
  const word = `${WEEKDAYS_SHORT[weekdayOf(day)]} ${MONTHS_SHORT[p.m - 1]} ${p.d}`;
  return p.y === dayParts(today).y ? word : `${word} ${p.y}`;
}

/** The walker's and the grid's month header: `august 2026`. */
export const monthWord = (y: number, m: number): string => `${MONTH_WORDS[m - 1]} ${y}`;

/** The repeat seat's cycle (§5.1): never → daily → weekly → monthly → yearly → never. */
export function nextRepeat(r: WhenRepeat | null): WhenRepeat | null {
  switch (r) {
    case null:
      return 'daily';
    case 'daily':
      return 'weekly';
    case 'weekly':
      return 'monthly';
    case 'monthly':
      return 'yearly';
    case 'yearly':
      return null;
  }
}

// ------------------------------------------------------------------ the week offer (§5.3)

/**
 * Weekday words a batch entry's title may lead with — deliberately the same
 * membership facts.ts' `DATE_WORDS` carries for its weekday half (English,
 * like the app's own language; honest about it — SPEC-CALENDAR §5.3).
 */
const WEEK_LEADS = new Map<string, number>([
  ['monday', 0], ['mon', 0],
  ['tuesday', 1], ['tue', 1], ['tues', 1],
  ['wednesday', 2], ['wed', 2],
  ['thursday', 3], ['thu', 3], ['thur', 3], ['thurs', 3],
  ['friday', 4], ['fri', 4],
  ['saturday', 5], ['sat', 5],
  ['sunday', 6], ['sun', 6],
]);

export interface WeekPlacement {
  id: string;
  day: string;
}

/**
 * The week offer's one question (§5.3): is this batch weekday-led, and where
 * would each entry land? Every entry's shown title must LEAD with a weekday
 * word and the batch must span at least two distinct weekdays — else null,
 * silently (never a partial offer). Placement is the NEXT matching weekday
 * from `today`, today included.
 */
export function weekPlacement(
  nodes: NodeMap,
  ids: string[],
  today: string
): WeekPlacement[] | null {
  if (ids.length < 2) return null;
  const out: WeekPlacement[] = [];
  const seen = new Set<number>();
  const todayWd = weekdayOf(today);
  for (const id of ids) {
    const n = nodes.get(id);
    if (!n || n.deletedAt !== null) return null;
    const lead = displayTitle(n).trim().split(/\s+/)[0]?.replace(/^\W+|\W+$/g, '').toLowerCase();
    const wd = lead !== undefined ? WEEK_LEADS.get(lead) : undefined;
    if (wd === undefined) return null;
    seen.add(wd);
    out.push({ id, day: addDays(today, (wd - todayWd + 7) % 7) });
  }
  return seen.size >= 2 ? out : null;
}
