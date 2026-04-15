import { vi } from 'vitest';

vi.mock('./db.js', () => ({ db: {}, stmts: {} }));
vi.mock('./config.js', () => ({
  default: {
    claudeBin: '/usr/bin/claude',
    defaultCwd: '/tmp',
    defaultTimeoutMs: 60000,
    slackWebhookUrl: null,
  },
  buildSpawnEnv: () => process.env,
}));
vi.mock('./worktree.js', () => ({
  getOrCreateProcessWorktree: (cwd: string) => cwd,
}));
vi.mock('./memory.js', () => ({ reconcileMemoryFromWiki: vi.fn() }));
vi.mock('./wiki.js', () => ({ listPages: vi.fn(), getPage: vi.fn() }));
vi.mock('./project-model.js', () => ({ getProjects: () => ({}) }));

const { runClaude } = await import('./heartbeat.js');

describe('runClaude — cwd validation', () => {
  it('rejects with a clear error when cwd does not exist', async () => {
    const fakeCwd = '/nonexistent/path/that/does/not/exist';
    await expect(runClaude('hello', fakeCwd)).rejects.toThrow('Working directory does not exist');
  });

  it('includes the bad path in the error message', async () => {
    const fakeCwd = '/home/ryan';
    await expect(runClaude('hello', fakeCwd)).rejects.toThrow(fakeCwd);
  });
});
