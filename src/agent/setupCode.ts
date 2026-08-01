/**
 * [mcp] SPEC-AGENT §4.5 — the ONE string a person carries out of the app.
 *
 * **Why this exists.** The setup used to hand over two opaque strings: a 43-char
 * token under "copy this now", and a UUID buried inside a command line. Both
 * look like the same kind of thing, nothing said which was which, and the
 * founder — who wrote the feature's spec — swapped them on his first attempt,
 * then stored the token under itself and got a refusal that named neither. The
 * lesson is not "label them better". Two secretsʼ-worth of ceremony for one
 * credential is the defect; a label would only make the wrong one easier to
 * find.
 *
 * So the app emits a single self-describing blob and the terminal step takes no
 * argument at all: `tinhead-mcp login`, paste once, done. The class of mistake
 * stops existing rather than being warned about.
 *
 * **What rides in it, and why that is safe.** The grant id and the gateway URL
 * are explicitly NOT secrets (§4.5 — they are what the MCP config file carries
 * in the clear). The token is. Bundling a non-secret with a secret costs
 * nothing: the whole code inherits the secret's handling, which is what the
 * panel already did with the token alone — shown once, kept by nobody.
 *
 * **JSON inside, for §4.1's reason.** A future field is additive and an older
 * CLI ignores it, rather than a positional format where one extra part shifts
 * everything after it.
 *
 * Pure, dependency-free, and NO crypto init. `login` runs before anything has
 * awaited `cryptoReady`, and a base64 helper that needs libsodium warmed up
 * would make the first thing a user types the slowest — so the codec below is
 * hand-rolled and works identically on Hermes, a browser and Node.
 */

/** Version tag. A code from a future app is refused by NAME, not by a parse error. */
export const SETUP_PREFIX = 'tinhead1:';

export interface SetupCode {
  /** The `agent_grants` row key. Not a secret. */
  grantId: string;
  /** The `grant_gateway` endpoint. Not a secret. */
  url: string;
  /** base64url of the 32-byte grant token. THE secret; this is why the code is shown once. */
  token: string;
}

/** A code that will not open. One type so the CLI can say which thing is wrong. */
export class SetupCodeError extends Error {}

// ------------------------------------------------------------------ base64url
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET[i]] = i;

function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 63];
  }
  return out;
}

function b64urlDecode(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = REVERSE[ch];
    if (v === undefined) throw new SetupCodeError('that setup code has characters that do not belong in one');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

const utf8Encode = (s: string): Uint8Array => {
  // `TextEncoder` exists on every target this ships to, and hand-rolling UTF-8
  // for a string that is ASCII in practice would be inventing a bug.
  return new TextEncoder().encode(s);
};
const utf8Decode = (b: Uint8Array): string => new TextDecoder().decode(b);

// ------------------------------------------------------------------ the codec

/** Build the one string the panel shows. */
export function encodeSetupCode(code: SetupCode): string {
  const json = JSON.stringify({ i: code.grantId, u: code.url, t: code.token });
  return SETUP_PREFIX + b64urlEncode(utf8Encode(json));
}

/**
 * Read a code back, with a sentence per failure a person can actually act on.
 *
 * Every refusal here is one somebody will meet with a terminal open and no idea
 * what a grant is, so none of them say "malformed" — they say what to do.
 */
export function decodeSetupCode(raw: string): SetupCode {
  const text = raw.trim();
  if (!text) throw new SetupCodeError('nothing was pasted');
  if (!text.startsWith(SETUP_PREFIX)) {
    // The overwhelmingly likely mis-paste: the connection id, or the old
    // two-part setup's token. Both are recognisable, so say so by name.
    const looksLikeId = /^[0-9a-f-]{32,36}$/i.test(text);
    throw new SetupCodeError(
      looksLikeId
        ? 'that is a connection id, not a setup code. In Tinhead, use the Copy button under “Your setup code”.'
        : `that does not look like a setup code — they begin with “${SETUP_PREFIX}”. Copy it again from Tinhead: Settings › Plugins.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(b64urlDecode(text.slice(SETUP_PREFIX.length))));
  } catch (err) {
    if (err instanceof SetupCodeError) throw err;
    throw new SetupCodeError('that setup code is damaged — it may have been cut short when it was copied');
  }
  const o = (parsed ?? {}) as { i?: unknown; u?: unknown; t?: unknown };
  const grantId = typeof o.i === 'string' ? o.i : '';
  const url = typeof o.u === 'string' ? o.u : '';
  const token = typeof o.t === 'string' ? o.t : '';
  if (!grantId || !url || !token) {
    throw new SetupCodeError('that setup code is missing part of itself — copy it again from Tinhead');
  }
  // The URL decides where a credential is SENT, so it is checked here rather
  // than trusted to whatever reads it later.
  if (!/^https:\/\/[^\s]+$/i.test(url)) {
    throw new SetupCodeError('that setup code points somewhere that is not an https address — do not use it');
  }
  return { grantId, url, token };
}
