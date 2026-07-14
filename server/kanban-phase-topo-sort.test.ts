import { describe, it, expect } from 'vitest';
import {
  topologicallySortPhaseIds,
  PhaseCycleError,
  type TopoPhaseInput,
  type TopoCardInput,
  type TopoBlockerEdge,
} from './kanban-phase-topo-sort.js';

describe('topologicallySortPhaseIds', () => {
  it('orders a foundation-last epic so dependencies come first (regression)', () => {
    // Narrative order: the foundation phase is authored LAST (position 6) but a
    // card in the front phase (position 0) is blocked by a foundation card. The
    // positional order deadlocks the autonomous cascade; the topo order must put
    // the foundation phase first.
    const phases: TopoPhaseInput[] = [
      { id: 'front', position: 0 },
      { id: 'middle', position: 3 },
      { id: 'foundation', position: 6 },
    ];
    const cards: TopoCardInput[] = [
      { id: 'front-card', phase_id: 'front' },
      { id: 'middle-card', phase_id: 'middle' },
      { id: 'foundation-card', phase_id: 'foundation' },
    ];
    // front-card blocked by foundation-card; middle-card blocked by front-card.
    const edges: TopoBlockerEdge[] = [
      { card_id: 'front-card', blocked_by_card_id: 'foundation-card' },
      { card_id: 'middle-card', blocked_by_card_id: 'front-card' },
    ];

    const order = topologicallySortPhaseIds(phases, cards, edges);

    expect(order).toEqual(['foundation', 'front', 'middle']);
    // Assert the emitted order is dependency-valid: every prerequisite precedes
    // its dependent.
    expect(order.indexOf('foundation')).toBeLessThan(order.indexOf('front'));
    expect(order.indexOf('front')).toBeLessThan(order.indexOf('middle'));
  });

  it('preserves authored position order when no cross-phase dependencies exist', () => {
    const phases: TopoPhaseInput[] = [
      { id: 'b', position: 1 },
      { id: 'a', position: 0 },
      { id: 'c', position: 2 },
    ];
    const order = topologicallySortPhaseIds(phases, [], []);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('ignores intra-phase blocker edges', () => {
    const phases: TopoPhaseInput[] = [
      { id: 'p1', position: 0 },
      { id: 'p2', position: 1 },
    ];
    const cards: TopoCardInput[] = [
      { id: 'a', phase_id: 'p1' },
      { id: 'b', phase_id: 'p1' },
    ];
    // a blocked by b, both in p1 — not a phase dependency.
    const edges: TopoBlockerEdge[] = [{ card_id: 'a', blocked_by_card_id: 'b' }];
    const order = topologicallySortPhaseIds(phases, cards, edges);
    expect(order).toEqual(['p1', 'p2']);
  });

  it('ignores blocker edges referencing cards outside the phase set', () => {
    const phases: TopoPhaseInput[] = [{ id: 'p1', position: 0 }];
    const cards: TopoCardInput[] = [
      { id: 'a', phase_id: 'p1' },
      { id: 'x', phase_id: null },
    ];
    const edges: TopoBlockerEdge[] = [{ card_id: 'a', blocked_by_card_id: 'x' }];
    expect(topologicallySortPhaseIds(phases, cards, edges)).toEqual(['p1']);
  });

  it('breaks peer ties deterministically by position then id', () => {
    // Two independent chains rooted at same-position phases → tie-break by id.
    const phases: TopoPhaseInput[] = [
      { id: 'zeta', position: 0 },
      { id: 'alpha', position: 0 },
    ];
    const order = topologicallySortPhaseIds(phases, [], []);
    expect(order).toEqual(['alpha', 'zeta']);
  });

  it('throws PhaseCycleError when the phase graph has a cycle', () => {
    const phases: TopoPhaseInput[] = [
      { id: 'p1', position: 0 },
      { id: 'p2', position: 1 },
    ];
    const cards: TopoCardInput[] = [
      { id: 'a', phase_id: 'p1' },
      { id: 'b', phase_id: 'p2' },
    ];
    // a (p1) blocked by b (p2), and b (p2) blocked by a (p1) → cycle p1<->p2.
    const edges: TopoBlockerEdge[] = [
      { card_id: 'a', blocked_by_card_id: 'b' },
      { card_id: 'b', blocked_by_card_id: 'a' },
    ];
    let thrown: unknown;
    try {
      topologicallySortPhaseIds(phases, cards, edges);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PhaseCycleError);
    expect((thrown as PhaseCycleError).cyclePhaseIds.sort()).toEqual(['p1', 'p2']);
  });
});
