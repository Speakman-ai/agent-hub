import type { AppConfig } from './types.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
vi.mock('./auto-git.js', () => ({
  autoGitChildEnv: () => ({}),
  resolveAutoGitGithubToken: vi.fn().mockResolvedValue('tok'),
  resolveOrgOwnerGithubToken: vi.fn().mockResolvedValue(null),
}));

const { lookupGithubOpenPr } = await import('./github-branch-pr.js');

function respond(err: Error | null, stdout = ''): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function') return;
    (cb as (e: Error | null, r: { stdout: string; stderr: string }) => void)(err, {
      stdout,
      stderr: '',
    });
  });
}

const base = {
  repo: 'acme/widgets',
  branch: 'feat/x',
  sessionId: 's1',
  config: {} as Pick<AppConfig, 'personalOAuth'>,
};

describe('lookupGithubOpenPr', () => {
  beforeEach(() => execFileMock.mockReset());

  it('reports an open PR', async () => {
    respond(null, '[{"number":7,"url":"https://github.com/acme/widgets/pull/7"}]');
    await expect(lookupGithubOpenPr(base)).resolves.toEqual({
      kind: 'open',
      ref: 'https://github.com/acme/widgets/pull/7',
    });
    const argv = execFileMock.mock.calls[0]![1] as string[];
    expect(argv).toEqual(
      expect.arrayContaining(['--repo', 'acme/widgets', '--head', 'feat/x', '--state', 'open']),
    );
  });

  it('reports none for an empty list', async () => {
    respond(null, '[]');
    await expect(lookupGithubOpenPr(base)).resolves.toEqual({ kind: 'none' });
  });

  it('reports unknown when gh fails or prints garbage', async () => {
    respond(new Error('gh auth required'));
    await expect(lookupGithubOpenPr(base)).resolves.toMatchObject({ kind: 'unknown' });
    respond(null, 'not json');
    await expect(lookupGithubOpenPr(base)).resolves.toMatchObject({ kind: 'unknown' });
  });
});
