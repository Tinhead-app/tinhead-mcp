/**
 * `tinhead-mcp` — the resources. SPEC-AGENT §6.6.
 *
 * MCP's second primitive. A client surfaces these in its `@` menu, fuzzy-
 * searchable, and fetches whichever one the person picks (`@tinhead:tinhead://
 * thought/<id>` in Claude Code).
 *
 * **This is where the disambiguation belongs.** Two branches called "Calendar"
 * is not a hard problem for a person — they know instantly which one they mean.
 * It is only hard for an agent guessing after the fact. Resources move the choice
 * back to the moment it is cheap: the person types `@`, sees both with their
 * paths and their open counts, and picks. Nothing is inferred, so nothing can be
 * inferred wrong.
 *
 * **Bounded on purpose.** These land in the same menu as the person's files, so
 * an exhaustive list of a 1,300-thought corpus would make their own `@` unusable
 * and bury the files they were reaching for. Two levels below each granted root
 * is the granularity addressing actually needs — "the Calendar list", not "that
 * one note inside it" — and the cap is stated rather than silent.
 */

import { NodeMap, displayTitle, isUnderArchive, levelStats, orderedChildren, pathTo, DEFAULT_SORT } from '../../../src/model/tree';
import { ThoughtNode } from '../../../src/model/types';
import { GrantScope } from '../../../src/agent/types';
import { inReadScope } from './scope';

export const RESOURCE_PREFIX = 'tinhead://thought/';
/** How deep below a granted root a thought is still worth its own `@` entry. */
export const RESOURCE_DEPTH = 2;
/** Hard ceiling — the person's `@` menu is theirs, not ours. */
export const RESOURCE_LIMIT = 100;

export interface DoorResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const uriFor = (id: string): string => `${RESOURCE_PREFIX}${id}`;

/** The id inside a resource URI, or null if this is not one of ours. */
export function idFromUri(uri: string): string | null {
  if (!uri.startsWith(RESOURCE_PREFIX)) return null;
  const id = uri.slice(RESOURCE_PREFIX.length).trim();
  return id.length ? id : null;
}

/** Where the walk starts: the granted branches, or the top level of a wide read. */
function rootsOf(nodes: NodeMap, scope: GrantScope): ThoughtNode[] {
  if (scope.branches.length) {
    return scope.branches
      .map((b) => nodes.get(b))
      .filter((n): n is ThoughtNode => !!n && n.deletedAt === null);
  }
  if (scope.reads !== 'everything') return [];
  return orderedChildren(nodes, null, DEFAULT_SORT);
}

/**
 * What the `@` menu shows. The description is doing the work here — it is the
 * only thing that separates two entries with the same name, so it leads with the
 * path and says what is inside.
 */
export function listResources(nodes: NodeMap, scope: GrantScope): DoorResource[] {
  const out: DoorResource[] = [];
  const seen = new Set<string>();

  const add = (n: ThoughtNode, depth: number): void => {
    if (out.length >= RESOURCE_LIMIT || seen.has(n.id)) return;
    if (isUnderArchive(nodes, n.id)) return;
    if (!inReadScope(nodes, n.id, scope)) return;
    seen.add(n.id);

    const stats = levelStats(nodes, [n.id]).get(n.id);
    const where = pathTo(nodes, n.id)
      .slice(0, -1)
      .filter((p) => inReadScope(nodes, p.id, scope))
      .map((p) => displayTitle(p))
      .join(' › ');
    const inside = stats
      ? `${stats.total} inside${stats.open > 0 ? `, ${stats.open} open` : ''}`
      : 'nothing inside';

    out.push({
      uri: uriFor(n.id),
      name: displayTitle(n),
      // Path first: it is what tells two same-named branches apart, and a menu
      // truncates from the right.
      description: where ? `${where} — ${inside}` : inside,
      mimeType: 'text/markdown',
    });

    if (depth >= RESOURCE_DEPTH) return;
    for (const kid of orderedChildren(nodes, n.id, DEFAULT_SORT)) add(kid, depth + 1);
  };

  for (const r of rootsOf(nodes, scope)) add(r, 0);
  return out;
}
