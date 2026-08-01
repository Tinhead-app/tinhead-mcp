import {
  KdfParams,
  PASS_KDF,
  b64,
  decryptBlob,
  deriveKek,
  encryptBlob,
  generateDek,
  generateKeyId,
  keyCheck,
  newSalt,
  passParamsAllowed,
  str,
  unb64,
  unwrapDek,
  verifyKeyCheck,
  wipe,
  wrapDek,
} from '../crypto';

/**
 * SPEC-ACCOUNTS §27 — the ENCRYPTED backup file. A serious app never hands you a
 * plaintext dump of your thoughts to keep on a disk; this wraps the whole-corpus
 * envelope ([model]/envelope) under a password the user sets, so the saved file is
 * ciphertext. It reuses the exact key hierarchy the account already trusts (Argon2id
 * KEK → wrapped content key → XChaCha20-Poly1305 AEAD), so there is nothing new to
 * audit and no new algorithm. A plaintext export still exists for moving to another
 * app — but the BACKUP, the copy you keep, is encrypted by default.
 *
 * Not a "second recovery secret" (SPEC-GAPS B1's worry): this is a per-FILE password,
 * exactly like every encrypted-backup feature (1Password, iOS). Lose it and you lose
 * that file — the app's own recovery still hangs off the one passphrase/recovery key.
 */

export const ENCRYPTED_FORMAT = 'tinhead-encrypted-v1';
/** AAD context binding the blob to this role — a wrapped node blob can't be fed here. */
const EXPORT_AAD = 'tinhead-export-v1';
/** A fixed synthetic id for the wrap AAD (there is no server user for a local export). */
const EXPORT_USER = 'tinhead-export';

interface EncryptedFile {
  format: typeof ENCRYPTED_FORMAT;
  exportedAt: string;
  keyId: string;
  kdf: KdfParams;
  salt: string; // b64, the Argon2id salt
  check: string; // KEK-keyed MAC — tells a wrong password from a corrupt file
  wrapped: string; // the content key, wrapped under the password-KEK
  body: string; // the envelope JSON, AEAD-encrypted under the content key
}

/** Detect an encrypted backup without decrypting it (the import router uses this). */
export function isEncryptedBackup(text: string): boolean {
  try {
    return (JSON.parse(text) as { format?: unknown })?.format === ENCRYPTED_FORMAT;
  } catch {
    return false;
  }
}

/**
 * Encrypt a plaintext envelope JSON string under `password`. Optional `now` for
 * deterministic tests. The password floor is enforced by the CALLER at entry (the
 * same zxcvbn floor the passphrase uses) — this module assumes a vetted password.
 */
export function encryptEnvelope(plaintextJson: string, password: string, now?: number): string {
  const contentKey = generateDek();
  const keyId = generateKeyId();
  const salt = newSalt();
  const p = PASS_KDF();
  const kek = deriveKek(str(password), salt, p);
  try {
    const file: EncryptedFile = {
      format: ENCRYPTED_FORMAT,
      exportedAt: new Date(now ?? Date.now()).toISOString(),
      keyId,
      kdf: p,
      salt: b64(salt),
      check: keyCheck(kek, salt, p, keyId),
      wrapped: wrapDek(contentKey, kek, EXPORT_USER, keyId, 'pass', 'argon2id', p, salt),
      body: encryptBlob(contentKey, EXPORT_AAD, plaintextJson),
    };
    return JSON.stringify(file);
  } finally {
    wipe(kek);
    wipe(contentKey);
  }
}

export type DecryptResult =
  | { ok: true; json: string }
  | { ok: false; error: 'unreadable' | 'wrongPassword' | 'corrupt' };

/**
 * Open an encrypted backup with `password`. `wrongPassword` is distinguished from
 * `corrupt` by the KEK-keyed check MAC (verifiable without the content key), so a
 * user who mistyped is told to retry, and a genuinely tampered/damaged file is named
 * as such — never conflated.
 */
export function decryptEnvelope(fileText: string, password: string): DecryptResult {
  let f: EncryptedFile;
  try {
    f = JSON.parse(fileText) as EncryptedFile;
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  if (
    !f ||
    f.format !== ENCRYPTED_FORMAT ||
    typeof f.keyId !== 'string' ||
    typeof f.salt !== 'string' ||
    typeof f.check !== 'string' ||
    typeof f.wrapped !== 'string' ||
    typeof f.body !== 'string' ||
    !f.kdf ||
    typeof f.kdf.opslimit !== 'number' ||
    typeof f.kdf.memlimit !== 'number'
  ) {
    return { ok: false, error: 'unreadable' };
  }
  // Reject KDF params outside the §12.1 allowlist — a hand-forged header must not be
  // able to demand an absurd memlimit (a DoS) or an unsafe-low one (fail closed).
  if (!passParamsAllowed(f.kdf)) return { ok: false, error: 'corrupt' };

  let salt: Uint8Array;
  try {
    salt = unb64(f.salt);
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  const kek = deriveKek(str(password), salt, f.kdf);
  try {
    if (!verifyKeyCheck(f.check, kek, salt, f.kdf, f.keyId)) {
      return { ok: false, error: 'wrongPassword' };
    }
    let contentKey: Uint8Array;
    try {
      contentKey = unwrapDek(f.wrapped, kek, EXPORT_USER, f.keyId, 'pass', 'argon2id', f.kdf, salt);
    } catch {
      return { ok: false, error: 'corrupt' };
    }
    try {
      const json = decryptBlob(contentKey, EXPORT_AAD, f.body);
      return json === null ? { ok: false, error: 'corrupt' } : { ok: true, json };
    } finally {
      wipe(contentKey);
    }
  } finally {
    wipe(kek);
  }
}
