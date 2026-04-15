import { vi } from 'vitest';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
}));

const { getOrCreateProcessWorktree } = await import('./worktree.js');

describe('getOrCreateProcessWorktree — cwd validation', () => {
  it('falls back to defaultCwd when cwd does not exist', () => {
    const result = getOrCreateProcessWorktree('/nonexistent/fake/path', 'test-process');
    expect(result).toBe('/tmp');
  });

  it('returns the original cwd when it exists', () => {
    const result = getOrCreateProcessWorktree('/tmp', 'test-process');
    expect(result).toBe('/tmp');
  });
});
