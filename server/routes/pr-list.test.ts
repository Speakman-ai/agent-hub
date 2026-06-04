import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';
import {
  parseRepoFullName,
  normalizePrSummary,
  normalizeReviews,
  normalizeIssueComments,
  normalizeCheckRuns,
  mergeableFromCli,
} from './pr-list.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promisify: () => vi.fn(),
  };
});

function buildMockDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    config: { port: 3051, dataDir: '/tmp' },
    stmts: {},
    broadcast: vi.fn() as unknown,
    findProject: vi.fn(),
    findAgent: vi.fn(),
    getEnrichedAgent: vi.fn(),
    allAgents: vi.fn(),
    saveProjects: vi.fn(),
    ensureProjectRoom: vi.fn(),
    handleChat: vi.fn(),
    pendingReviewComments: new Map(),
    lastDispatchedReviewId: new Map(),
    scheduleAutonomousEpic: vi.fn(),
    autonomousCrons: new Map(),
    runAutonomousLoop: vi.fn(),
    getProjects: vi.fn().mockReturnValue([]),
    setProjects: vi.fn(),
    getGhBotUser: vi.fn().mockReturnValue(null),
    setGhBotUser: vi.fn(),
    getGhAppSlug: vi.fn().mockReturnValue(null),
    setGhAppSlug: vi.fn(),
    serverDir: '/tmp',
    buildTranscript: vi.fn(),
    summarizeTranscript: vi.fn(),
    ...overrides,
  } as unknown as RouteDeps;
}

describe('pr-list — pure helpers', () => {
  describe('parseRepoFullName', () => {
    it('parses owner/repo', () => {
      expect(parseRepoFullName('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses owner/repo.git', () => {
      expect(parseRepoFullName('my-org/my-repo.git')).toEqual({
        owner: 'my-org',
        repo: 'my-repo',
      });
    });

    it('trims whitespace', () => {
      expect(parseRepoFullName('  owner/repo  ')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('returns null for empty', () => {
      expect(parseRepoFullName('')).toBeNull();
      expect(parseRepoFullName(null)).toBeNull();
      expect(parseRepoFullName(undefined)).toBeNull();
    });

    it('returns null for invalid formats', () => {
      expect(parseRepoFullName('just-a-name')).toBeNull();
      expect(parseRepoFullName('a/b/c')).toBeNull();
      expect(parseRepoFullName('has space/repo')).toBeNull();
    });
  });

  describe('normalizePrSummary', () => {
    it('flattens user/head/base and labels', () => {
      const out = normalizePrSummary({
        number: 42,
        title: 'Fix thing',
        state: 'open',
        draft: false,
        html_url: 'https://github.com/o/r/pull/42',
        user: { login: 'alice', avatar_url: 'https://img/1.png' },
        head: { ref: 'feature/x' },
        base: { ref: 'main' },
        created_at: '2026-04-17T00:00:00Z',
        updated_at: '2026-04-18T00:00:00Z',
        labels: [
          { name: 'bug', color: 'red' },
          { name: 'p1', color: 'orange' },
        ],
        comments: 3,
        review_comments: 5,
        additions: 10,
        deletions: 2,
        changed_files: 4,
      });
      expect(out.user).toBe('alice');
      expect(out.user_avatar).toBe('https://img/1.png');
      expect(out.head).toBe('feature/x');
      expect(out.base).toBe('main');
      expect(out.labels).toEqual([
        { name: 'bug', color: 'red' },
        { name: 'p1', color: 'orange' },
      ]);
      expect(out.number).toBe(42);
    });

    it('handles missing user/head/base gracefully', () => {
      const out = normalizePrSummary({
        number: 1,
        title: 't',
        state: 'closed',
        html_url: 'u',
      });
      expect(out.user).toBeNull();
      expect(out.head).toBeNull();
      expect(out.base).toBeNull();
      expect(out.labels).toEqual([]);
    });

    it('defaults draft to false when missing', () => {
      expect(normalizePrSummary({ number: 1 }).draft).toBe(false);
    });
  });

  describe('normalizeReviews', () => {
    it('flattens user and preserves fields', () => {
      const out = normalizeReviews([
        {
          id: 100,
          user: { login: 'reviewer' },
          state: 'APPROVED',
          body: 'looks good',
          submitted_at: '2026-04-18T00:00:00Z',
          html_url: 'url',
        },
      ]);
      expect(out).toEqual([
        {
          id: 100,
          user: 'reviewer',
          state: 'APPROVED',
          body: 'looks good',
          submitted_at: '2026-04-18T00:00:00Z',
          html_url: 'url',
        },
      ]);
    });

    it('returns empty for non-arrays', () => {
      expect(normalizeReviews(null)).toEqual([]);
      expect(normalizeReviews(undefined)).toEqual([]);
      expect(normalizeReviews('')).toEqual([]);
      expect(normalizeReviews({})).toEqual([]);
    });
  });

  describe('normalizeIssueComments', () => {
    it('flattens user and body', () => {
      const out = normalizeIssueComments([
        { id: 1, user: { login: 'bob' }, body: 'hi', created_at: 't' },
      ]);
      expect(out[0]).toMatchObject({ id: 1, user: 'bob', body: 'hi', created_at: 't' });
    });

    it('returns empty for non-arrays', () => {
      expect(normalizeIssueComments(null)).toEqual([]);
    });
  });

  describe('mergeableFromCli', () => {
    // Guards against a regression where `=== 'MERGEABLE'` collapsed
    // the three-state CLI `mergeable` field into a boolean, causing
    // mobile to render a false "Conflicts" badge for UNKNOWN PRs.
    it("maps 'MERGEABLE' to true", () => {
      expect(mergeableFromCli('MERGEABLE')).toBe(true);
    });

    it("maps 'CONFLICTING' to false", () => {
      expect(mergeableFromCli('CONFLICTING')).toBe(false);
    });

    it("maps 'UNKNOWN' to null", () => {
      expect(mergeableFromCli('UNKNOWN')).toBeNull();
    });

    it('maps null/undefined/missing to null', () => {
      expect(mergeableFromCli(null)).toBeNull();
      expect(mergeableFromCli(undefined)).toBeNull();
      expect(mergeableFromCli('')).toBeNull();
    });

    it('maps unexpected values to null (never guesses true)', () => {
      expect(mergeableFromCli('pending')).toBeNull();
      expect(mergeableFromCli(true)).toBeNull();
      expect(mergeableFromCli(0)).toBeNull();
    });
  });

  describe('normalizeCheckRuns', () => {
    it('flattens check_runs field', () => {
      const out = normalizeCheckRuns({
        total_count: 1,
        check_runs: [
          {
            id: 9,
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            html_url: 'u',
            started_at: 's',
            completed_at: 'c',
          },
        ],
      });
      expect(out).toEqual([
        {
          id: 9,
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          html_url: 'u',
          started_at: 's',
          completed_at: 'c',
        },
      ]);
    });

    it('returns empty when shape is unexpected', () => {
      expect(normalizeCheckRuns(null)).toEqual([]);
      expect(normalizeCheckRuns({})).toEqual([]);
      expect(normalizeCheckRuns({ check_runs: 'nope' })).toEqual([]);
    });
  });
});

describe('pr-list — routes', () => {
  let app: express.Express;

  async function mountWithFindProject(findProject: RouteDeps['findProject']) {
    vi.resetModules();
    const { default: createPrListRoutes } = await import('./pr-list.js');
    const deps = buildMockDeps({ findProject });
    const e = express();
    e.use(express.json());
    e.use(createPrListRoutes(deps));
    return e;
  }

  it('returns 404 if project is missing', async () => {
    app = await mountWithFindProject(vi.fn().mockReturnValue(null));
    const res = await request(app).get('/api/projects/ghost/pulls');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Project not found/);
  });

  it('returns 400 if project has no githubRepo', async () => {
    app = await mountWithFindProject(vi.fn().mockReturnValue({ id: 'p', githubRepo: undefined }));
    const res = await request(app).get('/api/projects/p/pulls');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/githubRepo/);
  });

  it('returns 400 if githubRepo is malformed', async () => {
    app = await mountWithFindProject(
      vi.fn().mockReturnValue({ id: 'p', githubRepo: 'not-a-repo' }),
    );
    const res = await request(app).get('/api/projects/p/pulls');
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid PR number on detail', async () => {
    app = await mountWithFindProject(vi.fn().mockReturnValue({ id: 'p', githubRepo: 'o/r' }));
    const res = await request(app).get('/api/projects/p/pulls/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid PR number/);
  });

  it('detail returns 404 when project missing', async () => {
    app = await mountWithFindProject(vi.fn().mockReturnValue(null));
    const res = await request(app).get('/api/projects/p/pulls/42');
    expect(res.status).toBe(404);
  });

  it('detail returns 400 when project has no githubRepo', async () => {
    app = await mountWithFindProject(vi.fn().mockReturnValue({ id: 'p' }));
    const res = await request(app).get('/api/projects/p/pulls/42');
    expect(res.status).toBe(400);
  });
});
