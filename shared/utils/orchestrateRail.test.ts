import { describe, expect, it } from 'vitest';
import { orchestrateRailParentId } from './orchestrateRail';

describe('orchestrateRailParentId', () => {
  it('shows an Orchestrate chat its own workers', () => {
    expect(orchestrateRailParentId({ id: 'p', session_mode: 'orchestrate' })).toBe('p');
  });

  it('shows a worker switched into Orchestrate its own workers, not its parent', () => {
    expect(
      orchestrateRailParentId({
        id: 'w',
        session_mode: 'orchestrate',
        spawned_from_session_id: 'p',
      }),
    ).toBe('w');
  });

  it("shows a plain worker its parent's list", () => {
    expect(
      orchestrateRailParentId({ id: 'w', session_mode: 'chat', spawned_from_session_id: 'p' }),
    ).toBe('p');
  });

  it('has no rail for an ordinary chat', () => {
    expect(orchestrateRailParentId({ id: 'c', session_mode: 'consult' })).toBeNull();
    expect(orchestrateRailParentId(null)).toBeNull();
  });
});
