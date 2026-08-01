/**
 * `tinhead-mcp` — the tool surface. SPEC-AGENT §6.
 *
 * Transport-free on purpose: every tool is a plain async function over a
 * context, so the whole surface is unit-testable without speaking MCP, and
 * `server.ts` is a thin binding rather than the place the rules live.
 *
 * **§1.7 is a hard rule here: every honest limitation the agent must work around
 * is in the tool DESCRIPTION**, not only in the README — the description is what
 * the model actually reads. So the descriptions say that the level order is
 * `created`, that compile truncates, that a covered field exists and cannot be
 * read, and that a level pages.
 */

import { compileArtifact } from '../../../src/compile';
import { DEFAULT_TARGET_ID, targetById } from '../../../src/compile/targets';
import { GrantScope } from '../../../src/agent/types';
import {
  DEFAULT_SORT,
  NodeMap,
  detailText,
  displayTitle,
  isUnderArchive,
  levelStats,
  orderedChildren,
  pathTo,
  subtreeStats,
} from '../../../src/model/tree';
import { sealedCount } from '../../../src/model/sealed';
import { ThoughtNode } from '../../../src/model/types';
import { ABOUT_TINHEAD } from './about';
import { Corpus } from './corpus';
import { NOT_YET_GRANTED, ScopeError, inBranches, inReadScope, requireRead } from './scope';
import { rankThoughts } from './search';

/** §6.3 — nothing returns unbounded. A silent truncation reads to a model as a complete answer. */
export const LEVEL_PAGE = 50;
export const SEARCH_LIMIT = 25;
export const COMPILE_MAX_CHARS = 40_000;
export const TASK_LIMIT = 100;
/**
 * How much detail a LISTING carries per row. `get_thought` and `compile_subtree`
 * still serve the whole of it — this is the cost of a row in a list of rows,
 * where fifty full details is most of a context window spent before the agent
 * has decided which one it wants.
 */
export const DETAIL_SNIP = 240;
/** Children of a granted root shown by `get_root` itself, before it defers to `get_level`. */
export const ROOT_PREVIEW = 12;

export interface DoorContext {
  /** The grant's own name, for `get_root`. */
  name: string;
  scope: GrantScope;
  /** The verified corpus. Refreshed by the caller's policy, never by a tool. */
  corpus(): Promise<Corpus>;
}

/**
 * What "no id" means to a tool that takes one context.
 *
 * A grant is rooted at a LIST now, so the old answer (`scope.branch`) has no
 * single successor. Guessing one — the first, the shallowest — would be a tool
 * silently choosing which of the person's projects the agent works in, which is
 * the one decision it must never make quietly.
 */
function defaultContext(ctx: DoorContext): string | null {
  const b = ctx.scope.branches;
  if (b.length === 1) return b[0];
  if (b.length === 0) {
    // Nothing granted, but the whole tree readable: the top level is a real,
    // unambiguous answer. Nothing granted and branch-scoped: there is no answer.
    if (ctx.scope.reads === 'everything') return null;
    throw new ScopeError(NOT_YET_GRANTED);
  }
  throw new ScopeError(
    `this grant is rooted at ${b.length} thoughts, so "inside what?" has no single answer — ` +
      `pass one of these ids: ${b.join(', ')} (call get_root for what they are).`
  );
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP annotations — reviewers look for these, and clients use them to decide prompting. */
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run(args: Record<string, unknown>): Promise<string>;
}

// ------------------------------------------------------------------ helpers

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function requireId(args: Record<string, unknown>, key = 'id'): string {
  const v = str(args[key]);
  if (!v) throw new ScopeError(`${key} is required`);
  return v;
}

/**
 * The breadcrumb down to a thought, as one readable line, **excluding the
 * thought itself** — this answers "where is it", not "what is it".
 *
 * Scope-filtered on the same rule as `get_path`: the corpus is the whole
 * decrypted account (§3), so an unfiltered walk climbs straight out of a granted
 * branch and hands over ancestor titles a branch-scoped grant must not learn.
 */
function breadcrumb(nodes: NodeMap, id: string, scope: GrantScope): string | null {
  const chain = pathTo(nodes, id)
    .slice(0, -1)
    .filter((p) => inReadScope(nodes, p.id, scope))
    .map((p) => displayTitle(p));
  return chain.length ? chain.join(' › ') : null;
}

interface DescribeOpts {
  /** Counts, task state and date. */
  stats?: boolean;
  /** Cap the detail at `DETAIL_SNIP` and SAY SO. For rows in a listing. */
  snip?: boolean;
}

/**
 * One thought as the model reads it. `covered` is load-bearing: `detailText`
 * omits a sealed field entirely, so without this number the agent believes it
 * has seen the whole thought — and then rewrites it (§1.5's write half is the
 * other end of the same rope).
 */
function describe(nodes: NodeMap, n: ThoughtNode, opts: DescribeOpts = {}): Record<string, unknown> {
  const stats = opts.stats !== false;
  const covered = sealedCount(n.body, n.extras);
  const full = detailText(n);
  const long = opts.snip && typeof full === 'string' && full.length > DETAIL_SNIP;
  const out: Record<string, unknown> = {
    id: n.id,
    title: displayTitle(n),
    detail: long ? `${(full as string).slice(0, DETAIL_SNIP).trimEnd()}…` : full,
  };
  if (long) out.detail_shortened = true;
  if (covered > 0) {
    out.covered_fields = covered;
    out.covered_note =
      `${covered} detail field(s) on this thought are private and cannot be read by any agent. ` +
      `They are preserved automatically when you update this thought — do not try to recreate them.`;
  }
  // The app hides an archived branch from its lists and its search; a door that
  // returned one as an ordinary thought would have the agent working on
  // something the person put away. Reachable by id (see `requireRead`), labelled
  // everywhere.
  if (isUnderArchive(nodes, n.id)) {
    out.archived = true;
    out.archived_note =
      'this thought is archived — the person has put it out of the way, and it is not in their ' +
      'lists or in this door’s search. Treat it as history unless they ask for it by name.';
  }
  if (stats) {
    const s = levelStats(nodes, [n.id]).get(n.id);
    if (s) out.inside = { thoughts: s.total, open_tasks: s.open };
    if (n.taskAt !== null) out.task = n.completedAt !== null ? 'done' : 'open';
    if (n.whenDay !== null) out.when = { day: n.whenDay, time: n.whenTime, repeat: n.whenRepeat };
  }
  return out;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

// ------------------------------------------------------------------ the tools

export function readTools(ctx: DoorContext): Tool[] {
  /** What is directly inside a granted root, bounded and honest about the bound. */
  const firstLevel = (nodes: NodeMap, id: string): Record<string, unknown> => {
    const all = orderedChildren(nodes, id, DEFAULT_SORT).filter((n) =>
      inReadScope(nodes, n.id, ctx.scope)
    );
    const shown = all.slice(0, ROOT_PREVIEW);
    return {
      total: all.length,
      order: DEFAULT_SORT,
      thoughts: shown.map((n) => describe(nodes, n, { snip: true })),
      ...(all.length > shown.length
        ? {
            note:
              `showing ${shown.length} of ${all.length} — call get_level with this id for the rest.`,
          }
        : {}),
    };
  };

  return [
    {
      name: 'get_root',
      description:
        'START HERE. Returns this grant: which thoughts it is rooted at (there may be several, ' +
        'or none yet), what it may read and write, and the ids you need for every other tool. ' +
        'Every other tool takes an id, and this is the only one that does not — call it first. ' +
        'It also hands back the FIRST LEVEL inside each root with its counts, so you can usually ' +
        'pick where to go next without a second call. ' +
        'If "roots" is empty the person has not given this connection a branch yet; say so and ' +
        'stop, because nothing can be changed until they do. ' +
        'CONVENTION: treat each root thought as the index of everything beneath it, the way you ' +
        'would treat a MEMORY.md — keep it current and you will find your own work later.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
      async run() {
        const c = await ctx.corpus();
        const wide = ctx.scope.reads === 'everything';
        const roots: ThoughtNode[] = [];
        const gone: string[] = [];
        for (const b of ctx.scope.branches) {
          const n = c.nodes.get(b);
          if (n && n.deletedAt === null) roots.push(n);
          else gone.push(b);
        }
        // The union, not the sum: two granted branches may nest, and a doubled
        // count is a wrong number handed to something that reasons about it.
        //
        // Archived thoughts are outside every other number here — `subtreeStats`
        // and `levelStats` both walk `childrenOf`, which hides them, and so do
        // this door's search and levels. Counting them in the total would hand
        // the agent a size it can never walk to, and put two numbers that
        // disagree in one answer.
        let thoughts = 0;
        let visible = 0;
        for (const n of c.nodes.values()) {
          if (isUnderArchive(c.nodes, n.id)) continue;
          visible++;
          if (inBranches(c.nodes, n.id, ctx.scope.branches)) thoughts++;
        }
        const levels = roots.reduce((m, n) => Math.max(m, subtreeStats(c.nodes, n.id).levels), 0);

        return json({
          // Repeated from the initialize response on purpose: a client that
          // drops `instructions` would otherwise leave the agent with a tool
          // table and no idea what the product is. One constant, two doors.
          about: ABOUT_TINHEAD,
          grant: ctx.name,
          // The first level comes free. Every session opened with get_root and
          // then immediately spent a round trip on get_level of the same id —
          // the counts alone say how big a branch is and never say what is IN
          // it, which is the question actually being asked. Held back when the
          // grant has many roots, where it stops being a preview and becomes
          // the tree.
          roots: roots.map((n) => ({
            ...describe(c.nodes, n),
            ...(roots.length <= 3 ? { first_level: firstLevel(c.nodes, n.id) } : {}),
          })),
          may_read: wide
            ? 'every thought'
            : roots.length
              ? `${roots.length} branch(es) only`
              : 'nothing yet',
          may_write: !ctx.scope.write
            ? 'nothing — this grant is read-only'
            : roots.length
              ? 'inside the branches above only'
              : 'nothing yet — no branch has been given to this connection',
          size: { thoughts, levels },
          ...(wide ? { whole_tree: { thoughts: visible } } : {}),
          ...(ctx.scope.branches.length === 0
            ? {
                note: wide
                  ? 'no branch has been given to this connection yet, so it can change nothing. ' +
                    'It may READ the whole tree — call get_level with no id for the top level. ' +
                    'To let it work somewhere, the person opens that thought in Tinhead and ' +
                    'chooses “Give access”.'
                  : NOT_YET_GRANTED,
              }
            : {}),
          // A branch can be binned while the connection lives on. Naming the
          // survivors beats failing the whole call, which is what the single
          // -branch shape used to do.
          ...(gone.length
            ? {
                gone: gone.length,
                gone_note:
                  `${gone.length} branch(es) this connection was given are in the bin or deleted, ` +
                  'so they are not listed above. The rest still work.',
              }
            : {}),
        });
      },
    },

    {
      name: 'search_thoughts',
      description:
        'Find thoughts by words. Matches whole words, word prefixes and misspellings (up to two ' +
        'letters off in a long word); EVERY word in the query must appear somewhere in the ' +
        'thought, so fewer words find more. Title matches rank above detail matches. ' +
        `Returns at most ${SEARCH_LIMIT}. ` +
        'EVERY HIT CARRIES WHAT TELLS IT APART: its path, whether it is a task and whether that ' +
        'task is done, how many thoughts and open tasks are inside it, and its date. Two thoughts ' +
        'often share a title — read those, not the title, to pick the one meant. ' +
        'Detail is shortened here; get_thought has the whole of one. ' +
        'It cannot match private detail fields — those are unreadable by design. ' +
        'It does not look inside ARCHIVED thoughts, matching what the person sees in the app; ' +
        'an archived thought is still readable if you already have its id, and says so. ' +
        'If you know roughly where something lives, walking with get_level from get_root is often ' +
        'more reliable than guessing words.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'words to look for' } },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      async run(args) {
        const q = str(args.query);
        if (!q) return json({ matched: 0, matches: [] });
        const c = await ctx.corpus();
        // Nothing granted and no wide read: say why there is nothing rather than
        // returning an empty result the model reads as "it isn't there".
        if (ctx.scope.reads !== 'everything' && ctx.scope.branches.length === 0) {
          return json({ matched: 0, matches: [], note: NOT_YET_GRANTED });
        }
        const candidates: ThoughtNode[] = [];
        for (const n of c.nodes.values()) {
          // The app's own lens (`searchNodes`) skips an archived branch, and this
          // matcher must agree — a door whose search reaches further than the
          // person's own is a surprise, not a feature.
          if (isUnderArchive(c.nodes, n.id)) continue;
          if (inReadScope(c.nodes, n.id, ctx.scope)) candidates.push(n);
        }
        const hits = rankThoughts(candidates, q, SEARCH_LIMIT);
        return json({
          matched: hits.length,
          searched: candidates.length,
          // Search is the one tool that returns AMBIGUOUS results — several
          // thoughts that could each be the one meant — and it used to be the
          // one tool with the disambiguating fields switched off, while serving
          // the full detail text of every hit. It spent the room on the half
          // that does not decide anything. Now: path, task state, counts and
          // date on every hit, and the detail shortened to pay for them.
          matches: hits.map((h) => ({
            ...describe(c.nodes, h.node, { snip: true }),
            path: breadcrumb(c.nodes, h.node.id, ctx.scope),
            matched_in: h.where,
          })),
        });
      },
    },

    {
      name: 'get_level',
      description:
        'The thoughts directly inside one thought — one level, not the whole subtree. ' +
        `Ordered oldest-first (the app's default, "${DEFAULT_SORT}"); the app can show a level in ` +
        'another order per-level, which this does not read, so do not treat this order as what the ' +
        'person sees. ' +
        `Returns at most ${LEVEL_PAGE} per call — pass "page" (0, 1, 2 …) for the rest, and the ` +
        'result says whether more remain. ' +
        'Detail is shortened on each row (marked detail_shortened) — get_thought has the whole of one. ' +
        'Thoughts the person has archived are not listed, as in the app; look inside one by id and ' +
        'what is in it is listed, each labelled archived. ' +
        'Omitting the id works only where there is ONE obvious place to look: the branch, when this ' +
        'grant was given exactly one; or the top of the tree, when it was given none and reads ' +
        'everything. Given several branches it refuses and names their ids — pass one of them.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'the thought to look inside; omit only where there is one obvious place',
          },
          page: { type: 'number', description: '0-based page of results' },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      async run(args) {
        const c = await ctx.corpus();
        const id = str(args.id) ?? defaultContext(ctx);
        if (id !== null) requireRead(c.nodes, id, ctx.scope);
        const page = Math.max(0, Math.floor(num(args.page) ?? 0));
        const all = orderedChildren(c.nodes, id, DEFAULT_SORT).filter((n) =>
          inReadScope(c.nodes, n.id, ctx.scope)
        );
        const slice = all.slice(page * LEVEL_PAGE, page * LEVEL_PAGE + LEVEL_PAGE);
        return json({
          inside: id,
          order: DEFAULT_SORT,
          page,
          total: all.length,
          more: page * LEVEL_PAGE + slice.length < all.length,
          thoughts: slice.map((n) => describe(c.nodes, n, { snip: true })),
        });
      },
    },

    {
      name: 'find_tasks',
      description:
        'THE WORK IN A BRANCH — every task under a thought, the open ones by default. ' +
        'get_root tells you how MANY tasks are open; this is the tool that reads them. ' +
        'Each comes back with its path, its date and what is inside it, so "what is outstanding" ' +
        'is one call and not a walk. ' +
        'Omit both id and name to cover everything this grant can read. ' +
        'Pass "id" for a branch you already have, or "name" for one the person named in words ' +
        '("the Calendar list") — name is matched the way search is, and the result REPORTS which ' +
        'branch it took and every other one that matched, so say that back to them rather than ' +
        'presenting a guess as the answer. ' +
        'state: "open" (default) · "done" · "all". ' +
        `Returns at most ${TASK_LIMIT}, and SAYS SO when there are more. ` +
        'ONLY thoughts the person designated a task are here. An ordinary thought is a note, not ' +
        'a backlog item, so a branch with no boxes legitimately answers zero — that is an answer, ' +
        'not a miss. Archived thoughts are excluded, as in the app.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'the thought to look under; omit for everything this grant can read',
          },
          name: {
            type: 'string',
            description: 'words naming the branch, when you do not have its id ("Calendar")',
          },
          state: { type: 'string', description: '"open" (default), "done", or "all"' },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      async run(args) {
        const c = await ctx.corpus();
        const state = (str(args.state) ?? 'open').toLowerCase();
        if (state !== 'open' && state !== 'done' && state !== 'all') {
          throw new ScopeError(`state must be "open", "done" or "all" — not "${state}"`);
        }
        const wanted = (n: ThoughtNode): boolean =>
          n.taskAt !== null &&
          !(state === 'open' && n.completedAt !== null) &&
          !(state === 'done' && n.completedAt === null) &&
          !isUnderArchive(c.nodes, n.id) &&
          inReadScope(c.nodes, n.id, ctx.scope);

        let id = str(args.id);
        const name = str(args.name);
        let resolved: Record<string, unknown> | null = null;
        if (id !== null) {
          requireRead(c.nodes, id, ctx.scope);
        } else if (name !== null) {
          // A person names a branch in words; this is where words become an id,
          // ONCE, in the tool — rather than every caller reimplementing "search
          // then pick the first" and each one deciding differently whether to
          // mention what it passed over.
          const pool: ThoughtNode[] = [];
          for (const n of c.nodes.values()) {
            if (isUnderArchive(c.nodes, n.id)) continue;
            if (inReadScope(c.nodes, n.id, ctx.scope)) pool.push(n);
          }
          const ranked = rankThoughts(pool, name, 10).map((h) => ({
            node: h.node,
            // Among equally-good name matches, the one that actually HOLDS work
            // of the kind being asked for is what a person means by "the
            // Calendar list". A tie-break, never a filter: everything that
            // matched is reported either way.
            count: [...c.nodes.values()].filter(
              (n) => wanted(n) && inBranches(c.nodes, n.id, [h.node.id])
            ).length,
          }));
          if (!ranked.length) {
            return json({
              state,
              matched: 0,
              tasks: [],
              note:
                `nothing here is called "${name}". Try fewer words, or call get_root and walk — ` +
                'search matches words, not meaning.',
            });
          }
          ranked.sort((a, b) => b.count - a.count || b.node.updatedAt - a.node.updatedAt);
          const pick = ranked[0];
          id = pick.node.id;
          resolved = {
            asked: name,
            took: {
              id: pick.node.id,
              title: displayTitle(pick.node),
              path: breadcrumb(c.nodes, pick.node.id, ctx.scope),
              [`${state}_tasks_inside`]: pick.count,
            },
            ...(ranked.length > 1
              ? {
                  also_matched: ranked.slice(1, 4).map((r) => ({
                    id: r.node.id,
                    title: displayTitle(r.node),
                    path: breadcrumb(c.nodes, r.node.id, ctx.scope),
                    [`${state}_tasks_inside`]: r.count,
                  })),
                  note:
                    `"${name}" matched ${ranked.length} thoughts — tell the person which one you ` +
                    'took, and name the others, so they can redirect you in one word.',
                }
              : {}),
          };
        } else if (ctx.scope.reads !== 'everything' && ctx.scope.branches.length === 0) {
          return json({ state, matched: 0, tasks: [], note: NOT_YET_GRANTED });
        }

        const found: { node: ThoughtNode; where: string }[] = [];
        for (const n of c.nodes.values()) {
          // `wanted` carries the state filter AND the app's own lens (bin,
          // archive, scope) — one predicate, so the name-resolution counts above
          // and the list below can never disagree about what a task is.
          if (!wanted(n)) continue;
          if (id !== null && !inBranches(c.nodes, n.id, [id])) continue;
          found.push({ node: n, where: breadcrumb(c.nodes, n.id, ctx.scope) ?? '' });
        }
        // Grouped by location rather than ranked: a list of tasks is read to
        // decide what to do next, and the branch a task sits under is most of
        // what decides that. Ties go newest-touched first.
        found.sort((a, b) => a.where.localeCompare(b.where) || b.node.updatedAt - a.node.updatedAt);
        const shown = found.slice(0, TASK_LIMIT);

        return json({
          under: id,
          ...(resolved ? { resolved } : {}),
          state,
          matched: found.length,
          ...(found.length > shown.length
            ? {
                note:
                  `showing ${shown.length} of ${found.length} — ask about a branch with "id" to ` +
                  'narrow it, rather than reading a truncated list as the whole of the work.',
              }
            : {}),
          tasks: shown.map((f) => ({
            ...describe(c.nodes, f.node, { snip: true }),
            path: f.where || null,
          })),
        });
      },
    },

    {
      name: 'get_path',
      description:
        'Where a thought sits — the chain of thoughts from the top down to it. Use it to orient ' +
        'after a search, or to describe a location to the person in their own words.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      async run(args) {
        const c = await ctx.corpus();
        const id = requireId(args);
        requireRead(c.nodes, id, ctx.scope);
        return json({
          path: pathTo(c.nodes, id)
            .filter((n) => inReadScope(c.nodes, n.id, ctx.scope))
            .map((n) => ({ id: n.id, title: displayTitle(n) })),
        });
      },
    },

    {
      name: 'get_thought',
      description:
        'One thought in full: its words, its detail, whether it is a task, its date, and how much ' +
        'is inside it. If it reports covered_fields, those detail entries are private and no agent ' +
        'can read them — they are carried through your updates untouched. ' +
        'The path it returns starts at the branch you were given, not at the top of the person’s ' +
        'tree — what sits above your branch is not yours to see.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      async run(args) {
        const c = await ctx.corpus();
        const id = requireId(args);
        requireRead(c.nodes, id, ctx.scope);
        const n = c.nodes.get(id)!;
        const s = subtreeStats(c.nodes, id);
        return json({
          ...describe(c.nodes, n),
          subtree: { thoughts: s.thoughts, levels: s.levels },
          // The corpus is the WHOLE decrypted account by design (§3), so this
          // walk climbs straight out of the branch unless it is filtered —
          // ancestor titles above a branch root are exactly the thing a
          // branch-scoped grant must not learn. `get_path` filters the identical
          // walk; this one did not, and leaked them.
          path: pathTo(c.nodes, id)
            .filter((p) => inReadScope(c.nodes, p.id, ctx.scope))
            .map((p) => displayTitle(p)),
        });
      },
    },

    {
      name: 'compile_subtree',
      description:
        'THE PRIMARY READ TOOL — prefer it to walking level by level. Renders a thought and ' +
        'everything inside it as one document, which is almost always what you actually want and ' +
        'costs one call instead of dozens. ' +
        `Targets: ${['document', 'prompt', 'work-order', 'brief', 'draft', 'checklist', 'outline', 'summary'].join(', ')} ` +
        `(default "${DEFAULT_TARGET_ID}"). ` +
        `Truncates at ${COMPILE_MAX_CHARS.toLocaleString()} characters and SAYS SO in the result ` +
        'rather than silently — if it truncates, compile a smaller thought rather than trusting the tail. ' +
        'Private detail fields are omitted from every target. ' +
        'The "checklist" target is the cheapest way to see the WORK in a branch: it boxes tasks ' +
        'only — `[ ]` open, `[x]` ticked off — and leaves every ordinary thought a plain bullet, ' +
        'so the boxes you count are the tasks the person actually designated.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          target: { type: 'string', description: `one of the target names; default ${DEFAULT_TARGET_ID}` },
        },
        required: ['id'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      async run(args) {
        const c = await ctx.corpus();
        const id = requireId(args);
        requireRead(c.nodes, id, ctx.scope);
        const targetId = str(args.target) ?? DEFAULT_TARGET_ID;
        const target = targetById(targetId);
        if (!target) throw new ScopeError(`no such target: ${targetId}`);
        const artifact = compileArtifact(c.nodes, id, target, { form: 'outline', includeDetail: true });
        if (!artifact) return json({ text: null, note: 'that thought has nothing to compile' });
        const full = artifact.text;
        const truncated = full.length > COMPILE_MAX_CHARS;
        return json({
          target: target.id,
          truncated,
          ...(truncated
            ? { note: `TRUNCATED at ${COMPILE_MAX_CHARS} of ${full.length} characters — compile a smaller thought for the rest.` }
            : {}),
          text: truncated ? full.slice(0, COMPILE_MAX_CHARS) : full,
        });
      },
    },
  ];
}
