/**
 * [compile] Compile targets — what a thought compiles INTO.
 *
 * A target is data, not code (SPEC-COMPILE §3): the artifact it produces, the
 * reader it serves, the sections it lifts from the tree by title, the forms it
 * allows, and (when refine exists for it) the instructions the AI stage adds
 * on top of the global fidelity contract. Targets encode SHAPE, not subject —
 * "a work order for an agent" is a target; "React bugs" never is.
 *
 * Like preset content ([presets]), everything here is feature DATA, not UI
 * chrome: names/taglines/headings/preambles live in this file, not `copy.ts`.
 * Preambles are spec-exact (SPEC-COMPILE §4.4) and read in the USER'S voice —
 * they must never mention Tinhead or sound like the app talking.
 */

export type CompileForm = 'outline' | 'prose';
export type OutlineStyle = 'headings' | 'bullets' | 'checklist' | 'numbered';
export type Fidelity = 'asWritten' | 'tidied' | 'reshaped';
export type Level = 'plainer' | 'kept' | 'sharper';
export type Voice = 'yours' | 'plain' | 'formal';

/** Lifts a direct child of the compiled thought into a named section (§5.1). */
export interface SectionRule {
  role: string;
  /** Normalized (trim+lowercase) title synonyms that claim a branch. */
  match: string[];
  /** The rendered section heading. */
  heading: string;
  /** Missing ⇒ a gap-line mention (§4.5) — never an error. */
  expected?: boolean;
}

/** The AI half of a target; absent ⇒ deterministic-only. */
export interface RefineSpec {
  /** One screen max; composed INSIDE the fidelity contract, never above it. */
  instructions: string;
  /** Default voice (whose register the artifact speaks in). */
  voice: Voice;
  /** Default level (who it's pitched at). */
  level: Level;
  /** Fidelity ceiling: false caps this target at `tidied` (§4.3). */
  reshapeAllowed: boolean;
}

export interface CompileTarget {
  id: string;
  /** Chip label — lowercase, like chrome. */
  name: string;
  /** One quiet line describing the artifact. */
  tagline: string;
  /** Who this is for, concretely. */
  reader: string;
  /** Exact opening text, user's voice; only machine-adjacent readers get one. */
  preamble?: string;
  sections?: SectionRule[];
  /** Allowed forms, first = default; a single entry hides the form dial. */
  forms: CompileForm[];
  /** The outline form's dialect. */
  outlineStyle: OutlineStyle;
  refine?: RefineSpec;
}

/**
 * The §8 prompt preamble, v2 — v1's three sentences kept verbatim, plus one
 * epistemic line so a capable model treats loose wording as loose (§4.4).
 * Changing this is a spec-level change and breaks the pinned test by design.
 */
export const PROMPT_PREAMBLE = `I've been developing the following idea over time as a structured tree of
thoughts. Each heading level and indentation level is a refinement or
component of its parent. Treat it as one coherent vision and help me take
it further. Where my wording is loose, the structure still carries the
intent — weigh both.`;

/** The work order's opening — teaches the receiving agent its epistemics. */
export const WORK_ORDER_PREAMBLE = `What follows is a working list I collected by hand — observations, not
diagnoses. Verify each item against the real thing before acting on it;
where my wording is vague, anything in quotes is exactly what I wrote in
the moment, and investigating beats guessing. My constraints and notes on
how to proceed, where present, take precedence.`;

export const BUILTIN_TARGETS: CompileTarget[] = [
  {
    id: 'document',
    name: 'document',
    tagline: 'the tree as one clean page',
    reader: 'anyone',
    forms: ['outline', 'prose'],
    outlineStyle: 'headings',
    refine: {
      instructions:
        'Produce a clean, readable document. Keep the author’s headings and order; ' +
        'smooth each thought into finished sentences. In prose form, write the ' +
        'connective tissue between thoughts so the page reads as one piece.',
      voice: 'yours',
      level: 'kept',
      reshapeAllowed: true,
    },
  },
  {
    id: 'prompt',
    name: 'prompt',
    tagline: 'hand the whole idea to an AI',
    reader: 'a general AI assistant',
    preamble: PROMPT_PREAMBLE,
    forms: ['outline', 'prose'],
    outlineStyle: 'headings',
    refine: {
      instructions:
        'Prepare this for another AI to act on. Keep every requirement and detail; ' +
        'tighten wording so nothing reads two ways. Never resolve an ambiguity by ' +
        'choosing — leave it visible for the reader to weigh.',
      voice: 'yours',
      level: 'kept',
      reshapeAllowed: true,
    },
  },
  {
    id: 'work-order',
    name: 'work order',
    tagline: 'findings and marching orders, ready to act on',
    reader: 'a coding agent or contractor who will act on this',
    preamble: WORK_ORDER_PREAMBLE,
    sections: [
      {
        role: 'context',
        match: ['context', 'background', 'the situation', 'what’s already there', "what's already there"],
        heading: 'Context',
      },
      {
        role: 'findings',
        match: ['findings', 'bugs', 'issues', 'observations', 'what i found', 'the list'],
        heading: 'Findings',
        expected: true,
      },
      {
        role: 'constraints',
        match: ['constraints', 'the rules', 'limits', 'don’t touch', "don't touch", 'keep in mind'],
        heading: 'Constraints',
      },
      {
        role: 'proceed',
        match: ['how to proceed', 'approach', 'notes for the agent', 'where to start', 'the plan', 'priorities'],
        heading: 'How to proceed',
      },
      {
        role: 'questions',
        match: ['open questions', 'questions', 'unknowns', 'still undecided'],
        heading: 'Open questions',
      },
    ],
    forms: ['outline'],
    outlineStyle: 'numbered',
    refine: {
      // reshapeAllowed false is the §4.3 stance: an observation log must never
      // be silently reinterpreted by a reader who can't verify it.
      instructions:
        'Tidy each finding so it states where it happened, what happened, and what ' +
        'was expected — nothing more. Where the author’s wording is vague, keep ' +
        'their exact words in quotation marks instead of a confident paraphrase. ' +
        'Do not merge findings, reorder them, or judge severity.',
      voice: 'plain',
      level: 'kept',
      reshapeAllowed: false,
    },
  },
  {
    id: 'brief',
    name: 'brief',
    tagline: 'where things stand, what you think, what you need',
    reader: 'a colleague or editor deciding something',
    sections: [
      {
        role: 'situation',
        match: ['situation', 'the situation', 'context', 'background', 'where things stand'],
        heading: 'Where things stand',
      },
      {
        role: 'position',
        match: ['what i think', 'my take', 'my read', 'where i land', 'position'],
        heading: 'What I think',
      },
      {
        role: 'ask',
        match: ['what i need from you', 'the ask', 'what i need', 'asks', 'next from you'],
        heading: 'What I need from you',
      },
    ],
    forms: ['prose', 'outline'],
    outlineStyle: 'headings',
    refine: {
      instructions:
        'Write a brief the reader can act on in one read: the situation, the ' +
        'author’s position, the ask. Keep the author’s judgement exactly as strong ' +
        'as they made it — a brief persuades by clarity, not by inflation.',
      voice: 'plain',
      level: 'kept',
      reshapeAllowed: true,
    },
  },
  {
    id: 'draft',
    name: 'draft',
    tagline: 'the thoughts written through as prose',
    reader: 'readers of the finished piece',
    forms: ['prose'],
    outlineStyle: 'headings',
    refine: {
      instructions:
        'Write the piece these thoughts are reaching for. The order of telling may ' +
        'differ from the order of thinking; every image, claim, and turn must come ' +
        'from the thoughts themselves. Match the author’s cadence — this is their ' +
        'byline, not yours.',
      voice: 'yours',
      level: 'kept',
      reshapeAllowed: true,
    },
  },
  {
    id: 'checklist',
    name: 'checklist',
    tagline: 'the plan as boxes to tick',
    reader: 'whoever executes the plan',
    forms: ['outline'],
    outlineStyle: 'checklist',
    // Deterministic-only, deliberately: proof the free tier owns real targets.
  },
  {
    id: 'outline',
    name: 'outline',
    tagline: 'the bare structure, ready for another tool',
    reader: 'another tool — slides, docs, an editor',
    forms: ['outline'],
    outlineStyle: 'bullets',
    // Deterministic-only.
  },
  {
    id: 'summary',
    name: 'summary',
    tagline: 'the whole thing in thirty seconds',
    reader: 'someone with thirty seconds',
    forms: ['prose'],
    outlineStyle: 'headings',
    refine: {
      instructions:
        'Distill to one screen at most: what this is, what matters most, where it ' +
        'lands. Every sentence must trace to something the author wrote — a summary ' +
        'earns its brevity by selection, never by invention.',
      voice: 'plain',
      level: 'kept',
      reshapeAllowed: true,
    },
  },
];

export function targetById(id: string): CompileTarget | undefined {
  return BUILTIN_TARGETS.find((t) => t.id === id);
}

export const DEFAULT_TARGET_ID = 'document';

/** The heading the assistant's own additions live under — never interleaved (§4.1). */
export const ASSISTANT_NOTES_HEADING = 'What the assistant noticed';

// ---------------------------------------------------------------------------
// Per-thought last target; per-target remembered dials.
//
// Both embed an id after a ':', which is exactly what the [sync] mirror's key CHECK
// forbids — so neither can reach the plaintext settings table as a key. `compileTargetKey`
// embeds a NODE id and must never be mirrored in any form; if `compile.dials` is ever
// mirrored it goes as ONE composed map, never by prefix-matching `compile.` across these
// two adjacent lines.
// ---------------------------------------------------------------------------

export const compileTargetKey = (nodeId: string) => `compile.target:${nodeId}`;
export const compileDialsKey = (targetId: string) => `compile.dials:${targetId}`;

/** The per-target dial memory, persisted as JSON under `compileDialsKey`. */
export interface CompileDials {
  form: CompileForm;
  fidelity: Fidelity;
  level: Level;
  voice: Voice;
  notes: boolean;
  detail: boolean;
}

export function defaultDials(target: CompileTarget): CompileDials {
  return {
    form: target.forms[0],
    fidelity: 'asWritten',
    level: target.refine?.level ?? 'kept',
    voice: target.refine?.voice ?? 'yours',
    notes: false,
    detail: true,
  };
}

/** Trust boundary for the persisted dials row — a corrupt value never crashes. */
export function parseDials(raw: string | undefined, target: CompileTarget): CompileDials {
  const d = defaultDials(target);
  if (!raw) return d;
  try {
    const p = JSON.parse(raw) as Partial<CompileDials>;
    const form =
      p.form === 'outline' || p.form === 'prose' ? p.form : d.form;
    const fidelity =
      p.fidelity === 'asWritten' || p.fidelity === 'tidied' || p.fidelity === 'reshaped'
        ? p.fidelity
        : d.fidelity;
    const level =
      p.level === 'plainer' || p.level === 'kept' || p.level === 'sharper' ? p.level : d.level;
    const voice =
      p.voice === 'yours' || p.voice === 'plain' || p.voice === 'formal' ? p.voice : d.voice;
    return {
      form: target.forms.includes(form) ? form : d.form,
      fidelity: clampFidelity(fidelity, target),
      level,
      voice,
      notes: typeof p.notes === 'boolean' ? p.notes : d.notes,
      detail: typeof p.detail === 'boolean' ? p.detail : d.detail,
    };
  } catch {
    return d;
  }
}

/** Positions past a target's ceiling don't exist (§4.1) — clamp, don't error. */
export function clampFidelity(f: Fidelity, target: CompileTarget): Fidelity {
  if (!target.refine) return 'asWritten';
  if (f === 'reshaped' && !target.refine.reshapeAllowed) return 'tidied';
  return f;
}
