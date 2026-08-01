import { isSealed } from './sealed';
import { ThoughtNode } from './types';

/**
 * Two pure text recognizers over what the user already wrote — no I/O, no
 * store, no React, nothing persisted. Both are LENSES: recomputed wherever
 * they're read, never a node field, so they cost no schema, no migration, no
 * sync payload key, and no crypto surface (SPEC-AI §5).
 *
 * `nodeFacts` reads a thought's detail fields and says which of them are a
 * phone number, an email, a link, or a place — the fact-line affordances.
 * `splitLines` reads a capture form and says whether something multi-line was
 * pasted into it, so the surface can offer to split it up.
 *
 * The classifying idea in both is the same, and it is the amdt-18 detail
 * discipline doing the work a parser can't: **the unit is a whole field, not a
 * span inside one.** "Is this whole line a phone number?" is a question with a
 * reliable answer in every locale; "where does the phone number start in this
 * paragraph?" is not. A field that isn't cleanly one thing is simply text, as
 * it is today — the failure mode is silence, never a wrong guess.
 */

export type FactKind = 'phone' | 'email' | 'url' | 'place';

/**
 * The part of a `Fact` that acting on it needs — the kind and the words. Inline
 * pills carry no field index, so [platform]'s `openTarget` takes this rather
 * than the whole `Fact` (which satisfies it structurally).
 */
export interface FactRef {
  kind: FactKind;
  text: string;
}

export interface Fact {
  kind: FactKind;
  /**
   * The field's text EXACTLY as written — never normalized, reformatted, or
   * repaired. Acting on it hands this string to the OS ([platform] openTarget),
   * which is what lets the recognizer stay locale-blind: `tel:` accepts nearly
   * any digit run and a maps query is free text, so nothing here has to know
   * what a phone number or an address looks like where the user lives.
   */
  text: string;
  /** Which detail field it came from: 0 = the body, 1..n = `extras[n-1]`. */
  field: number;
}

/** Facts past this on one thought are dropped — the panel is a list, not a directory. */
export const FACTS_MAX = 12;

/** A whole field that is one address: `name@host.tld`, nothing else on the line. */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** An explicit link — the only unambiguous one, scheme and all. */
const URL_SCHEME = /^https?:\/\/\S+$/i;

/**
 * A bare host (`tinhead.app`, `www.foo.co.uk/path`) — labels joined by dots
 * ending in a 2–63 letter TLD, no whitespace anywhere. The alpha-only TLD is
 * what keeps `1.5` and a trailing-dot abbreviation ("St.") out.
 */
const URL_BARE =
  /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,63}(?:\/\S*)?$/i;

/** Only the characters a written phone number uses — one letter disqualifies it. */
const PHONE_CHARS = /^[+()\-.\s\d]+$/;

/**
 * A written date, which `PHONE_CHARS` would otherwise wave through (`2026-07-25`
 * is eight digits and two dashes). The middle group is capped at two digits, so
 * a real number's `415-555-0134` can never match it.
 */
const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;

/** E.164's ceiling, and a floor low enough for a local number without an area code. */
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
/**
 * Groups a written number splits into. `+1 (415) 555-0134` is four; no format
 * anywhere runs past five. The cap is what stops two dates sitting side by side
 * (`2026-07-25 2026-08-01`) from reading as one long phone number, which the
 * digit count alone lets through.
 */
const PHONE_MAX_GROUPS = 5;

/** Is this whole string a written phone number? Shared by both tiers. */
function phoneLike(text: string): boolean {
  if (!PHONE_CHARS.test(text) || DATE_LIKE.test(text)) return false;
  const digits = text.replace(/\D/g, '').length;
  if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) return false;
  return text.split(/[\s().+-]+/).filter(Boolean).length <= PHONE_MAX_GROUPS;
}

/** A place line is short and few-worded; prose past these is left alone. */
const PLACE_MAX_CHARS = 120;
const PLACE_MIN_WORDS = 2;
const PLACE_MAX_WORDS = 12;
/**
 * How many numbers an address line carries: a street number, and at most a
 * postcode beside it. Three or more is a phone number written into a sentence
 * (`call +1 415 555 0134 today`), not a place.
 */
const PLACE_MAX_NUMBERS = 2;
/**
 * A street number, the way one is written anywhere: up to five digits and at
 * most one letter after (`12`, `221b`, `2200`). The five-digit ceiling is what
 * keeps a reference number (`20260725`) from reading as a house number.
 */
const NUMBER_WORD = /^\d{1,5}[a-z]?$/i;

/**
 * **The address dial**, for the offline fallback only. A line that clears the
 * gate below still has to earn this many points from `placeScore`.
 *
 * Read the `classifyField` note first: on iOS and Android this rule is not the
 * answer, it is the guess made while the OS is being asked ([platform]
 * `addressDetect`). That is what lets it be strict without stranding anyone —
 * a miss here is corrected by `NSDataDetector` / `TextClassifier`, so the only
 * cost of being wrong in the tight direction is a pill arriving a beat late.
 * Web has no such authority, and there this rule IS the answer.
 */
export const PLACE_SCORE_MIN = 2;

/**
 * The structural path's shape, for a line that names no street type. A leading
 * house number, then locality parts separated by commas.
 */
const PLACE_MIN_SEGMENTS = 2;
const PLACE_STRUCT_MIN_WORDS = 4;

/**
 * Street-type words, the strongest single signal a line is an address. A
 * shortlist, not a gazetteer: the Latin-script languages people are most
 * likely to write an address in, matched whole.
 */
const STREET_WORDS = new Set([
  // English
  'st', 'street', 'ave', 'av', 'avenue', 'rd', 'road', 'blvd', 'boulevard',
  'ln', 'lane', 'dr', 'drive', 'ct', 'court', 'pl', 'place', 'way', 'hwy',
  'highway', 'pkwy', 'parkway', 'sq', 'square', 'ter', 'terrace', 'cir',
  'circle', 'trail', 'trl', 'close', 'crescent', 'cres', 'row', 'walk',
  // French / Italian / Spanish / Portuguese / Catalan
  'rue', 'boulevard', 'chemin', 'quai', 'impasse', 'via', 'viale', 'corso',
  'piazza', 'calle', 'avenida', 'plaza', 'paseo', 'carrer', 'rua', 'praca',
  'praça', 'travessa', 'largo',
  // German / Dutch / Nordic / Slavic
  'platz', 'weg', 'allee', 'straat', 'laan', 'plein', 'gate', 'gata', 'gatan',
  'vei', 'veien', 'vej', 'gade', 'ulica', 'ul',
]);

/**
 * The compound half of the same signal: German, Dutch and Nordic write the
 * street type ONTO the name (`Hauptstrasse`), so a whole-word set can never
 * see it. Checked with `endsWith`, which is why the short ones need care —
 * `gade` is inside `brigade`, `gata` inside `regata`, and `laan` is one letter
 * from `Macallan`. Those three are left out: the languages they serve are
 * reached by `gatan` / `straat` / `plein` / `vej` anyway, and a suffix that can
 * fire on an ordinary word is worth less than the street it finds.
 */
const STREET_SUFFIXES = [
  'strasse', 'straße', 'gasse', 'weg', 'platz', 'allee',
  'straat', 'plein', 'gatan', 'veien', 'vej',
];

/** An initial capital — street and locality names are proper nouns, sentences aren't. */
const CAPITALIZED = /^[A-ZÀ-ÖØ-Þ]/;

/**
 * Month and weekday names. A DATE line is the commonest thing after a plain
 * note that a person writes on a detail field of its own, and the shape it
 * takes — a capitalized label, a capitalized month, a trailing day number —
 * fakes the proper-noun signal exactly. So a date word is not counted as a
 * proper noun.
 *
 * It does NOT disqualify the line outright, because a street can be called
 * `March Road`; it only withholds the one point it would otherwise buy. English
 * only, like `STREET_WORDS`: the words the app's own language writes, not a
 * calendar. (When SPEC-AI §5.3 C surfaces date lines for real, this set is where
 * it starts.)
 */
const DATE_WORDS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
]);

/** Strip the punctuation a word wears from its position in the line (`12,` → `12`). */
const bareWord = (w: string): string => w.replace(/^\W+|\W+$/g, '');

function isStreetWord(w: string): boolean {
  const lower = w.toLowerCase();
  return STREET_WORDS.has(lower) || STREET_SUFFIXES.some((s) => lower.length > s.length && lower.endsWith(s));
}

/**
 * How much a line looks like an address, 0–4. One point each:
 *
 * 1. **a comma** — an address separates street from locality; a bare sentence
 *    usually doesn't bother.
 * 2. **a street-type word** — the only signal prose does not produce by
 *    accident, which is why it is also a GATE (see `classifyField`): without it
 *    nothing is a place, however the other three land.
 * 3. **an anchored number** — a house number sits at one END of the line, where
 *    a number inside a sentence sits in the middle.
 * 4. **two or more proper nouns** — street and place names are capitalized in
 *    every Latin script, and a month name doesn't count (see `DATE_WORDS`).
 *    (Non-Latin scripts have no case, so this signal simply never fires for them
 *    and the others carry the line.)
 *
 * Signals 1, 3 and 4 are corroboration, never evidence: `Scotch, Macallan 12`
 * has all the shape of an address and none of the substance, and it takes two
 * of them without breaking a sweat.
 */
/**
 * The other way a line can look like an address, for the most of the world that
 * writes no street type at all: **a house number leading it, then locality
 * parts separated by commas, each of them a proper noun.**
 *
 * `68 Fukakusa Yabunouchicho, Fushimi Ward, Kyoto` is an address by every
 * measure a person would use and contains not one word this file knows. A
 * vocabulary rule can only ever be extended toward such a line, one language at
 * a time, and would still miss the next one — which is exactly the treadmill
 * this path exists to get off. Structure travels where words don't: number
 * first, then narrowing places, is how an address is written nearly everywhere.
 *
 * The capitalization of the later segments is what separates it from a list —
 * `12 eggs, milk, bread` has the same skeleton and none of the proper nouns.
 */
function placeStructure(text: string, bare: string[], words: string[]): boolean {
  if (words.length < PLACE_STRUCT_MIN_WORDS) return false;
  if (!NUMBER_WORD.test(bare[0])) return false;
  const segments = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length < PLACE_MIN_SEGMENTS) return false;
  return segments.slice(1).every((s) => CAPITALIZED.test(s));
}

function placeScore(text: string, bare: string[]): number {
  let score = 0;
  if (text.includes(',')) score += 1;
  if (bare.some(isStreetWord)) score += 1;
  if (NUMBER_WORD.test(bare[0]) || NUMBER_WORD.test(bare[bare.length - 1])) score += 1;
  const proper = bare.filter((w) => CAPITALIZED.test(w) && !DATE_WORDS.has(w.toLowerCase()));
  if (proper.length >= 2) score += 1;
  return score;
}

/** What a phone action hands the OS: a leading `+` if it was written, then digits. */
export function phoneDigits(text: string): string {
  const plus = text.trimStart().startsWith('+') ? '+' : '';
  return plus + text.replace(/\D/g, '');
}

/**
 * Classify ONE whole field. `null` when it isn't cleanly one thing — which is
 * the common answer and the safe one. Order matters only between email and
 * link (an address would satisfy neither of the other two).
 */
export function classifyField(raw: string): FactKind | null {
  // SPEC-PRIVATE §6 — a covered field is never scanned. Not only because the
  // pill's TEXT would show what the dots hide: the chip's very existence leaks
  // the KIND, and "this covered line is an email address" is most of the secret
  // for a login. The token would classify as nothing anyway; refusing it by name
  // is what keeps that an intention rather than an accident.
  if (isSealed(raw)) return null;
  const text = raw.trim();
  if (!text || text.includes('\n')) return null; // a multi-line field is a paste, not a fact
  if (EMAIL.test(text)) return 'email';
  if (URL_SCHEME.test(text) || URL_BARE.test(text)) return 'url';
  if (phoneLike(text)) return 'phone';
  // Everything else gets ONE more question, and it is the only judgement here.
  // There is no honest cross-locale regex for "is this an address" — so instead
  // of parsing one, we ask for the SHAPE an address line has anywhere and let
  // the maps query, which takes free text, do the understanding.
  //
  // **`place` is the OS's answer where there is an OS to ask.** On iOS and
  // Android, `NSDataDetector` / `TextClassifier` arbitrate it ([platform]
  // `addressDetect`) — real detectors, maintained by Apple and Google, that know
  // what this file can only approximate. What follows is the offline fallback:
  // the whole answer on web, and the guess held on native for the beat before
  // the OS replies. Being wrong in the TIGHT direction is nearly free there, so
  // it is written tight.
  //
  // A **gate** that costs nothing to fail — no colon, a short line, one or two
  // street-shaped numbers (not `5pm`, not a reference like `20260725`, and never
  // the three-or-more a phone number written into prose leaves behind) — and
  // then one of two paths to being address-shaped at all: a **street-type word**
  // (`900 West Palmdale Rd`), or the **structure** an address has without one
  // (`68 Fukakusa Yabunouchicho, Fushimi Ward, Kyoto` — see `placeStructure`).
  // Finally a **score**, tuned by `PLACE_SCORE_MIN`, so neither path stands on
  // its own evidence alone.
  //
  // Why both paths, rather than the vocabulary alone: every OTHER signal here is
  // something ordinary writing produces by accident — `Scotch, Macallan 12` is a
  // comma, a trailing number and two capitals, which is an address by every
  // measure except being one — so a line has to name a street type or wear the
  // number-then-locality shape before those signals mean anything.
  //
  // The colon carries its own weight beside them: `Average last frost: April 15`
  // is a LABELLED line — the shape amdt 18's one-fact-per-line detail encourages
  // above all others — and no address anywhere carries a colon.
  if (text.length <= PLACE_MAX_CHARS && !text.includes(':')) {
    const words = text.split(/\s+/);
    const bare = words.map(bareWord);
    const numbers = bare.filter((w) => NUMBER_WORD.test(w));
    const gated =
      words.length >= PLACE_MIN_WORDS &&
      words.length <= PLACE_MAX_WORDS &&
      numbers.length >= 1 &&
      numbers.length <= PLACE_MAX_NUMBERS &&
      (bare.some(isStreetWord) || placeStructure(text, bare, words));
    if (gated && placeScore(text, bare) >= PLACE_SCORE_MIN) return 'place';
  }
  return null;
}

/**
 * The facts a thought's DETAIL holds — body first, then each extra in order
 * (SPEC-AI §5). The title is deliberately not scanned: it is a label, and the
 * labels people write ("Call Bob about the 3rd") are exactly the noise the
 * whole-field rule exists to refuse. Duplicates across fields collapse (the
 * same number written twice is one thing to do), and the list caps at
 * `FACTS_MAX`.
 *
 * **No production caller today** (like [model]/tree's `sortForInsert`). It
 * backed the `Options › Open` list until the inline pills made that list
 * redundant — a phone number you can already tap does not need a menu naming
 * it. Kept, tested, and node-shaped because it is the exact question the
 * deferred directory/harvest target asks of every thought in a subtree
 * (SPEC-AI §5.3 B); `spanText` answers the per-FIELD question the pills need.
 */
export function nodeFacts(n: Pick<ThoughtNode, 'body' | 'extras'>): Fact[] {
  const fields = [n.body ?? '', ...n.extras];
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (let field = 0; field < fields.length; field++) {
    const text = fields[field].trim();
    const kind = classifyField(text);
    if (!kind) continue;
    const key = `${kind}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, text, field });
    if (out.length >= FACTS_MAX) break;
  }
  return out;
}

/** True when a thought holds anything to act on. Same no-caller note as above. */
export function hasFacts(n: Pick<ThoughtNode, 'body' | 'extras'>): boolean {
  return nodeFacts(n).length > 0;
}

// ---------------------------------------------------------------------------
// Inline spans. `classifyField` answers "is this whole line one thing"; this
// answers "which PARTS of this line are things" — what a reading surface needs
// to draw a phone number as its own pill inside a sentence.
//
// The two tiers pull in opposite directions on purpose. Whole-field
// classification can afford to be PERMISSIVE, because the user's line break is
// itself the evidence: a line holding nothing but `tinhead.app` is a link and
// nothing else. Inside prose there is no such evidence, so span scanning is
// CONSERVATIVE — only what is unmistakable without a line break around it.
// ---------------------------------------------------------------------------

/**
 * The one scanning pass: an explicit link, then an address, then a written
 * number. Deliberately free of lookbehind/lookahead (Hermes' regex support is
 * not the browser's) — the boundary rules are applied by hand in `spanAt`.
 *
 * A BARE host (`tinhead.app`) is absent on purpose: matching one inside prose
 * cannot tell `Dr.Alvarez` from a domain, and nothing distinguishes them but a
 * TLD list nobody wants to maintain. A bare host still pills when it is the
 * whole line, which is where people actually write one.
 */
const SPAN_RE =
  /(?:https?:\/\/|www\.)\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,24}|\+?\d[\d\s().-]{5,18}\d/g;

/** Sentence punctuation a link or address picks up by sitting at the end of one. */
const TRAILING = /[.,;:!?)\]]+$/;
/** A run touching a letter or digit is part of a word, not a fact. */
const WORDY = /[A-Za-z0-9]/;

/** One run of text: a fact when `kind` is set, plain text between them when null. */
export interface TextSpan {
  text: string;
  kind: FactKind | null;
}

/** Validate one `SPAN_RE` candidate and give back the span it really covers. */
function spanAt(text: string, m: RegExpExecArray): { start: number; end: number; span: TextSpan } | null {
  const start = m.index;
  const body = m[0].replace(TRAILING, '');
  if (!body) return null;
  const end = start + body.length;

  // Never cut a word in half: `abc4155550134` is an identifier, not a number.
  if (WORDY.test(text[start - 1] ?? '') || WORDY.test(text[end] ?? '')) return null;

  const kind: FactKind = /^(?:https?:\/\/|www\.)/i.test(body)
    ? 'url'
    : body.includes('@')
      ? 'email'
      : 'phone';

  if (kind === 'phone') {
    if (!phoneLike(body)) return null;
    // Inside prose, one more bar than a whole line has to clear: an unbroken
    // run with no separator at all is more often an id or a year than something
    // to dial. Written AS a number (spaces, dashes, brackets, a country +) a
    // local seven-digit one is plausible.
    if (!/[\s().+-]/.test(body) && body.replace(/\D/g, '').length < 9) return null;
  }
  return { start, end, span: { text: body, kind } };
}

/**
 * Split a field into the runs a reading surface draws — plain text and the fact
 * pills sitting INSIDE it ([components] `factChildren`).
 *
 * **This asks the inline question only.** Whether the WHOLE field is one fact is
 * `classifyField`'s question, and the two must stay apart: on native the
 * whole-field answer is arbitrated by the OS ([platform] `addressDetect`), so a
 * function that quietly re-derived it here would be a second, worse authority
 * disagreeing with the first. It was exactly that — this used to run
 * `classifyField` as a first tier, and when the OS demoted an address the caller
 * correctly stopped drawing a chip while this re-pilled the same line as a flat
 * inline highlight. One function per question.
 *
 * A `place` therefore never appears here at all: there is no honest way to spot
 * an address mid-sentence (see the module note), so an address is only ever a
 * whole line.
 *
 * A field with nothing in it returns exactly one plain span, so callers can
 * fast-path on that and pay nothing for the thoughts that have no facts.
 */
export function spanText(text: string): TextSpan[] {
  if (!text) return [];
  // SPEC-PRIVATE §6 — as `classifyField`: nothing inside a covered field is
  // pilled. One plain span, so the caller's fast path is the one it already has.
  if (isSealed(text)) return [{ text, kind: null }];
  const out: TextSpan[] = [];
  let last = 0;
  SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_RE.exec(text)) !== null) {
    const found = spanAt(text, m);
    if (!found) continue; // exec already advanced past this candidate
    if (found.start > last) out.push({ text: text.slice(last, found.start), kind: null });
    out.push(found.span);
    last = found.end;
    // The trailing-punctuation trim can pull the end back inside the match;
    // always > m.index, so the scan still advances and cannot loop.
    SPAN_RE.lastIndex = found.end;
  }
  if (!out.length) return [{ text, kind: null }];
  if (last < text.length) out.push({ text: text.slice(last), kind: null });
  return out;
}

// ---------------------------------------------------------------------------
// The paste split. Pasting a list into a capture surface is the one moment
// where a person's twenty minutes are on the table, so the form offers to make
// the list a list — offered, never automatic (nothing here writes anything).
// ---------------------------------------------------------------------------

/**
 * A paste longer than this gets no offer at all. The cap is a refusal, never a
 * truncation: the offer either takes EVERY line or isn't made, so no path can
 * quietly drop text the user pasted. Past 200 lines it's a document anyway.
 */
export const SPLIT_MAX = 200;

/**
 * The lines a capture form is holding, or `null` when there's nothing to offer.
 *
 * The detection is exact rather than heuristic, and amdt 20 is why: return
 * COMMITS from every field of every capture surface, so a newline can no longer
 * be typed into one. A field holding a newline was therefore **pasted** —
 * there is no other way for it to have got there, and no `onPaste` event (which
 * React Native does not offer cross-platform anyway) is needed to know it.
 *
 * The lines are gathered across the whole form in field order — title, detail,
 * then each extra — because the Composer's own smart paste (SPEC §7.1) has
 * already moved line 1 of a pasted block into the title, and the offer must
 * count the block the user actually pasted, not what the form did with it.
 */
export function splitLines(
  title: string,
  body: string,
  extras: readonly string[]
): string[] | null {
  if (!body.includes('\n') && !extras.some((x) => x.includes('\n'))) return null;
  const lines = [title, body, ...extras]
    .flatMap((f) => f.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length >= 2 && lines.length <= SPLIT_MAX ? lines : null;
}

/**
 * The other way to take the same lines: ONE thought wearing them as its detail
 * fields (amdt 18's one-fact-per-line shape — pasting a contact block and
 * keeping it as a contact). A title the user typed stays the title, and since
 * `splitLines` gathered it as line 1, dropping that line is what keeps it from
 * being written twice.
 */
export function splitAsDetails(
  title: string,
  lines: readonly string[]
): { body: string; extras: string[] } {
  const rest = title.trim() ? lines.slice(1) : lines;
  return { body: rest[0] ?? '', extras: [...rest.slice(1)] };
}
