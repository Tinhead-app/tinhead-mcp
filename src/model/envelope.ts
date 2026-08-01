import { Preset, parseCustomPresets } from '../presets/presets';
import { NodeMap } from './tree';
import { BODY_MAX, CompileRecord, DEPTH_MAX, ThoughtNode, TITLE_MAX, normalizeNode } from './types';

/**
 * SPEC-ACCOUNTS §27 D1/D2 (carrying SPEC-GAPS B1 forward) — the whole-corpus
 * serializer, built as a SEAM and not as settings-page logic: this module is
 * the one programmatic read/write of the corpus, `Settings › Your thoughts`
 * is merely its first caller, and SPEC-PRO §10.2's agent door is its named
 * second. Pure functions only — no store, no persistence, no platform.
 *
 * The envelope is the ROUND TRIP: every field of every node rides verbatim
 * (including `unknownPayload`, so a backup taken on a newer build survives a
 * restore on this one exactly the way SPEC-SYNC §4.1 makes the wire behave).
 * The markdown corpus (`src/compile/corpus.ts`) is the escape hatch — for a
 * human, and for every other notes app on earth; only the JSON comes back in.
 */

export const ENVELOPE_VERSION = 1;

/**
 * The import ceiling — refused with the size named, never silently clipped
 * (SPEC-AI §5.4's rule). Deliberately far above B2's indent-import ceiling:
 * this is the path a user's own full backup returns through, and a restore
 * that refuses your own corpus is not a backup. 20,000 is ~10× the largest
 * corpus the app has ever measured against (SPEC-GAPS B1 sizes 5,000).
 */
export const IMPORT_MAX_NODES = 20_000;

/**
 * SPEC-ACCOUNTS §19.4 — the account's own small blob, folded into the same
 * envelope rather than a second export surface. Assembled by the caller (the
 * screen holds the auth store; this module must not), absent when signed out.
 */
export interface AccountExport {
  email: string | null;
  /** Attached sign-in methods (`email` / `apple` / `google`). */
  methods: string[];
  /** The settings-mirror snapshot (`readMirror()`), nulls dropped. */
  settings: Record<string, string>;
}

export interface Envelope {
  version: number;
  exportedAt: string;
  nodes: ThoughtNode[];
  presets: Preset[];
  compiles: CompileRecord[];
  account?: AccountExport;
}

export interface WriteEnvelopeOptions {
  includeArchived?: boolean;
  includeDeleted?: boolean;
  account?: AccountExport;
  /** Injected clock for deterministic tests. */
  now?: number;
}

/** Authored sibling order — `sort` then `createdAt` then id: stable across exports. */
function byAuthored(a: ThoughtNode, b: ThoughtNode): number {
  return a.sort - b.sort || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The corpus as an ordered flat list: parents before children, siblings in
 * authored order, deterministic for a given map. Filters prune whole subtrees —
 * an archived thought hides its subtree (SPEC §4), a deleted thought took its
 * subtree down with it — so a filtered file can never hold an orphaned child.
 * Nodes whose parent is missing from the map entirely walk as extra roots
 * (corruption tolerance: a backup must not silently drop what it can reach).
 */
export function corpusNodes(
  nodes: NodeMap,
  opts?: { includeArchived?: boolean; includeDeleted?: boolean }
): ThoughtNode[] {
  const includeArchived = opts?.includeArchived ?? false;
  const includeDeleted = opts?.includeDeleted ?? false;
  const byParent = new Map<string | null, ThoughtNode[]>();
  for (const n of nodes.values()) {
    const key = n.parentId !== null && nodes.has(n.parentId) ? n.parentId : null;
    const list = byParent.get(key);
    if (list) list.push(n);
    else byParent.set(key, [n]);
  }
  for (const list of byParent.values()) list.sort(byAuthored);

  const out: ThoughtNode[] = [];
  const walk = (parent: string | null): void => {
    for (const n of byParent.get(parent) ?? []) {
      if (out.length >= 200_000) return; // recursion/size guard, like subtreeIds
      if (!includeDeleted && n.deletedAt !== null) continue;
      if (!includeArchived && n.archivedAt !== null) continue;
      out.push(n);
      walk(n.id);
    }
  };
  walk(null);
  return out;
}

/** How many thoughts a live (unarchived, undeleted) export would hold. */
export function corpusCount(nodes: NodeMap): number {
  return corpusNodes(nodes).length;
}

/** Deepest parent chain in a flat node list (for the import offer line). */
export function corpusDepth(list: readonly ThoughtNode[]): number {
  const byId = new Map(list.map((n) => [n.id, n]));
  let deepest = 1;
  for (const n of list) {
    let depth = 1;
    let cur: ThoughtNode | undefined = n;
    const seen = new Set<string>();
    while (cur && cur.parentId !== null && !seen.has(cur.id) && depth <= DEPTH_MAX) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
      if (cur) depth += 1;
    }
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

/**
 * The backup file. Pretty-printed on purpose: the user OWNS this file
 * (SPEC-GAPS B1 — "a plaintext file the user now owns"), and a backup a
 * human can open and read beats the bytes saved by minifying it.
 */
export function writeEnvelope(
  nodes: NodeMap,
  presets: readonly Preset[],
  compiles: readonly CompileRecord[],
  opts?: WriteEnvelopeOptions
): string {
  const env: Envelope = {
    version: ENVELOPE_VERSION,
    exportedAt: new Date(opts?.now ?? Date.now()).toISOString(),
    nodes: corpusNodes(nodes, opts),
    presets: presets.filter((p) => p.custom),
    compiles: [...compiles],
  };
  if (opts?.account) env.account = opts.account;
  return JSON.stringify(env, null, 2);
}

export type ParseEnvelopeResult =
  | { ok: true; nodes: ThoughtNode[]; presets: Preset[]; compiles: CompileRecord[] }
  | { ok: false; error: 'unreadable' | 'empty' }
  | { ok: false; error: 'tooMany'; count: number };

/** Model-contract caps, applied at the trust boundary (a hand-made file may exceed them). */
function capNode(n: ThoughtNode): ThoughtNode {
  return {
    ...n,
    title: n.title !== null ? n.title.slice(0, TITLE_MAX) : null,
    body: n.body !== null ? n.body.slice(0, BODY_MAX) : null,
    extras: n.extras.map((x) => x.slice(0, BODY_MAX)),
  };
}

/**
 * Read an envelope back — the trust boundary. Malformed entries drop, the
 * whole file is refused only when it is not an envelope at all, holds nothing,
 * or exceeds the stated ceiling (`tooMany` carries the count so the refusal
 * can name it). Nodes are normalized through the same armour every stored or
 * wire row passes (`normalizeNode`), presets through `parseCustomPresets`.
 */
export function parseEnvelope(text: string): ParseEnvelopeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'unreadable' };
  const env = raw as Record<string, unknown>;
  if (typeof env.version !== 'number' || !Array.isArray(env.nodes)) {
    return { ok: false, error: 'unreadable' };
  }

  const seen = new Set<string>();
  const nodes: ThoughtNode[] = [];
  for (const entry of env.nodes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.length === 0 || rec.id.length > 128) continue;
    if (seen.has(rec.id)) continue; // first wins; a well-formed file has no twins
    seen.add(rec.id);
    const partial: Partial<ThoughtNode> & Pick<ThoughtNode, 'id'> = {
      id: rec.id,
      parentId: typeof rec.parentId === 'string' ? rec.parentId : null,
      title: typeof rec.title === 'string' ? rec.title : null,
      body: typeof rec.body === 'string' ? rec.body : null,
      sort: typeof rec.sort === 'number' && Number.isFinite(rec.sort) ? rec.sort : 0,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : 0,
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
      editedAt: typeof rec.editedAt === 'number' ? rec.editedAt : null,
      // SPEC-SYNC §7.2 — the three conflict clocks. A backup that dropped them would
      // restore a corpus that merges the OLD whole-node way until every group is touched
      // again: not corruption, but not the corpus that was exported either, and D11's
      // identity check is right to insist those are the same thing.
      contentAt: typeof rec.contentAt === 'number' ? rec.contentAt : null,
      structureAt: typeof rec.structureAt === 'number' ? rec.structureAt : null,
      flagsAt: typeof rec.flagsAt === 'number' ? rec.flagsAt : null,
      deletedAt: typeof rec.deletedAt === 'number' ? rec.deletedAt : null,
      accessedAt: typeof rec.accessedAt === 'number' ? rec.accessedAt : undefined,
      pinnedAt: typeof rec.pinnedAt === 'number' ? rec.pinnedAt : null,
      taskAt: typeof rec.taskAt === 'number' ? rec.taskAt : null,
      completedAt: typeof rec.completedAt === 'number' ? rec.completedAt : null,
      archivedAt: typeof rec.archivedAt === 'number' ? rec.archivedAt : null,
      extras: rec.extras as ThoughtNode['extras'],
      suggestions: rec.suggestions as ThoughtNode['suggestions'],
      // SPEC-CALENDAR §7 — raw through to normalizeNode, whose armour is the
      // one authority on the when family's shape (a bad day nulls all four).
      whenDay: rec.whenDay as ThoughtNode['whenDay'],
      whenTime: rec.whenTime as ThoughtNode['whenTime'],
      whenRepeat: rec.whenRepeat as ThoughtNode['whenRepeat'],
      whenAlert: rec.whenAlert as ThoughtNode['whenAlert'],
      unknownPayload: rec.unknownPayload as ThoughtNode['unknownPayload'],
    };
    nodes.push(capNode(normalizeNode(partial)));
  }

  if (nodes.length > IMPORT_MAX_NODES) return { ok: false, error: 'tooMany', count: nodes.length };

  // Reuse the exact settings-blob armour: it drops malformed presets and
  // forces `custom: true`, which is what an imported preset must arrive as.
  const presets = parseCustomPresets(Array.isArray(env.presets) ? JSON.stringify(env.presets) : undefined);

  const compiles: CompileRecord[] = [];
  if (Array.isArray(env.compiles)) {
    for (const entry of env.compiles) {
      if (!entry || typeof entry !== 'object') continue;
      const c = entry as Record<string, unknown>;
      if (
        typeof c.id !== 'string' ||
        typeof c.nodeId !== 'string' ||
        typeof c.targetId !== 'string' ||
        typeof c.title !== 'string' ||
        typeof c.text !== 'string' ||
        typeof c.takenAt !== 'number'
      ) {
        continue;
      }
      compiles.push({
        id: c.id,
        nodeId: c.nodeId,
        targetId: c.targetId,
        title: c.title,
        text: c.text,
        refined: c.refined === true,
        takenAt: c.takenAt,
      });
    }
  }

  if (nodes.length === 0 && presets.length === 0 && compiles.length === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, nodes, presets, compiles };
}

export interface ImportPlan {
  /** Ready to persist: ids resolved, parents remapped, cycles broken. */
  nodes: ThoughtNode[];
  /** How many kept their original id (free) vs were minted a new one (collision). */
  kept: number;
  minted: number;
}

/**
 * SPEC-ACCOUNTS §27 D2 — ids kept where free, minted where colliding (a
 * collision includes a local tombstone: an id the bin still holds is taken,
 * and an import must never overwrite ANY existing row). Parents remap through
 * the same table; a parent found LIVE in the store grafts there (a branch
 * re-imported beside its tree); a parent found nowhere — or found as a
 * tombstone, since a live child under a deleted parent breaks the
 * subtree-delete invariant — roots the thought. Cycles in a hand-made file
 * break to root rather than looping.
 */
export function planImport(
  existing: ReadonlyMap<string, ThoughtNode>,
  incoming: readonly ThoughtNode[],
  mintId: () => string
): ImportPlan {
  const idMap = new Map<string, string>();
  let kept = 0;
  let minted = 0;
  for (const n of incoming) {
    if (existing.has(n.id)) {
      idMap.set(n.id, mintId());
      minted += 1;
    } else {
      idMap.set(n.id, n.id);
      kept += 1;
    }
  }

  const byOriginalId = new Map(incoming.map((n) => [n.id, n]));
  const rooted = new Set<string>();
  for (const n of incoming) {
    // Walk the ORIGINAL parent chain. Only a node whose chain returns to
    // ITSELF is in a cycle and roots; a node merely hanging off one keeps its
    // parent (the cycle members root, which mends the chain). The seen-set
    // bounds the walk when the chain circles a cycle this node is not in.
    const seen = new Set<string>([n.id]);
    let cur = n.parentId;
    while (cur !== null && byOriginalId.has(cur)) {
      if (cur === n.id) {
        rooted.add(n.id);
        break;
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = byOriginalId.get(cur)!.parentId;
    }
  }

  const liveGraft = (parentId: string): string | null => {
    const parent = existing.get(parentId);
    return parent && parent.deletedAt === null ? parentId : null;
  };
  const nodes = incoming.map((n) => {
    const parentId = rooted.has(n.id)
      ? null
      : n.parentId === null
        ? null
        : (idMap.get(n.parentId) ?? liveGraft(n.parentId));
    return { ...n, id: idMap.get(n.id)!, parentId };
  });

  return { nodes, kept, minted };
}
