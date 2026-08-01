/**
 * [sync] SPEC-SYNC §4/§4.1 — the node ⇄ wire payload codec. **Pure**: no store,
 * no network, no platform, no React.
 *
 * It lived inside `thoughtSync.ts` until SPEC-AGENT P1, which is when the cost
 * showed: the engine is store-coupled, so a headless client could not read one
 * row without dragging the UI layer into node. SPEC-AGENT §17 listed exactly
 * this as *"assumed and cheap to falsify in P1"*, and it was false — so the
 * extraction happened here, in the smallest shape that frees the door.
 *
 * **There is one codec and there will only ever be one.** A second
 * implementation of this format is the "second, worse serializer" SPEC-PRO
 * §10.2.4 warns about: it would drift on exactly the fields that are omitted
 * when null, which is every field added since the format shipped, and the
 * failure mode is a stale client silently stripping a newer one's data (the
 * 07-18 bundle ate every amdt-17 task designation that way). The engine and
 * `tinhead-mcp` import this file; nothing else may re-derive it.
 */

import { ThoughtNode, normalizeNode } from '../model/types';

/**
 * §4.1 — the payload format this build speaks. Emitted only above 1 (so today's blobs
 * stay byte-identical to pre-guard builds'), and bumped ONLY for a breaking change — a
 * payload an older client must not lossily half-read. An additive-optional key is NOT
 * a bump: it ships unversioned and rides older clients as cargo (below). A build that
 * sees a format above its own quarantines the row instead of decoding it partially.
 */
export const PAYLOAD_FORMAT = 1;

/** §4.1 — every payload key this build speaks. Anything else is carried cargo. */
export const KNOWN_PAYLOAD_KEYS = new Set([
  'f', 't', 'b', 'x', 'p', 's', 'c', 'u', 'ed', 'pin', 'task', 'comp', 'arch', 'sug',
  'wd', 'wt', 'wr', 'wa', // SPEC-CALENDAR §7 — the when family (wa dormant, §8.1)
  'cat', 'sat', 'fat', // SPEC-SYNC §7.2 — the three conflict clocks
]);

/**
 * Wire key → node field, for cargo that graduates to known on an app update
 * (`promoteCarriedCargo`). Everything in KNOWN_PAYLOAD_KEYS except `f`, which is
 * protocol, not content.
 */
export const WIRE_FIELDS: Record<string, keyof ThoughtNode> = {
  t: 'title',
  b: 'body',
  x: 'extras',
  p: 'parentId',
  s: 'sort',
  c: 'createdAt',
  u: 'updatedAt',
  ed: 'editedAt',
  pin: 'pinnedAt',
  task: 'taskAt',
  comp: 'completedAt',
  arch: 'archivedAt',
  sug: 'suggestions',
  wd: 'whenDay',
  wt: 'whenTime',
  wr: 'whenRepeat',
  wa: 'whenAlert',
  cat: 'contentAt',
  sat: 'structureAt',
  fat: 'flagsAt',
};

/** The known-key set as a stored signature — `promoteCarriedCargo`'s gate. */
export const payloadKeysSignature = (): string => [...KNOWN_PAYLOAD_KEYS].sort().join(',');

export function encodePayload(n: ThoughtNode): string {
  // §4.1 cargo: keys a newer build wrote and this one does not speak, re-emitted
  // verbatim so a stale client can never strip a field it cannot see (the 07-18
  // bundle ate every amdt-17 task designation exactly this way). Spread FIRST and
  // filtered against the known set, so cargo can never shadow a key this build owns.
  const carried: Record<string, unknown> = {};
  if (n.unknownPayload) {
    for (const [k, v] of Object.entries(n.unknownPayload)) {
      if (!KNOWN_PAYLOAD_KEYS.has(k)) carried[k] = v;
    }
  }
  return JSON.stringify({
    ...carried,
    ...(PAYLOAD_FORMAT > 1 ? { f: PAYLOAD_FORMAT } : {}),
    t: n.title,
    b: n.body,
    // amdt 18: extra detail fields — omitted when empty, so a plain thought's
    // payload is byte-identical to what pre-amdt-18 builds wrote.
    ...(n.extras.length ? { x: n.extras } : {}),
    // [expand] grown suggestions (SPEC-AI §3.13) — omitted when empty, so a
    // thought without any is byte-identical to what pre-suggestions builds wrote.
    ...(n.suggestions.length ? { sug: n.suggestions } : {}),
    p: n.parentId,
    s: n.sort,
    c: n.createdAt,
    u: n.updatedAt,
    // The content-edit stamp — omitted while null, so a thought nobody has
    // edited pushes a payload byte-identical to what pre-field builds wrote.
    ...(n.editedAt !== null ? { ed: n.editedAt } : {}),
    pin: n.pinnedAt,
    task: n.taskAt,
    comp: n.completedAt,
    arch: n.archivedAt,
    // SPEC-CALENDAR §7 — the when family, each omitted while null, so an
    // undated thought's payload is byte-identical to what pre-when builds
    // wrote. `wa` is the §8.1 dormant alert seam — carried now, scheduled later.
    ...(n.whenDay !== null ? { wd: n.whenDay } : {}),
    ...(n.whenTime !== null ? { wt: n.whenTime } : {}),
    ...(n.whenRepeat !== null ? { wr: n.whenRepeat } : {}),
    ...(n.whenAlert !== null ? { wa: n.whenAlert } : {}),
    // SPEC-SYNC §7.2 — the conflict clocks, each omitted while null so a thought
    // written before they existed still encodes byte-identically. A peer that does
    // not speak them carries them as §4.1 cargo and merges the old way.
    ...(n.contentAt !== null ? { cat: n.contentAt } : {}),
    ...(n.structureAt !== null ? { sat: n.structureAt } : {}),
    ...(n.flagsAt !== null ? { fat: n.flagsAt } : {}),
  });
}

export function decodeNode(id: string, json: string): ThoughtNode {
  const o = JSON.parse(json);
  // §4.1 format floor: a payload declaring a format above this build's is one it KNOWS
  // it cannot represent. The throw lands in the caller's quarantine catch — local row
  // kept, bookkeeping never advanced — instead of a lossy partial decode poisoning the
  // mark (and `pushOnce` stands down on quarantined ids, so the field can't be
  // clobbered from here either).
  if (typeof o.f === 'number' && o.f > PAYLOAD_FORMAT) {
    throw new Error(`payload format ${o.f} is newer than this build speaks`);
  }
  // §4.1 cargo: collect every key this build does not speak, carried verbatim through
  // the row and re-emitted by every push, never interpreted.
  let carried: Record<string, unknown> | undefined;
  for (const k of Object.keys(o)) {
    if (!KNOWN_PAYLOAD_KEYS.has(k)) (carried ??= {})[k] = o[k];
  }
  return normalizeNode({
    id,
    title: o.t,
    body: o.b,
    // Absent in blobs written before amdt 18 — normalizeNode backfills [] and
    // armours the shape (wire data is untrusted until it round-trips a MAC).
    extras: o.x,
    // Absent in blobs written before this field — normalizeNode backfills [].
    suggestions: o.sug,
    parentId: o.p,
    sort: o.s,
    createdAt: o.c,
    updatedAt: o.u,
    // Absent in blobs written before this field, and from any thought nobody
    // has edited — normalizeNode backfills null, which is the honest answer.
    editedAt: o.ed,
    pinnedAt: o.pin,
    // Absent in blobs written before amdt 17 — normalizeNode backfills null.
    taskAt: o.task,
    completedAt: o.comp,
    archivedAt: o.arch,
    // SPEC-CALENDAR §7 — absent in pre-when blobs and from every undated
    // thought; normalizeNode armours the family (a bad day nulls all four).
    whenDay: o.wd,
    whenTime: o.wt,
    whenRepeat: o.wr,
    whenAlert: o.wa,
    // SPEC-SYNC §7.2 — absent from pre-clock blobs; normalizeNode leaves them null,
    // which the merge reads as "un-mergeable, keep local" (the old whole-node rule).
    contentAt: o.cat,
    structureAt: o.sat,
    flagsAt: o.fat,
    unknownPayload: carried,
    deletedAt: null,
  });
}
