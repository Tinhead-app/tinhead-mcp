/**
 * `tinhead-mcp` — pull, decrypt, VERIFY. SPEC-AGENT §3 (the door is a client)
 * over SPEC-SYNC §7 (the integrity core).
 *
 * The door is stateless: it is spawned by its MCP client and dies with it, so
 * it holds no cursor and cannot use §12.11's incremental path. Every connect is
 * therefore the FULL verified read — the same one `syncNow` means when someone
 * asks to be sure. That is the honest cost of not being a daemon, and it is
 * stated in the README rather than hidden.
 *
 * **It refuses to serve a corpus it cannot verify.** A read tool that answers
 * from unverified rows is worse than one that fails: the agent cannot tell the
 * difference, and neither can the person reading its summary.
 */

import { decryptNode, verifyManifestMac } from '../../../src/crypto';
import { GrantOpenError } from '../../../src/agent/grants';
import { OpenedGrant } from '../../../src/agent/types';
import { NodeMap } from '../../../src/model/tree';
import { ThoughtNode } from '../../../src/model/types';
import { decodeNode } from '../../../src/sync/payload';
import {
  BatchPushResult,
  NodeMeta,
  PushRow,
  RemoteManifest,
  RemoteNode,
} from '../../../src/sync/types';

/**
 * What the door needs from the server — a strict subset of [sync]'s `SyncApi`,
 * so `createFakeSync().api` satisfies it in tests and the HTTP gateway client
 * satisfies it in production. Note what is NOT here: the keyring (the door's
 * key arrives in its bundle, never from the account's wraps), the shelf
 * channels, and `reapNodes`.
 */
export interface DoorApi {
  fetchManifest(): Promise<RemoteManifest | null>;
  fetchNodeMeta(): Promise<NodeMeta[]>;
  fetchNodes(ids?: string[]): Promise<RemoteNode[]>;
  casPushBatch(
    rows: PushRow[],
    payload: string,
    keyId: string,
    baseCounter: number
  ): Promise<BatchPushResult>;
}

/** The corpus as the door holds it: verified, decrypted, and its CAS bases. */
export interface Corpus {
  nodes: NodeMap;
  /** The manifest counter this view was proved against — the base for any push. */
  counter: number;
  keyId: string;
  /** id → the version the manifest bound. A write's CAS base; 0 for a new id. */
  versions: Map<string, number>;
  /** Every id the manifest binds, live and tombstoned — a push must predict the whole set. */
  manifest: Map<string, { version: number; deleted: boolean }>;
}

/** The set differs from what the manifest binds, or a row would not decrypt. */
export class IntegrityError extends Error {}

/**
 * The full verified read (§7). Order matters and each step is a refusal point:
 *
 * 1. the manifest, which is the only authority on what the set IS;
 * 2. the epoch check — a §6j reset moves `key_id` and the grant dies with the
 *    old one, which deserves a sentence rather than a MAC error (§4.6);
 * 3. the MAC over the claimed set, which is what makes step 4 sound;
 * 4. ciphertext for the live ids, each row's authenticated version checked
 *    EQUAL to the one the manifest bound — so a stale intermediate serve is
 *    caught rather than decrypted.
 */
export async function pullCorpus(api: DoorApi, grant: OpenedGrant): Promise<Corpus> {
  const manifest = await api.fetchManifest();
  const metas = await api.fetchNodeMeta();

  if (!manifest) {
    // A v1-era or never-pushed account. Empty is the only answer that can be
    // proved; anything else would be rows nothing binds.
    if (metas.length > 0) {
      throw new IntegrityError(
        'the server offered thoughts with no manifest to bind them — refusing to read them'
      );
    }
    return { nodes: new Map(), counter: 0, keyId: grant.keyId, versions: new Map(), manifest: new Map() };
  }

  if (manifest.keyId !== grant.keyId) {
    throw new GrantOpenError(
      'this account has been re-keyed since the grant was made — mint a new one in Tinhead',
      'epoch'
    );
  }

  const entries = metas.map((m) => ({ id: m.id, version: m.version, deleted: m.deleted }));
  if (
    !verifyManifestMac(
      manifest.payload,
      grant.dek,
      grant.userId,
      manifest.keyId,
      manifest.counter,
      entries
    )
  ) {
    throw new IntegrityError(
      'the set of thoughts the server offered is not the set it signed — refusing to read it'
    );
  }

  const bound = new Map(entries.map((e) => [e.id, { version: e.version, deleted: e.deleted }]));
  const liveIds = entries.filter((e) => !e.deleted).map((e) => e.id);
  const rows = liveIds.length ? await api.fetchNodes(liveIds) : [];

  const nodes: NodeMap = new Map();
  const versions = new Map<string, number>();
  for (const row of rows) {
    const b = bound.get(row.id);
    // §7: a row served at a version other than the one the manifest bound is a
    // stale (or rolled-back) serve, and the MAC above cannot see it — the MAC
    // proves the SET, this proves each ROW is the member that was signed.
    if (!b || b.deleted || row.version !== b.version) {
      throw new IntegrityError(
        `the server served ${row.id} at a version its own manifest does not bind`
      );
    }
    // Throws on a MAC failure, which is the same refusal by another name.
    const json = decryptNode(
      grant.dek,
      grant.userId,
      row.id,
      row.keyId,
      row.version,
      row.deleted,
      row.ciphertext
    );
    if (json === null) continue; // a verified tombstone; not part of a live read
    const node: ThoughtNode = decodeNode(row.id, json);
    nodes.set(node.id, node);
    versions.set(node.id, row.version);
  }

  // Withholding: the manifest bound live ids the server then did not serve.
  const missing = liveIds.filter((id) => !nodes.has(id));
  if (missing.length) {
    throw new IntegrityError(
      `the server signed for ${missing.length} thought(s) it did not serve — refusing a partial read`
    );
  }

  return { nodes, counter: manifest.counter, keyId: manifest.keyId, versions, manifest: bound };
}
