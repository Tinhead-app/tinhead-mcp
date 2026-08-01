/**
 * [model] SPEC-PRIVATE §4 — the sealed-field token, and the one question every
 * read surface asks about it.
 *
 * A private detail field stores `priv1:<base64url>` IN PLACE OF its plaintext,
 * inside the ordinary `body`/`extras` strings. There is no `private: boolean[]`,
 * no new column, no new payload key and no migration: **the seal is the flag**.
 * That is the decision the whole feature is cheap because of —
 *
 *   · index drift cannot happen (a token travels with its own text, so
 *     `normalizeDetails` promoting an extra to `body` moves the mark with it);
 *   · every egress is safe by CONSTRUCTION rather than by discipline — search,
 *     compile, the fact recognizers, previews, the §27 envelope and the sync
 *     wire all handle strings, and what they hold is opaque;
 *   · sync, backup and the wire are untouched — a stale client carries a sealed
 *     field verbatim without knowing what it is, which is exactly right.
 *
 * **This module is PURE and crypto-free on purpose.** `tree.ts`, `facts.ts` and
 * `compile/` must be able to ask "is this covered?" without importing libsodium;
 * the keyed half (sealing, opening, the word) lives in `[private]`.
 */

/** Marks a sealed field. Versioned so a future format can be told apart. */
export const SEALED_PREFIX = 'priv1:';

/**
 * The shortest a real token can be. A sealed payload is
 * `nonce(24) ‖ AEAD(frame(1) ‖ pad₁₂₈(text))` = 169 bytes minimum → 226 base64url
 * characters; 200 is a floor comfortably under that and hugely over anything a
 * person types by hand. It exists so the answer is STRUCTURAL, not a bare
 * prefix test: someone whose thought genuinely begins `priv1:` keeps their text.
 */
const SEALED_MIN = 200;
const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Is this field covered? Prefix AND shape — see `SEALED_MIN`. The residual is
 * documented rather than engineered away: a string that passes both tests but
 * was never sealed draws as dots and reports that it cannot be opened, which is
 * a truthful outcome for a field nothing holds the key to.
 */
export function isSealed(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || !text.startsWith(SEALED_PREFIX)) return false;
  const body = text.slice(SEALED_PREFIX.length);
  return body.length >= SEALED_MIN && B64URL.test(body);
}

/** The base64 payload of a sealed field, or null if it isn't one. */
export function sealedBody(text: string | null | undefined): string | null {
  return isSealed(text) ? (text as string).slice(SEALED_PREFIX.length) : null;
}

/** Wrap a sealed payload back into its token. */
export const sealedToken = (body: string): string => `${SEALED_PREFIX}${body}`;

/**
 * How many of a thought's detail fields are covered. The count is what the
 * §6 plain-export warning names and what `Settings › Private` counts when it
 * offers to forget the word — a number the user can check against, never a list.
 */
export function sealedCount(body: string | null, extras: string[]): number {
  let n = isSealed(body) ? 1 : 0;
  for (const x of extras) if (isSealed(x)) n++;
  return n;
}

/** Does this thought carry anything covered? (the cheap gate before any keyed work) */
export const hasSealed = (body: string | null, extras: string[]): boolean =>
  sealedCount(body, extras) > 0;

/**
 * What a covered field draws as. FIXED length, never the plaintext's — a
 * four-digit PIN and a twelve-word recovery phrase must not be distinguishable
 * at a glance, which is exactly what a faithful dot-per-character would do.
 */
export const DOTS = '••••••••';
