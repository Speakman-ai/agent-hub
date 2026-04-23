import { describe, it, expect } from 'vitest';
import { getProjectMode, defaultSessionUseWorktreeFlag } from './project-mode.js';
import type { Project } from './types.js';

describe('project-mode', () => {
  it('getProjectMode defaults to dev', () => {
    expect(getProjectMode(undefined)).toBe('dev');
    expect(getProjectMode(null)).toBe('dev');
    expect(getProjectMode({} as Project)).toBe('dev');
    expect(getProjectMode({ mode: 'dev' } as Project)).toBe('dev');
  });

  it('getProjectMode recognizes workflow', () => {
    expect(getProjectMode({ mode: 'workflow' } as Project)).toBe('workflow');
  });

  it('defaultSessionUseWorktreeFlag is 0 in workflow mode', () => {
    expect(defaultSessionUseWorktreeFlag({ mode: 'workflow' } as Project)).toBe(0);
    expect(defaultSessionUseWorktreeFlag({} as Project)).toBe(1);
  });
});
