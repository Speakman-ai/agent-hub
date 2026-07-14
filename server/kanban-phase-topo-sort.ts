// Topologically sort an epic's phases by the card blocker graph.
//
// Autonomous phase dispatch advances by `position` (see `maybeAdvanceToNextPhase`
// in autonomous.ts). When phases are authored in narrative order (foundation
// last) but their real dependencies live in card blocker edges, positional
// order disagrees with dependency order and the cascade can deadlock. This
// utility derives a phase-level dependency order from the card blocker graph so
// `position` can be rewritten to match: phase P depends on phase Q whenever any
// card in P is blocked by a card in Q (P !== Q). The emitted order is a valid
// topological order of that phase graph, with a deterministic tie-break so the
// same input always yields the same order.

export interface TopoPhaseInput {
  id: string;
  position: number;
}

export interface TopoCardInput {
  id: string;
  phase_id: string | null;
}

export interface TopoBlockerEdge {
  /** the blocked card */
  card_id: string;
  /** the card that must land first */
  blocked_by_card_id: string;
}

/**
 * Thrown when the derived phase dependency graph contains a cycle (phase A
 * depends on B which depends back on A). Surfaces the phases that could not be
 * ordered so a caller can report a precise error instead of silently emitting a
 * partial order.
 */
export class PhaseCycleError extends Error {
  constructor(public readonly cyclePhaseIds: string[]) {
    super(
      `Phase dependency cycle detected among phases: ${cyclePhaseIds.join(', ')}. ` +
        `Break the blocking chain between these phases' cards before reordering.`,
    );
    this.name = 'PhaseCycleError';
  }
}

/**
 * Return the epic's phase ids in dependency order (prerequisites first).
 *
 * - Phase P depends on phase Q when a card in P is blocked by a card in Q.
 * - Self-edges (a card blocked by another card in the same phase) are ignored —
 *   intra-phase ordering is not a phase dependency.
 * - Ties (phases with no ordering constraint between them) break by original
 *   `position` ascending, then `id` ascending, so the result is deterministic
 *   and stays close to the authored order where dependencies don't force a move.
 *
 * Throws {@link PhaseCycleError} if the phase graph has a cycle.
 */
export function topologicallySortPhaseIds(
  phases: TopoPhaseInput[],
  cards: TopoCardInput[],
  blockerEdges: TopoBlockerEdge[],
): string[] {
  const phaseIds = new Set(phases.map((p) => p.id));
  const positionById = new Map(phases.map((p) => [p.id, p.position]));

  // card id → phase id, restricted to cards that live in one of these phases.
  const phaseOfCard = new Map<string, string>();
  for (const c of cards) {
    if (c.phase_id && phaseIds.has(c.phase_id)) phaseOfCard.set(c.id, c.phase_id);
  }

  // Prerequisite edges: prereqs.get(P) = set of phases that must precede P.
  const prereqs = new Map<string, Set<string>>();
  for (const id of phaseIds) prereqs.set(id, new Set());
  for (const edge of blockerEdges) {
    const blockedPhase = phaseOfCard.get(edge.card_id);
    const blockerPhase = phaseOfCard.get(edge.blocked_by_card_id);
    if (!blockedPhase || !blockerPhase) continue;
    if (blockedPhase === blockerPhase) continue; // intra-phase edge — not a phase dep
    prereqs.get(blockedPhase)!.add(blockerPhase);
  }

  // Deterministic tie-break: position asc, then id asc.
  const byTieBreak = (a: string, b: string): number => {
    const pa = positionById.get(a) ?? 0;
    const pb = positionById.get(b) ?? 0;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const indegree = new Map<string, number>();
  for (const [id, deps] of prereqs) indegree.set(id, deps.size);

  // reverse adjacency: which phases become unblocked when `id` is emitted.
  const dependents = new Map<string, string[]>();
  for (const id of phaseIds) dependents.set(id, []);
  for (const [id, deps] of prereqs) {
    for (const dep of deps) dependents.get(dep)!.push(id);
  }

  const ready: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id);
  ready.sort(byTieBreak);

  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const dependent of dependents.get(next)!) {
      const deg = indegree.get(dependent)! - 1;
      indegree.set(dependent, deg);
      if (deg === 0) {
        // Insert keeping `ready` sorted so selection stays deterministic.
        const pos = lowerBound(ready, dependent, byTieBreak);
        ready.splice(pos, 0, dependent);
      }
    }
  }

  if (order.length !== phaseIds.size) {
    const stuck = [...phaseIds].filter((id) => !order.includes(id)).sort(byTieBreak);
    throw new PhaseCycleError(stuck);
  }

  return order;
}

function lowerBound(arr: string[], value: string, cmp: (a: string, b: string) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(arr[mid]!, value) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
