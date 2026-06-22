/**
 * auto-git-repo-aware-token.test.ts
 *
 * Regression test for the "first user wins even when their token can't
 * see the repo" bug: `resolveOrgOwnerGithubToken(config, githubRepo)`
 * should pick an Owner whose probe to `repos/<repo>` returns 2xx
 * instead of always falling through to `listUsers()[0]`.
 *
 * This file walks the resolver end-to-end against a real orgs.db so a
 * future refactor that loses the `githubRepo` plumb shows up red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
    personalOAuth: null,
  },
}));

// Drive OAuth lookups directly — we want to control which user has which
// token without exercising the real GitHub refresh path.
let mockOauthImpl: (userId: string) => Promise<string | null> = async () => null;
vi.mock('./github-connections-store.js', () => ({
  getActiveAccessToken: (userId: string) => mockOauthImpl(userId),
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { createMembership } = await import('./memberships-store.js');
const { resetRepoAccessCache } = await import('./repo-aware-token.js');
const { resolveOrgOwnerGithubToken } = await import('./auto-git.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auto-git-repo-aware-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

function seedOwners(n: number, prefix = 'owner'): Array<{ id: string }> {
  const out: Array<{ id: string }> = [];
  for (let i = 0; i < n; i++) {
    const u = createUser({ username: `${prefix}-${i}-${Date.now()}-${i}`, passwordHash: 'h' });
    createMembership(u.id, 'default', 'Owner');
    out.push({ id: u.id });
  }
  return out;
}

describe('resolveOrgOwnerGithubToken(config, githubRepo)', () => {
  beforeEach(() => {
    freshDb();
    resetRepoAccessCache();
    mockOauthImpl = async () => null;
  });

  it('skips Owners whose token returns 404 on the repo and picks the one that returns 200', async () => {
    const [first, second] = seedOwners(2);
    mockOauthImpl = async (uid) => `tok-${uid}`;
    void first;

    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      void url;
      if (auth === `token tok-${second.id}`) return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const token = await resolveOrgOwnerGithubToken(
      { personalOAuth: null },
      'Speakman-ai/agent-hub',
    );
    expect(token).toBe(`tok-${second.id}`);
  });

  it('returns null when no Owner probes 2xx (no org-owner fallback)', async () => {
    seedOwners(2);
    mockOauthImpl = async (uid) => `tok-${uid}`;

    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 404 }),
    ) as unknown as typeof fetch;

    const token = await resolveOrgOwnerGithubToken({ personalOAuth: null }, 'foo/bar');
    expect(token).toBeNull();
  });

  it('returns null when no `githubRepo` is provided (no org-owner fallback)', async () => {
    seedOwners(2);
    mockOauthImpl = async (uid) => `tok-${uid}`;

    let probes = 0;
    globalThis.fetch = vi.fn(async () => {
      probes++;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const token = await resolveOrgOwnerGithubToken({ personalOAuth: null });
    expect(token).toBeNull();
    // No probe happens — the repo-aware path is skipped entirely.
    expect(probes).toBe(0);
  });
});
