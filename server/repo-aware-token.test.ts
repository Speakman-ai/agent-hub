/**
 * repo-aware-token.test.ts
 *
 * Tests for `resolveOwnerWithRepoAccess` — the helper that walks
 * Owner-role users in `created_at` order and returns the first user
 * whose stored GitHub token can read `<owner>/<repo>`.
 *
 * Strategy:
 *   - Stand up a fresh orgs.db so memberships are real.
 *   - Mock `./github-connections-store.js#getActiveAccessToken` to
 *     control which userId resolves to which token without exercising
 *     the OAuth refresh path.
 *   - Mock `fetch` to drive probe responses (200 / 404 / network error)
 *     so we can assert on the probe order and the cache.
 *
 * There is no org-owner fallback: when no Owner can reach the repo (or the
 * inputs are garbage / the memberships lookup throws) the helper returns
 * `null` and the caller must hard-fail rather than borrow an identity.
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

let mockOauthImpl: (userId: string) => Promise<string | null> = async () => null;
vi.mock('./github-connections-store.js', () => ({
  getActiveAccessToken: (userId: string) => mockOauthImpl(userId),
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { createMembership } = await import('./memberships-store.js');
const { resolveOwnerWithRepoAccess, resetRepoAccessCache } = await import('./repo-aware-token.js');

interface SeededUser {
  id: string;
  username: string;
}

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'repo-aware-token-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

function seedOwners(n: number, prefix = 'owner'): SeededUser[] {
  const out: SeededUser[] = [];
  for (let i = 0; i < n; i++) {
    const u = createUser({ username: `${prefix}-${i}-${Date.now()}-${i}`, passwordHash: 'h' });
    createMembership(u.id, 'default', 'Owner');
    out.push({ id: u.id, username: u.username });
  }
  return out;
}

function fetchStub(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return responder(url, init ?? {});
  };
}

describe('resolveOwnerWithRepoAccess', () => {
  beforeEach(() => {
    freshDb();
    resetRepoAccessCache();
    mockOauthImpl = async () => null;
  });

  it('returns null when there are no users at all', async () => {
    let probeCount = 0;
    const result = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl: fetchStub(() => {
        probeCount++;
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(probeCount).toBe(0);
  });

  it('returns the first Owner whose token probes 200', async () => {
    const [a, b, c] = seedOwners(3);
    mockOauthImpl = async (uid) => `token-${uid}`;
    const seenUrls: string[] = [];
    const result = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl: fetchStub((url, init) => {
        seenUrls.push(`${url}:${(init.headers as Record<string, string>).Authorization}`);
        // Only `c` succeeds — a and b 404.
        const auth = (init.headers as Record<string, string>).Authorization;
        const ok = auth === `token token-${c.id}`;
        return new Response('', { status: ok ? 200 : 404 });
      }) as unknown as typeof fetch,
    });
    expect(result).toBe(c.id);
    // Probed in order: a, b, c — stop after first success.
    expect(seenUrls).toHaveLength(3);
    expect(seenUrls[0]).toContain(`token token-${a.id}`);
    expect(seenUrls[1]).toContain(`token token-${b.id}`);
    expect(seenUrls[2]).toContain(`token token-${c.id}`);
    // All probes hit the right URL.
    for (const entry of seenUrls) {
      expect(entry.startsWith('https://api.github.com/repos/Speakman-ai/agent-hub:')).toBe(true);
    }
  });

  it('returns null when no Owner probes 200 (no org-owner fallback)', async () => {
    seedOwners(2);
    mockOauthImpl = async (uid) => `token-${uid}`;
    const result = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl: fetchStub(() => new Response('', { status: 404 })) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('returns null when fetch rejects for every Owner (no org-owner fallback)', async () => {
    seedOwners(2);
    mockOauthImpl = async (uid) => `token-${uid}`;
    const result = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl: fetchStub(() => {
        throw new Error('econn');
      }) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('skips Owners with no resolvable token (no OAuth, no PAT)', async () => {
    const [a, b] = seedOwners(2);
    mockOauthImpl = async (uid) => (uid === b.id ? `token-${uid}` : null);
    const seenAuths: string[] = [];
    const result = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl: fetchStub((_url, init) => {
        seenAuths.push((init.headers as Record<string, string>).Authorization);
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toBe(b.id);
    // Only `b` was probed — `a` had no token.
    expect(seenAuths).toEqual([`token token-${b.id}`]);
  });

  it('caches the resolved user id for subsequent calls within the TTL', async () => {
    const [a, b] = seedOwners(2);
    mockOauthImpl = async (uid) => `token-${uid}`;
    let probeCount = 0;
    const fetchImpl = fetchStub((_url, init) => {
      probeCount++;
      const auth = (init.headers as Record<string, string>).Authorization;
      return new Response('', { status: auth === `token token-${b.id}` ? 200 : 404 });
    }) as unknown as typeof fetch;

    const fixedNow = 1_000_000_000;
    const first = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl,
      now: () => fixedNow,
    });
    expect(first).toBe(b.id);
    const initialProbes = probeCount;
    expect(initialProbes).toBeGreaterThan(0);

    // Within the 5-min TTL — must hit cache, no new probes.
    const second = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl,
      now: () => fixedNow + 60_000,
    });
    expect(second).toBe(b.id);
    expect(probeCount).toBe(initialProbes);

    // Past the TTL — must re-probe.
    const third = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl,
      now: () => fixedNow + 6 * 60_000,
    });
    expect(third).toBe(b.id);
    expect(probeCount).toBeGreaterThan(initialProbes);
    // Silence unused variable warnings — `a` exists only to ensure b is probed second.
    expect(a.id).toBeTruthy();
  });

  it('caches "no Owner has access" so misconfigured installs do not hammer GitHub', async () => {
    seedOwners(2);
    mockOauthImpl = async (uid) => `token-${uid}`;
    let probeCount = 0;
    const fetchImpl = fetchStub(() => {
      probeCount++;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const first = await resolveOwnerWithRepoAccess('foo/bar', { fetchImpl });
    expect(first).toBeNull();
    const initialProbes = probeCount;

    const second = await resolveOwnerWithRepoAccess('foo/bar', { fetchImpl });
    expect(second).toBeNull();
    // No re-probe — the null result is also cached.
    expect(probeCount).toBe(initialProbes);
  });

  it('skipCache forces a re-probe even within the TTL', async () => {
    const [, b] = seedOwners(2);
    mockOauthImpl = async (uid) => `token-${uid}`;
    let probeCount = 0;
    const fetchImpl = fetchStub((_url, init) => {
      probeCount++;
      const auth = (init.headers as Record<string, string>).Authorization;
      return new Response('', { status: auth === `token token-${b.id}` ? 200 : 404 });
    }) as unknown as typeof fetch;

    await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', { fetchImpl });
    const cached = probeCount;
    await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', { fetchImpl, skipCache: true });
    expect(probeCount).toBeGreaterThan(cached);
  });

  it('rejects garbage repo strings without probing or caching (returns null)', async () => {
    seedOwners(1);
    mockOauthImpl = async (uid) => `token-${uid}`;
    let probeCount = 0;
    const fetchImpl = fetchStub(() => {
      probeCount++;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    for (const bad of ['', '   ', 'no-slash', '/leading', 'trailing/', 'a/b/c', 'a /b']) {
      const r = await resolveOwnerWithRepoAccess(bad, { fetchImpl });
      expect(r).toBeNull();
    }
    expect(probeCount).toBe(0);
  });

  it('aborts a probe that hangs past the timeout (treated as no-access)', async () => {
    // We can't easily assert the timeout fires without burning real time;
    // instead we drive an immediately-rejected fetch and check the loop
    // moves on to the next Owner, which mirrors the same control-flow path
    // the AbortController hits.
    const [a, b] = seedOwners(2);
    mockOauthImpl = async (uid) => `token-${uid}`;
    const fetchImpl = fetchStub((_url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === `token token-${a.id}`) {
        const err = new Error('aborted') as Error & { name: string };
        err.name = 'AbortError';
        throw err;
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', { fetchImpl });
    expect(r).toBe(b.id);
  });

  it('returns null when memberships lookup throws (no org-owner fallback)', async () => {
    // No orgs.db init — calling listMembersForOrg throws.
    setOrgsDbPathForTests('/nonexistent/path/orgs.db');
    let probeCount = 0;
    const r = await resolveOwnerWithRepoAccess('Speakman-ai/agent-hub', {
      fetchImpl: fetchStub(() => {
        probeCount++;
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(r).toBeNull();
    expect(probeCount).toBe(0);
  });
});
