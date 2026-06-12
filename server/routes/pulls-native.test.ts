/**
 * POST /api/projects/:projectId/pulls — the agent-facing native PR create
 * endpoint (hosted projects). Live app + real git bare repos.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';

let request: supertest.Agent;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;

beforeAll(async () => {
  request = await getRequest();
  ({ gitHostRepoPath } = await import('../git-host/repo-store.js'));
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

async function hostedProjectWithBranch(): Promise<{ id: string; branch: string; work: string }> {
  const id = `pulls-native-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  await request
    .post(`/api/projects/${id}/git-host/enable`)
    .send({ importFrom: 'empty' })
    .expect(202);
  await vi.waitFor(
    async () => {
      const res = await request.get(`/api/projects/${id}/git-host`).expect(200);
      expect(res.body.importState?.status).toBe('ready');
    },
    { timeout: 10_000 },
  );

  const bare = gitHostRepoPath(id);
  const work = path.join(os.tmpdir(), `pulls-native-work-${uuidv4().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email "t@example.com"');
  git(work, 'config user.name "T"');
  writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add a.txt');
  git(work, 'commit -m base');
  git(work, `remote add origin "${bare}"`);
  git(work, 'push -u origin main');
  const branch = 'agent-hub/dev/session-cafe0001';
  git(work, `checkout -b ${branch}`);
  writeFileSync(path.join(work, 'b.txt'), 'b\n');
  git(work, 'add b.txt');
  git(work, 'commit -m "add b"');
  git(work, `push -u origin ${branch}`);
  return { id, branch, work };
}

describe('POST /api/projects/:projectId/pulls', () => {
  it('creates a native PR for a pushed branch and is idempotent on reuse', async () => {
    const { id, branch } = await hostedProjectWithBranch();

    const created = await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Add b', body: '## Summary\nadds b' })
      .expect(201);
    expect(created.body).toMatchObject({
      prUrl: `/projects/${id}/pulls/1`,
      number: 1,
      created: true,
    });

    const reused = await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Add b (updated)' })
      .expect(201);
    expect(reused.body).toMatchObject({ number: 1, created: false });

    // Shows up on the (native-branched) pulls list.
    const list = await request.get(`/api/projects/${id}/pulls`).expect(200);
    expect(list.body.pulls[0]).toMatchObject({
      number: 1,
      title: 'Add b (updated)',
      base: 'main',
      head: branch,
    });
  });

  it('rejects unknown branches, bad input, and non-hosted projects', async () => {
    const { id } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: 'never-pushed', title: 'x' })
      .expect(404);
    await request.post(`/api/projects/${id}/pulls`).send({ title: 'no head' }).expect(400);
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: 'b', title: '' })
      .expect(400);

    const plainId = `pulls-native-plain-${uuidv4().slice(0, 8)}`;
    await request
      .post('/api/projects')
      .send({ id: plainId, name: plainId, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    const res = await request
      .post(`/api/projects/${plainId}/pulls`)
      .send({ headBranch: 'main', title: 'x' })
      .expect(400);
    expect(res.body.error).toMatch(/not hosted on Agent Hub/);
  });
});

describe('PATCH /api/projects/:projectId/pulls/:number', () => {
  it('edits title/body of an open PR; locks closed PRs', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Original', body: 'old body' })
      .expect(201);

    const edited = await request
      .patch(`/api/projects/${id}/pulls/1`)
      .send({ title: 'Edited title', body: 'new body' })
      .expect(200);
    expect(edited.body.pr).toMatchObject({ title: 'Edited title', body: 'new body' });

    // Validation: nothing to change / empty title.
    await request.patch(`/api/projects/${id}/pulls/1`).send({}).expect(400);
    await request.patch(`/api/projects/${id}/pulls/1`).send({ title: '   ' }).expect(400);
    await request.patch(`/api/projects/${id}/pulls/99`).send({ title: 'x' }).expect(404);

    // Close it, then edits are locked.
    await request
      .post('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await request.patch(`/api/projects/${id}/pulls/1`).send({ title: 'nope' }).expect(409);
  });
});

describe('native PR review lifecycle', () => {
  it('close → reopen round-trips; merged PRs cannot reopen', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Round trip' })
      .expect(201);

    // Reopen while open → 409.
    await request.post(`/api/projects/${id}/pulls/1/reopen`).expect(409);

    await request
      .post('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    const reopened = await request.post(`/api/projects/${id}/pulls/1/reopen`).expect(200);
    expect(reopened.body.pr).toMatchObject({ status: 'open', closed_at: null });

    // Merge it, then reopen is permanently refused.
    await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    const refused = await request.post(`/api/projects/${id}/pulls/1/reopen`).expect(409);
    expect(refused.body.error).toMatch(/merged/);
  });

  it('request-review flags the PR; a verdict clears it; reviews render in detail', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Needs review' })
      .expect(201);

    const flagged = await request
      .post(`/api/projects/${id}/pulls/1/request-review`)
      .send({})
      .expect(200);
    expect(flagged.body.pr.review_requested_at).toBeTruthy();

    // List rows surface REVIEW_REQUIRED while flagged.
    const list = await request.get(`/api/projects/${id}/pulls`).expect(200);
    expect(list.body.pulls[0]).toMatchObject({
      review_requested: true,
      review_decision: 'REVIEW_REQUIRED',
    });

    // Comment reviews need a body and do NOT clear the flag.
    await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'commented', body: '' })
      .expect(400);
    await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'commented', body: 'looking…' })
      .expect(201);
    let detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_requested).toBe(true);

    // A changes-requested verdict clears the flag and drives the decision.
    const review = await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'Please rename the helper.' })
      .expect(201);
    expect(review.body.review).toMatchObject({ state: 'CHANGES_REQUESTED' });

    detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_requested).toBe(false);
    expect(detail.body.pr.review_decision).toBe('CHANGES_REQUESTED');
    expect(detail.body.reviews).toHaveLength(2);
    expect(detail.body.reviews[1]).toMatchObject({
      state: 'CHANGES_REQUESTED',
      body: 'Please rename the helper.',
    });

    // Approval supersedes for the same reviewer.
    await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'LGTM now' })
      .expect(201);
    detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_decision).toBe('APPROVED');
  });

  it('inline comments: add, render in detail + autofix context, validate, delete', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Commented' })
      .expect(201);

    // Validation.
    await request
      .post(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: '', line: 1, body: 'x' })
      .expect(400);
    await request
      .post(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 0, body: 'x' })
      .expect(400);
    await request
      .post(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, body: '  ' })
      .expect(400);

    const created = await request
      .post(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, side: 'new', body: 'rename this' })
      .expect(201);
    expect(created.body.comment).toMatchObject({
      file_path: 'b.txt',
      line: 1,
      side: 'new',
      body: 'rename this',
    });

    const detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.inline_comments).toHaveLength(1);
    expect(detail.body.inline_comments[0]).toMatchObject({ file_path: 'b.txt', line: 1 });
    // Folded into the issue-comment shape (timeline + autofix context).
    expect(detail.body.comments[0].body).toContain('`b.txt:1` — rename this');

    // Delete round-trip.
    const commentId = created.body.comment.id as string;
    await request.delete(`/api/projects/${id}/pulls/1/comments/${commentId}`).expect(200);
    const after = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(after.body.inline_comments).toHaveLength(0);
    await request.delete(`/api/projects/${id}/pulls/1/comments/${commentId}`).expect(404);

    // Comments lock once the PR is closed.
    await request
      .post('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await request
      .post(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, body: 'too late' })
      .expect(409);
  });

  it('resolve (Autofix) spawns against native PR context', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Fix me', body: 'has issues' })
      .expect(201);
    await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'tighten the loop' })
      .expect(201);

    // No agent configured for the fresh project → expect the agent guard,
    // proving the native PR fetch path succeeded (404 unknown agent, not
    // 400 githubRepo-missing / 502 fetch failure).
    const res = await request.post(`/api/projects/${id}/pulls/1/resolve`).send({ agentId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown agent/);
  });
});

describe('PR validation passthrough surface', () => {
  it('detail shows finalize_validated + check rows when Finalize validated the head sha', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Validated work' })
      .expect(201);

    // Before any validation: flag off, no checks.
    let detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.finalize_validated).toBe(false);
    expect(detail.body.checks).toEqual([]);

    // Seed a fully-validated finalize run (mode full → ready_to_push) for
    // the live head sha, with one passed job.
    const { stmts } = await import('../db.js');
    const bare = gitHostRepoPath(id);
    const headSha = execSync(`git -C "${bare}" rev-parse refs/heads/${branch}`, { stdio: 'pipe' })
      .toString()
      .trim();
    const runId = `fin-${uuidv4().slice(0, 8)}`;
    stmts!.insertFinalizeRun.run(
      runId,
      'card-x',
      null,
      id,
      branch,
      headSha,
      `test|${runId}`,
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
      null,
    );
    stmts!.markFinalizeRunReadyToPush.run(headSha, runId);
    stmts!.upsertFinalizeRunJob.run(runId, 'unit', '', 'passed', 0, Date.now(), Date.now());

    detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.finalize_validated).toBe(true);
    expect(detail.body.checks).toHaveLength(1);
    expect(detail.body.checks[0]).toMatchObject({
      name: 'finalize/unit',
      status: 'completed',
      conclusion: 'success',
    });
  });
});

describe('branch protection', () => {
  it('gates merges on review + checks; Finalize validation passes both', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();
    // Give the head commit a ci.yaml so requiredChecks is NOT vacuous.
    mkdirSync(path.join(work, '.agent-hub'), { recursive: true });
    writeFileSync(
      path.join(work, '.agent-hub', 'ci.yaml'),
      'version: 2\non: [push]\njobs:\n  unit:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n',
    );
    git(work, 'add -A');
    git(work, 'commit -m "add ci"');
    git(work, `push origin ${branch}`);

    await request
      .patch(`/api/projects/${id}`)
      .send({ branchProtection: { requiredChecks: true, requiredReview: true } })
      .expect(200);
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Protected' })
      .expect(201);

    // Blocked: no review yet.
    let res = await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(409);
    expect(res.body.error).toMatch(/approving review/);

    // Detail mirrors the same reason for the Merge button.
    const detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.merge_blocked_reason).toMatch(/approving review/);

    // Approve — now blocked on checks (ci.yaml exists, no run yet).
    await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'lgtm' })
      .expect(201);
    res = await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(409);
    expect(res.body.error).toMatch(/Branch protection: checks /);

    // Seed a fully-validated finalize run for the live head — passthrough
    // satisfies the checks requirement and the merge proceeds.
    const { stmts } = await import('../db.js');
    const bare = gitHostRepoPath(id);
    const headSha = execSync(`git -C "${bare}" rev-parse refs/heads/${branch}`, { stdio: 'pipe' })
      .toString()
      .trim();
    const runId = `fin-${uuidv4().slice(0, 8)}`;
    stmts!.insertFinalizeRun.run(
      runId,
      'card-x',
      null,
      id,
      branch,
      headSha,
      `test|${runId}`,
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
      null,
    );
    stmts!.markFinalizeRunReadyToPush.run(headSha, runId);

    await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
  });

  it('changes-requested blocks merge even without other gates tripping', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .patch(`/api/projects/${id}`)
      .send({ branchProtection: { requiredReview: true } })
      .expect(200);
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Blocked by review' })
      .expect(201);
    await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'fix first' })
      .expect(201);
    const res = await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(409);
    expect(res.body.error).toMatch(/requested changes/);

    // Approval (same reviewer's later verdict) unblocks; no ci.yaml at the
    // head commit so requiredChecks would be vacuous anyway.
    await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'fixed' })
      .expect(201);
    await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
  });

  it('blockDirectPushes rejects pushes to the default branch but merges still land', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();
    await request
      .patch(`/api/projects/${id}`)
      .send({ branchProtection: { blockDirectPushes: true } })
      .expect(200);
    const bare = gitHostRepoPath(id);
    // The PATCH syncs the protected-branches file asynchronously.
    await vi.waitFor(() => {
      expect(existsSync(path.join(bare, 'agent-hub-protected-branches'))).toBe(true);
    });

    // Direct push to main bounces with the protection message.
    git(work, 'checkout main');
    writeFileSync(path.join(work, 'direct.txt'), 'nope\n');
    git(work, 'add direct.txt');
    git(work, 'commit -m direct');
    let pushErr = '';
    try {
      execSync('git push origin main', { cwd: work, stdio: 'pipe' });
    } catch (err) {
      pushErr = String((err as { stderr?: Buffer }).stderr ?? err);
    }
    expect(pushErr).toMatch(/protected — direct pushes are blocked/);

    // Feature branches still push fine.
    git(work, `checkout ${branch}`);
    writeFileSync(path.join(work, 'feature.txt'), 'ok\n');
    git(work, 'add feature.txt');
    git(work, 'commit -m feature');
    execSync(`git push origin ${branch}`, { cwd: work, stdio: 'pipe' });

    // And a PR merge still moves main (update-ref bypasses receive hooks).
    const before = git(bare, 'rev-parse refs/heads/main');
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Via PR' })
      .expect(201);
    await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    expect(git(bare, 'rev-parse refs/heads/main')).not.toBe(before);
  });
});

describe('recent pushes (Compare & PR banner)', () => {
  it('lists pushed branches, excluding the default branch and branches with open PRs', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    const { recordRecentPush, __clearRecentPushes } = await import('../git-host/recent-pushes.js');
    __clearRecentPushes();
    // Simulate what the notify endpoint records on push.
    recordRecentPush(id, [`refs/heads/${branch}`, 'refs/heads/main', 'refs/tags/v1']);

    let res = await request.get(`/api/projects/${id}/git-host/recent-pushes`).expect(200);
    expect(res.body.pushes).toHaveLength(1); // main (default) + tag excluded
    expect(res.body.pushes[0]).toMatchObject({ branch });
    expect(typeof res.body.pushes[0].pushedAt).toBe('number');

    // Opening a PR for the branch removes it from the banner list.
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'From banner' })
      .expect(201);
    res = await request.get(`/api/projects/${id}/git-host/recent-pushes`).expect(200);
    expect(res.body.pushes).toEqual([]);

    // Non-hosted project → 404.
    const plainId = `pulls-rp-plain-${uuidv4().slice(0, 8)}`;
    await request
      .post('/api/projects')
      .send({ id: plainId, name: plainId, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    await request.get(`/api/projects/${plainId}/git-host/recent-pushes`).expect(404);
  });
});

describe('setup-failure surfacing on PR checks', () => {
  it('a run that failed before producing jobs shows a synthetic failed check', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Broken CI' })
      .expect(201);

    const { stmts } = await import('../db.js');
    const bare = gitHostRepoPath(id);
    const headSha = execSync(`git -C "${bare}" rev-parse refs/heads/${branch}`, { stdio: 'pipe' })
      .toString()
      .trim();
    const runId = `ci-${uuidv4().slice(0, 8)}`;
    stmts!.insertFinalizeRun.run(
      runId,
      'ci-push',
      null,
      id,
      branch,
      headSha,
      `test|${runId}`,
      'queued',
      null,
      'pr_push',
      null,
      'system',
      'CI',
      'ci@x',
      null,
      Date.now(),
      'checks',
      null,
    );
    stmts!.failFinalizeRun.run('failed', 'ci_config_invalid', runId);

    const detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks).toHaveLength(1);
    expect(detail.body.checks[0]).toMatchObject({
      name: 'ci/setup (ci_config_invalid)',
      status: 'completed',
      conclusion: 'failure',
    });
  });
});

describe('CI empty-state explanation (checks_note)', () => {
  it('explains missing config, v1 config, and v2-not-started', async () => {
    // hostedProjectWithBranch seeds no ci.yaml → "No CI is configured".
    const { id, branch, work } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Explain me' })
      .expect(201);
    let detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks_note).toMatch(/No CI is configured/);

    // v1 config → finalize-only migration hint.
    mkdirSync(path.join(work, '.agent-hub'), { recursive: true });
    writeFileSync(
      path.join(work, '.agent-hub', 'ci.yaml'),
      'version: 1\non: [finalize]\ntimeout_minutes: 10\nsteps:\n  - name: t\n    run: echo ok\n',
    );
    git(work, 'add -A');
    git(work, 'commit -m "v1 ci"');
    git(work, `push origin ${branch}`);
    detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks_note).toMatch(/version 1 \(Finalize-only\)/);

    // v2 config with no run yet → "not started" (PR CI is disabled in
    // tests via AGENT_HUB_DISABLE_PUSH_CI, so no run row appears).
    writeFileSync(
      path.join(work, '.agent-hub', 'ci.yaml'),
      'version: 2\non: [push]\ntimeout_minutes: 10\njobs:\n  unit:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n',
    );
    git(work, 'add -A');
    git(work, 'commit -m "v2 ci"');
    git(work, `push origin ${branch}`);
    detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks_note).toMatch(/not started yet/);
  });
});

describe('POST ci-runs/:runId/rerun guards', () => {
  it('400s finalize runs, 409s in-progress, 202s terminal CI runs', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    const { stmts } = await import('../db.js');

    const mkRun = (runId: string, trigger: string, status: string) => {
      stmts!.insertFinalizeRun.run(
        runId,
        'card',
        null,
        id,
        branch,
        'a'.repeat(40),
        `t|${runId}`,
        'queued',
        null,
        trigger,
        null,
        'u',
        'U',
        'u@x',
        null,
        Date.now(),
        'checks',
        null,
      );
      if (status !== 'queued') stmts!.failFinalizeRun.run(status, null, runId);
    };

    mkRun('rr-fin', 'ui_button', 'pushed');
    const fin = await request.post(`/api/projects/${id}/ci-runs/rr-fin/rerun`).send({});
    expect(fin.status).toBe(400);

    mkRun('rr-live', 'pr_push', 'queued');
    const live = await request.post(`/api/projects/${id}/ci-runs/rr-live/rerun`).send({});
    expect(live.status).toBe(409);

    mkRun('rr-done', 'pr_push', 'failed');
    const done = await request.post(`/api/projects/${id}/ci-runs/rr-done/rerun`).send({});
    expect(done.status).toBe(202);
    expect(done.body).toEqual({ ok: true });

    await request.post(`/api/projects/${id}/ci-runs/missing/rerun`).send({}).expect(404);
  });
});

describe('checks merge across runs (per-job re-run keeps all checks visible)', () => {
  it('shows every job with its newest verdict across multiple runs', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Merged checks' })
      .expect(201);

    const { stmts } = await import('../db.js');
    const bare = gitHostRepoPath(id);
    const headSha = execSync(`git -C "${bare}" rev-parse refs/heads/${branch}`, { stdio: 'pipe' })
      .toString()
      .trim();

    // Run 1 (older): backend passed, frontend FAILED.
    stmts!.insertFinalizeRun.run(
      'mc-run1',
      'ci-push',
      null,
      id,
      branch,
      headSha,
      'mc|1',
      'queued',
      null,
      'pr_push',
      null,
      'system',
      'CI',
      'ci@x',
      null,
      Date.now() - 60_000,
      'checks',
      null,
    );
    stmts!.failFinalizeRun.run('failed', 'checks_failed', 'mc-run1');
    stmts!.upsertFinalizeRunJob.run('mc-run1', 'backend-tests', '', 'passed', 0, 1, 2);
    stmts!.upsertFinalizeRunJob.run('mc-run1', 'frontend-tests', '', 'failed', 1, 1, 2);

    // Run 2 (newer, per-job re-run): ONLY frontend, now passed.
    stmts!.insertFinalizeRun.run(
      'mc-run2',
      'ci-push',
      null,
      id,
      branch,
      headSha,
      'mc|2',
      'queued',
      null,
      'pr_push',
      null,
      'system',
      'CI',
      'ci@x',
      null,
      Date.now(),
      'checks',
      null,
    );
    stmts!.failFinalizeRun.run('succeeded', null, 'mc-run2');
    stmts!.upsertFinalizeRunJob.run('mc-run2', 'frontend-tests', '', 'passed', 0, 3, 4);

    const detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    const byName = Object.fromEntries(
      (detail.body.checks as Array<{ name: string }>).map((c) => [c.name, c]),
    );
    // BOTH jobs visible; frontend's verdict comes from the newer run.
    expect(Object.keys(byName).sort()).toEqual(['ci/backend-tests', 'ci/frontend-tests']);
    expect(byName['ci/backend-tests']).toMatchObject({ conclusion: 'success', run_id: 'mc-run1' });
    expect(byName['ci/frontend-tests']).toMatchObject({ conclusion: 'success', run_id: 'mc-run2' });
  });
});

describe('POST pulls/generate-description (AI assist)', () => {
  it('feeds diff + commits to the generator and parses TITLE/BODY', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    const { __setPrTextGeneratorForTests } = await import('./pulls-native.js');
    let seenPrompt = '';
    __setPrTextGeneratorForTests(async (prompt) => {
      seenPrompt = prompt;
      return 'TITLE: Add b file support\nBODY:\n## Summary\n- adds b.txt\n\n## Test plan\n- CI';
    });
    try {
      const res = await request
        .post(`/api/projects/${id}/pulls/generate-description`)
        .send({ headBranch: branch })
        .expect(200);
      expect(res.body).toEqual({
        title: 'Add b file support',
        body: '## Summary\n- adds b.txt\n\n## Test plan\n- CI',
      });
      // The prompt carried the real diff + commit subject.
      expect(seenPrompt).toContain('add b');
      expect(seenPrompt).toContain('b.txt');

      // Generator failure → 502, never a hang.
      __setPrTextGeneratorForTests(async () => {
        throw new Error('model exploded');
      });
      const fail = await request
        .post(`/api/projects/${id}/pulls/generate-description`)
        .send({ headBranch: branch })
        .expect(502);
      expect(fail.body.error).toMatch(/model exploded/);

      await request
        .post(`/api/projects/${id}/pulls/generate-description`)
        .send({ headBranch: 'missing-branch' })
        .expect(404);
    } finally {
      __setPrTextGeneratorForTests(null);
    }
  });
});

describe('POST git-host/default-branch', () => {
  it('moves HEAD to an existing branch; validates names', async () => {
    const { id, branch } = await hostedProjectWithBranch();

    const ok = await request
      .post(`/api/projects/${id}/git-host/default-branch`)
      .send({ branch })
      .expect(200);
    expect(ok.body.defaultBranch).toBe(branch);
    const bare = gitHostRepoPath(id);
    expect(
      execSync(`git -C "${bare}" symbolic-ref HEAD`, { stdio: 'pipe' }).toString().trim(),
    ).toBe(`refs/heads/${branch}`);

    await request
      .post(`/api/projects/${id}/git-host/default-branch`)
      .send({ branch: 'does-not-exist' })
      .expect(404);
    await request
      .post(`/api/projects/${id}/git-host/default-branch`)
      .send({ branch: '../evil' })
      .expect(400);
  });
});

describe('linked card + list CI status', () => {
  it('list rows and detail carry linked_card and check_rollup', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Card-linked' })
      .expect(201);

    const { stmts } = await import('../db.js');
    // Link a kanban card to the PR by its native URL.
    stmts!.createKanbanBoard.run('board-x', id, 'Board');
    stmts!.createKanbanColumn.run('col-x', 'board-x', 'In Progress', 0, null);
    stmts!.createKanbanCard.run(
      'card-lk1',
      'col-x',
      'board-x',
      'Ship the widget',
      '',
      'medium',
      null,
      '[]',
      null,
      null,
      'test',
      null,
      0,
    );
    stmts!.setCardPrUrl.run(`/projects/${id}/pulls/1`, 'card-lk1');

    // Seed a CI run with one passed job for the recorded head sha.
    const headSha = execSync(`git -C "${gitHostRepoPath(id)}" rev-parse refs/heads/${branch}`, {
      stdio: 'pipe',
    })
      .toString()
      .trim();
    stmts!.insertFinalizeRun.run(
      'lk-run',
      'ci-push',
      null,
      id,
      branch,
      headSha,
      'lk|1',
      'queued',
      null,
      'pr_push',
      null,
      'system',
      'CI',
      'ci@x',
      null,
      Date.now(),
      'checks',
      null,
    );
    stmts!.failFinalizeRun.run('succeeded', null, 'lk-run');
    stmts!.upsertFinalizeRunJob.run('lk-run', 'unit', '', 'passed', 0, 1, 2);

    const list = await request.get(`/api/projects/${id}/pulls`).expect(200);
    expect(list.body.pulls[0].linked_card).toMatchObject({
      id: 'card-lk1',
      title: 'Ship the widget',
    });
    expect(list.body.pulls[0].check_rollup).toHaveLength(1);
    expect(list.body.pulls[0].check_rollup[0]).toMatchObject({ conclusion: 'success' });

    const detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.linked_card).toMatchObject({ id: 'card-lk1' });
  });
});

describe('deleteBranchOnMerge setting + branch deletion', () => {
  it('keeps the head branch after merge when deleteBranchOnMerge=false', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request.patch(`/api/projects/${id}`).send({ deleteBranchOnMerge: false }).expect(200);
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Keep my branch' })
      .expect(201);
    await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    // Branch survives the merge.
    const bare = gitHostRepoPath(id);
    execSync(`git -C "${bare}" rev-parse --verify refs/heads/${branch}`, { stdio: 'pipe' });
  });

  it('default behavior deletes the head branch after merge', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Cleanup me' })
      .expect(201);
    await request
      .post('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    const bare = gitHostRepoPath(id);
    expect(() =>
      execSync(`git -C "${bare}" rev-parse --verify refs/heads/${branch}`, { stdio: 'pipe' }),
    ).toThrow();
  });

  it('DELETE branches/:branch removes a branch; refuses default + open-PR heads', async () => {
    const { id, branch } = await hostedProjectWithBranch();

    // Refuses the default branch.
    const def = await request.delete(`/api/projects/${id}/git-host/branches/main`).expect(409);
    expect(def.body.error).toMatch(/default branch/);

    // Refuses a branch backing an open PR.
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Open PR' })
      .expect(201);
    const inUse = await request
      .delete(`/api/projects/${id}/git-host/branches/${encodeURIComponent(branch)}`)
      .expect(409);
    expect(inUse.body.error).toMatch(/open PR #1/);

    // Close the PR — now deletion succeeds.
    await request
      .post('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await request
      .delete(`/api/projects/${id}/git-host/branches/${encodeURIComponent(branch)}`)
      .expect(200);
    const bare = gitHostRepoPath(id);
    expect(() =>
      execSync(`git -C "${bare}" rev-parse --verify refs/heads/${branch}`, { stdio: 'pipe' }),
    ).toThrow();

    await request.delete(`/api/projects/${id}/git-host/branches/never-existed`).expect(404);
  });
});

describe('review reviewer-name override', () => {
  it('attributes the review to the supplied reviewer name (agent reviews)', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await request
      .post(`/api/projects/${id}/pulls`)
      .send({ headBranch: branch, title: 'Agent-reviewed' })
      .expect(201);
    const res = await request
      .post(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'tighten', reviewer: 'Demo Reviewer' })
      .expect(201);
    expect(res.body.review.user).toBe('Demo Reviewer');
    const detail = await request.get(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.reviews[0].user).toBe('Demo Reviewer');
    expect(detail.body.pr.review_decision).toBe('CHANGES_REQUESTED');
  });
});
