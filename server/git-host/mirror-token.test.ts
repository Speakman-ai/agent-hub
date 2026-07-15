import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project } from '../types.js';

/**
 * Focused unit tests for `resolveMirrorToken`'s token precedence: the GitHub
 * App installation token (the ruleset-bypass identity) is preferred when
 * configured and resolvable, otherwise the per-user OAuth/PAT chain is used.
 * All auth collaborators are mocked so the precedence is asserted in isolation.
 */

const mocks = vi.hoisted(() => ({
  config: { githubApp: null as unknown, personalOAuth: null, dataDir: '/unused' },
  mint: vi.fn(),
  resolveOwner: vi.fn(),
  resolveUserToken: vi.fn(),
}));

vi.mock('../config.js', () => ({ default: mocks.config }));
vi.mock('../github-app.js', () => ({ getInstallationTokenForOwner: mocks.mint }));
vi.mock('../repo-aware-token.js', () => ({ resolveOwnerWithRepoAccess: mocks.resolveOwner }));
vi.mock('../skill-credentials-github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skill-credentials-github.js')>();
  return { ...actual, resolveUserGithubToken: mocks.resolveUserToken };
});
vi.mock('../spawn-github-credentials.js', () => ({ resolveOAuthAppCredentials: () => null }));

import { resolveMirrorToken } from './mirror.js';

function project(overrides: Partial<Project>): Project {
  return { id: 'p1', gitHost: 'agenthub', ...overrides } as unknown as Project;
}

const APP_CONFIG = { appId: '1', privateKey: 'KEY', installationId: '99' };

beforeEach(() => {
  mocks.config.githubApp = null;
  mocks.mint.mockReset();
  mocks.resolveOwner.mockReset();
  mocks.resolveUserToken.mockReset();
});

describe('resolveMirrorToken — token precedence', () => {
  it('prefers the App installation token when configured and resolvable', async () => {
    mocks.config.githubApp = APP_CONFIG;
    mocks.mint.mockResolvedValue('ghs_app_tok');

    const token = await resolveMirrorToken(project({ githubRepo: 'acme/widgets' }));

    expect(token).toBe('ghs_app_tok');
    expect(mocks.mint).toHaveBeenCalledWith(APP_CONFIG, 'acme');
    // App token short-circuits the per-user chain entirely.
    expect(mocks.resolveOwner).not.toHaveBeenCalled();
    expect(mocks.resolveUserToken).not.toHaveBeenCalled();
  });

  it('derives the owner from repoUrl when githubRepo is absent', async () => {
    mocks.config.githubApp = APP_CONFIG;
    mocks.mint.mockResolvedValue('ghs_app_tok');

    await resolveMirrorToken(project({ repoUrl: 'https://github.com/acme/widgets.git' }));

    expect(mocks.mint).toHaveBeenCalledWith(APP_CONFIG, 'acme');
  });

  it('falls back to the per-user OAuth/PAT token when no App is configured', async () => {
    mocks.config.githubApp = null;
    mocks.resolveOwner.mockResolvedValue('owner-1');
    mocks.resolveUserToken.mockResolvedValue('user_pat');

    const token = await resolveMirrorToken(project({ githubRepo: 'acme/widgets' }));

    expect(token).toBe('user_pat');
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.resolveOwner).toHaveBeenCalledWith('acme/widgets');
  });

  it('falls back to the per-user token when the App mint returns null (misconfig / no install)', async () => {
    mocks.config.githubApp = APP_CONFIG;
    mocks.mint.mockResolvedValue(null);
    mocks.resolveOwner.mockResolvedValue('owner-1');
    mocks.resolveUserToken.mockResolvedValue('user_pat');

    const token = await resolveMirrorToken(project({ githubRepo: 'acme/widgets' }));

    expect(token).toBe('user_pat');
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(mocks.resolveUserToken).toHaveBeenCalled();
  });

  it('honors an explicit appConfig override (bypasses config.githubApp)', async () => {
    mocks.config.githubApp = null; // config says none...
    mocks.mint.mockResolvedValue('ghs_override');

    const token = await resolveMirrorToken(project({ githubRepo: 'acme/widgets' }), {
      appConfig: APP_CONFIG, // ...but the override supplies one
      mintAppToken: mocks.mint,
    });

    expect(token).toBe('ghs_override');
    expect(mocks.mint).toHaveBeenCalledWith(APP_CONFIG, 'acme');
  });

  it('returns null when neither an App token nor a repo owner resolves', async () => {
    mocks.config.githubApp = null;
    mocks.resolveOwner.mockResolvedValue(null);

    const token = await resolveMirrorToken(project({ githubRepo: 'acme/widgets' }));

    expect(token).toBeNull();
    expect(mocks.resolveUserToken).not.toHaveBeenCalled();
  });
});
