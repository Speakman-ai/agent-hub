import { describe, expect, it } from 'vitest';
import { healthForProject } from './useDefaultBranchHealth';

const red = { state: 'red' as const, branch: 'main', breakage: null, failures: [] };

describe('healthForProject', () => {
  it('returns a snapshot only for the project it was read for', () => {
    expect(healthForProject({ projectId: 'p1', health: red }, 'p1')).toBe(red);
    expect(healthForProject({ projectId: 'p1', health: red }, 'p2')).toBeNull();
    expect(healthForProject(null, 'p1')).toBeNull();
    expect(healthForProject({ projectId: '', health: red }, '')).toBeNull();
  });
});
