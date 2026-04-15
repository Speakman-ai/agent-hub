import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing module
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
}));

import { exec } from 'child_process';
import { checkWorktreeChanges } from './auto-git.js';

// Helper to mock execAsync results
function mockExec(results: Record<string, { stdout?: string; stderr?: string; error?: Error }>) {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      cmd: string,
      _opts: Record<string, unknown>,
      callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // promisify wraps exec, so the mock needs to support the callback style
      for (const [pattern, result] of Object.entries(results)) {
        if (cmd.includes(pattern)) {
          if (callback) {
            if (result.error) {
              callback(result.error, { stdout: '', stderr: '' });
            } else {
              callback(null, { stdout: result.stdout || '', stderr: result.stderr || '' });
            }
          }
          return;
        }
      }
      // Default: empty output
      if (callback) {
        callback(null, { stdout: '', stderr: '' });
      }
    },
  );
}

describe('checkWorktreeChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects uncommitted changes', async () => {
    mockExec({
      'git status --porcelain': { stdout: 'M server/index.ts\n' },
      'git log @{upstream}..HEAD': { error: new Error('no upstream') },
      'git log main..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/test\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUncommitted).toBe(true);
    expect(result.branch).toBe('feature/test');
  });

  it('detects unpushed commits', async () => {
    mockExec({
      'git status --porcelain': { stdout: '' },
      'git log @{upstream}..HEAD': { stdout: 'abc123 some commit\n' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/test\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUncommitted).toBe(false);
    expect(result.hasUnpushed).toBe(true);
  });

  it('returns no changes when clean', async () => {
    mockExec({
      'git status --porcelain': { stdout: '' },
      'git log @{upstream}..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUncommitted).toBe(false);
    expect(result.hasUnpushed).toBe(false);
    expect(result.branch).toBe('main');
  });
});
