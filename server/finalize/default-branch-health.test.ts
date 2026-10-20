/**
 * Default-branch CI health: breakage recording/clearing, card idempotency,
 * merge-range attribution, and inherited-failure classification. Real test
 * DB (production DDL) and real git repos for ancestry.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { KanbanCardRow, Stmts } from '../types.js';
import {
  classifyInheritedFailures,
  defaultIsAncestor,
  parseInheritedFailures,
  recordDefaultBranchCiResult,
  type DefaultBranchBreakageRow,
  type DefaultBranchFailureRow,
} from './default-branch-health.js';

let stmts: Stmts;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest();
  stmts = (await import('../db.js')).stmts!;
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

/** A linear repo; returns the shas oldest first. */
function linearRepo(subjects: string[]): { dir: string; shas: string[] } {
  const dir = path.join(os.tmpdir(), `dbh-${uuidv4().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: dir, stdio: 'pipe' });
  git(dir, 'config user.email "t@example.com"');
  git(dir, 'config user.name "T"');
  const shas: string[] = [];
  for (const [i, subject] of subjects.entries()) {
    writeFileSync(path.join(dir, 'f.txt'), `${i}\n`);
    git(dir, 'add -A');
    git(dir, `commit -m "${subject}"`);
    shas.push(git(dir, 'rev-parse HEAD'));
  }
  return { dir, shas };
}

type JobState = 'passed' | 'failed' | 'skipped';

/** Insert a finished CI run with the given per-instance results. */
function seedRun(
  projectId: string,
  headSha: string,
  jobs: Array<[jobId: string, matrixKey: string, state: JobState]>,
  opts: { trigger?: 'git_push' | 'ui_button' } = {},
): { runId: string; sessionId: string } {
  const runId = uuidv4();
  const sessionId = uuidv4();
  stmts.createSession.run(sessionId, 'ci-push', 'CI', 'claude-code', 'none', 0, 0, 1);
  stmts.insertFinalizeRun.run(
    runId,
    'ci-push',
    sessionId,
    projectId,
    'main',
    headSha,
    `test|${runId}`,
    'running',
    null,
    opts.trigger ?? 'git_push',
    null,
    'system',
    'CI',
    'ci@example.com',
    null,
    Date.now(),
    'checks',
  );
  for (const [i, [jobId, matrixKey, state]] of jobs.entries()) {
    stmts.upsertFinalizeRunJob.run(runId, jobId, matrixKey, state, null, 1, 2, null);
    stmts.upsertFinalizeRunStep.run(
      runId,
      i,
      `${jobId} test`,
      state,
      state === 'failed' ? 1 : 0,
      1,
      2,
      jobId,
      matrixKey,
    );
  }
  return { runId, sessionId };
}

function failures(projectId: string): DefaultBranchFailureRow[] {
  return stmts.listDefaultBranchFailures.all(projectId) as DefaultBranchFailureRow[];
}

function comments(cardId: string): Array<{ content: string }> {
  return stmts.getKanbanCardComments.all(cardId) as Array<{ content: string }>;
}

function newProject(): string {
  return `dbh-${uuidv4().slice(0, 8)}`;
}

const deps = () => ({
  stmts,
  broadcast: () => {},
  log: () => {},
  stepLogTail: () => ['FAIL server/foo.test.ts', 'expected 1 to be 2'],
});

describe('recordDefaultBranchCiResult', () => {
  it('records failing instances, opens one card with range, PRs, sessions and logs, then clears on green', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['base', 'feat: add thing', 'fix: other']);
    const [a, b, c] = shas;

    // Last green CI was on `a`.
    const green0 = seedRun(projectId, a, [['unit', '', 'passed']]);
    await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: a,
      runId: green0.runId,
      logSessionId: green0.sessionId,
      outcome: 'succeeded',
      repoDir: dir,
    });

    // `b` merged through a native PR from a session branch.
    const prId = uuidv4();
    stmts.insertPullRequest.run(
      prId,
      projectId,
      7,
      'Add thing',
      '',
      'agent-hub/dev/session-x',
      'main',
      b,
      'u1',
      1,
      1,
    );
    stmts.markPullRequestMerged.run(b, 'u1', 'squash', 2, 2, prId);
    const sessionId = uuidv4();
    stmts.createSession.run(sessionId, 'dev', 'work', 'claude-code', 'none', 0, 0, 1);
    stmts.updateSessionWorktreeBranch.run('agent-hub/dev/session-x', sessionId);

    // Queue coalesced b and c into one run at c, which fails two shards.
    const red = seedRun(projectId, c, [
      ['unit', 'shard-1', 'failed'],
      ['unit', 'shard-2', 'passed'],
      ['e2e', '', 'failed'],
    ]);
    const res = await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: c,
      runId: red.runId,
      logSessionId: red.sessionId,
      outcome: 'failed',
      repoDir: dir,
    });

    expect(res.kind).toBe('recorded');
    const rows = failures(projectId);
    expect(rows.map((r) => [r.job_id, r.matrix_key, r.first_failing_sha])).toEqual([
      ['e2e', '', c],
      ['unit', 'shard-1', c],
    ]);
    const breakage = stmts.getOpenDefaultBranchBreakage.get(projectId) as DefaultBranchBreakageRow;
    expect(breakage).toMatchObject({ first_failing_sha: c, range_from_sha: a, status: 'open' });
    expect(breakage.card_id).toBeTruthy();
    const card = stmts.getKanbanCard.get(breakage.card_id) as KanbanCardRow;
    expect(card.title).toContain('Default branch red');
    expect(card.title).toContain('unit (shard-1)');
    expect(card.priority).toBe('high');
    const desc = card.description ?? '';
    expect(desc).toContain(`\`${a.slice(0, 8)}..${c.slice(0, 8)}\` (2 commits)`);
    expect(desc).toContain('PR #7 "Add thing"');
    expect(desc).toContain(sessionId);
    expect(desc).toContain('fix: other');
    expect(desc).toContain('expected 1 to be 2');

    // A later red run (same breakage) comments instead of opening a second card.
    const d = (() => {
      writeFileSync(path.join(dir, 'g.txt'), 'x');
      git(dir, 'add -A');
      git(dir, 'commit -m "chore: more"');
      return git(dir, 'rev-parse HEAD');
    })();
    const red2 = seedRun(projectId, d, [
      ['unit', 'shard-1', 'passed'],
      ['unit', 'shard-2', 'passed'],
      ['e2e', '', 'failed'],
    ]);
    await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: d,
      runId: red2.runId,
      logSessionId: red2.sessionId,
      outcome: 'failed',
      repoDir: dir,
    });
    const again = stmts.getOpenDefaultBranchBreakage.get(projectId) as DefaultBranchBreakageRow;
    expect(again.id).toBe(breakage.id);
    expect(again.last_failing_sha).toBe(d);
    // shard-1 passed: cleared. e2e keeps its first failing sha.
    expect(
      failures(projectId).map((r) => [r.job_id, r.first_failing_sha, r.last_failing_sha]),
    ).toEqual([['e2e', c, d]]);
    expect(comments(breakage.card_id!).some((x) => x.content.includes('Still failing'))).toBe(true);

    // Green run clears everything and closes the breakage.
    writeFileSync(path.join(dir, 'h.txt'), 'x');
    git(dir, 'add -A');
    git(dir, 'commit -m "fix: e2e"');
    const e = git(dir, 'rev-parse HEAD');
    const green = seedRun(projectId, e, [
      ['unit', 'shard-1', 'passed'],
      ['unit', 'shard-2', 'passed'],
      ['e2e', '', 'passed'],
    ]);
    await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: e,
      runId: green.runId,
      logSessionId: green.sessionId,
      outcome: 'succeeded',
      repoDir: dir,
    });
    expect(failures(projectId)).toEqual([]);
    expect(stmts.getOpenDefaultBranchBreakage.get(projectId)).toBeUndefined();
    const fixed = stmts.getDefaultBranchBreakage.get(breakage.id) as DefaultBranchBreakageRow;
    expect(fixed).toMatchObject({ status: 'fixed', fixed_sha: e });
    expect(
      comments(breakage.card_id!).some((x) =>
        x.content.startsWith(`Fixed by \`${e.slice(0, 8)}\``),
      ),
    ).toBe(true);
  });

  it('is idempotent on project + first failing sha: a replayed red run opens no second card', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['base']);
    const [a] = shas;
    const run1 = seedRun(projectId, a, [['unit', '', 'failed']]);
    const args = {
      projectId,
      branch: 'main',
      headSha: a,
      runId: run1.runId,
      logSessionId: run1.sessionId,
      outcome: 'failed' as const,
      repoDir: dir,
    };
    await recordDefaultBranchCiResult(deps(), args);
    // A re-run of the same red sha.
    const run2 = seedRun(projectId, a, [['unit', '', 'failed']]);
    await recordDefaultBranchCiResult(deps(), { ...args, runId: run2.runId });

    const board = stmts.getKanbanBoard.get(projectId) as { id: string };
    const cards = (stmts.getKanbanCards.all(board.id) as KanbanCardRow[]).filter((c) =>
      c.title.startsWith('Default branch red'),
    );
    expect(cards).toHaveLength(1);
    const byFirst = stmts.getDefaultBranchBreakageByFirstSha.get(
      projectId,
      a,
    ) as DefaultBranchBreakageRow;
    expect(byFirst.card_id).toBe(cards[0].id);
  });

  it('ignores a result for a commit older than the last one recorded', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['a', 'b']);
    const [a, b] = shas;
    const red = seedRun(projectId, b, [['unit', '', 'failed']]);
    await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: b,
      runId: red.runId,
      logSessionId: red.sessionId,
      outcome: 'failed',
      repoDir: dir,
    });
    // A passing re-run of the older commit must not clear today's failure.
    const oldGreen = seedRun(projectId, a, [['unit', '', 'passed']]);
    const res = await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: a,
      runId: oldGreen.runId,
      logSessionId: oldGreen.sessionId,
      outcome: 'succeeded',
      repoDir: dir,
    });
    expect(res.kind).toBe('stale');
    expect(failures(projectId)).toHaveLength(1);
  });
});

describe('recordDefaultBranchCiResult: instance set reconciliation', () => {
  it('a green full run clears a failing instance that was removed from ci.yaml and closes the breakage', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['a', 'b']);
    const [a, b] = shas;
    const red = seedRun(projectId, a, [
      ['unit', '', 'passed'],
      ['e2e', 'old-shard', 'failed'],
    ]);
    await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: a,
      runId: red.runId,
      logSessionId: red.sessionId,
      outcome: 'failed',
      repoDir: dir,
    });
    const breakage = stmts.getOpenDefaultBranchBreakage.get(projectId) as DefaultBranchBreakageRow;
    expect(breakage).toBeTruthy();

    // The shard was renamed: the next full run has no `e2e/old-shard` at all.
    const green = seedRun(projectId, b, [
      ['unit', '', 'passed'],
      ['e2e', 'new-shard', 'passed'],
    ]);
    await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: b,
      runId: green.runId,
      logSessionId: green.sessionId,
      outcome: 'succeeded',
      repoDir: dir,
    });
    expect(failures(projectId)).toEqual([]);
    expect(stmts.getDefaultBranchBreakage.get(breakage.id)).toMatchObject({
      status: 'fixed',
      fixed_sha: b,
    });
  });

  it('a single-job re-run does not clear failures of jobs it did not run', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['a']);
    const [a] = shas;
    const red = seedRun(projectId, a, [
      ['unit', '', 'failed'],
      ['e2e', '', 'failed'],
    ]);
    const base = {
      projectId,
      branch: 'main',
      headSha: a,
      logSessionId: red.sessionId,
      repoDir: dir,
    };
    await recordDefaultBranchCiResult(deps(), { ...base, runId: red.runId, outcome: 'failed' });
    const rerun = seedRun(projectId, a, [['unit', '', 'passed']]);
    await recordDefaultBranchCiResult(deps(), {
      ...base,
      runId: rerun.runId,
      outcome: 'succeeded',
      fullRun: false,
    });
    expect(failures(projectId).map((f) => f.job_id)).toEqual(['e2e']);
    expect(stmts.getOpenDefaultBranchBreakage.get(projectId)).toBeTruthy();
  });
});

describe('recordDefaultBranchCiResult: overlapping completions', () => {
  function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    return { wait, open };
  }
  const realIsAncestor = defaultIsAncestor;

  it('the newest result wins when an older run is still recording', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['a', 'b', 'c']);
    const [a, b, c] = shas;
    const runA = seedRun(projectId, a, [['unit', '', 'passed']]);
    await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: a,
      runId: runA.runId,
      logSessionId: runA.sessionId,
      outcome: 'succeeded',
      repoDir: dir,
    });

    // B (green) stalls in its ancestry check after reading state; C (red,
    // newer) completes meanwhile. B must not overwrite C or clear its failure.
    const g = gate();
    const runB = seedRun(projectId, b, [['unit', '', 'passed']]);
    const runC = seedRun(projectId, c, [['unit', '', 'failed']]);
    const recordB = recordDefaultBranchCiResult(
      {
        ...deps(),
        isAncestor: async (...xs) => {
          await g.wait;
          return realIsAncestor(...xs);
        },
      },
      {
        projectId,
        branch: 'main',
        headSha: b,
        runId: runB.runId,
        logSessionId: runB.sessionId,
        outcome: 'succeeded',
        repoDir: dir,
      },
    );
    const recordC = recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: c,
      runId: runC.runId,
      logSessionId: runC.sessionId,
      outcome: 'failed',
      repoDir: dir,
    });
    await new Promise((r) => setTimeout(r, 50));
    g.open();
    await Promise.all([recordB, recordC]);

    expect(failures(projectId).map((f) => [f.job_id, f.first_failing_sha])).toEqual([['unit', c]]);
    expect(stmts.getDefaultBranchCiState.get(projectId)).toMatchObject({
      last_sha: c,
      last_status: 'failed',
    });
  });

  it('overlapping red results open exactly one breakage card', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['a', 'b']);
    const [a, b] = shas;
    const g = gate();
    const runA = seedRun(projectId, a, [['unit', '', 'failed']]);
    const runB = seedRun(projectId, b, [['unit', '', 'failed']]);
    // A stalls while resolving its merge range (before it stores a card id).
    const recordA = recordDefaultBranchCiResult(
      {
        ...deps(),
        listRange: async (_dir, _from, to) => {
          await g.wait;
          return [{ sha: to, subject: 'a' }];
        },
      },
      {
        projectId,
        branch: 'main',
        headSha: a,
        runId: runA.runId,
        logSessionId: runA.sessionId,
        outcome: 'failed',
        repoDir: dir,
      },
    );
    const recordB = recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: b,
      runId: runB.runId,
      logSessionId: runB.sessionId,
      outcome: 'failed',
      repoDir: dir,
    });
    await new Promise((r) => setTimeout(r, 50));
    g.open();
    await Promise.all([recordA, recordB]);

    const board = stmts.getKanbanBoard.get(projectId) as { id: string };
    const cards = (stmts.getKanbanCards.all(board.id) as KanbanCardRow[]).filter((x) =>
      x.title.startsWith('Default branch red'),
    );
    expect(cards).toHaveLength(1);
    const open = stmts.getOpenDefaultBranchBreakage.get(projectId) as DefaultBranchBreakageRow;
    expect(open).toMatchObject({ first_failing_sha: a, last_failing_sha: b, card_id: cards[0].id });
    expect(comments(cards[0].id).some((x) => x.content.includes('Still failing'))).toBe(true);
  });
});

describe('classifyInheritedFailures', () => {
  async function redDefaultBranch(): Promise<{
    projectId: string;
    dir: string;
    shas: string[];
    cardId: string;
  }> {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['a', 'b', 'c']);
    // e2e first fails at b.
    const red = seedRun(projectId, shas[1], [
      ['unit', '', 'passed'],
      ['e2e', 's1', 'failed'],
      ['e2e', 's2', 'passed'],
    ]);
    const res = await recordDefaultBranchCiResult(deps(), {
      projectId,
      branch: 'main',
      headSha: shas[1],
      runId: red.runId,
      logSessionId: red.sessionId,
      outcome: 'failed',
      repoDir: dir,
    });
    if (res.kind !== 'recorded' || !res.cardId) throw new Error('expected a breakage card');
    return { projectId, dir, shas, cardId: res.cardId };
  }

  it('classifies a run whose only failures are already red at its base as inherited', async () => {
    const { projectId, dir, shas, cardId } = await redDefaultBranch();
    const session = seedRun(
      projectId,
      'feature-head',
      [
        ['unit', '', 'passed'],
        ['e2e', 's1', 'failed'],
        ['e2e', 's2', 'skipped'], // fail-fast sibling of the red job
      ],
      { trigger: 'ui_button' },
    );
    const verdict = await classifyInheritedFailures(
      { stmts },
      { projectId, runId: session.runId, baseSha: shas[2], repoDir: dir },
    );
    expect(verdict).toEqual({
      kind: 'inherited',
      summary: {
        count: 1,
        instances: [{ jobId: 'e2e', matrixKey: 's1', firstFailingSha: shas[1] }],
        breakageId: expect.any(String),
        cardId,
      },
    });
    if (verdict.kind === 'inherited') {
      expect(parseInheritedFailures(JSON.stringify(verdict.summary))).toEqual(verdict.summary);
    }
  });

  it('is not inherited when another instance also failed', async () => {
    const { projectId, dir, shas } = await redDefaultBranch();
    const session = seedRun(
      projectId,
      'feature-head',
      [
        ['unit', '', 'failed'],
        ['e2e', 's1', 'failed'],
      ],
      { trigger: 'ui_button' },
    );
    const verdict = await classifyInheritedFailures(
      { stmts },
      { projectId, runId: session.runId, baseSha: shas[2], repoDir: dir },
    );
    expect(verdict.kind).toBe('not_inherited');
  });

  it('is not inherited when the session base predates the first failure', async () => {
    const { projectId, dir, shas } = await redDefaultBranch();
    const session = seedRun(projectId, 'feature-head', [['e2e', 's1', 'failed']], {
      trigger: 'ui_button',
    });
    const verdict = await classifyInheritedFailures(
      { stmts },
      { projectId, runId: session.runId, baseSha: shas[0], repoDir: dir },
    );
    expect(verdict).toMatchObject({ kind: 'not_inherited' });
    if (verdict.kind === 'not_inherited')
      expect(verdict.reason).toContain('after the session base');
  });

  it('is not inherited when a different job was skipped', async () => {
    const { projectId, dir, shas } = await redDefaultBranch();
    const session = seedRun(
      projectId,
      'feature-head',
      [
        ['e2e', 's1', 'failed'],
        ['deploy-check', '', 'skipped'], // needs e2e: never validated
      ],
      { trigger: 'ui_button' },
    );
    const verdict = await classifyInheritedFailures(
      { stmts },
      { projectId, runId: session.runId, baseSha: shas[2], repoDir: dir },
    );
    expect(verdict.kind).toBe('not_inherited');
  });

  it('is not inherited once the default branch is green again', async () => {
    const projectId = newProject();
    const { dir, shas } = linearRepo(['a']);
    const session = seedRun(projectId, 'feature-head', [['e2e', 's1', 'failed']], {
      trigger: 'ui_button',
    });
    const verdict = await classifyInheritedFailures(
      { stmts },
      { projectId, runId: session.runId, baseSha: shas[0], repoDir: dir },
    );
    expect(verdict).toEqual({ kind: 'not_inherited', reason: 'default branch is green' });
  });
});
