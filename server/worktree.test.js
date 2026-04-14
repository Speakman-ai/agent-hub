import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing worktree
vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
}));

const { getOrCreateProcessWorktree } = await import('./worktree.js');

describe('getOrCreateProcessWorktree — cwd validation', () => {
  it('falls back to defaultCwd when cwd does not exist', () => {
    const result = getOrCreateProcessWorktree('/nonexistent/fake/path', 'test-process');
    // Should return the fallback (/tmp) since the original path doesn't exist
    // and /tmp is not a git repo, so it returns /tmp directly
    expect(result).toBe('/tmp');
  });

  it('returns the original cwd when it exists', () => {
    // /tmp exists and is not a git repo, so it's returned as-is
    const result = getOrCreateProcessWorktree('/tmp', 'test-process');
    expect(result).toBe('/tmp');
  });
});
