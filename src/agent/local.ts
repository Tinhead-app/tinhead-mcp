/**
 * [mcp] The grant list this device keeps. SPEC-AGENT §5.
 *
 * **Grants are credentials, so the record is device-local by construction.** The
 * key is not in [sync]'s mirror registry, which is default-deny — so it cannot
 * travel even if someone registers a key later without reading this — and it is
 * not in the §27 backup envelope either. A grant minted on the laptop must not
 * authorize the phone.
 *
 * The consequence, said plainly because the surface has to live with it: a grant
 * is managed from the device that made it. The SERVER row is what the door
 * redeems and what revoking deletes, and that row carries no name and no
 * readable branch — so another device could see that a grant exists but not what
 * it is for. Showing an unnameable list of ids on your phone is worse than
 * showing nothing.
 */

import { Grant, GrantReads, coerceAvailability } from './types';

/** Unlisted in the mirror registry ON PURPOSE — that is the whole mechanism. */
export const AGENT_GRANTS_KEY = 'agentGrants';

/**
 * Wire data until proven otherwise: every field is re-armoured on the way in,
 * and **every default is the less permissive answer**. A record this build
 * cannot fully read must never read as MORE permission — which for
 * `availability` means `off` rather than `always` (`coerceAvailability`), and
 * for `branches` means the empty list rather than the root.
 */
export function parseGrants(raw: string | null | undefined): Grant[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: Grant[] = [];
  for (const g of list) {
    // `null` and primitives are members of a JSON array too, and reading a
    // property off one throws rather than yielding undefined.
    if (!g || typeof g !== 'object') continue;
    const o = g as Partial<Grant> & { branch?: unknown };
    if (typeof o.id !== 'string' || !o.id) continue;
    out.push({
      id: o.id,
      name: typeof o.name === 'string' ? o.name : '',
      userId: typeof o.userId === 'string' ? o.userId : '',
      branches: readBranches(o),
      write: o.write === true,
      reads: (o.reads as GrantReads) === 'everything' ? 'everything' : 'branch',
      availability: coerceAvailability(o.availability),
      keyId: typeof o.keyId === 'string' ? o.keyId : '',
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
      issuedAt: typeof o.issuedAt === 'number' ? o.issuedAt : null,
      // A record written before §4.2b has no revision. It reads as 1, which is
      // what the next re-seal will bump past.
      scopeRev: typeof o.scopeRev === 'number' && o.scopeRev >= 1 ? o.scopeRev : 1,
      lastUsed: typeof o.lastUsed === 'number' ? o.lastUsed : null,
    });
  }
  return out;
}

/**
 * The branch list, accepting the single `branch` a pre-2026-07-31 record wrote.
 * A stored `branch: null` meant the root then; it reads as the empty list now,
 * for `openGrantBundle`'s reason — never widen on ambiguous data.
 */
function readBranches(o: { branches?: unknown; branch?: unknown }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== 'string' || !v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  if (Array.isArray(o.branches)) for (const b of o.branches) push(b);
  else push(o.branch);
  return out;
}

export const serializeGrants = (list: Grant[]): string => JSON.stringify(list);

/**
 * The grants belonging to the account currently signed in — **the only ones any
 * surface may show or act on.**
 *
 * A device outlives a sign-in and this list is device-local, so without the
 * filter the next person to sign in on this browser saw a connection that was
 * not theirs. They could not revoke it either: RLS scopes the delete to their
 * own rows, so it reached zero, the local record was dropped as though it had
 * worked, and the server went on serving the FIRST account's key to whatever
 * held the token.
 *
 * Filtering rather than clearing at sign-out, deliberately: signing back into
 * the same account on the same machine should find its connections where it
 * left them, and a grant is not recoverable — losing the record means losing the
 * only list that can manage it.
 *
 * An empty `uid` matches nothing, so a signed-out app shows no connections even
 * though the records are still on disk.
 */
export const grantsFor = (list: Grant[], uid: string | null | undefined): Grant[] =>
  uid ? list.filter((g) => g.userId === uid) : [];

/** Newest first — a list you add to reads better from the top. */
export const sortGrants = (list: Grant[]): Grant[] =>
  [...list].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
