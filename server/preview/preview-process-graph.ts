/**
 * Pure helpers for the multi-process preview graph.
 *
 * Owns the validation contract for `PrEnvPreviewConfig.processes`:
 *   - name shape (kebab-case, ASCII-lowercase-leading)
 *   - dependsOn references resolve to existing process names
 *   - no cycles (Kahn-style topological sort)
 *   - bounded process count (≤ MAX_PROCESSES)
 *
 * Lives separately from `preview-runtime.ts` so the validator can be
 * called from the project-config save path (so a busted `processes`
 * block is rejected before the runtime ever sees it) without dragging
 * the full runtime + DB into the validation surface.
 */

import type { PreviewProcess } from '../types.js';

/**
 * Upper bound on process count per preview graph. Keeps host resource
 * usage (file descriptors, log streams, port pool slots) bounded. Six
 * is large enough for a typical fullstack repo (api + web + worker +
 * cache + db + ssr) and small enough that the topological scan stays
 * trivially O(n²).
 */
export const MAX_PROCESSES = 6;

/**
 * Regex enforced on `PreviewProcess.name`. Matches ASCII kebab-case
 * leading with a lowercase letter so names are safe in URLs, log file
 * paths, and shell variables without escaping.
 */
export const PROCESS_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export type GraphValidationError =
  | { kind: 'too_many'; count: number; max: number }
  | { kind: 'empty' }
  | { kind: 'invalid_name'; name: string }
  | { kind: 'duplicate_name'; name: string }
  | { kind: 'invalid_health_path'; name: string; healthPath: string }
  | { kind: 'unknown_dependency'; from: string; missing: string }
  | { kind: 'self_dependency'; name: string }
  | { kind: 'cycle'; path: string[] };

export interface GraphValidationOk {
  ok: true;
  /** Spawn waves — processes within a wave can be started in parallel. */
  waves: PreviewProcess[][];
}

export interface GraphValidationFail {
  ok: false;
  error: GraphValidationError;
}

export type GraphValidationResult = GraphValidationOk | GraphValidationFail;

/**
 * Validate a `processes[]` array and (if valid) return a topological
 * spawn order grouped into waves. Each wave is a set of processes that
 * can be spawned in parallel because all their `dependsOn` entries
 * are satisfied by earlier waves.
 *
 * Pure: no IO, no exceptions. The caller decides whether to surface
 * the error to a config-save HTTP response, a wizard preview, or a
 * runtime spawn rejection.
 */
export function validateProcessGraph(processes: PreviewProcess[]): GraphValidationResult {
  if (!Array.isArray(processes) || processes.length === 0) {
    return { ok: false, error: { kind: 'empty' } };
  }
  if (processes.length > MAX_PROCESSES) {
    return {
      ok: false,
      error: { kind: 'too_many', count: processes.length, max: MAX_PROCESSES },
    };
  }

  const seen = new Set<string>();
  for (const p of processes) {
    if (typeof p.name !== 'string' || !PROCESS_NAME_RE.test(p.name)) {
      return { ok: false, error: { kind: 'invalid_name', name: String(p.name) } };
    }
    if (seen.has(p.name)) {
      return { ok: false, error: { kind: 'duplicate_name', name: p.name } };
    }
    seen.add(p.name);
    if (p.healthPath != null) {
      if (typeof p.healthPath !== 'string' || !p.healthPath.startsWith('/')) {
        return {
          ok: false,
          error: { kind: 'invalid_health_path', name: p.name, healthPath: String(p.healthPath) },
        };
      }
    }
  }

  // Build adjacency + in-degree maps. We also surface unknown / self
  // edges here so a typo (`dependsOn: ['frotend']`) gets a precise
  // error rather than mysteriously failing the topo sort.
  const byName = new Map(processes.map((p) => [p.name, p]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const p of processes) {
    inDegree.set(p.name, 0);
    adj.set(p.name, []);
  }
  for (const p of processes) {
    const deps = p.dependsOn ?? [];
    for (const dep of deps) {
      if (dep === p.name) {
        return { ok: false, error: { kind: 'self_dependency', name: p.name } };
      }
      if (!byName.has(dep)) {
        return { ok: false, error: { kind: 'unknown_dependency', from: p.name, missing: dep } };
      }
      adj.get(dep)!.push(p.name);
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm — pull every zero-in-degree node into the current
  // wave, decrement neighbours, repeat. Anything left after the loop
  // is in a cycle; we recover the cycle path for the error message via
  // a DFS over the remaining nodes.
  const waves: PreviewProcess[][] = [];
  const remaining = new Set<string>(byName.keys());
  while (remaining.size > 0) {
    const wave: PreviewProcess[] = [];
    for (const name of remaining) {
      if ((inDegree.get(name) ?? 0) === 0) {
        wave.push(byName.get(name)!);
      }
    }
    if (wave.length === 0) {
      // Cycle — every remaining node has at least one in-edge from
      // another remaining node.
      const path = findCycle(adj, remaining);
      return { ok: false, error: { kind: 'cycle', path } };
    }
    // Sort within the wave for deterministic spawn order — easier to
    // assert on in tests and gives the operator a stable log layout.
    wave.sort((a, b) => a.name.localeCompare(b.name));
    waves.push(wave);
    for (const node of wave) {
      remaining.delete(node.name);
      for (const next of adj.get(node.name) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      }
    }
  }
  return { ok: true, waves };
}

/**
 * DFS over the remaining adjacency to recover *a* cycle. The returned
 * path starts and ends at the same node so the error message reads as
 * a → b → c → a. We don't promise this is the shortest cycle — any
 * cycle is enough to fix the config.
 */
function findCycle(adj: Map<string, string[]>, remaining: Set<string>): string[] {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): string[] | null => {
    if (onStack.has(node)) {
      const idx = stack.indexOf(node);
      return [...stack.slice(idx), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (!remaining.has(next)) continue;
      const found = dfs(next);
      if (found) return found;
    }
    stack.pop();
    onStack.delete(node);
    return null;
  };

  for (const node of remaining) {
    const found = dfs(node);
    if (found) return found;
  }
  // Should be unreachable when called with a known-cyclic set, but fall
  // back to the remaining set in adjacency order so the error message
  // is never empty.
  return [...remaining];
}

/**
 * Format a `GraphValidationError` into a single-line human-readable
 * string. Used by both the route handler and the runtime's spawn-time
 * guard so the user sees the same wording in both surfaces.
 */
export function formatGraphError(err: GraphValidationError): string {
  switch (err.kind) {
    case 'empty':
      return 'processes[] is empty';
    case 'too_many':
      return `processes[] has ${err.count} entries (max ${err.max})`;
    case 'invalid_name':
      return `invalid process name "${err.name}" (must match /^[a-z][a-z0-9_-]*$/)`;
    case 'duplicate_name':
      return `duplicate process name "${err.name}"`;
    case 'invalid_health_path':
      return `process "${err.name}" healthPath "${err.healthPath}" must start with /`;
    case 'unknown_dependency':
      return `process "${err.from}" depends on unknown process "${err.missing}"`;
    case 'self_dependency':
      return `process "${err.name}" cannot depend on itself`;
    case 'cycle':
      return `dependency cycle: ${err.path.join(' → ')}`;
  }
}

/**
 * Pick the "leaf" process — the one with no dependents — as the
 * default surface for `<agenthub:preview>` / single-URL UI. Returns
 * the last leaf in the final wave so when both backend and frontend
 * end the wave list, the frontend (typically the one users want to
 * see) wins. Falls back to the first process when the graph has no
 * dependents at all (every process is a leaf).
 */
export function pickDefaultProcess(
  waves: PreviewProcess[][],
  adj?: Map<string, string[]>,
): PreviewProcess {
  if (waves.length === 0) {
    throw new Error('pickDefaultProcess: empty waves');
  }
  const lastWave = waves[waves.length - 1];
  if (adj) {
    // Prefer leaves (no outgoing edges) in the last wave.
    const leaves = lastWave.filter((p) => (adj.get(p.name)?.length ?? 0) === 0);
    if (leaves.length > 0) {
      return leaves[leaves.length - 1];
    }
  }
  return lastWave[lastWave.length - 1];
}
