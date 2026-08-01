import sodium from 'libsodium-wrappers-sumo';

/**
 * [crypto] The libsodium adapter — WEB / default backend (libsodium-wrappers-sumo, WASM).
 *
 * This is the ONLY module that imports a libsodium package on web/Node; `index.ts` and
 * everything above it import `./sodium`. Metro resolves `./sodium` to `sodium.native.ts`
 * (react-native-libsodium / JSI) on iOS + Android and to THIS file everywhere else; tsc
 * and jest resolve it here too (jest via a moduleNameMapper — see jest.config.js — because
 * the React-Native jest preset would otherwise prefer the `.native` file, which needs JSI).
 * The seam is byte-for-byte: both backends wrap the same libsodium primitives, and the
 * golden vectors in `./vectors.ts` pin their outputs identical.
 *
 * The `Sodium` interface below is the whole contract `index.ts` depends on. Keep the
 * function names/signatures matching libsodium-wrappers so the crypto call sites read the
 * same on both backends; constants get short names.
 */
export interface Sodium {
  // constants
  readonly SALTBYTES: number; // crypto_pwhash_SALTBYTES (16)
  readonly NPUBBYTES: number; // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES (24)
  readonly OPSLIMIT_MODERATE: number; // crypto_pwhash_OPSLIMIT_MODERATE (3)
  readonly MEMLIMIT_MODERATE: number; // crypto_pwhash_MEMLIMIT_MODERATE (256 MiB)
  readonly ALG_ARGON2ID13: number; // crypto_pwhash_ALG_ARGON2ID13 (2)
  // key material
  randombytes_buf(length: number): Uint8Array;
  crypto_kdf_keygen(): Uint8Array;
  crypto_kdf_derive_from_key(subkeyLen: number, subkeyId: number, ctx: string, key: Uint8Array): Uint8Array;
  // KDFs
  crypto_pwhash(
    keyLength: number,
    password: Uint8Array,
    salt: Uint8Array,
    opslimit: number,
    memlimit: number,
    alg: number
  ): Uint8Array;
  crypto_generichash(hashLength: number, message: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_hash_sha256(data: Uint8Array): Uint8Array;
  // AEAD — additionalData is a STRING on the v2 path (native requires it); v1 fallbacks pass
  // binary AAD, which only the WASM backend accepts (native never meets a v1 row — see index.ts).
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: string | Uint8Array,
    secretNonce: null,
    nonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;
  /**
   * SPEC-PRIVATE §3 — anonymous sealed boxes (X25519). The PADLOCK primitive:
   * `crypto_box_seal` needs only the PUBLIC key, so a private field is sealed
   * with nothing secret in hand and covering one never asks for a passphrase;
   * only `crypto_box_seal_open` needs the secret half. Present on BOTH backends
   * (`jsi_crypto_box_seal*` in react-native-libsodium, verified in its source).
   * No AAD parameter exists on this primitive — see index.ts for why the key-id
   * binding it replaces was already carrying nothing.
   */
  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array
  ): Uint8Array;
  // MACs
  crypto_auth(message: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_auth_verify(tag: Uint8Array, message: Uint8Array, key: Uint8Array): boolean;
  // encodings — the base64 variant is PINNED (URLSAFE_NO_PADDING); never rely on a default.
  to_base64(input: Uint8Array): string;
  from_base64(input: string): Uint8Array;
  to_hex(input: Uint8Array): string;
  // hygiene
  memzero(buf: Uint8Array): void;
}

// The one base64 variant every server row (wraps, checks, node ciphertext) is written in.
// libsodium-wrappers' to_base64 happens to default to this, but the native binding's could
// drift — so both adapters pass it explicitly. Getting this wrong corrupts every account. Read
// at CALL time: libsodium populates its constants only after `ready`, so a load-time capture
// would freeze the value as undefined.
const B64 = (): number => sodium.base64_variants.URLSAFE_NO_PADDING;

const impl: Sodium = {
  // Same reason the constants are getters, not eager reads: every access is post-`ready`
  // (gated by `available`/`cryptoAvailable`), so it sees the real value rather than undefined.
  get SALTBYTES() {
    return sodium.crypto_pwhash_SALTBYTES;
  },
  get NPUBBYTES() {
    return sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  },
  get OPSLIMIT_MODERATE() {
    return sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  },
  get MEMLIMIT_MODERATE() {
    return sodium.crypto_pwhash_MEMLIMIT_MODERATE;
  },
  get ALG_ARGON2ID13() {
    return sodium.crypto_pwhash_ALG_ARGON2ID13;
  },

  randombytes_buf: (length) => sodium.randombytes_buf(length),
  crypto_kdf_keygen: () => sodium.crypto_kdf_keygen(),
  crypto_kdf_derive_from_key: (len, id, ctx, key) => sodium.crypto_kdf_derive_from_key(len, id, ctx, key),

  crypto_pwhash: (keyLength, password, salt, ops, mem, alg) =>
    sodium.crypto_pwhash(keyLength, password, salt, ops, mem, alg),
  crypto_generichash: (hashLength, message, key) => sodium.crypto_generichash(hashLength, message, key),
  crypto_hash_sha256: (data) => sodium.crypto_hash_sha256(data),

  crypto_aead_xchacha20poly1305_ietf_encrypt: (message, aad, secretNonce, nonce, key) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, aad, secretNonce, nonce, key),
  crypto_aead_xchacha20poly1305_ietf_decrypt: (secretNonce, ciphertext, aad, nonce, key) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(secretNonce, ciphertext, aad, nonce, key),

  crypto_box_keypair: () => {
    const kp = sodium.crypto_box_keypair();
    return { publicKey: kp.publicKey, privateKey: kp.privateKey };
  },
  crypto_box_seal: (message, publicKey) => sodium.crypto_box_seal(message, publicKey),
  crypto_box_seal_open: (ciphertext, publicKey, privateKey) =>
    sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey),

  crypto_auth: (message, key) => sodium.crypto_auth(message, key),
  crypto_auth_verify: (tag, message, key) => sodium.crypto_auth_verify(tag, message, key),

  to_base64: (input) => sodium.to_base64(input, B64()),
  from_base64: (input) => sodium.from_base64(input, B64()),
  to_hex: (input) => sodium.to_hex(input),

  memzero: (buf) => sodium.memzero(buf),
};

export default impl;

/** Await once before any call. */
export const ready: Promise<void> = sodium.ready;
// On an engine without WebAssembly, libsodium's WASM load aborts and leaves `sodium.ready`
// PENDING FOREVER (Emscripten rejects its own internal promise, not this one). Attach a catch
// so any eventual rejection is never "unhandled" — but callers must never AWAIT this there.
// With the platform split this file is only reached on web/Node (WASM present), so this is
// belt-and-suspenders; the real native gate lives in sodium.native.ts.
void ready.catch(() => {});

/**
 * The single availability gate `thoughtSync` checks before any crypto/sync work. Resolves
 * `false` immediately where there is no `WebAssembly` (never awaiting a promise that would
 * hang); only where it exists (web, Node/tests) do we await real init.
 */
export const available: Promise<boolean> =
  typeof WebAssembly === 'undefined' ? Promise.resolve(false) : ready.then(() => true, () => false);
