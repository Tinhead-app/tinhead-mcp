/**
 * [compile] Public API — gather → render in one call (SPEC-COMPILE §2).
 * Pure; the refine stage layers on top in `./refine` and never replaces this.
 */

import { NodeMap } from '../model/tree';
import { CompileIR, GatherOptions, gatherIR } from './ir';
import { RenderOptions, renderTarget } from './render';
import { CompileTarget } from './targets';

export * from './targets';
export * from './ir';
export * from './render';

export interface CompiledArtifact {
  text: string;
  ir: CompileIR;
}

/** Null when the target thought is deleted or missing — callers must handle it. */
export function compileArtifact(
  nodes: NodeMap,
  id: string,
  target: CompileTarget,
  opts: RenderOptions & GatherOptions
): CompiledArtifact | null {
  const ir = gatherIR(nodes, id, target, { hints: opts.hints });
  if (!ir) return null;
  return { text: renderTarget(ir, target, opts), ir };
}
