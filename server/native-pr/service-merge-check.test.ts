/**
 * Merge-time base drift on native PRs: merge checks and auto-update.
 * Live test DB + real git in a hosted bare repo; the merge-check runner is
 * injected, so no job phase runs.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { Project, PullRequestRow, Stmts } from '../types.js';

let stmts: Stmts;
let createNativePrService: typeof import('./service.js').createNativePrService;
let createHostedRepo: typeof import('../git-host/repo-store.js').createHostedRepo;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;
let autoUpdateDriftedPrs: typeof import('./auto-update.js').autoUpdateDriftedPrs;
let mergeCheckRunKey: typeof import('./merge-drift.js').mergeCheckRunKey;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest();
  stmts = (await import('../db.js')).stmts!;
  ({ createNativePrService } = await import('./service.js'));
  ({ createHostedRepo, gitHostRepoPath } = await import('../git-host/repo-store.js'));
  ({ autoUpdateDriftedPrs } = await import('./auto-update.js'));
  ({ mergeCheckRunKey } = await import('./merge-drift.js'));
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function commit(work: string, file: string, message: string): void {
  mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  writeFileSync(path.join(work, file), `${file}\n`);
  git(work, 'add -A');
  git(work, `commit -m "${message}"`);
}

const TEST_PR_AUTHOR = '00000000-0000-4000-8000-000000000010';
const BRANCH = 'agent-hub/dev/session-mc000001';

/**
 * Hosted repo where the PR branch adds `branchFile` and main then gains
 * `baseFile`. The PR head is Finalize-validated, as #2238 was.
 */
async function seed(
  branchFile: string,
  baseFile: string,
  baseDrift: Project['baseDrift'],
): Promise<{ project: Project; bare: string; headSha: string; baseTip: string }> {
  const projectId = `npr-mc-${uuidv4().slice(0, 8)}`;
  const work = path.join(os.tmpdir(), `${projectId}-work`);
  mkdirSync(work, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email "t@example.com"');
  git(work, 'config user.name "T"');
  commit(work, 'training/migrations/0028_base.py', 'initial');
  await createHostedRepo({ id: projectId, cwd: work, repoUrl: null }, {});
  const bare = gitHostRepoPath(projectId);
  git(work, `remote add origin "${bare}"`);
  git(work, `checkout -b ${BRANCH}`);
  commit(work, branchFile, 'feature');
  git(work, `push -u origin ${BRANCH}`);
  const headSha = git(work, 'rev-parse HEAD');
  git(work, 'checkout main');
  commit(work, baseFile, 'main moves');
  git(work, 'push origin main');
  const baseTip = git(work, 'rev-parse HEAD');

  seedValidatedRun(projectId, headSha);
  const project = {
    id: projectId,
    name: projectId,
    cwd: '',
    ahw: '',
    gitHost: 'agenthub',
    branchProtection: { requiredChecks: true },
    baseDrift,
  } as Project;
  return { project, bare, headSha, baseTip };
}

function insertRun(projectId: string, sha: string, key: string): string {
  const runId = `fin-${uuidv4().slice(0, 8)}`;
  stmts.insertFinalizeRun.run(
    runId,
    'card-x',
    null,
    projectId,
    BRANCH,
    sha,
    key,
    'queued',
    null,
    'ui_button',
    null,
    'user',
    'Test',
    't@example.com',
    null,
    Date.now(),
    'full',
  );
  return runId;
}

function seedValidatedRun(projectId: string, sha: string): void {
  const runId = insertRun(projectId, sha, `test|${uuidv4()}`);
  stmts.markFinalizeRunReadyToPush.run(sha, runId);
}

function openPr(service: ReturnType<typeof createNativePrService>, project: Project, sha: string) {
  return service.createOrGetOpenPr({
    project,
    headBranch: BRANCH,
    baseBranch: 'main',
    headSha: sha,
    title: 'Certificates',
    body: '',
    author: TEST_PR_AUTHOR,
  }).row;
}

describe('merge checks on a drifted PR', () => {
  it('starts merge checks, arms auto-merge, and merges once they pass', async () => {
    const { project, headSha, baseTip } = await seed(
      'training/migrations/0029_certificates.py',
      'training/migrations/0029_trainer_cleanup.py',
      { mode: 'fast', reuseJobs: ['e2e'], mergeCheckJobs: ['backend-checks'] },
    );
    const startMergeCheck = vi.fn(async () => true);
    const service = createNativePrService({ stmts, broadcast: () => {}, startMergeCheck });
    const row = openPr(service, project, headSha);

    // The detail view reports the gate but never starts checks.
    const detail = await service.getDetail({ project, number: row.number });
    expect(detail.pr.merge_blocked_reason).toMatch(/checks have not run yet/);
    expect(startMergeCheck).not.toHaveBeenCalled();

    const first = await service.merge({
      project,
      number: row.number,
      mergeMethod: 'squash',
      actor: 'u1',
    });
    expect(first).toMatchObject({ ok: false, status: 409 });
    expect(!first.ok && first.error).toMatch(/Merge checks are running/);
    const prefix = mergeCheckRunKey(project.id, headSha, baseTip, ['backend-checks']);
    expect(startMergeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha,
        baseTip,
        jobs: ['backend-checks'],
        idempotencyKeyPrefix: prefix,
      }),
    );
    const armed = stmts.getPullRequestByNumber.get(project.id, row.number) as PullRequestRow;
    expect(armed.auto_merge).toBe(1);

    // A failed run blocks with the failure; a later passing attempt clears it.
    const failedRun = insertRun(project.id, 'merge-sha-1', `${prefix}|a`);
    stmts.failFinalizeRun.run('failed', 'checks_failed', failedRun);
    const blocked = await service.merge({
      project,
      number: row.number,
      mergeMethod: 'squash',
      actor: 'u1',
    });
    expect(!blocked.ok && blocked.error).toMatch(/merge checks failed .*checks_failed/);

    const passedRun = insertRun(project.id, 'merge-sha-2', `${prefix}|b`);
    stmts.failFinalizeRun.run('succeeded', null, passedRun);
    const merged = await service.merge({
      project,
      number: row.number,
      mergeMethod: 'squash',
      actor: 'auto-merge',
    });
    expect(merged.ok).toBe(true);
  });

  it('a pass under an older job list does not clear a merge that now needs more jobs', async () => {
    const { project, headSha, baseTip } = await seed(
      'training/migrations/0029_a.py',
      'training/migrations/0029_b.py',
      { mergeCheckJobs: ['backend-checks'] },
    );
    const startMergeCheck = vi.fn(async () => true);
    const service = createNativePrService({ stmts, broadcast: () => {}, startMergeCheck });
    const row = openPr(service, project, headSha);
    const oldKey = mergeCheckRunKey(project.id, headSha, baseTip, ['backend-checks']);
    const passed = insertRun(project.id, 'merge-sha-old', `${oldKey}|a`);
    stmts.failFinalizeRun.run('succeeded', null, passed);

    // Same head, same base tip, but the project now also requires frontend-build.
    project.baseDrift = { mergeCheckJobs: ['frontend-build', 'backend-checks'] };
    const res = await service.merge({
      project,
      number: row.number,
      mergeMethod: 'squash',
      actor: 'u1',
    });
    expect(!res.ok && res.error).toMatch(/Merge checks are running/);
    const newKey = mergeCheckRunKey(project.id, headSha, baseTip, [
      'backend-checks',
      'frontend-build',
    ]);
    expect(newKey).not.toBe(oldKey);
    expect(startMergeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        jobs: ['frontend-build', 'backend-checks'],
        idempotencyKeyPrefix: newKey,
      }),
    );
  });

  it('without merge-check jobs the drifted PR asks for Update branch', async () => {
    const { project, headSha } = await seed(
      'training/migrations/0029_a.py',
      'training/migrations/0029_b.py',
      undefined,
    );
    const startMergeCheck = vi.fn(async () => true);
    const service = createNativePrService({ stmts, broadcast: () => {}, startMergeCheck });
    const row = openPr(service, project, headSha);
    const res = await service.merge({
      project,
      number: row.number,
      mergeMethod: 'squash',
      actor: 'u1',
    });
    expect(!res.ok && res.error).toMatch(/Update the branch/);
    expect(startMergeCheck).not.toHaveBeenCalled();
    const after = stmts.getPullRequestByNumber.get(project.id, row.number) as PullRequestRow;
    expect(after.auto_merge).toBe(0);
  });
});

describe('autoUpdateDriftedPrs', () => {
  it('updates a PR the base moved onto and leaves an unrelated one alone', async () => {
    const { project, bare, headSha } = await seed(
      'training/migrations/0029_a.py',
      'training/migrations/0029_b.py',
      { autoUpdatePrs: true },
    );
    const afterHeadBranchMoved = vi.fn(async () => {});
    const service = createNativePrService({ stmts, broadcast: () => {}, afterHeadBranchMoved });
    const row = openPr(service, project, headSha);

    const result = await autoUpdateDriftedPrs(project, 'main', { stmts, nativePr: service });
    expect(result.updated).toEqual([row.number]);
    const newHead = git(bare, `rev-parse refs/heads/${BRANCH}`);
    expect(newHead).not.toBe(headSha);
    expect(git(bare, `merge-base ${newHead} refs/heads/main`)).toBe(
      git(bare, 'rev-parse refs/heads/main'),
    );
    // Update branch re-runs PR CI through the head-moved hook.
    expect(afterHeadBranchMoved).toHaveBeenCalledTimes(1);

    // Already current: a second pass is a no-op.
    expect(
      (await autoUpdateDriftedPrs(project, 'main', { stmts, nativePr: service })).updated,
    ).toEqual([]);
  });

  it('skips PRs whose files the base did not touch, and projects that did not opt in', async () => {
    const unrelated = await seed('app/views.py', 'frontend/app.ts', { autoUpdatePrs: true });
    const updateBranch = vi.fn();
    const service = createNativePrService({ stmts, broadcast: () => {} });
    openPr(service, unrelated.project, unrelated.headSha);
    await autoUpdateDriftedPrs(unrelated.project, 'main', {
      stmts,
      nativePr: { updateBranch },
    });
    expect(updateBranch).not.toHaveBeenCalled();

    const optedOut = await seed('training/migrations/0029_a.py', 'training/migrations/0029_b.py', {
      autoUpdatePrs: false,
    });
    openPr(service, optedOut.project, optedOut.headSha);
    await autoUpdateDriftedPrs(optedOut.project, 'main', { stmts, nativePr: { updateBranch } });
    expect(updateBranch).not.toHaveBeenCalled();
  });
});
