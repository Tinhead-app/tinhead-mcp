import { editBudget, withinEdits } from '../src/search';

/**
 * The matcher's one piece of real algorithm, pinned against a definition rather
 * than against itself.
 *
 * `withinEdits` decides Levenshtein ≤ max on a BAND around the diagonal — every
 * cell further out is already over budget, so it is never computed. That saves a
 * full matrix per candidate word, and it is exactly the kind of optimisation
 * that can be quietly wrong in one direction: a band that is too generous
 * accepts strings that are not within budget, and the door starts answering
 * "calendar" with everything of roughly that shape. No search test would look
 * wrong; the results would just get worse.
 *
 * So this compares it to a plain full-matrix Levenshtein over an exhaustive
 * small alphabet, at every budget the door actually uses. The brute force is
 * written here rather than imported, because a check against the same code is
 * not a check.
 */

/** Textbook full-matrix edit distance. Slow, obvious, and the thing being trusted. */
function levenshtein(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

/** Every string up to `len` over `alphabet`, the empty string included. */
function allStrings(alphabet: string, len: number): string[] {
  let out = [''];
  const acc = [''];
  for (let i = 0; i < len; i++) {
    out = out.flatMap((s) => [...alphabet].map((c) => s + c));
    acc.push(...out);
  }
  return acc;
}

describe('withinEdits agrees with edit distance', () => {
  it('exhaustively, over every short string in a three-letter alphabet', () => {
    const words = allStrings('abc', 4); // 121 strings → ~14.6k ordered pairs
    let checked = 0;
    for (const a of words) {
      for (const b of words) {
        const d = levenshtein(a, b);
        for (const max of [1, 2]) {
          expect(withinEdits(a, b, max)).toBe(d <= max);
          checked++;
        }
      }
    }
    // Guard against the loop silently collapsing to nothing.
    expect(checked).toBeGreaterThan(20_000);
  });

  it('on the real words that forced the widening', () => {
    // Two substitutions — the spelling this tree is actually written in.
    expect(levenshtein('calendar', 'calander')).toBe(2);
    expect(withinEdits('calendar', 'calander', 2)).toBe(true);
    expect(withinEdits('calendar', 'calander', 1)).toBe(false);
    // Three — out, and staying out.
    expect(levenshtein('calendar', 'colander')).toBe(3);
    expect(withinEdits('calendar', 'colander', 2)).toBe(false);
    // Length differences beyond the budget short-circuit rather than scanning.
    expect(withinEdits('calendar', 'cal', 2)).toBe(false);
    expect(withinEdits('', '', 1)).toBe(true);
    expect(withinEdits('a', '', 1)).toBe(true);
  });
});

describe('editBudget', () => {
  it('scales with length, and spends nothing on words too short to spare it', () => {
    // One edit in a three-letter word is a different word: "cat"/"car"/"can".
    expect(editBudget('cat')).toBe(0);
    expect(editBudget('week')).toBe(1);
    expect(editBudget('month')).toBe(1);
    expect(editBudget('compile')).toBe(2);
    expect(editBudget('calendar')).toBe(2);
  });
});
