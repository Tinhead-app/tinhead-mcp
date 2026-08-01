/**
 * `tinhead-mcp` — the prompts. SPEC-AGENT §6.6.
 *
 * MCP's third primitive, and the one this package was missing. A client surfaces
 * these as slash commands (`/mcp__tinhead__work_on Calendar` in Claude Code),
 * discovered from the server rather than configured by anyone.
 *
 * **Why they exist here.** The person's own nouns collide with everything else in
 * a session — "the Calendar list", "the compile notes" — and the cost of that
 * collision is paid twice: once by the agent, guessing which namespace was meant,
 * and once by the person, reading an answer about the wrong thing. A prompt
 * removes the guess by construction: `/mcp__tinhead__work_on` can only ever mean
 * this tree, and the argument after it can only ever be a branch of it.
 *
 * **A prompt is a message, not a procedure.** It returns text that lands in the
 * conversation as if the person had typed it. So each one is written in their
 * voice, names the exact tool to start with, and states the standing rules for
 * that job — the things a tool description cannot say because they span several
 * calls (report what you took, do not tick anything off unasked, ask rather than
 * invent when a thought is a stub).
 *
 * They carry NO orientation. `about.ts` says what Tinhead is, twice, and a third
 * copy here would be the drift the [mcp] doc's gotcha warns about.
 */

import { GrantScope } from '../../../src/agent/types';

export interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface Prompt {
  name: string;
  description: string;
  arguments: PromptArg[];
  /** The message text. Args arrive already trimmed; a missing optional one is ''. */
  render(args: Record<string, string>): string;
}

/** Where a job that names a branch in words should start, said once. */
const BY_NAME =
  'Start with find_tasks and pass that as "name" — it resolves the words to a branch and reports ' +
  'what else matched. Do not search first and pick one yourself.';

/** The rule that makes a resolved name honest rather than lucky. */
const SAY_WHICH =
  'If more than one branch matched, tell me which one you worked in and name the others in one ' +
  'line, so I can redirect you in a word.';

const WORK_ON: Prompt = {
  name: 'work_on',
  description:
    'Work on the open tasks in one branch of my Tinhead thoughts, named in words ("Calendar").',
  arguments: [
    { name: 'branch', description: 'the branch, in words — e.g. Calendar', required: true },
    { name: 'how_many', description: 'optional — how many tasks to take on', required: false },
  ],
  render: (a) =>
    [
      `Work on the open tasks in my Tinhead branch called "${a.branch}".`,
      '',
      BY_NAME,
      SAY_WHICH,
      '',
      a.how_many ? `Take on ${a.how_many}, the most useful first.` : 'Read all of them first.',
      '',
      'Then, for each task, judge before you build: my tasks are often a NOTE THAT ENDS IN A',
      'QUESTION rather than a work order. Where the task actually decides what to do, do it —',
      'and verify it the way this project verifies things. Where it leaves a question open, do',
      'not answer it by guessing: come back with a recommendation and what it costs.',
      '',
      'Do not tick anything off, and do not write to the tree at all, unless I ask. Tell me what',
      'you did, what you recommend, and what you left.',
    ].join('\n'),
};

const OUTSTANDING: Prompt = {
  name: 'outstanding',
  description: 'Everything still open across the Tinhead thoughts this connection can reach.',
  arguments: [
    { name: 'branch', description: 'optional — narrow it to one branch, in words', required: false },
  ],
  render: (a) =>
    [
      a.branch
        ? `What is still outstanding in my Tinhead branch called "${a.branch}"?`
        : 'What is still outstanding across my Tinhead thoughts?',
      '',
      a.branch ? BY_NAME : 'Use find_tasks with no id — it covers everything you can reach.',
      a.branch ? SAY_WHICH : '',
      '',
      'Group them by where they live and keep it short — a line each, in my own words, not a',
      'summary of my words. Only boxes count: a plain thought is a note, not a backlog item, so',
      'a branch with nothing open genuinely has nothing open.',
      '',
      'End with the one you would pick up first and why. Change nothing.',
    ]
      .filter((l) => l !== '')
      .join('\n'),
};

const CAPTURE: Prompt = {
  name: 'capture',
  description: 'Put a thought into my Tinhead tree, in the right place, in my voice.',
  arguments: [
    { name: 'text', description: 'what to capture', required: true },
    { name: 'branch', description: 'optional — where it belongs, in words', required: false },
  ],
  render: (a) =>
    [
      `Capture this in my Tinhead thoughts: ${a.text}`,
      '',
      a.branch
        ? `It belongs under my branch called "${a.branch}" — find it first, and if more than one ` +
          'matched, ask me before writing rather than picking.'
        : 'Work out where it belongs from what is already there — get_root, then look inside the ' +
          'branch that fits. If nothing obviously fits, ask me rather than starting a new pile.',
      '',
      'Write it the way I write: a short title that carries the meaning, and detail only if it',
      'adds something the title does not. Match the voice of its neighbours. Make it a task ONLY',
      'if it is genuinely something to do — a note is not a task here.',
      '',
      'Tell me where you put it and what you wrote, in full, so I can correct it.',
    ].join('\n'),
};

/**
 * The table, scoped like the tools are. `capture` writes, so a read-only grant is
 * not shown it — a slash command that can only ever refuse is worse than no
 * slash command, because the person finds it by browsing and reads its presence
 * as a promise.
 */
export function promptsFor(scope: GrantScope): Prompt[] {
  const all = [WORK_ON, OUTSTANDING, CAPTURE];
  return scope.write ? all : all.filter((p) => p !== CAPTURE);
}

/** One prompt's messages, in the shape the protocol wants. */
export function renderPrompt(p: Prompt, args: Record<string, unknown>): string {
  const clean: Record<string, string> = {};
  for (const a of p.arguments) {
    const v = args[a.name];
    clean[a.name] = typeof v === 'string' ? v.trim() : '';
    if (a.required && !clean[a.name]) {
      throw new Error(`${p.name} needs "${a.name}" — ${a.description}`);
    }
  }
  return p.render(clean);
}
