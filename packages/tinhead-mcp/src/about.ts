/**
 * `tinhead-mcp` — what the agent is told at the gate. SPEC-AGENT §6.
 *
 * ONE copy of the orientation, in two places that both need it: the MCP
 * `instructions` field (sent in the initialize response, before any tool is
 * called) and `get_root` (which the tool table calls START HERE, and which is
 * the only one guaranteed to be read — not every client surfaces instructions).
 *
 * Deliberately short. This competes for attention with the tool descriptions,
 * which carry the per-tool limits; what belongs HERE is only what an agent
 * cannot infer from a tool signature — what the product is, WHEN TO REACH FOR
 * IT, what a thought can carry, and the two conventions that are invisible from
 * the schemas.
 *
 * **The WHEN paragraph is load-bearing, not throat-clearing.** Claude Code runs
 * MCP tool search by default: tool schemas are DEFERRED, and only tool names and
 * this field load at session start. So this is the routing signal — the thing
 * that decides whether "work on the Calendar list" reaches for the tree at all,
 * before a single tool description has been read. The client docs say so to
 * server authors in as many words ("server instructions help Claude understand
 * when to search for your tools"). This text described the product for a week
 * and never said when it was the answer.
 *
 * Vocabulary is the app's own ([copy]): the word is always **thought**, never
 * node/tree/entry/record. An agent that writes back in the person's own
 * vocabulary produces thoughts that read like theirs.
 */

export const ABOUT_TINHEAD = [
  'Tinhead is a thought-tree app. The person grows an idea as a tree of small thoughts and then',
  'compiles a branch into one document or AI prompt. It is quiet and deliberately minimal: the',
  'structure IS the nesting, and there is no metadata surface hiding behind it.',
  '',
  'WHEN TO REACH FOR THIS. These thoughts are the person\'s own thinking, and nothing else you can',
  'see this session holds them. Reach for them when they mention their thoughts, their tree, their',
  'notes, or name a branch of it; when they ask what they have written, decided or planned about',
  'something; and whenever they ask what is OUTSTANDING, what is on their list, or what to work on',
  'next — the tasks they keep are in here. A bare noun with no file behind it ("the Calendar list",',
  '"the compile notes") is usually a branch in here, so look before deciding it is something else.',
  'Do not reach for them for general knowledge, or for anything they point at by filename or URL.',
  'If a name could be more than one branch, say which you took and what else matched — the answer',
  'that quietly picks one is the one they cannot correct.',
  '',
  'A THOUGHT is a short title plus an optional detail, and it holds other thoughts inside it.',
  'The detail is a LIST of fields, not one blob — they arrive joined by blank lines and must be',
  'sent back the same way. A thought may also carry:',
  '  · a TASK designation, which it only has if the person gave it one (or ticked it off);',
  '  · a DATE — a day, optionally a time, optionally a repeat — which makes it show up in the',
  '    calendar surface. The thought IS the event; there is no separate event object;',
  '  · PRIVATE detail fields, sealed by the person. No agent can read one, at any permission',
  '    level. They are carried through your writes untouched — never try to preserve or',
  '    recreate one yourself.',
  '',
  'A BOX MEANS A TASK. There is no such thing as an open thought — an ordinary thought is just a',
  'thought. `[ ]` means a task the person has not ticked off; `[x]` means one they have; no box',
  'means it was never a task. So "what is outstanding here" is a question about tasks only, and',
  'the plain thoughts around them are notes, not a backlog. Ticking a thought that was never a',
  'task makes it a completed task — deliberate, but it means you cannot un-tick your way back to',
  'an ordinary thought.',
  '',
  'WHAT YOU CAN DO: read a branch (get_root, then get_level / get_thought / get_path /',
  'search_thoughts, or compile_subtree to read a whole branch in one call), and — if this grant',
  'allows writing — add thoughts, edit their words, tick them off, designate them tasks, give',
  'them dates, and bin them. You reach the branches this connection was given and nothing else;',
  'the person moves that boundary in the app, not through this door.',
  '',
  'WORKING WELL HERE: titles carry most of the meaning and details are often thin or absent, so',
  'a thought that reads like a stub usually is one — ask rather than assume you have the whole',
  'brief. Put new thoughts where a person would look for them, match the surrounding voice, and',
  'keep the branch you were given readable from its top thought down.',
].join('\n');
