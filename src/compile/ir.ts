/**
 * [compile] Gather — the faithful intermediate snapshot (SPEC-COMPILE §2).
 *
 * Pure functions over a `NodeMap`: walk the live subtree (childrenOf ordering —
 * pinned → recency → completed; archived branches excluded, completed kept),
 * lift role-matched direct children into the target's sections (§5.1), and run
 * the three-heuristic gap scan (§4.5). No store reads, no I/O, no timestamps.
 */

import { NodeMap, childrenOf, detailText, displayTitle, liveNode, subtreeStats } from '../model/tree';
import { CompileTarget, SectionRule } from './targets';

export interface IRNode {
  id: string;
  title: string | null;
  body: string | null;
  /**
   * Designated a task (amdt 17) — the ONLY thing that earns a checklist box.
   * A completed row counts even without `taskAt`: `completeThought` backfills
   * the designation, and a pre-amdt-17 row that was ticked is still a done task
   * ([core] `completeThought`). An ordinary thought is not an unfinished one.
   */
  task: boolean;
  completed: boolean;
  children: IRNode[];
}

export interface MatchedSection {
  rule: SectionRule;
  /** The lifted direct children (whole subtrees), in tree order. */
  nodes: IRNode[];
}

export type GapKind = 'unfilled' | 'missingSection' | 'openQuestion';

export interface Gap {
  kind: GapKind;
  /** What to point at: a thought's display title or a section heading. */
  label: string;
}

export interface CompileIR {
  sourceId: string;
  title: string | null;
  body: string | null;
  stats: { thoughts: number; levels: number };
  /** Root children NOT lifted into a section, in tree order. */
  bodyChildren: IRNode[];
  /** Lifted sections, in the target's declared order; matched ones only. */
  sections: MatchedSection[];
  gaps: Gap[];
}

export interface GatherOptions {
  /** Ids of thoughts still wearing a ghost hint ([presets]) — gap heuristic 1. */
  hints?: ReadonlySet<string>;
}

/** Title normalization for section matching — trim + lowercase, nothing cleverer (§3.2 D). */
export const normalizeTitle = (s: string | null): string => (s ?? '').trim().toLowerCase();

const endsWithQuestion = (s: string | null): boolean => {
  const t = (s ?? '').trim();
  return t.length > 0 && t.endsWith('?');
};

export function gatherIR(
  nodes: NodeMap,
  id: string,
  target: CompileTarget,
  opts: GatherOptions = {}
): CompileIR | null {
  const root = liveNode(nodes, id);
  if (!root) return null;
  const hints = opts.hints;
  const gaps: Gap[] = [];

  const walk = (nid: string): IRNode => {
    const n = nodes.get(nid)!;
    const children = childrenOf(nodes, nid).map((c) => walk(c.id));
    // amdt 18: the IR's body is the WHOLE detail — body + extras as paragraphs
    // — so every renderer sees the full thought with no dialect changes.
    const detail = detailText(n);
    const bare = !hasText(detail) && children.length === 0;
    // Gap 1 — a seeded branch still wearing its ghost hint, never filled.
    if (hints?.has(nid) && bare) {
      gaps.push({ kind: 'unfilled', label: displayTitle(n) });
    } else if (bare && (endsWithQuestion(n.title) || endsWithQuestion(detail))) {
      // Gap 3 — a question the author asked and never answered.
      gaps.push({ kind: 'openQuestion', label: displayTitle(n) });
    }
    return {
      id: n.id,
      title: n.title,
      body: detail,
      task: n.taskAt !== null || n.completedAt !== null,
      completed: n.completedAt !== null,
      children,
    };
  };

  const rootIR = walk(id);

  // Role matching — DIRECT children of the compiled thought only (§5.1).
  const rules = target.sections ?? [];
  const claimed = new Map<string, SectionRule>();
  for (const child of rootIR.children) {
    const key = normalizeTitle(child.title);
    if (!key) continue;
    const rule = rules.find((r) => r.match.includes(key));
    if (rule) claimed.set(child.id, rule);
  }
  const sections: MatchedSection[] = [];
  for (const rule of rules) {
    const lifted = rootIR.children.filter((c) => claimed.get(c.id) === rule);
    if (lifted.length > 0) sections.push({ rule, nodes: lifted });
    else if (rule.expected) {
      // Gap 2 — a section the target expected that matched nothing.
      gaps.push({ kind: 'missingSection', label: rule.heading });
    }
  }
  const bodyChildren = rootIR.children.filter((c) => !claimed.has(c.id));

  return {
    sourceId: id,
    title: root.title,
    body: detailText(root),
    stats: subtreeStats(nodes, id),
    bodyChildren,
    sections,
    gaps,
  };
}

const hasText = (s: string | null): s is string => !!s && s.trim().length > 0;
