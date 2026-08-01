/**
 * [mcp] SPEC-AGENT §4 — minting and opening a grant. The whole key path, in
 * one file, imported by BOTH the app (which mints) and `tinhead-mcp` (which
 * opens), so the two can never drift.
 *
 * The claim this file is responsible for: **the server holds a key it cannot
 * use.** It is sent `grantAuth` on every connect and it stores the wrapped
 * bundle beside it, so everything rests on `grantAuth` being useless against
 * that blob. See [crypto]'s `deriveGrantAuth`/`deriveGrantWrap` for why it is
 * (two independent one-way subkey draws off one `crypto_kdf` master).
 *
 * **TWO SEALS, not one** (§4.2 / §4.2b, 2026-07-31). The DEK is sealed under
 * `grantWrap` and is therefore frozen the instant the code is shown — the app
 * keeps no token and could not re-seal it if it wanted to. The SCOPE is sealed
 * separately under the account DEK, which the app holds whenever the vault is
 * open, so branches can be granted and taken back for the life of one
 * connection. Both are opaque to the server; only one of them can move.
 *
 * Pure — no store, no React, no network. `await cryptoReady` before calling.
 */

import {
  GRANT_ALG,
  GRANT_PARAMS,
  b64,
  deriveGrantAuth,
  deriveGrantWrap,
  generateGrantToken,
  generateKeyId,
  hashGrantAuth,
  newSalt,
  openGrantScope,
  sealGrantScope,
  str,
  unb64,
  unwrapDek,
  wipe,
  wrapDek,
} from '../crypto';
import {
  Grant,
  GrantAvailability,
  GrantBundle,
  GrantRow,
  GrantScope,
  OpenedGrant,
} from './types';

/** A grant token is exactly one `crypto_kdf` master. Anything else is not a token. */
const TOKEN_BYTES = 32;

/**
 * What rides under `grantWrap`. JSON rather than the raw 32 bytes for the same
 * reason [sync]'s payload is (§4.1 forward-compatibility): a future field is
 * additive, and an older door that does not know it simply ignores it rather
 * than failing to open a bundle.
 *
 * `branch` / `write` / `reads` are the LEGACY scope fields. Nothing writes them
 * any more — a grant minted today carries its scope in its own seal — but a
 * grant minted before 2026-07-31 has them here and must keep opening.
 */
interface SealedBundle {
  /** base64 of the 32-byte account DEK. */
  dek: string;
  branch?: string | null;
  write?: boolean;
  reads?: string;
}

/** What rides under the account DEK. The half that is allowed to change. */
interface SealedScope {
  branches?: unknown;
  write?: unknown;
  reads?: unknown;
}

/** A minted grant: the three pieces go to three different places, exactly once. */
export interface MintedGrant {
  /** SHOWN ONCE to the user, then forgotten by the app. Never stored anywhere. */
  token: string;
  /** Kept device-local by the app and listed at `Settings › Plugins`. */
  grant: Grant;
  /** Written to the server. Holds no usable key and no readable scope. */
  row: GrantRow;
}

export interface MintOptions {
  name: string;
  scope: GrantScope;
  /**
   * Reuse an existing local id instead of minting one. The app's shape needs
   * this: a connection is set up (and given branches) before it has a code, and
   * it must stay the same connection across issuing — a new id would remount its
   * section and, less visibly, orphan whatever the user was looking at. There is
   * no server row before issuing, so nothing collides.
   */
  id?: string;
  /** §5 — `always` is the default because that is what minting a grant is FOR. */
  availability?: GrantAvailability;
  /** Injectable only so tests can pin a stamp; production passes nothing. */
  now?: number;
}

/** Every scope write starts here, so `branches` can never carry a duplicate or a blank. */
export function normalizeScope(scope: GrantScope): GrantScope {
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const b of scope.branches ?? []) {
    if (typeof b !== 'string' || !b || seen.has(b)) continue;
    seen.add(b);
    branches.push(b);
  }
  return { branches, write: scope.write === true, reads: scope.reads === 'everything' ? 'everything' : 'branch' };
}

/** The scope blob for a grant at a revision. The app re-calls this on every scope change. */
export function sealScope(
  dek: Uint8Array,
  userId: string,
  keyId: string,
  grantId: string,
  rev: number,
  scope: GrantScope
): string {
  const s = normalizeScope(scope);
  return sealGrantScope(
    dek,
    userId,
    keyId,
    grantId,
    rev,
    JSON.stringify({ branches: s.branches, write: s.write, reads: s.reads })
  );
}

/**
 * Mint a grant against the account DEK. Runs in the app, which holds the DEK.
 *
 * The token is generated, used twice, and dropped: this function returns it as
 * a string for the one screen that shows it, and keeps no reference. The app
 * must not persist it — the whole point of `hashGrantAuth` is that there is
 * nothing to steal from either end afterwards.
 */
export function mintGrant(
  dek: Uint8Array,
  userId: string,
  keyId: string,
  opts: MintOptions
): MintedGrant {
  const now = opts.now ?? Date.now();
  const id = opts.id ?? generateKeyId();
  const scope = normalizeScope(opts.scope);
  const token = generateGrantToken();
  const auth = deriveGrantAuth(token);
  const wrap = deriveGrantWrap(token);
  const salt = newSalt();

  // Under grantWrap: the key, and nothing that will ever need to change.
  const sealed: SealedBundle = { dek: b64(dek) };
  const wrapped = wrapDek(
    str(JSON.stringify(sealed)),
    wrap,
    userId,
    keyId,
    'grant',
    GRANT_ALG,
    GRANT_PARAMS,
    salt
  );
  // Under the account DEK: the half the app may rewrite for the life of the grant.
  const scopeRev = 1;
  const scopeBlob = sealScope(dek, userId, keyId, id, scopeRev, scope);

  const availability = opts.availability ?? 'always';
  const out: MintedGrant = {
    token: b64(token),
    grant: {
      id,
      name: opts.name,
      // The minter IS the account — the record is device-local and a device
      // outlives a sign-in, so it has to carry who it belongs to.
      userId,
      branches: scope.branches,
      write: scope.write,
      reads: scope.reads,
      availability,
      keyId,
      createdAt: now,
      issuedAt: now,
      scopeRev,
      lastUsed: null,
    },
    row: {
      id,
      authHash: hashGrantAuth(auth),
      wrapped,
      salt: b64(salt),
      keyId,
      scope: scopeBlob,
      scopeRev,
      availability,
    },
  };
  // Best-effort: the derived buffers can go now. The token STRING cannot be
  // zeroed (JS strings are immutable — the same documented limit the passphrase
  // has, [crypto]), which is one more reason it is shown once and never stored.
  wipe(token);
  wipe(auth);
  wipe(wrap);
  return out;
}

/** What the door sends to authenticate. Derived fresh per connect; never persisted. */
export function grantAuthFor(token: string): string {
  const raw = decodeToken(token);
  const auth = deriveGrantAuth(raw);
  const out = b64(auth);
  wipe(raw);
  wipe(auth);
  return out;
}

/** A bundle that will not open. Distinguished so the door can say WHICH thing is wrong. */
export class GrantOpenError extends Error {
  constructor(
    message: string,
    /** `token` — wrong/garbled token or a tampered blob. `epoch` — the account re-keyed. */
    readonly kind: 'token' | 'epoch' | 'format'
  ) {
    super(message);
  }
}

/**
 * A token as bytes, or a legible refusal. The length check is the load-bearing
 * part: `from_base64` happily decodes a truncated paste, and `crypto_kdf` then
 * throws a bare `TypeError: invalid key length` from two layers down — which the
 * CLI printed verbatim at the exact moment a person had mis-copied something.
 */
function decodeToken(token: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = unb64(token.trim());
  } catch {
    throw new GrantOpenError('that token is not readable — copy it again from Tinhead', 'format');
  }
  if (raw.length !== TOKEN_BYTES) {
    wipe(raw);
    throw new GrantOpenError(
      'that token is not the right length — it may have been cut short when it was copied',
      'format'
    );
  }
  return raw;
}

/** A scope from wire data: every field re-armoured, every default the NARROW one. */
function readScope(raw: SealedScope): GrantScope {
  const list = Array.isArray(raw.branches) ? raw.branches : [];
  return normalizeScope({
    branches: list.filter((b): b is string => typeof b === 'string'),
    write: raw.write === true,
    reads: raw.reads === 'everything' ? 'everything' : 'branch',
  });
}

/**
 * Open a bundle with the token. Runs in `tinhead-mcp`, on the user's machine.
 *
 * The `epoch` failure is raised a layer up, in the door's hydration, where the
 * manifest's `key_id` is known: a §6j reset mints a new DEK and the grant dies
 * with the old one, and that deserves a sentence the user can act on rather than
 * a MAC error two layers down (§4.6).
 *
 * **The scope defaults to reaching NOTHING.** A bundle this build cannot fully
 * read must never resolve to more permission than it granted, and before §4.2b
 * a missing branch meant `null` meant the ROOT — the widest possible answer, in
 * exactly the forward-compatibility case the narrow-defaults rule exists for.
 */
export function openGrantBundle(token: string, bundle: GrantBundle): OpenedGrant {
  const raw = decodeToken(token);
  let salt: Uint8Array;
  try {
    salt = unb64(bundle.salt);
  } catch {
    wipe(raw);
    throw new GrantOpenError('this grant is corrupt', 'format');
  }
  const wrap = deriveGrantWrap(raw);
  let plain: Uint8Array;
  try {
    plain = unwrapDek(
      bundle.wrapped,
      wrap,
      bundle.userId,
      bundle.keyId,
      'grant',
      GRANT_ALG,
      GRANT_PARAMS,
      salt
    );
  } catch {
    throw new GrantOpenError('this grant does not open with that token', 'token');
  } finally {
    wipe(raw);
    wipe(wrap);
  }

  let dek: Uint8Array;
  let legacy: SealedBundle;
  try {
    legacy = JSON.parse(new TextDecoder().decode(plain)) as SealedBundle;
    dek = unb64(legacy.dek);
  } catch {
    throw new GrantOpenError('this grant is corrupt', 'format');
  }
  if (dek.length !== 32) throw new GrantOpenError('this grant is corrupt', 'format');

  // The current shape: a scope of its own, sealed under the DEK we just opened.
  if (bundle.scope) {
    const rev = typeof bundle.scopeRev === 'number' ? bundle.scopeRev : 0;
    const json = openGrantScope(dek, bundle.userId, bundle.keyId, bundle.id, rev, bundle.scope);
    if (json === null) {
      wipe(dek);
      throw new GrantOpenError('this grant’s permissions did not verify', 'format');
    }
    let parsed: SealedScope;
    try {
      parsed = JSON.parse(json) as SealedScope;
    } catch {
      wipe(dek);
      throw new GrantOpenError('this grant is corrupt', 'format');
    }
    return { dek, keyId: bundle.keyId, userId: bundle.userId, scope: readScope(parsed) };
  }

  // A grant minted before §4.2b carries a single `branch` inside the wrap. It
  // keeps working, read as a one-branch list.
  //
  // `branch: null` meant THE ROOT in that shape, and it is deliberately NOT
  // honoured here: it resolves to the empty list like everything else. Reviving
  // a whole-tree grant from a field a newer build no longer writes is the widest
  // possible reading of ambiguous wire data, which is precisely what the
  // narrow-defaults rule forbids — and it costs nothing real, because no grant
  // minted in that shape ever authenticated (the gateway compared `grantAuth`
  // against a stored hash of it, so every connect 401'd until 2026-07-31).
  const hasLegacyScope =
    'branch' in legacy || typeof legacy.write === 'boolean' || typeof legacy.reads === 'string';
  if (!hasLegacyScope) {
    wipe(dek);
    throw new GrantOpenError('this grant is missing its permissions', 'format');
  }
  return {
    dek,
    keyId: bundle.keyId,
    userId: bundle.userId,
    scope: normalizeScope({
      branches: typeof legacy.branch === 'string' ? [legacy.branch] : [],
      write: legacy.write === true,
      reads: legacy.reads === 'everything' ? 'everything' : 'branch',
    }),
  };
}
