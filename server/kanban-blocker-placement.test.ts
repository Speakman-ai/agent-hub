import { describe, it, expect } from 'vitest';
import { blockerPlacementHazard, type PlacementPhase } from './kanban-blocker-placement.js';

const phases: Record<string, PlacementPhase> = {
  a1: { id: 'a1', epic_id: 'A', name: 'Phase 1', position: 0 },
  a2: { id: 'a2', epic_id: 'A', name: 'Phase 2', position: 1 },
  b2: { id: 'b2', epic_id: 'B', name: 'P2: HR stepper', position: 1 },
};
const lookups = {
  phaseById: (id: string) => phases[id],
  epicNameById: (id: string) => (id === 'B' ? 'Employee Onboarding' : 'Provisioning'),
};
const card = (id: string, epic_id: string | null, phase_id: string | null) => ({
  id,
  title: id,
  epic_id,
  phase_id,
});

describe('blockerPlacementHazard', () => {
  it('flags a blocker in a later phase of the same epic', () => {
    const h = blockerPlacementHazard(card('x', 'A', 'a1'), card('y', 'A', 'a2'), lookups);
    expect(h?.kind).toBe('later_phase');
  });

  it('flags a blocker that lives in another epic (the reported stall)', () => {
    const h = blockerPlacementHazard(card('x', 'A', 'a1'), card('y', 'B', 'b2'), lookups);
    expect(h?.kind).toBe('other_epic');
    expect(h?.message).toContain('Employee Onboarding');
  });

  it('flags a blocker with no epic', () => {
    expect(blockerPlacementHazard(card('x', 'A', 'a1'), card('y', null, null), lookups)?.kind).toBe(
      'other_epic',
    );
  });

  it('accepts same-phase, earlier-phase, and unphased blocked cards', () => {
    expect(blockerPlacementHazard(card('x', 'A', 'a1'), card('y', 'A', 'a1'), lookups)).toBeNull();
    expect(blockerPlacementHazard(card('x', 'A', 'a2'), card('y', 'A', 'a1'), lookups)).toBeNull();
    expect(blockerPlacementHazard(card('x', 'A', null), card('y', 'B', 'b2'), lookups)).toBeNull();
  });
});
