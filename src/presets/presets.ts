/**
 * [presets] Built-in starting shapes for a thought.
 *
 * A preset seeds the first child thoughts under a thought — a ready-made
 * scaffold to fill in instead of a blank list. Each branch becomes a titled
 * child; its `note` is a GHOST PROMPT (persisted as a local `hint:<id>` setting,
 * never as a body) so it guides without ever reaching the compiled output.
 *
 * The preset content below (names, taglines, branch titles, notes, category
 * labels) is feature DATA, not UI chrome — it lives here, not in `copy.ts`, and
 * that distinction sets its casing. Chrome is lowercase-leaning (SPEC §10), but
 * a seeded branch becomes the user's OWN thought, sitting in a list beside ones
 * they typed and capitalized themselves — so **titles and notes are sentence
 * case: first word capitalized**. Lowercase seeds read as the app talking. The
 * rest of the tone rules still hold (quiet; never node/tree/etc.), asserted by
 * `presets.test.ts`.
 *
 * HOW TO ADD OR CHANGE ONE (the bar these were rebuilt to):
 * - There is NO branch-count rule. A preset is as long as its subject demands —
 *   `a-goal-gently` is 6 thoughts, `the-move` is 40. A uniform count across the
 *   set is the tell that the shapes were arbitrary rather than chosen.
 * - Every branch earns its place by the domain's real practice. If the honest
 *   reason is "it rounds out the set", cut it.
 * - Nest only where the subject genuinely subdivides (acts hold beats; a move is
 *   a countdown of phases). Nesting also keeps a big preset quiet: the level list
 *   shows one row per top-level branch, not the whole scaffold.
 * - Titles ARE the compiled document's headings (`##`, `###`), and they persist
 *   after the note evaporates — so each must stand alone, with no instruction
 *   inside it and no antecedent borrowed from its parent or its note.
 * - House style, measured against this file: sentence case (capitalize the
 *   first word of every title and note — the ‘quote’ case capitalizes the first
 *   LETTER, not the quote mark), the typographic apostrophe (’) only, one clause
 *   per note (join with a comma or an em dash, never a mid-note period), no
 *   question marks, and no imperatives aimed at the user — a note is a whisper,
 *   not a instruction.
 */
import { NodeMap, childrenOf, displayTitle, normalizeDetails } from '../model/tree';
import { ContextId, TITLE_MAX, ThoughtNode } from '../model/types';

/** A category key — a built-in default (`work`…) or a user's custom name. */
export type PresetCategory = string;

export interface PresetBranch {
  title: string;
  /** Built-in ghost prompt: persisted as a local hint, never a body. */
  note?: string;
  /** Custom "as-is" content: seeded as the thought's real body. */
  body?: string;
  /** Custom "as-is" extra detail fields (amdt 18), seeded after the body. */
  extras?: string[];
  /**
   * [expand] Grown follow-up asks — short tappable lines the model left on this
   * branch, persisted as a local `suggest:<id>` setting (never a body, never
   * synced), each a one-tap grow under the thought. Whole-mode grows only.
   */
  suggestions?: string[];
  /**
   * A thing to DO — seeded as an OPEN task (SPEC v1.1 amdt 17). Per-branch,
   * for shapes that mix checklist items with plain thoughts ([expand]'s grown
   * trees); a whole-preset checklist still rides `compilesTo: 'checklist'`.
   */
  task?: boolean;
  /** Nested scaffold — a subject that genuinely subdivides, or a custom preset. */
  children?: PresetBranch[];
}

export interface Preset {
  id: string;
  name: string;
  /** One quiet line shown under the name in the picker. */
  tagline: string;
  category: PresetCategory;
  branches: PresetBranch[];
  /**
   * Paired compile target id (SPEC-COMPILE §5.2 — the round trip): seeding
   * also sets the thought's remembered target, so the shape you grow from is
   * the shape you compile into. A plain string to keep this module free of
   * [compile] imports; validity is asserted in the tests.
   */
  compilesTo?: string;
  /** True for a user-saved preset (vs a built-in). */
  custom?: boolean;
  /** When a custom preset was saved (epoch ms). */
  createdAt?: number;
}

/** The picker's categories, in display order. `custom` is user-made (local, later). */
export const PRESET_CATEGORIES: { key: PresetCategory; label: string }[] = [
  { key: 'work', label: 'work' },
  { key: 'writing', label: 'writing' },
  { key: 'learning', label: 'learning' },
  { key: 'life', label: 'life' },
  { key: 'reflecting', label: 'reflecting' },
  { key: 'custom', label: 'custom' },
];

export const PRESETS: Preset[] = [
  // ---------- work ----------
  {
    id: 'build-with-claude',
    name: 'hand this to claude',
    tagline: 'everything claude needs before it starts guessing',
    category: 'work',
    compilesTo: 'prompt',
    branches: [
      { title: 'The one job', note: 'If it does only this, it still ships' },
      { title: 'Who’s using it, and when', note: 'The moment they reach for this, not a persona' },
      { title: 'What’s already there', note: 'The stack, the versions, what you’d be building on top of' },
      { title: 'How it should feel', note: 'Quiet or loud, dense or roomy — or point at something that exists' },
      {
        title: 'Walk the screens',
        note: 'The flow, one screen at a time',
        children: [
          { title: 'The blank first run', note: 'What invites them to make the first thing' },
          { title: 'While it’s working', note: 'The seconds between asking and getting' },
          { title: 'What they see when it fails', note: 'Anything but a silent nothing' },
        ],
      },
      { title: 'What gets saved', note: 'What survives a reload, and what’s fine to lose' },
      { title: 'What one of these is made of', note: 'A title, a date, whatever else it holds' },
      { title: 'The rules', note: 'The logic that has to hold however they poke at it' },
      { title: 'Where it breaks', note: 'Empty, huge, offline, twice at once, wrong on purpose' },
      { title: 'Not doing', note: 'The fair asks you’re deliberately not building this round' },
      { title: 'Don’t touch', note: 'The code, data, or dependencies to leave exactly alone' },
      { title: 'Still undecided', note: 'The calls you haven’t made, before they get made for you' },
      { title: 'Done when', note: 'What you’d click or run, and what it should print' },
    ],
  },
  {
    id: 'qa-sweep',
    name: 'a walkthrough',
    tagline: 'walk it end to end, write down what snags',
    category: 'work',
    compilesTo: 'work-order',
    branches: [
      { title: 'Context', note: 'What you walked through, and on which build' },
      { title: 'Findings', note: 'One snag per thought inside — where, what happened, what you expected' },
      { title: 'Constraints', note: 'What can’t change, and what to leave alone' },
      { title: 'How to proceed', note: 'Where to start, and what can wait' },
      { title: 'Open questions', note: 'The calls you can’t make from here' },
    ],
  },
  {
    id: 'business-idea',
    name: 'a business idea',
    tagline: 'find what would kill it, then go check',
    category: 'work',
    branches: [
      { title: 'The one-liner', note: 'If it takes a paragraph, you don’t have it yet' },
      { title: 'The problem, and where you saw it', note: 'A time you watched someone else hit it' },
      {
        title: 'Who has it worst',
        note: 'One person you can name beats a market you imagine',
        children: [
          { title: 'The first ten you could reach this week', note: 'No names, and that’s the finding' },
        ],
      },
      {
        title: 'What they do instead today',
        note: 'The spreadsheet, the intern, the doing-nothing',
        children: [
          { title: 'What the workaround costs them', note: 'Hours a week, dollars a month, or a risk they carry' },
          { title: 'Why they’ve put up with it', note: 'If it were unbearable, someone would have fixed it' },
          { title: 'Why they’d leave it', note: '‘Better’ rarely moves anyone off what already works' },
        ],
      },
      {
        title: 'Who else is in this',
        note: 'An empty room is usually an empty market',
        children: [
          { title: 'The ones people already pay', note: 'Their pricing pages are more honest than your memory' },
          { title: 'The graveyard', note: 'Someone tried this before you — what happened to them' },
        ],
      },
      {
        title: 'How it makes money',
        note: 'Money changing hands, in one plain sentence',
        children: [
          { title: 'Who signs the check', note: 'The payer and the sufferer are often different people' },
          { title: 'The price you’d name', note: 'The number you’d feel awkward saying, said out loud' },
          { title: 'How they’d find out this exists', note: 'If the answer is ‘we’ll post about it’, keep going' },
          { title: 'Napkin math', note: 'The number you need to live, worked backwards' },
        ],
      },
      { title: 'What a copycat couldn’t buy', note: 'Years in the trade, a licence, a list they can’t buy' },
      {
        title: 'The one belief this rests on',
        note: 'If this is false, nothing above it matters',
        children: [
          { title: 'The beliefs you’re parking', note: 'Still risky, just not the one that scares you most' },
        ],
      },
      {
        title: 'The cheapest test that could kill it',
        note: 'Something you could run without writing code',
        children: [
          { title: 'The number that means no', note: 'Decided now, before the data arrives and starts flattering you' },
          { title: 'When you’ll call it', note: 'A date — ‘soon’ is how an idea eats a year' },
          { title: 'What came back', note: 'The answer you got, before you start explaining it away' },
        ],
      },
    ],
  },
  {
    id: 'the-pitch',
    name: 'the pitch',
    tagline: 'make the case in the order a yes happens',
    category: 'work',
    compilesTo: 'brief',
    branches: [
      { title: 'The one line', note: 'The sentence your champion repeats when you’re not in the room' },
      { title: 'What’s broken', note: 'The person it happens to, and what their week looks like' },
      { title: 'Who else has this', note: 'The count, and what it’s worth if you fix it' },
      { title: 'Why now', note: 'What changed lately, and why this wasn’t possible before' },
      {
        title: 'The fix',
        note: 'What you’d actually do about it, in a breath',
        children: [
          { title: 'Why it’ll last', note: 'The machinery, plainly — and why it doesn’t get copied' },
          { title: 'What this isn’t', note: 'The edges you draw before someone draws them for you' },
        ],
      },
      { title: 'What they’d do instead', note: 'The other options on the table, including doing nothing' },
      {
        title: 'The proof',
        note: 'The part they’ll test hardest, so lead with your strongest',
        children: [
          { title: 'What’s already working', note: 'The smallest thing that’s already real, one honest number' },
          { title: 'The people asking for it', note: 'Names and quotes land harder than a market number' },
        ],
      },
      { title: 'The bet underneath', note: 'The assumption everything rests on, said out loud' },
      { title: 'Why us', note: 'The reason this lands with you and not another team' },
      {
        title: 'The ask',
        note: 'The one decision you want, plain enough to act on, and on what terms',
        children: [
          { title: 'The number', note: 'Money, people, time — the real one, not the comfortable one' },
          { title: 'Where it goes', note: 'The number broken into the things it actually buys' },
          { title: 'The milestone this unlocks', note: 'What you’ll have proved, and by when' },
        ],
      },
      { title: 'What it pays back', note: 'The money it makes or saves, and roughly when' },
      { title: 'Where they’ll push back', note: 'The questions you hope nobody asks' },
    ],
  },
  {
    id: 'meeting-prep',
    name: 'prep a meeting',
    tagline: 'walk in with an outcome, walk out with owners',
    category: 'work',
    branches: [
      { title: 'What this settles', note: 'A decision, an agreement, a list — if it’s just news, send a note' },
      {
        title: 'Who’s in the room',
        note: 'The people the outcome needs, not the invite list',
        children: [
          { title: 'Who decides', note: 'One name, and they shouldn’t hear it cold in the room' },
          { title: 'Whose read you need', note: 'They weigh in, they don’t decide' },
        ],
      },
      { title: 'The pre-read', note: 'What you’d otherwise burn ten minutes explaining, sent a day ahead' },
      { title: 'The first sixty seconds', note: 'The outcome said out loud, and a clock on it' },
      { title: 'Agenda', note: 'One thought per point, decisions first, minutes and a name on each' },
      { title: 'What they’ll push back on', note: 'The real objection, not the polite one, and your answer' },
      {
        title: 'The last five minutes',
        note: 'Reserve them — this is where the hour lands or evaporates',
        children: [
          { title: 'What we decided', note: 'Each one read back out loud before anyone moves' },
          { title: 'Owners and dates', note: 'A name and a date against each one' },
          { title: 'Who to tell', note: 'The people it lands on who weren’t in the room' },
          { title: 'Parked for later', note: 'Came up, and deserves its own hour' },
        ],
      },
    ],
  },
  {
    id: 'a-decision',
    name: 'a decision',
    tagline: 'write the case before you make the call',
    category: 'work',
    branches: [
      { title: 'What i’m deciding', note: 'Narrowed to one question you’d say out loud' },
      { title: 'What’s forcing this', note: 'What changed, and how long you’ve actually got' },
      { title: 'Whose call this is', note: 'If it isn’t yours, this is a recommendation' },
      { title: 'Which way the door swings', note: 'What it’d cost to walk this back, if you even can' },
      { title: 'What i’m weighing against', note: 'The few things that decide it, and the one you won’t trade' },
      {
        title: 'Options on the table',
        note: 'If none of these were allowed, what then — that one counts too',
        children: [
          { title: 'Changing nothing', note: 'What it costs to leave this exactly as it is' },
          { title: 'The front-runner', note: 'The one you’d pick if you had to answer today' },
          { title: 'The one i keep dismissing', note: 'What you’d need to see to stop waving it off' },
        ],
      },
      { title: 'What would have to be true', note: 'The conditions this rests on, shakiest first' },
      { title: 'How this fails', note: 'It’s done and it went badly — what happened' },
      { title: 'The call', note: 'One line, plain words, no hedge, and how sure you are' },
      { title: 'When i’d walk away', note: 'A date, and what you’d have to see by then' },
    ],
  },

  // ---------- writing ----------
  {
    id: 'story',
    name: 'story',
    tagline: 'acts, beats, and the arc running under them',
    category: 'writing',
    compilesTo: 'draft',
    branches: [
      { title: 'Logline', note: 'One sentence: who wants what, what blocks it, what it costs' },
      {
        title: 'Who we follow',
        note: 'The one whose choices drive it, and who changes most',
        children: [
          { title: 'What they want', note: 'The thing they’d say out loud if you asked' },
          { title: 'What they need', note: 'The truth they’d deny, and can’t have while chasing the want' },
          { title: 'The lie they believe', note: 'The sentence they’d never say but live by anyway' },
          { title: 'Where the lie came from', note: 'The old hurt that taught it, long before page one' },
        ],
      },
      { title: 'What’s against them', note: 'A person, a system, a habit — but it has to want something' },
      { title: 'How it’s told', note: 'Whose eyes, what tense, how close we sit' },
      {
        title: 'Act one',
        note: 'Roughly the first quarter, and it ends when they can’t go home',
        children: [
          { title: 'The world before', note: 'What normal looks like, and what’s already quietly wrong' },
          { title: 'Inciting incident', note: 'The thing that arrives and won’t let normal continue' },
          { title: 'Second thoughts', note: 'They try the smaller, safer answer first' },
          { title: 'No way back', note: 'A choice with a price, not an event that happens to them' },
        ],
      },
      {
        title: 'Act two',
        note: 'Half the story lives here, so keep the cost climbing',
        children: [
          { title: 'Into the new world', note: 'New rules, new people, each attempt costing more than the last' },
          { title: 'Midpoint', note: 'A win that isn’t, or a loss that isn’t — and now they act' },
          { title: 'The screws tighten', note: 'The opposition stops reacting and starts hunting' },
          { title: 'All is lost', note: 'The want fails, and what’s left is the need' },
          { title: 'The long night', note: 'No plan, no allies, and this is where the lie cracks' },
        ],
      },
      {
        title: 'Act three',
        note: 'The last quarter, the fastest pages, everything already planted',
        children: [
          { title: 'What they finally see', note: 'The truth they’ve been refusing, arriving too late to be easy' },
          { title: 'The climax', note: 'They can only win it by giving up the want' },
          { title: 'How we leave them', note: 'The same world, a different person — rhyme it with the opening' },
        ],
      },
      { title: 'The other threads', note: 'Usually a relationship, and it argues the theme' },
    ],
  },
  {
    id: 'a-character',
    name: 'a character',
    tagline: 'know what they’d do in a room you haven’t written yet',
    category: 'writing',
    branches: [
      { title: 'What they’d say they want', note: 'Out loud, to a stranger, in one sentence' },
      { title: 'What they actually need', note: 'The truth they’d have to trade the want for' },
      {
        title: 'The lie they believe',
        note: 'It was the right read once, and it isn’t now',
        children: [
          { title: 'The day it happened', note: 'One scene — an age, a room, a person' },
          { title: 'What happens if they’re wrong', note: 'The picture they can’t stand to look at' },
          { title: 'What it makes them do', note: 'Someone else has been paying for it for years' },
        ],
      },
      { title: 'Where they don’t add up', note: 'Two true things about them that shouldn’t both be true' },
      { title: 'The act they keep up', note: 'Who they need the room to think they are' },
      { title: 'Where the act slips', note: 'Tired, drunk, in love, caught out' },
      { title: 'What they’re good at', note: 'The thing they’d be doing if nobody needed them' },
      { title: 'How they get what they want', note: 'Charm, wait, bully, vanish — their first move, before they think' },
      { title: 'What their hands do', note: 'Weight, stillness, where the eyes go' },
      {
        title: 'How they talk',
        note: 'Rhythm, register, the length of their sentences',
        children: [
          { title: 'Words that are theirs alone', note: 'Two or three nobody else here would say' },
          { title: 'What they talk around', note: 'The subject they’ll steer a whole conversation to miss' },
        ],
      },
      {
        title: 'Their people',
        note: 'The few who still get a say',
        children: [
          { title: 'Who props up the lie', note: 'The easy one — and easy suits them too' },
          { title: 'Who won’t let it stand', note: 'They want something the lie is standing on' },
          { title: 'The one who remembers the first version', note: 'They still want that version back' },
        ],
      },
      { title: 'Cornered, with no good options', note: 'No time to be their better self' },
      {
        title: 'What breaks the lie',
        note: 'Not an argument — something they can’t explain away',
        children: [
          { title: 'What changing costs them', note: 'The price is real, and it isn’t the lie' },
          { title: 'Who they are on the last page', note: 'Not fixed, different — that’s not the same thing' },
        ],
      },
    ],
  },
  {
    id: 'something-to-publish',
    name: 'something to publish',
    tagline: 'everything between the angle and the send',
    category: 'writing',
    branches: [
      { title: 'The angle', note: 'If it takes a paragraph, you don’t have one yet' },
      { title: 'Who’s reading, and where', note: 'One real person, and the page they’re on when they find it' },
      { title: 'The headline', note: 'The words that do the sharing when you’re not in the room' },
      {
        title: 'How it opens',
        note: 'The first two hundred words, where an editor decides',
        children: [
          { title: 'The first line', note: 'One sentence whose only job is to buy the second' },
          { title: 'Why i’m telling you this now', note: 'What they’re getting, and why it matters today' },
        ],
      },
      { title: 'Section by section', note: 'Where it picks up speed, and where it drags' },
      { title: 'What i have on the record', note: 'Quotes, numbers, documents — who said it, and where' },
      { title: 'The hole i’m writing around', note: 'The call you haven’t made, the number you’re guessing at' },
      { title: 'The scene', note: 'A moment in the middle a reader can watch happen' },
      { title: 'What complicates it', note: 'The place it stops being tidy' },
      { title: 'The last line', note: 'What they’ll still be holding when they close the tab' },
      {
        title: 'One pass at a time',
        note: 'Never all at once, that’s how things get missed',
        children: [
          { title: 'The cut', note: 'The real start is usually further down than you think' },
          { title: 'Read it aloud', note: 'Your ear catches what your eye forgives' },
          { title: 'The facts', note: 'Names, dates, quotes, and the thing you’re sure of' },
        ],
      },
      {
        title: 'Out the door',
        note: 'The day it goes, and what you do after',
        children: [
          { title: 'The subject line', note: 'Not the headline — the promise that earns the open' },
          { title: 'Where else it goes', note: 'The excerpt, the post, the reply you’re hoping for' },
        ],
      },
    ],
  },
  {
    id: 'outline-an-essay',
    name: 'make a case',
    tagline: 'a claim that survives its strongest objection',
    category: 'writing',
    branches: [
      { title: 'The claim, in one sentence', note: 'If no one could disagree with it, it’s a topic' },
      { title: 'Why this needs saying now', note: 'Someone smart currently believes otherwise' },
      {
        title: 'First reason',
        note: 'The one you’d keep if you could keep only one',
        children: [
          { title: 'What backs it up', note: 'A number, a case, a quote — something a skeptic would accept' },
          { title: 'The assumption underneath', note: 'What a reader must already believe for this to land' },
        ],
      },
      {
        title: 'Second reason',
        note: 'Different ground, not the first one in a new coat',
        children: [
          { title: 'Its own evidence', note: 'Not the first reason’s, reached for a second time' },
          { title: 'What it rests on', note: 'If it’s the same as above, you have one reason' },
        ],
      },
      {
        title: 'The strongest objection',
        note: 'The one that kept you up, as its smartest believer puts it',
        children: [
          { title: 'Where they’re right', note: 'Concede it plainly, hedging here costs you the reader' },
          { title: 'Why the claim still stands', note: 'Not a dismissal — a reason' },
        ],
      },
      { title: 'Where the claim stops', note: 'The exceptions a reader will find if you don’t' },
      { title: 'What follows if you’re right', note: 'Not a summary — the thing that changes now' },
    ],
  },

  // ---------- learning ----------
  {
    id: 'learn-something-new',
    name: 'teach yourself something',
    tagline: 'aim at something you can do, not something you’ve read',
    category: 'learning',
    branches: [
      { title: 'What i want to be able to do', note: 'Not ‘understand it’ — a job someone could hand you tomorrow' },
      { title: 'How i’ll know i’ve got there', note: 'The proof you’d accept from someone else, not a feeling' },
      { title: 'My half-right picture', note: 'Whatever you’d say if someone asked today, wrong parts and all' },
      { title: 'The idea everything else waits on', note: 'You’ll know it by how often you bounce off it' },
      { title: 'Words i can’t read past', note: 'The five or six that unlock the rest, not a glossary' },
      { title: 'One example, worked all the way through', note: 'The messy full run, not the tidy summary' },
      {
        title: 'The loop',
        note: 'The small thing you repeat, and what tells you it’s working',
        children: [
          { title: 'The rep', note: 'Small enough to do again tomorrow without dread' },
          { title: 'Who tells me i’m wrong', note: 'A person, a test, a compiler — something that answers back' },
          { title: 'The level just past me', note: 'Comfortable reps are maintenance, not learning' },
        ],
      },
      { title: 'Questions i can’t answer yet', note: 'The fuzzy parts, sharpened into something answerable' },
      { title: 'The plain version, book shut', note: 'Out loud, no jargon, and where you stall is the gap' },
    ],
  },
  {
    id: 'investigation',
    name: 'investigation',
    tagline: 'chase it down without falling for your own theory',
    category: 'learning',
    branches: [
      { title: 'The question, narrowed', note: 'Broad enough to matter, tight enough to actually close' },
      {
        title: 'Working theory',
        note: 'The answer you suspect, stated plainly enough to be wrong',
        children: [
          { title: 'The claims inside it', note: 'Pulled apart, each piece true or false on its own' },
          { title: 'Rival explanations', note: 'The boring one, the innocent one, the coincidence' },
          { title: 'What would kill it', note: 'Named now, while you can still stomach going to look' },
        ],
      },
      { title: 'What happened, in order', note: 'Dates first, and the gaps show themselves' },
      {
        title: 'The paper trail',
        note: 'Paper first, people second — that order is the whole trick',
        children: [
          { title: 'Already public', note: 'Filings, court records, old coverage, and nobody hears you looking' },
          { title: 'What i’ll have to ask for', note: 'Requests are slow, and they tip your hand' },
        ],
      },
      {
        title: 'The people',
        note: 'The edges first — whoever’s at the centre talks last',
        children: [
          { title: 'Who set it going', note: 'The ones who made the call, not the ones who carried it' },
          { title: 'Who was in the room', note: 'They saw it happen, and memories get tidier with time' },
          { title: 'Who gained', note: 'Follow it to whoever ended up better off' },
          { title: 'Who got hurt', note: 'Hardest to reach, and the reason any of this matters' },
        ],
      },
      { title: 'Nailed down', note: 'Only what you could show someone — paper, a recording, two people' },
      { title: 'Still just a claim', note: 'Heard once, from one person, so keep it and don’t lean on it' },
      { title: 'What doesn’t fit', note: 'Two things that can’t both be true, usually the good part' },
      { title: 'Open threads', note: 'The calls not made, the boxes not opened, and who has it' },
      { title: 'Where it stands', note: 'The honest version, if you had to file it tomorrow' },
    ],
  },

  // ---------- life ----------
  {
    id: 'a-trip',
    name: 'a trip',
    tagline: 'what’s on the clock, and what can wait',
    category: 'life',
    compilesTo: 'checklist',
    branches: [
      { title: 'Who’s coming, and what for', note: 'Rest, or a hit list, and whether everyone agrees' },
      { title: 'Where, and when', note: 'Another season is another trip, and loose dates are money' },
      {
        title: 'The paperwork clock',
        note: 'None of it is fast, and it all comes before you book',
        children: [
          { title: 'Passport', note: 'Six months past your return, and pages to spare' },
          { title: 'Visas and approvals', note: 'One takes a morning, another takes two months' },
          { title: 'Jabs and pills', note: 'The clinic wants six weeks, not six days' },
          { title: 'Insurance', note: 'The cover worth having closes about two weeks after your first payment' },
        ],
      },
      { title: 'Book this first', note: 'Usually the long fare, sometimes the permit or the room that sells out' },
      {
        title: 'How the days go',
        note: 'A shape, not a schedule',
        children: [
          { title: 'The few things worth the trip', note: 'Two or three, and the route has to reach them' },
          { title: 'Arrival day', note: 'Door to bed, and what’s still open when you land' },
          { title: 'The pace', note: 'Two nights a stop, and a slack day a week' },
          { title: 'The day you leave', note: 'Checkout at eleven, flight at nine, and those hours need a plan' },
        ],
      },
      { title: 'Getting between them', note: 'A car wants the permit you can only get before you fly' },
      { title: 'A bed for every night', note: 'One line a night, and the blanks are what bite' },
      {
        title: 'The money',
        note: 'The fares are the easy half to count',
        children: [
          { title: 'Still owed, and when', note: 'Balances come due quietly, sixty days out' },
          { title: 'What a day costs there', note: 'Food, tickets, and the taxi you’ll cave and take' },
        ],
      },
      { title: 'A second card, and someone with the plan', note: 'The policy number too, and never all in one bag' },
      {
        title: 'The week before',
        note: 'Nothing here is hard, and all of it gets forgotten',
        children: [
          { title: 'What can’t be bought there', note: 'Medicines in their box, and the shoes that fit' },
          { title: 'On your phone before you go', note: 'Maps, tickets and passes, downloaded rather than emailed' },
          { title: 'Home while you’re gone', note: 'The cat, the plants, the post stacking up on the step' },
        ],
      },
    ],
  },
  {
    id: 'the-move',
    name: 'the move',
    tagline: 'count backwards from the day the van comes',
    category: 'life',
    compilesTo: 'checklist',
    branches: [
      {
        title: 'As soon as you know',
        note: 'The choices that are still cheap to change',
        children: [
          { title: 'Keys out, keys in', note: 'The two dates everything else counts back from' },
          { title: 'If the dates don’t meet', note: 'A gap means storage and a bed, an overlap means paying twice' },
          { title: 'Notice, in writing', note: 'Landlord, agent, or lender — dated, and kept' },
          { title: 'The bills that all land together', note: 'The new deposit, the first month, and the van, inside two weeks' },
        ],
      },
      {
        title: 'Six weeks out',
        note: 'The things that get more expensive the longer you wait',
        children: [
          {
            title: 'Who’s carrying it',
            note: 'Three quotes in writing, or the friend with the van',
            children: [
              { title: 'What’s covered while it’s on the van', note: 'The free option pays by weight, not by what it’s worth' },
              { title: 'What they won’t load', note: 'Gas, paint, aerosols, plants, anything that burns' },
            ],
          },
          { title: 'What isn’t coming', note: 'You pay to move every box, and selling takes weeks' },
          { title: 'What fits through the door', note: 'The sofa, the fridge, the turn at the top of the stairs' },
          { title: 'Parking, both ends', note: 'A permit takes weeks, and buildings book their own slots' },
        ],
      },
      {
        title: 'A month out',
        note: 'Paperwork that sits in someone else’s queue',
        children: [
          { title: 'The switch dates', note: 'Off the day after you leave, on the day before you arrive' },
          { title: 'Internet, earlier than you think', note: 'The only one that needs an engineer and a slot' },
          { title: 'Who needs the new address', note: 'Bank, work, doctor, driving, the tax people, the one you’ll forget' },
          { title: 'Records that travel with you', note: 'The doctor, the school, the dog, the prescription you refill' },
          { title: 'What’s tied to the old address', note: 'The gym, the parking permit, the thing that auto-renews' },
        ],
      },
      {
        title: 'Two weeks out',
        note: 'Packing stops being a someday job',
        children: [
          { title: 'One room at a time', note: 'Label it for the room it lands in, not the one it left' },
          { title: 'Mail forwarding', note: 'A net under the ones you forgot, and it expires' },
          { title: 'What rides with you', note: 'Passports, medication, keys, the drive with everything on it' },
          { title: 'Eat the freezer down', note: 'It has to be empty and dry a day before the van' },
          { title: 'Somewhere else for the kids and the dog', note: 'The front door stands open for six hours' },
        ],
      },
      {
        title: 'The week of',
        note: 'Nothing new starts now, you’re only closing what’s open',
        children: [
          { title: 'The box you open first', note: 'Kettle, bedding, chargers, toilet paper, a knife for the tape' },
          { title: 'Everything confirmed twice', note: 'The hour, the address, the parking, the payment, the keys' },
          { title: 'Cleaning, and proving it', note: 'The report from the day you moved in is what you’re judged against' },
        ],
      },
      {
        title: 'Moving day',
        note: 'You’re the coordinator today, not the muscle',
        children: [
          { title: 'What goes, what stays', note: 'Walk it with them before the first box moves' },
          { title: 'Read the meters, photograph the meters', note: 'Gas, water, power, with the date on the picture' },
          { title: 'Every key, both ways', note: 'Window keys, the garage remote, the one next door has' },
          { title: 'A sign on each door', note: 'Twenty seconds of direction saves carrying it all twice' },
          { title: 'Walk it once more, empty', note: 'The loft, the shed, behind every door, and photograph it' },
          { title: 'Beds built before the crew leave', note: 'Ten minutes for them, or midnight for you' },
        ],
      },
      {
        title: 'The first month',
        note: 'After you’re in, when nobody is helping any more',
        children: [
          { title: 'Photograph it before you fill it', note: 'Anything unreported now is your damage at the end' },
          { title: 'Who else has a key', note: 'The last tenant’s cleaner, their dog walker, their ex' },
          { title: 'Where the water shuts off', note: 'And the fuse box, before you need either at 2am' },
          { title: 'Chasing the deposit', note: 'There’s a clock on it, and it started without telling you' },
          { title: 'What arrived broken', note: 'The window for saying so closes before the unpacking does' },
          { title: 'The changes you couldn’t make yet', note: 'Driving, registration, voting — they all wanted proof you live there' },
          { title: 'The boxes you never opened', note: 'A month taped shut means you didn’t need it' },
        ],
      },
    ],
  },
  {
    id: 'plan-a-gathering',
    name: 'host a gathering',
    tagline: 'the work all happens before anyone knocks',
    category: 'life',
    branches: [
      { title: 'What this night is', note: 'Loud and late, or slow and lingering' },
      { title: 'Who’s coming', note: 'The names, the number, and who’s never met' },
      { title: 'When and where', note: 'How many can sit down, and where the rest spill' },
      { title: 'The invite', note: 'A reply-by early enough to chase the quiet ones' },
      {
        title: 'The menu',
        note: 'One dish that shows off, the rest that hold themselves',
        children: [
          { title: 'Who can’t eat what', note: 'Names against needs — an allergy isn’t a preference' },
          { title: 'How much to make', note: 'Heads, plus the one who eats like three' },
        ],
      },
      {
        title: 'Drink',
        note: 'Two in the first hour, one an hour after',
        children: [
          { title: 'For whoever isn’t drinking', note: 'Something you’d want yourself, not a warm cola' },
          { title: 'Ice', note: 'A pound a head, one and a half if it’s warm' },
        ],
      },
      { title: 'The shopping', note: 'The heavy shop early, the fresh things last' },
      {
        title: 'What gets made ahead',
        note: 'The more that’s done now, the more of the night you get',
        children: [
          { title: 'A week out', note: 'The freezer, and anything with a lead time' },
          { title: 'The day before', note: 'Braises, sauces, puddings — they’re better tomorrow anyway' },
          { title: 'The morning of', note: 'The cold jobs — chop, set the table, chill the white' },
        ],
      },
      {
        title: 'The room',
        note: 'Come in your own front door and see what they’ll see',
        children: [
          { title: 'Where people end up', note: 'They’ll stand in the kitchen, so plan for it rather than fight it' },
          { title: 'Who sits where', note: 'The loud one in the middle, never at the end' },
          { title: 'Light and sound', note: 'Lamps rather than the overhead, music under the talking' },
          { title: 'Coats, bags, bathroom', note: 'Three things every guest needs in the first minute' },
        ],
      },
      {
        title: 'How the night runs',
        note: 'Roughly when, not exactly, but somebody has to decide',
        children: [
          { title: 'The hour before', note: 'Dressed, kitchen quiet, one poured for you' },
          { title: 'The first ten minutes', note: 'A drink in the hand before the coat’s off' },
          { title: 'When we eat', note: 'The one time that can’t move — everything bends to it' },
          { title: 'The moment it’s for', note: 'The toast, the cake, the thing, and a time on it' },
          { title: 'After the plates', note: 'Have a move ready, this is where evenings die' },
          { title: 'How it ends', note: 'Music down, lights up, people need permission to go' },
        ],
      },
      { title: 'Who’s doing what', note: 'A name against the door, the music, the dishes' },
    ],
  },
  {
    id: 'meals-for-the-week',
    name: 'a week of dinners',
    tagline: 'so nothing rots, and thursday has an answer',
    category: 'life',
    branches: [
      { title: 'How many dinners, really', note: 'Four is usually the honest number, not seven' },
      { title: 'What’s already here', note: 'The half bag of spinach is already on the clock' },
      {
        title: 'The dinners',
        note: 'Ordered by what rots first, not by the calendar',
        children: [
          { title: 'Early, while it’s fresh', note: 'Fish, greens, herbs — the things that won’t wait' },
          { title: 'Later, from what keeps', note: 'By friday it’s pasta, eggs, whatever’s in the freezer' },
        ],
      },
      { title: 'The one big cook', note: 'Double what reheats, thursday shouldn’t taste like sunday' },
      { title: 'When you’re wrecked on thursday', note: 'Beans on toast counts, it just has to already be here' },
      { title: 'The list, aisle by aisle', note: 'Only what’s missing — one head of garlic, not three' },
    ],
  },
  {
    id: 'money-honestly',
    name: 'money, honestly',
    tagline: 'every number in one place, including the one you avoid',
    category: 'life',
    branches: [
      { title: 'What comes in, and when it lands', note: 'Take-home rather than the headline, and how steady it really is' },
      {
        title: 'What goes out',
        note: 'Everything, before you argue with any of it',
        children: [
          { title: 'The bills that don’t move', note: 'Rent, insurance, phone — the ones you’ve stopped noticing' },
          { title: 'What you actually spend', note: 'Not what you’d guess, what the statement says' },
          { title: 'Once a year, all at once', note: 'Insurance, the car, december, divided by twelve' },
        ],
      },
      {
        title: 'What you owe',
        note: 'All of it, in one place, for once',
        children: [
          { title: 'Every balance, and its rate', note: 'The rate’s on the statement, not in your memory' },
          { title: 'The debts you left off', note: 'Your brother, the buy-now-pay-later, the one you flinch at' },
          { title: 'Anything with a consequence', note: 'What you’re behind on — rent, power, the car that gets you to work' },
        ],
      },
      { title: 'What’s left', note: 'Income minus everything above, and it’s allowed to be negative' },
      { title: 'When it gets tight', note: 'Which months, and what you actually do to get through' },
      { title: 'The cushion', note: 'How many weeks you’d last if it all stopped' },
      { title: 'Money with a name on it', note: 'The deposit, the trip, the year off you keep not taking' },
      { title: 'One change, this month', note: 'Not the biggest one — the one that survives march' },
    ],
  },

  // ---------- reflecting ----------
  {
    id: 'weekly-review',
    name: 'weekly review',
    tagline: 'the week that happened, not the one you remember',
    category: 'reflecting',
    branches: [
      { title: 'Still in my head', note: 'All of it, before you start sorting' },
      { title: 'Where the week actually went', note: 'Last week’s calendar — every meeting left something owed' },
      { title: 'Moved this week', note: 'More than you think, and it’s on the record somewhere' },
      {
        title: 'Stuck',
        note: 'Nothing moved here, so whose move is it',
        children: [
          { title: 'Stalled on me', note: 'No next step is why it’s stuck, so name one' },
          { title: 'Waiting on someone', note: 'The nudge goes out now, not monday' },
          { title: 'Let it go', note: 'Stuck two weeks running, and that’s allowed' },
        ],
      },
      { title: 'Already booked', note: 'Next week’s calendar, and how little room is left' },
      { title: 'Worth protecting', note: 'Two or three, blocked now or the week takes them' },
    ],
  },
  {
    id: 'a-goal-gently',
    name: 'a goal, gently',
    tagline: 'one thing you want, and a plan for the day you don’t feel like it',
    category: 'reflecting',
    branches: [
      { title: 'Whose goal is this', note: 'Yours, or something you feel you should want' },
      { title: 'What it looks like when it’s real', note: 'A tuesday after it’s true, not the finish line' },
      {
        title: 'What gets in my own way',
        note: 'Not the schedule, the thing underneath it',
        children: [
          { title: 'If that shows up, then i', note: 'One small move, chosen now rather than in the moment' },
        ],
      },
      { title: 'The first move, and when i’ll make it', note: 'Something you could do badly in ten minutes' },
      { title: 'One person who’d ask', note: 'Not to applaud, to ask how it went' },
    ],
  },
  {
    id: 'working-through-a-worry',
    name: 'taking a worry apart',
    tagline: 'for the thought that keeps coming back around',
    category: 'reflecting',
    branches: [
      { title: 'When it showed up', note: 'A message, a silence, or nothing you can point to' },
      { title: 'What the body’s doing', note: 'Chest, jaw, breath, and a name for it if it has one' },
      { title: 'The worry, said plainly', note: 'One sentence, the one you’d be embarrassed to say out loud' },
      {
        title: 'What i actually know',
        note: 'Facts only, the ones that would still hold up in the morning',
        children: [
          { title: 'Why the worry makes sense', note: 'It isn’t stupid, something real is feeding it' },
          { title: 'What it’s leaving out', note: 'What the worry skipped over on its way here' },
        ],
      },
      {
        title: 'How this actually plays out',
        note: 'Worry only ever plays the one version, and there are others',
        children: [
          { title: 'If it all went wrong', note: 'The version you’ve been rehearsing, said in full so it stops growing' },
          { title: 'And then what', note: 'It always stops at the worst frame, so keep going past it' },
          { title: 'How i’d get through it', note: 'You’ve survived things before, and that wasn’t luck' },
          { title: 'What’s likelier than that', note: 'Not the good ending, the boring one' },
        ],
      },
      { title: 'If a friend said this to me', note: 'You’d never talk to them the way you’re talking to you' },
      { title: 'Mine to do', note: 'The parts that would move if you actually pushed on them' },
      { title: 'Not mine to carry', note: 'Other people’s choices, the past, the weather' },
      { title: 'One small thing, and when', note: 'Not the fix, just the next real move, put on the clock' },
      { title: 'Where it’s sitting now', note: 'Back to the chest, the jaw, and whether it moved at all' },
    ],
  },
  {
    id: 'a-hard-conversation',
    name: 'before a hard conversation',
    tagline: 'untangle it here, so you don’t untangle it on them',
    category: 'reflecting',
    branches: [
      {
        title: 'What happened',
        note: 'Yours isn’t the neutral one, and neither is theirs',
        children: [
          { title: 'The story i’m telling myself', note: 'Written down, it stops feeling like the only one' },
          { title: 'Their story, if they’re not the villain', note: 'The one where they’re reasonable and you still don’t like it' },
          { title: 'What they know that i don’t', note: 'You built your version out of half the information' },
          { title: 'Meant one thing, landed another', note: 'You guessed their intent from how much it hurt' },
          { title: 'My part in it', note: 'Not fault, just the part that’s yours to move' },
        ],
      },
      {
        title: 'What i’m feeling',
        note: 'They come into the room whether you name them or not',
        children: [
          { title: 'The feeling i’d admit to', note: 'The one you’d give if someone asked you right now' },
          { title: 'What’s under it', note: 'Usually hurt, or fear, or something you’d rather not say' },
        ],
      },
      {
        title: 'What this says about me',
        note: 'This is the one that actually makes it hard',
        children: [
          { title: 'What i’m afraid it makes me', note: 'Incompetent, unkind, not who you thought — the actual word' },
          { title: 'Ground i can stand on', note: 'You can be wrong here and still be alright' },
        ],
      },
      {
        title: 'Why i’m raising this',
        note: 'If the honest answer is to win, sit with it longer',
        children: [
          { title: 'Where i want this to land', note: 'The honest one, not the diplomatic one' },
          { title: 'What i’d settle for', note: 'The one you’d shake hands on, not celebrate' },
        ],
      },
      { title: 'Whether to raise it at all', note: 'Letting go is a real move, if you can actually do it' },
      {
        title: 'How i open',
        note: 'It’s the only part of this you actually control',
        children: [
          { title: 'How a stranger would tell it', note: 'No villain, no victim, just two people and a gap' },
          { title: 'The first sentence, word for word', note: 'Out loud, before you say it to them' },
        ],
      },
      { title: 'If it goes sideways', note: 'They cry, they rage, they leave, and you still need a next move' },
    ],
  },
];

/** Presets in a category, in declared order. `custom` has none built in. */
export function presetsInCategory(category: PresetCategory): Preset[] {
  return PRESETS.filter((p) => p.category === category);
}

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export interface SeededPreset {
  nodes: ThoughtNode[];
  /** Ghost prompts to persist as local `hint:<id>` settings (never a body). */
  hints: { id: string; note: string }[];
}

/**
 * Pure builder: turn a preset into the child thoughts to plant under `context`,
 * recursing into any nested branches (built-ins nest where their subject really
 * subdivides; custom presets can be multi-level too). Timestamps stagger by
 * sibling index so the authored order survives recency sort (branch 0 is the
 * freshest → sits on top). A branch's `note` comes back as a hint (never a body)
 * so an unfilled scaffold compiles to titles alone (SPEC §8); a branch's `body`
 * (custom "as-is") is seeded as real content instead.
 */
export function buildSeedNodes(
  preset: Preset,
  context: ContextId,
  opts: { now: number; baseSort: number; id: (index: number) => string; maxDepth?: number }
): SeededPreset {
  // `maxDepth` = how many levels may be added below `context` (SPEC §4 depth cap).
  // A nested preset must not plant past it.
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  // A checklist-paired shape is a list of things to DO — its seeds are born
  // open tasks (SPEC v1.1 amdt 17), so the parent's badge counts them at once.
  const asTasks = preset.compilesTo === 'checklist';
  const nodes: ThoughtNode[] = [];
  const hints: { id: string; note: string }[] = [];
  let seq = 0;
  const walk = (branches: PresetBranch[], parentId: ContextId, baseSort: number, level: number) => {
    if (level > maxDepth) return; // clamp: deeper branches are dropped, not planted past the cap
    branches.forEach((branch, i) => {
      const id = opts.id(seq++);
      const ts = opts.now - i; // sibling 0 newest → first under recency ordering
      // Same commit-time shape as typed thoughts (amdt 18): empties drop, the
      // first surviving field is the body.
      const d = normalizeDetails(branch.body ?? '', branch.extras ?? []);
      const title = (branch.title ?? '').slice(0, TITLE_MAX);
      // [expand] grown suggestions ride the node itself now (SPEC-AI §3.13):
      // trimmed + blank-dropped, synced WITH the thought (payload key `sug`).
      const sugg = (branch.suggestions ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
      nodes.push({
        id,
        parentId,
        // SPEC-SYNC §7.2 — a seeded node is a creation; every group is new.
        contentAt: ts,
        structureAt: ts,
        flagsAt: ts,
        title: title || null,
        body: d.body,
        extras: d.extras,
        suggestions: sugg,
        sort: baseSort + i,
        createdAt: ts,
        updatedAt: ts,
        editedAt: null, // seeded and grown thoughts are written, never edited
        deletedAt: null,
        accessedAt: ts,
        pinnedAt: null,
        taskAt: asTasks || branch.task ? ts : null,
        // SPEC-CALENDAR §3 — seeded thoughts are born undated; the week offer
        // (§5.3) is the one-tap door for a weekday-shaped batch afterwards.
        whenDay: null,
        whenTime: null,
        whenRepeat: null,
        whenAlert: null,
        completedAt: null,
        archivedAt: null,
      });
      const note = branch.note?.trim();
      if (note && !d.body) hints.push({ id, note });
      if (branch.children && branch.children.length) walk(branch.children, id, 1, level + 1);
    });
  };
  walk(preset.branches, context, opts.baseSort, 1);
  return { nodes, hints };
}

/** Total thoughts a preset would seed (across all levels). */
export function countBranches(branches: PresetBranch[]): number {
  let n = 0;
  for (const b of branches) {
    n += 1;
    if (Array.isArray(b.children)) n += countBranches(b.children);
  }
  return n;
}

/** A category key, normalized: trimmed + lowercased, empty → `custom`. */
export function normalizeCategory(cat: string): string {
  return cat.trim().toLowerCase() || 'custom';
}

/**
 * Snapshot a thought's subtree into a reusable custom preset. The preset's
 * branches are the target's CHILDREN (so applying it under a new thought
 * reproduces the same shape). `includeDetails` keeps bodies ("as-is", good for
 * repeatable checklists); otherwise only titles + structure are kept (skeleton).
 * Pure — the caller supplies the id and timestamp.
 */
export function buildPresetFromTree(
  nodes: NodeMap,
  rootId: string,
  opts: { name: string; category: string; includeDetails: boolean; id: string; now: number }
): Preset {
  const toBranch = (node: ThoughtNode): PresetBranch => {
    // Skeleton keeps each thought's DISPLAYED label (`displayTitle`) so a
    // title-less, body-only thought still contributes a usable titled slot
    // rather than a blank one; the body itself is always dropped in skeleton
    // mode. As-is keeps the raw title (preserving title-less thoughts) + body.
    const branch: PresetBranch = {
      title: opts.includeDetails ? node.title ?? '' : displayTitle(node),
    };
    if (opts.includeDetails && node.body) branch.body = node.body;
    if (opts.includeDetails && node.extras.length) branch.extras = [...node.extras];
    const kids = childrenOf(nodes, node.id).map(toBranch);
    if (kids.length) branch.children = kids;
    return branch;
  };
  const branches = childrenOf(nodes, rootId).map(toBranch);
  const n = countBranches(branches);
  return {
    id: opts.id,
    name: opts.name.trim(),
    tagline: `${n} ${n === 1 ? 'thought' : 'thoughts'}`,
    category: normalizeCategory(opts.category),
    branches,
    custom: true,
    createdAt: opts.now,
  };
}

export interface CategoryInfo {
  key: string;
  label: string;
  count: number;
}

/** Distinct categories the user's custom presets live in, in first-seen order. */
export function customCategoriesOf(customPresets: Preset[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of customPresets) {
    if (!seen.has(p.category)) {
      seen.add(p.category);
      out.push(p.category);
    }
  }
  return out;
}

/** Human label for a category key — the default's label, else the key itself. */
export function categoryLabel(key: string): string {
  return PRESET_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

/** Presets (built-in + custom) filed under a category, built-ins first. */
export function presetsForCategory(category: string, customPresets: Preset[]): Preset[] {
  return [
    ...PRESETS.filter((p) => p.category === category),
    ...customPresets.filter((p) => p.category === category),
  ];
}

/**
 * Categories to show in the picker: the defaults (in declared order) plus any
 * custom-only categories, each with a live count (built-in + custom). Empty
 * categories are omitted, so a bare `custom` bucket never shows until used.
 */
export function browseCategories(customPresets: Preset[]): CategoryInfo[] {
  const countFor = (key: string) =>
    PRESETS.filter((p) => p.category === key).length +
    customPresets.filter((p) => p.category === key).length;
  const out: CategoryInfo[] = [];
  const seen = new Set<string>();
  for (const c of PRESET_CATEGORIES) {
    const count = countFor(c.key);
    if (count > 0) {
      out.push({ key: c.key, label: c.label, count });
      seen.add(c.key);
    }
  }
  for (const p of customPresets) {
    if (seen.has(p.category)) continue;
    seen.add(p.category);
    out.push({ key: p.category, label: categoryLabel(p.category), count: countFor(p.category) });
  }
  return out;
}

/** Coerce untrusted branch JSON into well-formed PresetBranches (drops junk). */
/**
 * Coerce untrusted branch data to a well-formed `PresetBranch[]` (shape only —
 * no size caps; callers with unbounded input add their own). Shared by
 * `parseCustomPresets` below and by [expand]'s AI-tree landing pad.
 */
export function sanitizeBranches(raw: unknown): PresetBranch[] {
  if (!Array.isArray(raw)) return [];
  const out: PresetBranch[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const rb = b as Record<string, unknown>;
    const branch: PresetBranch = { title: typeof rb.title === 'string' ? rb.title : '' };
    if (typeof rb.note === 'string') branch.note = rb.note;
    if (typeof rb.body === 'string') branch.body = rb.body;
    if (rb.task === true) branch.task = true;
    if (Array.isArray(rb.extras)) {
      const xs = rb.extras.filter((x): x is string => typeof x === 'string');
      if (xs.length) branch.extras = xs;
    }
    if (Array.isArray(rb.suggestions)) {
      const ss = rb.suggestions.filter((x): x is string => typeof x === 'string');
      if (ss.length) branch.suggestions = ss;
    }
    const kids = sanitizeBranches(rb.children);
    if (kids.length) branch.children = kids;
    out.push(branch);
  }
  return out;
}

/**
 * Safely parse the persisted custom-preset blob (local settings JSON). This is
 * a trust boundary — a corrupt or hand-edited row must never crash boot or the
 * picker, so malformed presets are dropped and every branch is normalized to a
 * well-formed shape (string title, optional string note/body, array children).
 */
export function parseCustomPresets(raw: string | undefined): Preset[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: Preset[] = [];
    for (const p of data) {
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !Array.isArray(p.branches)) {
        continue;
      }
      out.push({
        id: p.id,
        name: p.name,
        tagline: typeof p.tagline === 'string' ? p.tagline : '',
        category: typeof p.category === 'string' ? p.category : 'custom',
        branches: sanitizeBranches(p.branches),
        custom: true,
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Settings key holding a thought's ghost prompt (local-only; never synced). */
export const hintKey = (nodeId: string): string => `hint:${nodeId}`;

/** Settings key holding the user's custom presets (local-only; never synced). */
export const CUSTOM_PRESETS_KEY = 'customPresets';
