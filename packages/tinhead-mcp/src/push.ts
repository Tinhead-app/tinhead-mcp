/**
 * `tinhead-mcp` — the write path. SPEC-AGENT §1.4 + SPEC-SYNC §12.10.
 *
 * The door writes the way a phone writes: node rows built by [core], encrypted
 * with [crypto], serialized by [sync]'s ONE codec, and landed by the atomic
 * push — rows and the manifest in one transaction, or nothing.
 *
 * **Why the door must hold the whole corpus to write one word of it.** The
 * manifest MAC is computed CLIENT-side over the predicted post-apply set,
 * because the server has no DEK and never will. So a push has to predict the
 * entire set exactly, which means holding it. That is not a shortcut taken
 * here — it is forced, it is why §8's branch scope is policy rather than
 * cryptography, and SPEC-AGENT §3's Consequence 2 says so out loud.
 *
 * **A conflict is reported, never swallowed.** §6.4: no tool may tell the model
 * a write landed when the server took a different one.
 */

import { encryptNode, manifestMac } from '../../../src/crypto';
import { ThoughtNode } from '../../../src/model/types';
import { OpenedGrant } from '../../../src/agent/types';
import { encodePayload } from '../../../src/sync/payload';
import { PushRow } from '../../../src/sync/types';
import { Corpus, DoorApi } from './corpus';

/** What a push did. `applied: false` always carries a reason the model can act on. */
export interface PushOutcome {
  applied: boolean;
  /** Set when the push did not land — a sentence, not a code. */
  reason?: string;
  /** Ids the server took differently, when it said so. */
  conflicts?: string[];
}

/**
 * Land a set of node writes. `deletions` are the ids being tombstoned; every
 * other row is a live write.
 *
 * **No retry, deliberately.** A counter conflict means a peer wrote between the
 * read and the push, so the rows in hand were computed by [core] against a tree
 * that no longer exists — retrying with a fresh counter but the old
 * `baseVersion`s would either be refused again or, worse, land an edit derived
 * from stale words over someone else's. Re-deriving the mutation is the TOOL's
 * job, not this function's, and the honest move is the one §6.4 asks for: report
 * it and let the agent read again. (An earlier comment here promised "one retry
 * on a counter conflict" and no code ever did it.)
 */
export async function pushWrites(
  api: DoorApi,
  grant: OpenedGrant,
  corpus: Corpus,
  writes: readonly ThoughtNode[],
  opts: { deletions?: ReadonlySet<string> } = {}
): Promise<PushOutcome> {
  if (writes.length === 0) return { applied: true };
  const deletions = opts.deletions ?? new Set<string>();
  const { dek, userId, keyId } = grant;

  const rows: PushRow[] = writes.map((n) => {
    const base = corpus.versions.get(n.id) ?? corpus.manifest.get(n.id)?.version ?? 0;
    const version = base + 1;
    const deleted = deletions.has(n.id) || n.deletedAt !== null;
    return {
      id: n.id,
      // A tombstone encrypts a fixed marker, never the words — the row is gone,
      // and its `deleted` flag is authenticated in the AAD ([crypto]).
      ciphertext: deleted
        ? encryptNode(dek, userId, n.id, keyId, version, true, '')
        : encryptNode(dek, userId, n.id, keyId, version, false, encodePayload(n)),
      keyId,
      version,
      deleted,
      baseVersion: base,
    };
  });

  // The predicted post-apply set — this is what the MAC binds, and it must be
  // exactly what the server will hold, or it publishes a manifest describing a
  // set that never existed.
  const predicted = new Map(corpus.manifest);
  for (const r of rows) predicted.set(r.id, { version: r.version, deleted: r.deleted });
  const payload = manifestMac(
    dek,
    userId,
    keyId,
    corpus.counter + 1,
    [...predicted.entries()].map(([id, e]) => ({ id, version: e.version, deleted: e.deleted }))
  );

  const res = await api.casPushBatch(rows, payload, keyId, corpus.counter);
  if (res.applied) {
    // Keep the caller's view usable for a second write in the same turn.
    corpus.counter = res.counter ?? corpus.counter + 1;
    for (const r of rows) {
      corpus.manifest.set(r.id, { version: r.version, deleted: r.deleted });
      if (r.deleted) {
        corpus.versions.delete(r.id);
        corpus.nodes.delete(r.id);
      } else {
        corpus.versions.set(r.id, r.version);
      }
    }
    for (const n of writes) if (!deletions.has(n.id) && n.deletedAt === null) corpus.nodes.set(n.id, n);
    return { applied: true };
  }

  if (res.counterConflict) {
    return {
      applied: false,
      reason:
        'someone wrote to this account while you were working (a phone or the app itself), ' +
        'so nothing was saved. Read the thought again and repeat the change.',
    };
  }
  const conflicts = res.conflicts.map((c) => c.id);
  return {
    applied: false,
    conflicts,
    reason:
      `nothing was saved: ${conflicts.length} thought(s) changed on another device since you read ` +
      `them (${conflicts.join(', ')}). Read them again and repeat the change.`,
  };
}
