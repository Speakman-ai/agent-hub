import { describe, it, expect } from 'vitest';
import { isDelegationDisabledForAgent } from './delegation-gate.js';

describe('isDelegationDisabledForAgent — operator gate semantics', () => {
  it('returns false when delegationEnabled is undefined (default = enabled)', () => {
    expect(isDelegationDisabledForAgent({})).toBe(false);
  });

  it('returns false when delegationEnabled is true', () => {
    expect(isDelegationDisabledForAgent({ delegationEnabled: true })).toBe(false);
  });

  it('returns true ONLY when delegationEnabled is the literal boolean false', () => {
    expect(isDelegationDisabledForAgent({ delegationEnabled: false })).toBe(true);
  });

  // Defensive corruption-safety: anything non-boolean must default to enabled
  // because the worst failure mode here is silently disabling delegation on
  // every lead in the org. See module-level rationale.
  it('returns false for non-boolean garbage (null, 0, empty string, "false" string)', () => {
    expect(isDelegationDisabledForAgent({ delegationEnabled: null as unknown as boolean })).toBe(
      false,
    );
    expect(isDelegationDisabledForAgent({ delegationEnabled: 0 as unknown as boolean })).toBe(
      false,
    );
    expect(isDelegationDisabledForAgent({ delegationEnabled: '' as unknown as boolean })).toBe(
      false,
    );
    expect(isDelegationDisabledForAgent({ delegationEnabled: 'false' as unknown as boolean })).toBe(
      false,
    );
  });
});
