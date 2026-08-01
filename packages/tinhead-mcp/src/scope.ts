/**
 * `tinhead-mcp` — grant scope. SPEC-AGENT §5 + §8.
 *
 * **Say the honest thing first: this is policy, not cryptography.** The process
 * holds the account DEK, so a compromised process reads everything regardless of
 * what is in this file. Two things make that structural rather than sloppy —
 * `parentId` is inside the ciphertext, so the server does not know which rows
 * are under which thought and could not enforce a branch if it wanted to; and
 * §12.10's push needs a client-computed manifest MAC over the whole post-apply
 * set, so a writing door must hold the entire corpus to write one word of it.
 * §3 B (a per-branch key domain) is the upgrade that would make scope math, and
 * it is deferred with a named trigger.
 *
 * What this file DOES buy is real and worth having: an agent that is steered by
 * text inside the user's own thoughts (§8's realistic case) has a blast radius
 * of the branches the person handed it, which is something they take back in one
 * gesture.
 *
 * **A grant is rooted at a LIST, and the empty list is the normal state.** A
 * connection is made in `Settings › Plugins` before it has been given anything;
 * branches arrive later, one at a time, from `Options › Give access` on the
 * thought itself. So "no branches" is not a broken grant and must not read like
 * one — it is a connection waiting for its first branch, and every refusal it
 * produces says exactly that (`NOT_YET_GRANTED`).
 */

import { NodeMap } from '../../../src/model/tree';
import { GrantScope } from '../../../src/agent/types';

/** Depth guard: a cycle in wire data must not hang the door. Matches [model]'s. */
const WALK_MAX = 1000;

/**
 * The one sentence an agent sees when nothing has been granted yet. It names the
 * gesture the PERSON makes, because the agent cannot fix this and its only
 * useful move is to say so in words its user recognises — so the row is quoted
 * exactly as the app labels it (`copy.mcpGive`, `Options › Give access`). A
 * paraphrase here is a support question there.
 */
export const NOT_YET_GRANTED =
  'this connection has not been given a branch yet, so there is nothing here to read or ' +
  'change. In Tinhead, open the thought you want it to work in and choose ' +
  '“Options › Give access”.';

/**
 * Is `id` at or beneath ANY of `branches`? A thought that is not live (binned)
 * is nowhere. **An empty list reaches nothing** — never the root (SPEC-AGENT
 * §4.2b: the widest reading of an absent scope is exactly what the narrow-default
 * rule forbids).
 */
export function inBranches(nodes: NodeMap, id: string, branches: readonly string[]): boolean {
  const start = nodes.get(id);
  if (!start || start.deletedAt !== null) return false;
  if (branches.length === 0) return false;
  const roots = new Set(branches);
  let cur: string | null = id;
  for (let i = 0; cur !== null && i < WALK_MAX; i++) {
    if (roots.has(cur)) return true;
    const n = nodes.get(cur);
    if (!n) return false;
    cur = n.parentId;
  }
  return false;
}

/** May the grant READ this thought? */
export function inReadScope(nodes: NodeMap, id: string, scope: GrantScope): boolean {
  if (scope.reads === 'everything') {
    const n = nodes.get(id);
    return !!n && n.deletedAt === null;
  }
  return inBranches(nodes, id, scope.branches);
}

/**
 * May the grant WRITE this thought? Always the granted branches, **even when
 * `reads` is `everything`** — the two dials are independent by design (§5), and
 * the wide one is the read.
 */
export function inWriteScope(nodes: NodeMap, id: string, scope: GrantScope): boolean {
  return scope.write && inBranches(nodes, id, scope.branches);
}

/** A refusal the tool layer turns into a sentence the model can act on. */
export class ScopeError extends Error {}

export function requireRead(nodes: NodeMap, id: string, scope: GrantScope): void {
  if (inReadScope(nodes, id, scope)) return;
  // "You were given nothing" and "that is outside what you were given" are
  // different situations and must not share a sentence — the first is answered
  // by the person, the second by the agent picking a different thought.
  if (scope.reads !== 'everything' && scope.branches.length === 0) {
    throw new ScopeError(NOT_YET_GRANTED);
  }
  throw new ScopeError(
    `that thought is outside this grant (it reads ${
      scope.reads === 'everything' ? 'the whole tree' : `${scope.branches.length} branch(es)`
    }), or it is in the bin`
  );
}

export function requireWrite(nodes: NodeMap, id: string, scope: GrantScope): void {
  if (!scope.write) throw new ScopeError('this grant is read-only');
  if (scope.branches.length === 0) throw new ScopeError(NOT_YET_GRANTED);
  if (!inWriteScope(nodes, id, scope)) {
    throw new ScopeError('this grant may only write inside the branches it was given');
  }
}
