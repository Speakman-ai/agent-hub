import { describe, expect, it } from 'vitest';
import { isCompleteProject } from './newProjectProvisioning';

describe('isCompleteProject', () => {
  it('rejects null and partial responses before enabling Open Board', () => {
    expect(isCompleteProject(null, 'p1')).toBe(false);
    expect(isCompleteProject({ id: 'p1', name: 'Tool' }, 'p1')).toBe(false);
    expect(isCompleteProject({ id: 'p1', cwd: '/workspace' }, 'p1')).toBe(false);
  });

  it('accepts a project response with the required project identity and workspace', () => {
    expect(isCompleteProject({ id: 'p1', name: 'Tool', cwd: '/workspace' }, 'p1')).toBe(true);
  });

  it('allows GitHub-only projects without a local workspace', () => {
    expect(isCompleteProject({ id: 'p1', name: 'Tool' }, 'p1', false)).toBe(true);
  });
});
