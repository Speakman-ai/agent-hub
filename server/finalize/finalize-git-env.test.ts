import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mergeFinalizeGitSpawnEnv } from './finalize-git-env.js';

vi.mock('../auto-git.js', () => ({
  resolveAutoGitGithubToken: vi.fn(),
  resolveOrgOwnerGithubToken: vi.fn(),
  autoGitChildEnv: vi.fn((token: string | null) => ({
    PATH: '/usr/bin',
    GH_TOKEN: token ?? undefined,
  })),
}));

const { resolveAutoGitGithubToken, resolveOrgOwnerGithubToken, autoGitChildEnv } =
  await import('../auto-git.js');

describe('mergeFinalizeGitSpawnEnv', () => {
  beforeEach(() => {
    vi.mocked(resolveAutoGitGithubToken).mockReset();
    vi.mocked(resolveOrgOwnerGithubToken).mockReset();
    vi.mocked(autoGitChildEnv).mockClear();
  });

  it('prefers session-owner token over org-owner fallback', async () => {
    vi.mocked(resolveAutoGitGithubToken).mockResolvedValue('ghs_session');
    vi.mocked(resolveOrgOwnerGithubToken).mockResolvedValue('ghs_org');
    const env: NodeJS.ProcessEnv = { FOO: 'bar' };
    await mergeFinalizeGitSpawnEnv(env, {
      config: { personalOAuth: null },
      project: { githubRepo: 'acme/widgets' },
      sessionId: 'sess-1',
    });
    expect(resolveAutoGitGithubToken).toHaveBeenCalledWith('sess-1', expect.any(Object));
    expect(resolveOrgOwnerGithubToken).not.toHaveBeenCalled();
    expect(autoGitChildEnv).toHaveBeenCalledWith('ghs_session');
    expect(env.GH_TOKEN).toBe('ghs_session');
    expect(env.FOO).toBe('bar');
  });

  it('falls back to org-owner token when session has none', async () => {
    vi.mocked(resolveAutoGitGithubToken).mockResolvedValue(null);
    vi.mocked(resolveOrgOwnerGithubToken).mockResolvedValue('ghs_org');
    const env: NodeJS.ProcessEnv = {};
    await mergeFinalizeGitSpawnEnv(env, {
      config: { personalOAuth: null },
      project: { githubRepo: 'acme/widgets' },
      sessionId: 'sess-1',
    });
    expect(resolveOrgOwnerGithubToken).toHaveBeenCalledWith(expect.any(Object), 'acme/widgets');
    expect(autoGitChildEnv).toHaveBeenCalledWith('ghs_org');
  });
});
