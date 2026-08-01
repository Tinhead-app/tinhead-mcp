/**
 * [compile] Render — deterministic artifact writers (SPEC-COMPILE §2).
 *
 * One renderer per outline dialect plus the prose join. The `headings` dialect
 * is a byte-exact port of the Phase-1 §8 algorithm — the `document` target's
 * output is pinned against the original golden tests, so any spacing change
 * here is a spec-level change and breaks tests by design.
 *
 * Shared invariants: no timestamps, no decoration, never more than one blank
 * line in a row, no leading/trailing whitespace (before preamble/postscript).
 */

import { displayTitle } from '../model/tree';
import { CompileIR, IRNode, MatchedSection } from './ir';
import { CompileForm, CompileTarget, OutlineStyle } from './targets';

export interface RenderOptions {
  form: CompileForm;
  includeDetail: boolean;
  /** The ephemeral delivery note — appended under a quiet rule, never persisted (§5.3). */
  postscript?: string;
}

const hasText = (s: string | null): s is string => !!s && s.trim().length > 0;
const pseudo = (n: IRNode): string => displayTitle({ title: n.title, body: n.body });

// ---------------------------------------------------------------------------
// Headings dialect — the §8 algorithm, ported exactly.
// Depth 0 = `#`, 1 = `##`, 2 = `###`, ≥3 = bullets (two-space indent per extra
// level). Decomposed into own-block + child-loop so section targets can reuse
// the pieces; with no sections the composition is byte-identical to Phase 1.
// ---------------------------------------------------------------------------

function ownHeadingBlock(n: IRNode, depth: number, detail: boolean): string[] {
  const lines: string[] = [];
  const title = hasText(n.title) ? n.title.trim() : null;
  const body = detail && hasText(n.body) ? n.body.trim() : null;
  const marks = '#'.repeat(depth + 1);
  if (title) {
    lines.push(`${marks} ${title}`);
    if (body) lines.push(...body.split('\n'));
  } else if (body) {
    // Title-less with detail on: body as content directly, no synthesized heading.
    lines.push(...body.split('\n'));
  } else {
    // Title-less with detail off: pseudo-title stands in.
    lines.push(`${marks} ${pseudo(n)}`);
  }
  return lines;
}

function headingChildLoop(children: IRNode[], parentDepth: number, detail: boolean): string[] {
  const lines: string[] = [];
  let prevWasBullet = false;
  for (const child of children) {
    const childLines = renderHeadingNode(child, parentDepth + 1, detail);
    const childIsBullet = parentDepth + 1 >= 3;
    if (!childIsBullet || !prevWasBullet) lines.push('');
    lines.push(...childLines);
    prevWasBullet = childIsBullet;
  }
  return lines;
}

function renderHeadingNode(n: IRNode, depth: number, detail: boolean): string[] {
  if (depth <= 2) {
    return [...ownHeadingBlock(n, depth, detail), ...headingChildLoop(n.children, depth, detail)];
  }
  const lines: string[] = [];
  const title = hasText(n.title) ? n.title.trim() : null;
  const body = detail && hasText(n.body) ? n.body.trim() : null;
  const indent = '  '.repeat(depth - 3);
  let bulletText: string;
  let extraBodyLines: string[] = [];
  if (title) {
    bulletText = title;
    if (body) extraBodyLines = body.split('\n');
  } else if (body) {
    const bodyLines = body.split('\n');
    bulletText = bodyLines[0];
    extraBodyLines = bodyLines.slice(1);
  } else {
    bulletText = pseudo(n);
  }
  lines.push(`${indent}- ${bulletText}`);
  for (const extra of extraBodyLines) lines.push(`${indent}  ${extra}`);
  for (const child of n.children) {
    lines.push(...renderHeadingNode(child, depth + 1, detail));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Bullets / checklist dialects — root as `# title`, everything beneath packed
// bullets, two-space indent per level.
//
// A BOX MEANS A TASK. The checklist dialect boxes only thoughts the person
// designated (`n.task`), and marks the box from `n.completed` — so `[ ]` reads
// as "open task" and nothing else. Everything else renders as a plain bullet:
// there is no such thing as an open thought, only an entry, and a dialect that
// boxed every line reported a whole tree's worth of work that was never asked
// for. Continuation indent follows the marker's width, so mixed levels align.
// ---------------------------------------------------------------------------

function bulletMarker(style: OutlineStyle, n: IRNode): string {
  if (style === 'checklist' && n.task) return n.completed ? '- [x] ' : '- [ ] ';
  return '- ';
}

function renderBulletNode(n: IRNode, depth: number, detail: boolean, style: OutlineStyle): string[] {
  const lines: string[] = [];
  const title = hasText(n.title) ? n.title.trim() : null;
  const body = detail && hasText(n.body) ? n.body.trim() : null;
  const indent = '  '.repeat(depth);
  let text: string;
  let extra: string[] = [];
  if (title) {
    text = title;
    if (body) extra = body.split('\n');
  } else if (body) {
    const bodyLines = body.split('\n');
    text = bodyLines[0];
    extra = bodyLines.slice(1);
  } else {
    text = pseudo(n);
  }
  const marker = bulletMarker(style, n);
  lines.push(`${indent}${marker}${text}`);
  const contIndent = indent + ' '.repeat(marker.length);
  for (const e of extra) lines.push(`${contIndent}${e}`);
  for (const child of n.children) lines.push(...renderBulletNode(child, depth + 1, detail, style));
  return lines;
}

// ---------------------------------------------------------------------------
// Numbered dialect — a punch list. Items `1.` at their level, continuation
// lines and children indented beneath; one blank line between items so a
// finding with a body still reads as one entry.
// ---------------------------------------------------------------------------

function renderNumberedItems(items: IRNode[], detail: boolean): string[] {
  const lines: string[] = [];
  items.forEach((n, i) => {
    if (i > 0) lines.push('');
    const title = hasText(n.title) ? n.title.trim() : null;
    const body = detail && hasText(n.body) ? n.body.trim() : null;
    let text: string;
    let extra: string[] = [];
    if (title) {
      text = title;
      if (body) extra = body.split('\n');
    } else if (body) {
      const bodyLines = body.split('\n');
      text = bodyLines[0];
      extra = bodyLines.slice(1);
    } else {
      text = pseudo(n);
    }
    lines.push(`${i + 1}. ${text}`);
    for (const e of extra) lines.push(`   ${e}`);
    for (const child of n.children) {
      lines.push(...renderBulletNode(child, 0, detail, 'bullets').map((l) => `   ${l}`));
    }
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Sections (§5.1) — a lifted branch's own body flows under the `##` heading;
// its children are the section's items, rendered in the target's dialect.
// ---------------------------------------------------------------------------

function renderSection(
  section: MatchedSection,
  style: OutlineStyle,
  detail: boolean
): string[] {
  const lines: string[] = ['', `## ${section.rule.heading}`];
  const items: IRNode[] = [];
  for (const carrier of section.nodes) {
    const body = detail && hasText(carrier.body) ? carrier.body.trim() : null;
    if (body) lines.push(...body.split('\n'));
    items.push(...carrier.children);
  }
  if (items.length > 0) {
    if (style === 'numbered') {
      lines.push('');
      lines.push(...renderNumberedItems(items, detail));
    } else if (style === 'bullets' || style === 'checklist') {
      lines.push('');
      for (const item of items) lines.push(...renderBulletNode(item, 0, detail, style));
    } else {
      // headings dialect: items sit one level under the section heading.
      lines.push(...headingChildLoop(items, 1, detail));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Prose join (§4.1) — free, offline, no AI. Bodies as paragraphs in tree
// order; a titled, body-less thought contributes its title as a line; a title
// over a body is the writer's working label and is dropped. Detail is always
// on in prose form (bodies ARE the content).
// ---------------------------------------------------------------------------

function proseBlocks(n: IRNode, blocks: string[]): void {
  if (hasText(n.body)) blocks.push(n.body.trim());
  else if (hasText(n.title)) blocks.push(n.title.trim());
  for (const child of n.children) proseBlocks(child, blocks);
}

function renderProse(ir: CompileIR): string[] {
  const lines: string[] = [];
  if (hasText(ir.title)) lines.push(`# ${ir.title.trim()}`);
  if (hasText(ir.body)) {
    lines.push('');
    lines.push(ir.body.trim());
  }
  for (const section of ir.sections) {
    lines.push('', `## ${section.rule.heading}`);
    const blocks: string[] = [];
    for (const carrier of section.nodes) {
      if (hasText(carrier.body)) blocks.push(carrier.body.trim());
      for (const child of carrier.children) proseBlocks(child, blocks);
    }
    for (const b of blocks) lines.push('', b);
  }
  const blocks: string[] = [];
  for (const child of ir.bodyChildren) proseBlocks(child, blocks);
  for (const b of blocks) lines.push('', b);
  return lines;
}

// ---------------------------------------------------------------------------
// The composed artifact.
// ---------------------------------------------------------------------------

/** The quiet rule the postscript sits under (§5.3). */
export const POSTSCRIPT_RULE = '—';

const normalize = (lines: string[]): string =>
  lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

export function renderTarget(ir: CompileIR, target: CompileTarget, opts: RenderOptions): string {
  const form: CompileForm = target.forms.includes(opts.form) ? opts.form : target.forms[0];
  // Prose form always carries bodies — the detail toggle is hidden there (§4.1).
  const detail = form === 'prose' ? true : opts.includeDetail;

  let bodyLines: string[];
  if (form === 'prose') {
    bodyLines = renderProse(ir);
  } else {
    const style = target.outlineStyle;
    // The compiled thought itself renders as the `# heading`, never as a bullet,
    // so neither flag is ever read here.
    const rootNode: IRNode = {
      id: ir.sourceId,
      title: ir.title,
      body: ir.body,
      task: false,
      completed: false,
      children: [],
    };
    const lines: string[] = [...ownHeadingBlock(rootNode, 0, detail)];
    for (const section of ir.sections) {
      lines.push(...renderSection(section, style, detail));
    }
    if (style === 'numbered' && ir.sections.length === 0) {
      // Rule G degrade: with nothing lifted, the body mass IS the punch list.
      if (ir.bodyChildren.length > 0) {
        lines.push('');
        lines.push(...renderNumberedItems(ir.bodyChildren, detail));
      }
    } else if (style === 'bullets' || style === 'checklist') {
      for (const child of ir.bodyChildren) {
        lines.push('');
        lines.push(...renderBulletNode(child, 0, detail, style));
      }
    } else {
      // headings (and numbered-with-sections): the §8 child loop from depth 0.
      lines.push(...headingChildLoop(ir.bodyChildren, 0, detail));
    }
    bodyLines = lines;
  }

  let text = normalize(bodyLines);
  if (target.preamble) text = `${target.preamble}\n\n${text}`;
  const ps = opts.postscript?.trim();
  if (ps) text = `${text}\n\n${POSTSCRIPT_RULE}\n\n${ps}`;
  return text;
}
