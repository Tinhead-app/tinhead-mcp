/**
 * `tinhead-mcp` — the door's own matcher. SPEC-AGENT §6.2.
 *
 * §16 names *"it can't find what it wrote last week"* as the feature-killing
 * failure, and the app's `searchNodes` is substring-only: an agent that does not
 * know the exact words has to guess or walk. v0.1 answered that with an index
 * convention the USER maintains, which is a tax on the wrong person.
 *
 * The door holds the decrypted `NodeMap` in memory, so it can do better here at
 * **zero cost to the app and with no new app surface** — the one place in this
 * system where doing better is free. So it does: token AND-matching with word
 * prefixes, and a typo tolerance per token that scales with the token's length
 * (`editBudget`) — one edit at four letters, two at seven.
 *
 * **The one thing it inherits rather than re-derives is the covered-field rule.**
 * §1.5 makes reads ride the model's lenses precisely so the [private] rule comes
 * for free, and a bespoke matcher forfeits that — so `isSealed` is applied here
 * explicitly, and the jest case that pins it is the same one `tree.test.ts`
 * carries: a search for `priv1` must not list every covered thought.
 */

import { isSealed } from '../../../src/model/sealed';
import { ThoughtNode } from '../../../src/model/types';

export interface Match {
  node: ThoughtNode;
  score: number;
  /** Which field carried the strongest hit — the model likes knowing. */
  where: 'title' | 'detail';
}

/** Words, lowercased, punctuation-stripped. Deliberately naive and deterministic. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Levenshtein ≤ `max`, decided on a band of width `2·max+1` around the diagonal
 * rather than a full matrix — every cell further out is already over budget.
 *
 * This replaced a hand-rolled ≤1 walker. The walker was correct and could not be
 * widened: it spent a single unit of slack inline, so "two edits" had no
 * expression in it.
 */
export function withinEdits(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  const OVER = max + 1;
  let prev = new Array<number>(b.length + 1).fill(OVER);
  let cur = new Array<number>(b.length + 1).fill(OVER);
  for (let j = 0; j <= Math.min(b.length, max); j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const lo = Math.max(1, i - max);
    const hi = Math.min(b.length, i + max);
    cur.fill(OVER);
    cur[0] = i <= max ? i : OVER;
    let best = cur[0];
    for (let j = lo; j <= hi; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, sub);
      if (cur[j] < best) best = cur[j];
    }
    // Nothing on this row is still affordable, so no later row can be either.
    if (best > max) return false;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length] <= max;
}

/**
 * How far off a query token may be. **Scales with length, because a fixed budget
 * of one is wrong at both ends**: one edit in a four-letter word is usually a
 * different word, and one edit in an eight-letter word is not enough for a real
 * misspelling.
 *
 * The case that forced this: a tree whose author writes *"calander"* throughout.
 * `calendar` → `calander` is TWO substitutions, so searching the correct spelling
 * for his own calendar work returned the two thoughts titled "Calendar" and none
 * of the tasks under them — a near-miss that reads exactly like a hit.
 *
 * The AND rule downstream is what makes this safe to widen: every query token
 * must still land somewhere, so a loose token buys false positives only for
 * one-word queries.
 */
export function editBudget(token: string): number {
  if (token.length >= 7) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

/**
 * How well one query token matches one field's words. A token that matches
 * nothing scores 0, and one zero fails the whole AND — every query word must
 * land somewhere, which is what keeps a two-word query from returning the
 * corpus.
 */
function scoreToken(q: string, words: string[], whole: string): number {
  if (whole.includes(q)) {
    // A substring hit anywhere, including mid-word: the app's own behaviour, kept
    // as the floor so nothing that used to be findable stops being findable.
    if (words.includes(q)) return 4; // an exact word
    if (words.some((w) => w.startsWith(q))) return 3; // a word prefix
    return 2;
  }
  // Typos, at a budget that scales with the token's length.
  const budget = editBudget(q);
  if (budget > 0 && words.some((w) => withinEdits(q, w, budget))) return 1;
  return 0;
}

/**
 * Rank the candidates it is GIVEN against a query. Title hits outrank detail
 * hits, as the app's own search does; ties break on `updatedAt`, newest first.
 *
 * It applies no lens of its own beyond the covered-field rule below — the header
 * used to claim it ranked "live, un-archived thoughts", which was simply untrue
 * and let archived thoughts into results the app's own search would not show.
 * The caller owns the lens: `tools.ts` filters out the bin, the out-of-scope and
 * the archived before anything reaches here.
 *
 * Scope in particular is applied BEFORE ranking, so a branch-scoped grant can
 * never learn that a better match exists outside its branch by watching what
 * ranks below it.
 */
export function rankThoughts(
  candidates: Iterable<ThoughtNode>,
  query: string,
  limit: number
): Match[] {
  const qs = tokens(query);
  if (!qs.length) return [];
  const out: Match[] = [];

  for (const n of candidates) {
    // SPEC-PRIVATE §6 — a covered field is not matched, and the token is not a
    // search term. Skipping it is what makes the rule true rather than
    // incidentally true (the seal is base64url, so `priv1` WOULD match it).
    const titleText = isSealed(n.title) ? '' : (n.title ?? '');
    const detailText = [n.body ?? '', ...n.extras].filter((f) => !isSealed(f)).join('\n');

    const titleWords = tokens(titleText);
    const detailWords = tokens(detailText);
    const titleWhole = titleText.toLowerCase();
    const detailWhole = detailText.toLowerCase();

    let titleScore = 0;
    let detailScore = 0;
    let titleComplete = true;
    let detailComplete = true;
    for (const q of qs) {
      const t = scoreToken(q, titleWords, titleWhole);
      const d = scoreToken(q, detailWords, detailWhole);
      if (t === 0) titleComplete = false;
      if (d === 0) detailComplete = false;
      titleScore += t;
      detailScore += d;
    }
    // A hit must satisfy EVERY query token within one field, or across both —
    // "calendar todo" should find a `todo` under `Calendar` only when both words
    // are actually present somewhere in that thought.
    const bothComplete = qs.every(
      (q) =>
        scoreToken(q, titleWords, titleWhole) > 0 || scoreToken(q, detailWords, detailWhole) > 0
    );
    if (!bothComplete) continue;

    const score = titleComplete
      ? 1000 + titleScore
      : detailComplete
        ? 500 + detailScore
        : 100 + titleScore + detailScore;
    out.push({ node: n, score, where: titleComplete || titleScore >= detailScore ? 'title' : 'detail' });
  }

  out.sort((a, b) => b.score - a.score || b.node.updatedAt - a.node.updatedAt);
  return out.slice(0, limit);
}
