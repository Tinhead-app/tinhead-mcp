/**
 * `tinhead-mcp` — the write tools. SPEC-AGENT §6 (P3).
 *
 * Every one of them is the same four steps: check the scope, ask [core] what
 * the write would be, push it atomically, report what happened. No rule is
 * decided here — `mutations.ts` owns which fields a verb touches and every
 * stamp it lays down, and this file owns nothing but the door's manners.
 *
 * §7's negative rule is asserted structurally: **there is no navigation action
 * to call.** The door holds a `NodeMap` and pushes rows; `touchNode` lives in
 * `appStore`'s navigation actions and is not reachable from here at all, so an
 * agent's reads and writes cannot reorder the room. The test asserts the
 * observable half — `accessedAt` byte-identical across a full session.
 */

import {
  completeThought,
  createThought,
  deleteThought,
  setTask,
  setWhen,
  updateThought,
} from '../../../src/core/mutations';
import { displayTitle, liveNode } from '../../../src/model/tree';
import { WhenRepeat } from '../../../src/model/types';
import { parseTimeText } from '../../../src/model/when';
import { OpenedGrant } from '../../../src/agent/types';
import { Corpus, DoorApi } from './corpus';
import { pushWrites } from './push';
import { ScopeError, requireWrite } from './scope';
import { Tool } from './tools';

export interface WriteContext {
  api: DoorApi;
  grant: OpenedGrant;
  corpus(): Promise<Corpus>;
  /** Mint an id for a new thought. The core never generates one (it is pure). */
  newId(): string;
  now(): number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const rawStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * A thought's detail is an ordered LIST of fields; `detailText` joins it with
 * blank lines, so the door splits it back the same way. That round-trips
 * exactly for anything a person or an agent actually writes, and the one
 * lossy case — a single field containing its own blank line — is stated in
 * the tool description rather than hidden (§1.7).
 */
function splitDetail(detail: string): { body: string; extras: string[] } {
  const fields = detail.split(/\n[ \t]*\n/).map((f) => f.trim());
  return { body: fields[0] ?? '', extras: fields.slice(1) };
}

function requireId(args: Record<string, unknown>, key: string): string {
  const v = str(args[key]);
  if (!v) throw new ScopeError(`${key} is required`);
  return v;
}

const ok = (what: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ saved: true, what, ...extra }, null, 2);

export function writeTools(ctx: WriteContext): Tool[] {
  /** Push and report — the tail every write tool shares. */
  const land = async (
    corpus: Corpus,
    writes: Parameters<typeof pushWrites>[3],
    what: string,
    extra: Record<string, unknown> = {},
    deletions?: ReadonlySet<string>
  ): Promise<string> => {
    const out = await pushWrites(ctx.api, ctx.grant, corpus, writes, { deletions });
    if (!out.applied) {
      // §6.4 — never report a landed write that did not land.
      return JSON.stringify({ saved: false, reason: out.reason, conflicts: out.conflicts }, null, 2);
    }
    return ok(what, extra);
  };

  return [
    {
      name: 'create_thought',
      description:
        'Put a new thought inside another one. The parent must be inside a branch this grant was ' +
        'given (get_root lists them). ' +
        'A thought is a short title plus an optional detail; give it a title if you can, because ' +
        'that is what the person sees in their list. ' +
        'The detail is a LIST of fields joined by blank lines — write "one\\n\\ntwo" for two of them. ' +
        'Set task:true to make it something to tick off. ' +
        'You cannot create a PRIVATE detail field: only the person can cover something, and text ' +
        'shaped like a covered field is dropped rather than saved.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { type: 'string', description: 'the thought to put it inside' },
          title: { type: 'string' },
          detail: { type: 'string' },
          task: { type: 'boolean' },
        },
        required: ['parent_id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      async run(args) {
        const corpus = await ctx.corpus();
        const parentId = requireId(args, 'parent_id');
        requireWrite(corpus.nodes, parentId, ctx.grant.scope);
        const d = splitDetail(rawStr(args.detail) ?? '');
        const node = createThought(
          corpus.nodes,
          parentId,
          { title: rawStr(args.title) ?? '', body: d.body, extras: d.extras, task: args.task === true },
          { now: ctx.now(), id: ctx.newId() },
          // SPEC-AGENT §1.5, the write half. A door that cannot READ a seal must
          // not be able to AUTHOR one either: without this an agent could land a
          // `priv1:`-shaped field the person can never open and the app renders
          // as covered — a forged secret, from text a prompt injection supplied.
          { dropSealed: true }
        );
        if (!node) {
          throw new ScopeError(
            'nothing to save — a thought needs a title or a detail, and the level may be at its depth limit'
          );
        }
        return land(corpus, [node], `created "${displayTitle(node)}"`, { id: node.id });
      },
    },

    {
      name: 'update_thought',
      description:
        'Change a thought\'s words — its title, its detail, or both. Only what you pass changes. ' +
        'The detail is a LIST of fields joined by blank lines, exactly as get_thought returned it; ' +
        'send the whole detail back, not just your addition. ' +
        'PRIVATE FIELDS ARE CARRIED THROUGH AUTOMATICALLY: a thought may hold detail you cannot ' +
        'read, and it is put back where it was — never try to preserve or recreate it yourself. ' +
        'This changes words only; use complete_thought, set_task and set_when for the rest.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async run(args) {
        const corpus = await ctx.corpus();
        const id = requireId(args, 'id');
        requireWrite(corpus.nodes, id, ctx.grant.scope);
        const detail = rawStr(args.detail);
        const d = detail !== undefined ? splitDetail(detail) : null;
        const updated = updateThought(
          corpus.nodes,
          id,
          {
            title: rawStr(args.title),
            ...(d ? { body: d.body, extras: d.extras } : {}),
          },
          ctx.now(),
          // SPEC-AGENT §1.5 — this caller read the detail through `detailText`,
          // which omits a seal. Without this, saving would destroy it.
          { preserveSealed: true }
        );
        if (!updated) return ok('nothing changed — those are already its words');
        return land(corpus, [updated], `updated "${displayTitle(updated)}"`);
      },
    },

    {
      name: 'complete_thought',
      description:
        'Tick a thought off, or un-tick it. Ticking one that was never marked as a task makes it ' +
        'a completed task, so un-ticking later leaves an open one — that is deliberate.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean', description: 'default true' } },
        required: ['id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async run(args) {
        const corpus = await ctx.corpus();
        const id = requireId(args, 'id');
        requireWrite(corpus.nodes, id, ctx.grant.scope);
        const done = args.done !== false;
        const updated = completeThought(corpus.nodes, id, done, ctx.now());
        if (!updated) return ok(done ? 'it was already done' : 'it was already open');
        return land(corpus, [updated], `${done ? 'completed' : 'reopened'} "${displayTitle(updated)}"`);
      },
    },

    {
      name: 'set_task',
      description:
        'Mark a thought as something to do, or take that away. Taking it away also clears whether ' +
        'it was done — a thought cannot refuse to be a task and keep a tick.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, task: { type: 'boolean', description: 'default true' } },
        required: ['id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async run(args) {
        const corpus = await ctx.corpus();
        const id = requireId(args, 'id');
        requireWrite(corpus.nodes, id, ctx.grant.scope);
        const task = args.task !== false;
        const updated = setTask(corpus.nodes, id, task, ctx.now());
        if (!updated) return ok('nothing changed');
        return land(corpus, [updated], `${task ? 'marked' : 'unmarked'} "${displayTitle(updated)}" as a task`);
      },
    },

    {
      name: 'set_when',
      description:
        'Give a thought a date, or take it away. day is YYYY-MM-DD; pass null to clear it, which ' +
        'also clears the time and the repeat (a time without a day means nothing). ' +
        'time is a clock time like "09:00" or "9am". repeat is daily, weekly, monthly or yearly.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          day: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear' },
          time: { type: ['string', 'null'] },
          repeat: { type: ['string', 'null'], enum: ['daily', 'weekly', 'monthly', 'yearly', null] },
        },
        required: ['id', 'day'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async run(args) {
        const corpus = await ctx.corpus();
        const id = requireId(args, 'id');
        requireWrite(corpus.nodes, id, ctx.grant.scope);
        const day = args.day === null ? null : str(args.day);
        if (args.day !== null && !day) throw new ScopeError('day must be YYYY-MM-DD, or null to clear');
        const timeRaw = args.time;
        const time =
          timeRaw === undefined ? undefined : timeRaw === null ? null : parseTimeText(String(timeRaw));
        if (timeRaw !== undefined && timeRaw !== null && time === null) {
          throw new ScopeError(`could not read "${String(timeRaw)}" as a time — try "09:00"`);
        }
        const repeat =
          args.repeat === undefined
            ? undefined
            : args.repeat === null
              ? null
              : (String(args.repeat) as WhenRepeat);
        const updated = setWhen(corpus.nodes, id, { day, time, repeat }, ctx.now());
        if (!updated) throw new ScopeError('that thought is gone');
        return land(
          corpus,
          [updated],
          day ? `dated "${displayTitle(updated)}" ${day}` : `cleared the date on "${displayTitle(updated)}"`
        );
      },
    },

    {
      name: 'delete_thought',
      description:
        'Put a thought in the bin, with everything inside it. NOT permanent — it lands in the ' +
        'app\'s bin where the person can restore it, which is the only reason an agent is allowed ' +
        'to do this at all. Deleting a thought deletes everything beneath it, so check what is ' +
        'inside first with get_level.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      async run(args) {
        const corpus = await ctx.corpus();
        const id = requireId(args, 'id');
        requireWrite(corpus.nodes, id, ctx.grant.scope);
        const node = liveNode(corpus.nodes, id);
        const writes = deleteThought(corpus.nodes, id, ctx.now());
        if (!writes.length) throw new ScopeError('that thought is already gone');
        const title = node ? displayTitle(node) : id;
        return land(
          corpus,
          writes,
          `binned "${title}"${writes.length > 1 ? ` and the ${writes.length - 1} thought(s) inside it` : ''}`,
          { restorable: true },
          new Set(writes.map((n) => n.id))
        );
      },
    },
  ];
}
