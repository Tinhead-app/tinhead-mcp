import sodium, { available as sodiumAvailable, ready as sodiumReady } from './sodium';

/**
 * SPEC-SYNC.md §3 — the pure crypto layer for E2EE thought sync. No network, no store, and
 * nothing above it imports a libsodium package: it reaches libsodium only through the
 * `./sodium` adapter (WASM on web/Node, react-native-libsodium/JSI on native), so the same
 * code produces byte-identical output on every backend. Every value is canonically serialized
 * (fixed order, length-prefixed, big-endian ints, raw salts, byte booleans) so the real
 * client and FakeSync produce byte-identical AAD/MAC inputs.
 *
 * Key separation: DEK, KEK, RKEK are only crypto_kdf masters; each purpose derives its own
 * 8-byte-context subkey (libsodium's crypto_kdf context is exactly 8 bytes, so the human
 * label maps to a fixed context + a per-purpose subkey id).
 */

/** Await once before any other call (App boot / test setup). */
export const cryptoReady: Promise<void> = sodiumReady;

/**
 * Whether crypto can run here — the single gate every caller checks before crypto work. The
 * backend adapter decides: the WASM adapter resolves `false` immediately where there is no
 * `WebAssembly` (never awaiting a promise that would hang, which is what keeps `unlockSync`
 * from freezing on native), and `true` after real init on web/Node; the native adapter
 * resolves `true` only when the JSI binding installed (a dev build) and `false` in Expo Go.
 * See `sodium.ts` / `sodium.native.ts`.
 */
export const cryptoAvailable: Promise<boolean> = sodiumAvailable;

// ---------------------------------------------------------------- serialization
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function str(s: string): Uint8Array {
  return utf8.encode(s);
}
function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function u64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function boolByte(b: boolean): Uint8Array {
  return new Uint8Array([b ? 1 : 0]);
}
function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** Canonical: each field length-prefixed (u32be) then concatenated. */
function canon(fields: Uint8Array[]): Uint8Array {
  const out: Uint8Array[] = [];
  for (const f of fields) {
    out.push(u32be(f.length), f);
  }
  return concat(out);
}

// ---------------------------------------------------------------- subkeys
const KDF_CTX = 'tinhsync'; // exactly crypto_kdf_CONTEXTBYTES (8)
/** Per-purpose subkey ids (scoped by which master derives them). */
const SUB = {
  // from DEK / a content key
  nodeEnc: 1,
  dekCheck: 2,
  manifestMac: 3,
  compileEnc: 4,
  presetEnc: 5,
  exportEnc: 6, // §27 encrypted backup: the export blob's AEAD subkey
  // from KEK / RKEK
  dekWrap: 1,
  passCheck: 2,
  // from a GRANT TOKEN (SPEC-AGENT §4.1). Ids 7/8 rather than 1/2 purely so a
  // reader never has to check which master a number belongs to — scoping is by
  // master, so they could not have collided either way.
  grantAuth: 7,
  grantWrap: 8,
  // from the account DEK — a grant's MUTABLE half (SPEC-AGENT §4.2b). Its own
  // subkey rather than `exportEnc` because a §27 backup blob and a grant scope
  // must not be interchangeable even in principle.
  grantScopeEnc: 9,
} as const;

function subkey(master: Uint8Array, id: number): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(32, id, KDF_CTX, master);
}

// ---------------------------------------------------------------- generation
export function generateDek(): Uint8Array {
  return sodium.crypto_kdf_keygen(); // 32 random bytes, a valid kdf master
}
export function generateKeyId(): string {
  return sodium.to_hex(sodium.randombytes_buf(16)); // 128-bit, globally unique
}
/** Legacy v1 recovery keys were 32 raw bytes shown as base64; still accepted at entry. */
export function generateRecoveryKey(): Uint8Array {
  return sodium.randombytes_buf(32); // 256-bit
}
/** §12.2 recovery keys: 128-bit entropy, presented as 12 BIP39 words (see recovery.ts). */
export function generateRecoveryEntropy(): Uint8Array {
  return sodium.randombytes_buf(16);
}
/** SHA-256 (for the BIP39 checksum — recovery.ts). */
export function sha256(data: Uint8Array): Uint8Array {
  return sodium.crypto_hash_sha256(data);
}
export function newSalt(): Uint8Array {
  return sodium.randombytes_buf(sodium.SALTBYTES); // 16
}
export const b64 = (b: Uint8Array): string => sodium.to_base64(b);
export const unb64 = (s: string): Uint8Array => sodium.from_base64(s);

// ---------------------------------------------------------------- KDFs
export interface KdfParams {
  opslimit: number;
  memlimit: number;
}
/** §12.1 baseline — MODERATE, pinned regardless of device for at-rest wrapping. */
export const PASS_KDF = (): KdfParams => ({
  opslimit: sodium.OPSLIMIT_MODERATE,
  memlimit: sodium.MEMLIMIT_MODERATE,
});

/**
 * §12.1 allowlist — `pass_params` arrive from the server, so they are bounded in BOTH
 * directions: below the MODERATE floor is a downgrade attack; above the cap is resource
 * exhaustion (an unbounded memlimit fed to crypto_pwhash would OOM/hang the unlock).
 * Callers fail closed with the corrupted-keys diagnostic when this returns false.
 */
export function passParamsAllowed(p: KdfParams): boolean {
  return (
    Number.isInteger(p.opslimit) &&
    Number.isInteger(p.memlimit) &&
    p.opslimit >= sodium.OPSLIMIT_MODERATE &&
    p.opslimit <= 6 &&
    p.memlimit >= sodium.MEMLIMIT_MODERATE &&
    p.memlimit <= 1024 * 1024 * 1024
  );
}

/** KEK = Argon2id(passphrase). */
export function deriveKek(passphrase: Uint8Array, salt: Uint8Array, p: KdfParams): Uint8Array {
  return sodium.crypto_pwhash(
    32,
    passphrase,
    salt,
    p.opslimit,
    p.memlimit,
    sodium.ALG_ARGON2ID13
  );
}
/** RKEK = a fast keyed hash — the recovery key is already 256-bit high-entropy. */
export function deriveRkek(recoveryKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(32, recoveryKey, salt);
}

// ---------------------------------------------------------------- wrap / unwrap
/**
 * Which secret a wrap is held under. `pass`/`recovery` are the §6a account pair;
 * `private` is SPEC-PRIVATE §3's own word; `grant` is SPEC-AGENT §4.2's agent
 * door. The role rides the wrap AAD, so it is also what stops one wrap being
 * presented as another — a grant bundle can never be served as the account's
 * passphrase wrap, or the reverse.
 */
export type WrapRole = 'pass' | 'recovery' | 'private' | 'grant';

/** v2 wrap AAD — ASCII by construction (see nodeAadV2's rationale); salt hex-encoded. */
function wrapAadV2(
  userId: string,
  keyId: string,
  role: WrapRole,
  alg: string,
  p: KdfParams,
  salt: Uint8Array
): string {
  return [
    'tinhead-dekwrap-v2',
    userId,
    keyId,
    role,
    alg,
    String(p.opslimit),
    String(p.memlimit),
    sodium.to_hex(salt),
  ].join('|');
}
function wrapAadV1(
  userId: string,
  keyId: string,
  role: WrapRole,
  alg: string,
  p: KdfParams,
  salt: Uint8Array
): Uint8Array {
  return canon([
    str('tinhead-dekwrap-v1'),
    str(userId),
    str(keyId),
    str(role),
    str(alg),
    u64be(p.opslimit),
    u64be(p.memlimit),
    salt,
  ]);
}
export function wrapDek(
  dek: Uint8Array,
  wrapMaster: Uint8Array,
  userId: string,
  keyId: string,
  role: WrapRole,
  alg: string,
  p: KdfParams,
  salt: Uint8Array
): string {
  const key = subkey(wrapMaster, SUB.dekWrap);
  const nonce = sodium.randombytes_buf(sodium.NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    dek,
    wrapAadV2(userId, keyId, role, alg, p, salt),
    null,
    nonce,
    key
  );
  return sodium.to_base64(concat([nonce, ct]));
}
/** Throws if the wrap key is wrong or the blob is corrupt. */
export function unwrapDek(
  wrapped: string,
  wrapMaster: Uint8Array,
  userId: string,
  keyId: string,
  role: WrapRole,
  alg: string,
  p: KdfParams,
  salt: Uint8Array
): Uint8Array {
  const raw = sodium.from_base64(wrapped);
  const n = sodium.NPUBBYTES;
  const nonce = raw.subarray(0, n);
  const ct = raw.subarray(n);
  const key = subkey(wrapMaster, SUB.dekWrap);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ct,
      wrapAadV2(userId, keyId, role, alg, p, salt),
      nonce,
      key
    );
  } catch {
    // Legacy v1 (binary-AAD) wrap — wasm-only; the engine re-wraps to v2 at unlock.
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ct,
      wrapAadV1(userId, keyId, role, alg, p, salt),
      nonce,
      key
    );
  }
}

// ---------------------------------------------------------------- checks
function keyCheckInput(salt: Uint8Array, p: KdfParams, keyId: string): Uint8Array {
  return canon([str('tinhead-keycheck-v1'), salt, u64be(p.opslimit), u64be(p.memlimit), str(keyId)]);
}
/** A KEK/RKEK-keyed MAC verifiable WITHOUT the DEK — separates wrong-secret from corrupt row. */
export function keyCheck(wrapMaster: Uint8Array, salt: Uint8Array, p: KdfParams, keyId: string): string {
  return sodium.to_base64(sodium.crypto_auth(keyCheckInput(salt, p, keyId), subkey(wrapMaster, SUB.passCheck)));
}
export function verifyKeyCheck(
  mac: string,
  wrapMaster: Uint8Array,
  salt: Uint8Array,
  p: KdfParams,
  keyId: string
): boolean {
  try {
    return sodium.crypto_auth_verify(sodium.from_base64(mac), keyCheckInput(salt, p, keyId), subkey(wrapMaster, SUB.passCheck));
  } catch {
    return false;
  }
}
/** A DEK-keyed MAC used AFTER a successful unwrap to confirm the DEK matches the node set. */
export function dekCheck(dek: Uint8Array, userId: string, keyId: string): string {
  return sodium.to_base64(
    sodium.crypto_auth(canon([str('tinhead-dekcheck-v1'), str(userId), str(keyId)]), subkey(dek, SUB.dekCheck))
  );
}

// ---------------------------------------------------------------- grant token
/**
 * SPEC-AGENT §4.1 — the split grant token, the key path for the agent door.
 *
 * A grant hands one 256-bit token to an MCP process ONCE. That token has two
 * jobs, and they must not be the same secret: it AUTHENTICATES the caller to the
 * server, and it derives the key the account DEK is WRAPPED under. The spec's
 * first draft used the raw token for both — so every connect handed the server
 * the one value that opens the blob stored beside it, which is the hosted
 * variant SPEC-AGENT §3 rejects, reached by accident rather than by decision.
 *
 * The token is 32 random bytes, i.e. a valid `crypto_kdf` master exactly like a
 * DEK — so this file's own key-separation rule already answers it: a master is
 * only ever a master, and every purpose derives its own subkey. `grantAuth` and
 * `grantWrap` are two subkey ids off that one master. BLAKE2b is one-way and the
 * two draws are independent, so **holding `grantAuth` yields neither `grantWrap`
 * nor the token** — which is the whole claim: the server can hold the value it
 * is sent, in a log, forever, and still not open the bundle beside it.
 *
 * NOT HKDF: there is none on the `./sodium` adapter interface on either backend,
 * and grants are minted on Android through the JSI adapter — specifying one was
 * a build blocker, not a naming choice. NOT Argon2id: the input is 256-bit
 * random, so memory-hard stretching buys nothing and would cost startup latency
 * on every connect (Argon2id stays with the human-chosen secrets — the sync
 * passphrase and §27's file password). `crypto_kdf_derive_from_key` is real
 * libsodium C on both backends and byte-identical between them.
 */

/** The token: 32 random bytes, shown once, never stored by the app or the server. */
export function generateGrantToken(): Uint8Array {
  return sodium.crypto_kdf_keygen();
}

/** SENT to the server on every connect. Authenticates; opens nothing. */
export function deriveGrantAuth(token: Uint8Array): Uint8Array {
  return subkey(token, SUB.grantAuth);
}

/** NEVER sent. Wraps the DEK (`wrapDek`, role `grant`). */
export function deriveGrantWrap(token: Uint8Array): Uint8Array {
  return subkey(token, SUB.grantWrap);
}

/**
 * What the server STORES for a grant — a keyed hash of `grantAuth`, so a dump
 * does not even yield a replayable credential for the bundle endpoint. The key
 * is a fixed domain constant of exactly 16 bytes (`crypto_generichash`'s minimum
 * key length; do not shorten the string).
 */
const GRANT_HASH_KEY = str('tinhead-grant-v1'); // 16 bytes exactly — see above
export function hashGrantAuth(grantAuth: Uint8Array): string {
  return sodium.to_base64(sodium.crypto_generichash(32, grantAuth, GRANT_HASH_KEY));
}

/**
 * The wrap AAD's `alg` for a grant bundle — it names the derivation the wrap key
 * came from, exactly as `argon2id`/`blake2b` do for the account pair.
 */
export const GRANT_ALG = 'kdf-blake2b';

/**
 * The wrap AAD carries KDF-cost fields because the PASSPHRASE path needs them.
 * This path has no cost to declare, so it declares none — a fixed sentinel that
 * binds nothing and must simply be identical on both sides of the wrap.
 *
 * **`passParamsAllowed` must never be applied to these.** That is the §12.1
 * allowlist for server-supplied Argon2id params; a floor check here would reject
 * every grant that has ever been minted, which is a fail-closed bug wearing the
 * costume of a security check.
 */
export const GRANT_PARAMS: KdfParams = { opslimit: 0, memlimit: 0 };

/**
 * SPEC-AGENT §4.2b — a grant's scope, sealed under the ACCOUNT DEK rather than
 * under `grantWrap`.
 *
 * **Why the two halves are held under different keys.** A grant hands out one
 * token, once, and the app never keeps it — so anything sealed under `grantWrap`
 * is frozen the instant the code is shown. That is right for the DEK (a key
 * should not be re-issuable without re-issuing the credential) and wrong for the
 * scope, because the whole product shape is that you connect Claude Code once
 * and then grant and un-grant BRANCHES over time. Sealing the scope under the
 * DEK — which the app holds whenever the vault is unlocked — makes it rewritable
 * without the token, while a server that holds neither still cannot read it or
 * forge one.
 *
 * `grantId` and `rev` ride the AAD, so a blob cannot be moved to another grant
 * and cannot be relabelled with a revision it does not carry.
 *
 * **The residual, stated rather than buried:** the server chooses which sealed
 * scope it serves, so a malicious one can replay an EARLIER revision — bounded
 * by a scope the user themselves once set, never a wider one it invented. The
 * door is stateless (§4.3) and has nothing to compare a revision against. This
 * sits inside §8's existing concession that branch scope is policy enforced by
 * the open client, and it is the price of the scope being able to move at all.
 */
function grantScopeAad(userId: string, keyId: string, grantId: string, rev: number): string {
  return ['tinhead-grantscope-v1', userId, keyId, grantId, String(rev)].join('|');
}
export function sealGrantScope(
  dek: Uint8Array,
  userId: string,
  keyId: string,
  grantId: string,
  rev: number,
  json: string
): string {
  const nonce = sodium.randombytes_buf(sodium.NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    str(json),
    grantScopeAad(userId, keyId, grantId, rev),
    null,
    nonce,
    subkey(dek, SUB.grantScopeEnc)
  );
  return sodium.to_base64(concat([nonce, ct]));
}
/** Null on a MAC failure — a wrong DEK, a tampered blob, or a relabelled revision. */
export function openGrantScope(
  dek: Uint8Array,
  userId: string,
  keyId: string,
  grantId: string,
  rev: number,
  blob: string
): string | null {
  let raw: Uint8Array;
  try {
    raw = sodium.from_base64(blob);
  } catch {
    return null;
  }
  const n = sodium.NPUBBYTES;
  if (raw.length <= n) return null;
  try {
    return fromUtf8.decode(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        raw.subarray(n),
        grantScopeAad(userId, keyId, grantId, rev),
        raw.subarray(0, n),
        subkey(dek, SUB.grantScopeEnc)
      )
    );
  } catch {
    return null;
  }
}

// ------------------------------------------------- §27 encrypted-backup blob
/**
 * Encrypt an arbitrary UTF-8 blob (the export envelope JSON) under a content key —
 * the same XChaCha20-Poly1305 AEAD every other path uses, over its own `exportEnc`
 * subkey, `aad` binding a context string so a blob can't be lifted into another role.
 * Returns `base64(nonce ‖ ciphertext)`. The content key is itself wrapped under a
 * passphrase-KEK via `wrapDek` ([model]/encryptedEnvelope), so the file is opaque.
 */
export function encryptBlob(contentKey: Uint8Array, aad: string, plaintext: string): string {
  const nonce = sodium.randombytes_buf(sodium.NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    str(plaintext),
    aad,
    null,
    nonce,
    subkey(contentKey, SUB.exportEnc)
  );
  return sodium.to_base64(concat([nonce, ct]));
}
/** Reverse of `encryptBlob`. Null on a MAC failure (wrong key or a tampered blob). */
export function decryptBlob(contentKey: Uint8Array, aad: string, blob: string): string | null {
  const raw = sodium.from_base64(blob);
  const n = sodium.NPUBBYTES;
  try {
    const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.subarray(n),
      aad,
      raw.subarray(0, n),
      subkey(contentKey, SUB.exportEnc)
    );
    return fromUtf8.decode(pt);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- node encrypt / decrypt
/**
 * AAD v2 (ASCII canonical): react-native-libsodium's JSI layer hard-requires AEAD
 * additional data to be a STRING (validateIsString in its C++), so binary AAD cannot
 * cross the native bridge. Every component here is ASCII by construction (uuids, hex,
 * decimals, role words), so the pipe-joined string UTF-8-encodes to identical bytes on
 * every backend and survives any string-only FFI. '|' cannot occur inside a component.
 * The check MACs and the manifest MAC keep the binary canon — crypto_auth accepts
 * binary messages on all backends. v1 (binary-AAD) rows still decrypt via a wasm-only
 * fallback; the engine's one-time reformat sweep re-encrypts old corpora to v2 so
 * native never needs the fallback.
 */
function nodeAadV2(userId: string, nodeId: string, keyId: string, version: number, deleted: boolean): string {
  return ['tinhead-node-v2', userId, nodeId, keyId, String(version), deleted ? '1' : '0'].join('|');
}
function nodeAadV1(userId: string, nodeId: string, keyId: string, version: number, deleted: boolean): Uint8Array {
  return canon([str('tinhead-node-v1'), str(userId), str(nodeId), str(keyId), u64be(version), boolByte(deleted)]);
}
const TOMBSTONE_MARKER = str(' '); // fixed marker for deleted rows (authenticated, not null)

/**
 * §12.7 metadata padding: live plaintexts are `0x01 ‖ pad₅₁₂(json)` (ISO/IEC 7816-4 via the
 * pure-JS pad512 below), so most thoughts land in one 512-byte bucket and are size-indistinguishable.
 * Legacy v1 rows begin `{` (0x7B) — decrypt discriminates on the first byte, so old rows
 * keep decrypting and converge to the padded format as they are next edited. Tombstone
 * markers stay 1 byte: `deleted` is a plaintext column anyway, their size hides nothing.
 */
const PAD_BLOCK = 512;
const PAD_FRAME = 0x01;

/**
 * ISO/IEC 7816-4 padding to a multiple of PAD_BLOCK — pure JS, backend-independent (padding
 * has no secret inputs), so the JSI backend never needs libsodium's `pad`. Byte-identical to
 * `sodium.pad(data, 512)`: append one 0x80 marker then 0x00 up to the next block boundary,
 * ALWAYS adding at least one byte (a length that is already a multiple gains a full block).
 * A jest parity test (`__tests__/vectors.test.ts`) pins this against `sodium.pad` on WASM.
 */
export function padTo(data: Uint8Array, block: number): Uint8Array {
  const padLen = block - (data.length % block); // 1..block (never 0)
  const out = new Uint8Array(data.length + padLen);
  out.set(data, 0);
  out[data.length] = 0x80; // trailing bytes are already 0x00
  return out;
}
export function pad512(data: Uint8Array): Uint8Array {
  return padTo(data, PAD_BLOCK);
}
/** Inverse of pad512: strip trailing 0x00 back to the 0x80 marker. Input is AEAD-authenticated. */
export function unpad512(padded: Uint8Array): Uint8Array {
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0x00) i--;
  if (i < 0 || padded[i] !== 0x80) throw new Error('invalid padding');
  return padded.subarray(0, i);
}

/** `plaintextJson` is the §4 syncable projection; for a delete pass deleted=true. */
export function encryptNode(
  dek: Uint8Array,
  userId: string,
  nodeId: string,
  keyId: string,
  version: number,
  deleted: boolean,
  plaintextJson: string
): string {
  const nonce = sodium.randombytes_buf(sodium.NPUBBYTES);
  const msg = deleted
    ? TOMBSTONE_MARKER
    : concat([new Uint8Array([PAD_FRAME]), pad512(str(plaintextJson))]);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    msg,
    nodeAadV2(userId, nodeId, keyId, version, deleted),
    null,
    nonce,
    subkey(dek, SUB.nodeEnc)
  );
  return sodium.to_base64(concat([nonce, ct]));
}
/** Returns the JSON string for a live node, or null for a (verified) tombstone. Throws on MAC failure. */
export function decryptNode(
  dek: Uint8Array,
  userId: string,
  nodeId: string,
  keyId: string,
  version: number,
  deleted: boolean,
  ciphertext: string
): string | null {
  const raw = sodium.from_base64(ciphertext);
  const n = sodium.NPUBBYTES;
  const key = subkey(dek, SUB.nodeEnc);
  let pt: Uint8Array;
  try {
    pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.subarray(n),
      nodeAadV2(userId, nodeId, keyId, version, deleted),
      raw.subarray(0, n),
      key
    );
  } catch {
    // Legacy v1 (binary-AAD) row — wasm-only fallback; native throws before sodium runs,
    // which is correct: the reformat sweep guarantees phones never meet a v1 row.
    pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.subarray(n),
      nodeAadV1(userId, nodeId, keyId, version, deleted),
      raw.subarray(0, n),
      key
    );
  }
  if (deleted) return null;
  // §12.7 framing: padded (0x01-prefixed) vs legacy raw JSON (starts '{').
  const body = pt[0] === PAD_FRAME ? unpad512(pt.subarray(1)) : pt;
  return fromUtf8.decode(body);
}

// ---------------------------------------------------------------- compile encrypt / decrypt
/**
 * SPEC-SYNC §4.2 — the compile-shelf channel's AEAD binding. Its own context string AND
 * its own DEK subkey, so a compile ciphertext can never be replayed as a node row (or
 * vice versa): the AAD would fail even before the key separation does. No version in the
 * AAD on purpose — shelf records are derived snapshots at a deliberately weaker tier
 * than §7's thoughts (no manifest, no CAS); the accepted consequences are written in
 * §4.2, not implied. ASCII throughout, same rationale as nodeAadV2.
 */
function compileAad(userId: string, compileId: string, keyId: string): string {
  return ['tinhead-compile-v1', userId, compileId, keyId].join('|');
}

/** `plaintextJson` is the CompileRecord minus its id (the id rides the AAD). */
export function encryptCompile(
  dek: Uint8Array,
  userId: string,
  compileId: string,
  keyId: string,
  plaintextJson: string
): string {
  const nonce = sodium.randombytes_buf(sodium.NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    concat([new Uint8Array([PAD_FRAME]), pad512(str(plaintextJson))]),
    compileAad(userId, compileId, keyId),
    null,
    nonce,
    subkey(dek, SUB.compileEnc)
  );
  return sodium.to_base64(concat([nonce, ct]));
}
/** Returns the JSON string. Throws on MAC failure or bad framing. */
export function decryptCompile(
  dek: Uint8Array,
  userId: string,
  compileId: string,
  keyId: string,
  ciphertext: string
): string {
  const raw = sodium.from_base64(ciphertext);
  const n = sodium.NPUBBYTES;
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    raw.subarray(n),
    compileAad(userId, compileId, keyId),
    raw.subarray(0, n),
    subkey(dek, SUB.compileEnc)
  );
  if (pt[0] !== PAD_FRAME) throw new Error('invalid compile framing');
  return fromUtf8.decode(unpad512(pt.subarray(1)));
}

// ---------------------------------------------------------------- preset encrypt / decrypt
/**
 * §4.3 — the custom-preset channel: same shelf tier as compiles, its own subkey and
 * AAD context so no two channels' ciphertexts can impersonate each other (or a node).
 */
function presetAad(userId: string, presetId: string, keyId: string): string {
  return ['tinhead-preset-v1', userId, presetId, keyId].join('|');
}

/** `plaintextJson` is the Preset minus its id (the id rides the AAD). */
export function encryptPreset(
  dek: Uint8Array,
  userId: string,
  presetId: string,
  keyId: string,
  plaintextJson: string
): string {
  const nonce = sodium.randombytes_buf(sodium.NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    concat([new Uint8Array([PAD_FRAME]), pad512(str(plaintextJson))]),
    presetAad(userId, presetId, keyId),
    null,
    nonce,
    subkey(dek, SUB.presetEnc)
  );
  return sodium.to_base64(concat([nonce, ct]));
}
/** Returns the JSON string. Throws on MAC failure or bad framing. */
export function decryptPreset(
  dek: Uint8Array,
  userId: string,
  presetId: string,
  keyId: string,
  ciphertext: string
): string {
  const raw = sodium.from_base64(ciphertext);
  const n = sodium.NPUBBYTES;
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    raw.subarray(n),
    presetAad(userId, presetId, keyId),
    raw.subarray(0, n),
    subkey(dek, SUB.presetEnc)
  );
  if (pt[0] !== PAD_FRAME) throw new Error('invalid preset framing');
  return fromUtf8.decode(unpad512(pt.subarray(1)));
}

// ---------------------------------------------------------------- private field
/**
 * SPEC-PRIVATE §3 — a covered detail field, and **the one channel here that is
 * a PADLOCK rather than a key**.
 *
 * Every other channel is symmetric: the same secret that encrypts also decrypts,
 * so the app must be holding it to WRITE. That is exactly wrong for this one.
 * Writing an ordinary thought never asks the user for anything, and the founder
 * caught the asymmetry immediately — covering a field must not be the one act in
 * the app that demands a passphrase up front.
 *
 * So this is an anonymous **sealed box** (X25519 + XSalsa20-Poly1305, libsodium's
 * `crypto_box_seal`): a keypair is made once, the PUBLIC half is kept plainly
 * available and can only ever lock, and the SECRET half is wrapped under the
 * sync passphrase and never cached. You can snap a padlock shut without the key
 * to it — so `sealPrivate` needs nothing secret and never prompts, while
 * `openPrivate` needs the half that only exists while the passphrase is typed.
 * Someone with a copy of the database has the public half and it buys them
 * nothing: it cannot open what it closed.
 *
 * **There is no AAD on this primitive, and nothing is lost.** The AEAD version
 * bound the private key id and deliberately nothing else — binding the node id
 * or field index would have been a data-loss bug, because `normalizeDetails`
 * promotes a sealed extra to `body` when the body is cleared, and §27
 * `planImport` MINTS A NEW ID for a colliding node. The key-id binding that
 * remained only distinguished envelopes, which a wrong secret key already does
 * by failing to open. The ephemeral-sender construction supplies the freshness
 * a nonce would.
 */

/**
 * §12.7 padding for a secret rather than a thought: 128-byte buckets, not 512.
 * A private field is sealed INSIDE a node blob that is itself padded to 512, so
 * the coarse bucket is already hidden; 128 is what keeps a 4-digit PIN and a
 * twelve-word recovery phrase the same size without inflating every node that
 * holds one into another 512-bucket of its own.
 */
const PRIVATE_PAD_BLOCK = 128;

/** The padlock and its key. The public half is stored in the clear, on purpose. */
export function generatePrivateKeypair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  return sodium.crypto_box_keypair();
}

/**
 * Seal one detail field with the PUBLIC half alone — no secret, no prompt, no
 * session. Returns base64 of the sealed box; the `priv1:` prefix is [model]'s.
 */
export function sealPrivate(publicKey: Uint8Array, plaintext: string): string {
  return sodium.to_base64(
    sodium.crypto_box_seal(
      concat([new Uint8Array([PAD_FRAME]), padTo(str(plaintext), PRIVATE_PAD_BLOCK)]),
      publicKey
    )
  );
}

/**
 * Open one, which needs both halves. **Null rather than a throw**, unlike the
 * shelf channels: this runs at render, once per covered field, and not having
 * the key is an ORDINARY state here (the word for a corpus you have not
 * unlocked), not an integrity alarm. The caller draws dots either way.
 */
export function openPrivate(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  blob: string
): string | null {
  try {
    const pt = sodium.crypto_box_seal_open(sodium.from_base64(blob), publicKey, privateKey);
    if (pt[0] !== PAD_FRAME) return null;
    return fromUtf8.decode(unpad512(pt.subarray(1)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- manifest
export interface ManifestEntry {
  id: string;
  version: number;
  deleted: boolean;
}
/** counter + key_id + user_id bound INSIDE the message; entries sorted by id for determinism. */
function manifestMessage(userId: string, keyId: string, counter: number, entries: ManifestEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fields: Uint8Array[] = [str('tinhead-manifest-v1'), str(userId), str(keyId), u64be(counter)];
  for (const e of sorted) fields.push(str(e.id), u64be(e.version), boolByte(e.deleted));
  return canon(fields);
}
export function manifestMac(
  dek: Uint8Array,
  userId: string,
  keyId: string,
  counter: number,
  entries: ManifestEntry[]
): string {
  return sodium.to_base64(sodium.crypto_auth(manifestMessage(userId, keyId, counter, entries), subkey(dek, SUB.manifestMac)));
}
export function verifyManifestMac(
  mac: string,
  dek: Uint8Array,
  userId: string,
  keyId: string,
  counter: number,
  entries: ManifestEntry[]
): boolean {
  try {
    return sodium.crypto_auth_verify(
      sodium.from_base64(mac),
      manifestMessage(userId, keyId, counter, entries),
      subkey(dek, SUB.manifestMac)
    );
  } catch {
    return false;
  }
}

/** Zero a sensitive buffer (best-effort; JS strings cannot be zeroed — marshal early). */
export function wipe(buf: Uint8Array): void {
  sodium.memzero(buf);
}
