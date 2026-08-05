import '../test/setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createOrGetOpenPullRequest,
  getPullRequest,
  listPullRequests,
  listPullRequestsForBranch,
  markClosed,
  markMerged,
  markReverted,
} from './store.js';
import { buildNativePrUrl, isNativePrUrl, parseNativePrUrl } from './url.js';
import type { Stmts } from '../types.js';

let stmts: Stmts;
/** Force every PR row in a project to the same `updated_at` (tie-breaker tests). */
let pinUpdatedAt: (projectId: string, updatedAt: number) => void;

beforeAll(async () => {
  // test/setup initializes the DB into the per-process tmp data dir.
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest(); // boots the app + initDb
  const dbModule = await import('../db.js');
  stmts = dbModule.stmts!;
  pinUpdatedAt = (projectId, updatedAt) => {
    dbModule
      .getDb()
      .prepare('UPDATE pull_requests SET updated_at = ? WHERE project_id = ?')
      .run(updatedAt, projectId);
  };
});

function freshArgs(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    title: 'Add feature',
    body: 'body text',
    headBranch: `agent-hub/a1/session-${uuidv4().slice(0, 8)}`,
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    author: 'finalize',
    ...overrides,
  };
}

describe('native-pr store', () => {
  it('allocates per-project numbers sequentially and independently', () => {
    const p1 = `np-${uuidv4().slice(0, 8)}`;
    const p2 = `np-${uuidv4().slice(0, 8)}`;
    expect(createOrGetOpenPullRequest(stmts, freshArgs(p1)).row.number).toBe(1);
    expect(createOrGetOpenPullRequest(stmts, freshArgs(p1)).row.number).toBe(2);
    expect(createOrGetOpenPullRequest(stmts, freshArgs(p2)).row.number).toBe(1);
  });

  it('reuses the open PR for the same head branch and refreshes head/title/body', () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    const args = freshArgs(projectId);
    const first = createOrGetOpenPullRequest(stmts, args);
    expect(first.created).toBe(true);

    const second = createOrGetOpenPullRequest(stmts, {
      ...args,
      headSha: 'b'.repeat(40),
      title: 'Updated title',
    });
    expect(second.created).toBe(false);
    expect(second.row.number).toBe(first.row.number);
    expect(second.row.head_sha).toBe('b'.repeat(40));
    expect(second.row.title).toBe('Updated title');
    expect(second.row.updated_at).toBeGreaterThanOrEqual(first.row.updated_at);
  });

  it('does NOT reuse a merged/closed PR for the same branch — new number', () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    const args = freshArgs(projectId);
    const first = createOrGetOpenPullRequest(stmts, args).row;
    expect(
      markMerged(stmts, first, {
        mergedSha: 'c'.repeat(40),
        mergedBy: 'u1',
        mergeMethod: 'squash',
      }),
    ).toMatchObject({ status: 'merged', merge_method: 'squash' });

    const second = createOrGetOpenPullRequest(stmts, args);
    expect(second.created).toBe(true);
    expect(second.row.number).toBe(first.number + 1);
  });

  it('merge/close transitions are guarded — only open rows transition', () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    const row = createOrGetOpenPullRequest(stmts, freshArgs(projectId)).row;
    const closed = markClosed(stmts, row);
    expect(closed?.status).toBe('closed');
    expect(closed?.closed_at).toBeTruthy();

    // Already closed — both transitions refuse.
    expect(markClosed(stmts, row)).toBeNull();
    expect(
      markMerged(stmts, row, { mergedSha: 'd'.repeat(40), mergedBy: 'u1', mergeMethod: 'merge' }),
    ).toBeNull();
  });

  it('markReverted only fires once, and only on a merged row', () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    const row = createOrGetOpenPullRequest(stmts, freshArgs(projectId)).row;

    // Open PR — nothing to revert.
    expect(markReverted(stmts, row, { revertSha: 'a'.repeat(40), revertedBy: 'u1' })).toBeNull();

    const merged = markMerged(stmts, row, {
      mergedSha: 'b'.repeat(40),
      mergedBy: 'u1',
      mergeMethod: 'squash',
    });
    expect(merged).toBeTruthy();

    const reverted = markReverted(stmts, row, { revertSha: 'c'.repeat(40), revertedBy: 'u2' });
    expect(reverted).toMatchObject({
      status: 'merged',
      revert_sha: 'c'.repeat(40),
      reverted_by: 'u2',
    });
    expect(reverted?.reverted_at).toBeTruthy();

    // Second revert refused in SQL — the recorded sha is not overwritten.
    expect(markReverted(stmts, row, { revertSha: 'd'.repeat(40), revertedBy: 'u3' })).toBeNull();
    expect(getPullRequest(stmts, projectId, row.number)?.revert_sha).toBe('c'.repeat(40));
  });

  it('list filters by state', () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    const a = createOrGetOpenPullRequest(stmts, freshArgs(projectId)).row;
    createOrGetOpenPullRequest(stmts, freshArgs(projectId));
    markClosed(stmts, a);

    expect(listPullRequests(stmts, projectId, 'open', 50)).toHaveLength(1);
    expect(listPullRequests(stmts, projectId, 'closed', 50)).toHaveLength(1);
    expect(listPullRequests(stmts, projectId, 'all', 50)).toHaveLength(2);
    expect(getPullRequest(stmts, projectId, a.number)?.status).toBe('closed');
    expect(getPullRequest(stmts, projectId, 999)).toBeNull();
  });

  it('list pages with offset — no row is repeated or skipped across pages', async () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    for (let i = 0; i < 7; i++) {
      createOrGetOpenPullRequest(stmts, freshArgs(projectId));
      // updated_at is millisecond-resolution; keep the ORDER BY deterministic.
      await new Promise((r) => setTimeout(r, 2));
    }

    const pageOne = listPullRequests(stmts, projectId, 'all', 3, 0);
    const pageTwo = listPullRequests(stmts, projectId, 'all', 3, 3);
    const pageThree = listPullRequests(stmts, projectId, 'all', 3, 6);

    expect(pageOne.map((r) => r.number)).toHaveLength(3);
    expect(pageTwo).toHaveLength(3);
    expect(pageThree).toHaveLength(1);
    const seen = [...pageOne, ...pageTwo, ...pageThree].map((r) => r.number);
    expect(new Set(seen).size).toBe(7);
    // Newest activity first, so page 2 must not overlap page 1.
    expect(pageTwo.map((r) => r.number)).not.toContain(pageOne[0].number);
    // Offset defaults to 0 for callers that don't page.
    expect(listPullRequests(stmts, projectId, 'all', 3).map((r) => r.number)).toEqual(
      pageOne.map((r) => r.number),
    );
    expect(listPullRequests(stmts, projectId, 'all', 3, 99)).toHaveLength(0);
  });

  it('pages deterministically when every row shares an updated_at', () => {
    // The real collision: a Finalize run touches several PRs inside the same
    // millisecond. Ordering on updated_at alone leaves tied rows in whatever
    // order SQLite feels like per query, so a row can be served on two pages
    // while another is never served at all.
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    for (let i = 0; i < 7; i++) createOrGetOpenPullRequest(stmts, freshArgs(projectId));
    pinUpdatedAt(projectId, 1_760_000_000_000);

    const pages = [0, 3, 6].map((offset) => listPullRequests(stmts, projectId, 'all', 3, offset));
    const seen = pages.flat().map((r) => r.number);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    // Total order: newest number first, and every page picks up where the
    // previous one stopped.
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);

    // Same query, same answer — no per-call reshuffling of the tied rows.
    expect(listPullRequests(stmts, projectId, 'all', 3, 3).map((r) => r.number)).toEqual([4, 3, 2]);
  });

  it('listPullRequestsForBranch returns branch matches even beyond a 200-PR page', async () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    const featureBranch = 'feature/big-epic';

    // A ticket PR that targets the feature branch, and the epic's integration
    // PR whose head IS the feature branch.
    const targetsPr = createOrGetOpenPullRequest(
      stmts,
      freshArgs(projectId, { baseBranch: featureBranch }),
    ).row;
    const integrationPr = createOrGetOpenPullRequest(
      stmts,
      freshArgs(projectId, { headBranch: featureBranch, baseBranch: 'main' }),
    ).row;

    // Force the two matches to be the OLDEST rows so a `updated_at DESC LIMIT
    // 200` page provably sorts them out (deterministic, no timestamp-tie flake).
    const { getDb } = await import('../db.js');
    const bump = getDb().prepare('UPDATE pull_requests SET updated_at = ? WHERE id = ?');
    bump.run(1, targetsPr.id);
    bump.run(1, integrationPr.id);

    // 205 unrelated, newer PRs — enough to bury the two matches outside the old
    // 200-row page that the endpoint used to fetch-then-filter in memory.
    for (let i = 0; i < 205; i++) {
      createOrGetOpenPullRequest(stmts, freshArgs(projectId));
    }

    // The old approach: fetch the newest 200 then filter — drops the matches.
    const paged = listPullRequests(stmts, projectId, 'all', 200);
    expect(paged).toHaveLength(200);
    const pagedNumbers = new Set(paged.map((p) => p.number));
    expect(pagedNumbers.has(targetsPr.number)).toBe(false);
    expect(pagedNumbers.has(integrationPr.number)).toBe(false);

    // The fix: branch-scoped storage query returns both, regardless of paging.
    const branchPrs = listPullRequestsForBranch(stmts, projectId, featureBranch);
    const branchNumbers = new Set(branchPrs.map((p) => p.number));
    expect(branchNumbers).toEqual(new Set([targetsPr.number, integrationPr.number]));
  });

  it('listPullRequestsForBranch trims the query branch and ignores blank', () => {
    const projectId = `np-${uuidv4().slice(0, 8)}`;
    const branch = 'feature/trimmed';
    const pr = createOrGetOpenPullRequest(stmts, freshArgs(projectId, { baseBranch: branch })).row;

    // A whitespace-padded query still matches the stored (trimmed) branch —
    // agrees with the in-memory matchers instead of missing the row.
    expect(
      listPullRequestsForBranch(stmts, projectId, `  ${branch}  `).map((p) => p.number),
    ).toEqual([pr.number]);
    // Blank-after-trim → no query, empty result.
    expect(listPullRequestsForBranch(stmts, projectId, '   ')).toEqual([]);
  });
});

describe('native-pr url', () => {
  it('builds and parses relative + absolute URLs', () => {
    const url = buildNativePrUrl('my-project', 12);
    expect(url).toBe('/projects/my-project/pulls/12');
    expect(parseNativePrUrl(url)).toEqual({ projectId: 'my-project', number: 12 });
    expect(parseNativePrUrl(`https://hub.example.com${url}`)).toEqual({
      projectId: 'my-project',
      number: 12,
    });
    expect(parseNativePrUrl(`${url}?tab=files#diff`)).toEqual({
      projectId: 'my-project',
      number: 12,
    });
  });

  it('rejects GitHub URLs and garbage', () => {
    expect(parseNativePrUrl('https://github.com/owner/repo/pull/5')).toBeNull();
    expect(parseNativePrUrl('/projects/x/pulls/abc')).toBeNull();
    expect(parseNativePrUrl('')).toBeNull();
    expect(parseNativePrUrl(null)).toBeNull();
    expect(isNativePrUrl('/projects/x/pulls/1')).toBe(true);
    expect(isNativePrUrl('https://github.com/o/r/pull/1')).toBe(false);
  });
});
