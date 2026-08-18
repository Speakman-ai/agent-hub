/**
 * POST /api/projects/:projectId/pulls — the agent-facing native PR create
 * endpoint (hosted projects). Live app + real git bare repos.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { saveAuthRecord, generateJwtSecret, reloadAuthRecord } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { setSessionOwner } from '../session-ownership.js';
import config from '../config.js';
import * as autoReview from '../native-pr/auto-review.js';

let request: supertest.Agent;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;
let pullsTestUser: { id: string; token: string };
let pullsAuthPath = '';
/** auth.json contents before this suite overwrote them (null = no file). */
let priorAuthJson: string | null = null;

function authHeader() {
  return { Authorization: `Bearer ${pullsTestUser.token}` };
}

function authedGet(url: string) {
  return request.get(url).set(authHeader());
}
function authedPost(url: string) {
  return request.post(url).set(authHeader());
}
function authedPatch(url: string) {
  return request.patch(url).set(authHeader());
}
function authedDelete(url: string) {
  return request.delete(url).set(authHeader());
}

beforeAll(async () => {
  request = await getRequest();

  pullsAuthPath = path.join(config.dataDir, 'auth.json');
  // Snapshot any pre-existing auth record so teardown can restore it — this
  // suite enables auth process-wide, and the in-memory cache would otherwise
  // bleed into later unauthenticated route tests in the same worker.
  priorAuthJson = existsSync(pullsAuthPath) ? readFileSync(pullsAuthPath, 'utf-8') : null;
  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'pulls-native-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });
  reloadAuthRecord();
  const row = createUser({
    username: `pulls-native-user-${Date.now()}`,
    passwordHash: 'h',
  });
  createMembership(row.id, getActiveOrgId(), 'Admin');
  pullsTestUser = {
    id: row.id,
    token: signJwt(row.username, jwtSecret, {
      expiresInSec: 3600,
      claims: { role: 'Owner', uid: row.id },
    }),
  };
  ({ gitHostRepoPath } = await import('../git-host/repo-store.js'));
});

afterAll(() => {
  // Restore the prior auth.json (or remove the one this suite created) AND
  // drop the in-memory cache, so later tests in this worker re-read the
  // restored/absent record instead of inheriting this suite's auth-enabled
  // state.
  if (priorAuthJson !== null) {
    writeFileSync(pullsAuthPath, priorAuthJson, { mode: 0o600 });
  } else if (pullsAuthPath && existsSync(pullsAuthPath)) {
    unlinkSync(pullsAuthPath);
  }
  reloadAuthRecord();
});

function postPulls(projectId: string) {
  return authedPost(`/api/projects/${projectId}/pulls`);
}

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

async function hostedProjectWithBranch(): Promise<{ id: string; branch: string; work: string }> {
  const id = `pulls-native-${uuidv4().slice(0, 8)}`;
  await authedPost('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  await authedPost(`/api/projects/${id}/git-host/enable`).send({ importFrom: 'empty' }).expect(202);
  await vi.waitFor(
    async () => {
      const res = await authedGet(`/api/projects/${id}/git-host`).expect(200);
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

    const created = await postPulls(id)
      .send({ headBranch: branch, title: 'Add b', body: '## Summary\nadds b' })
      .expect(201);
    expect(created.body).toMatchObject({
      prUrl: `/projects/${id}/pulls/1`,
      number: 1,
      created: true,
    });

    const reused = await postPulls(id)
      .send({ headBranch: branch, title: 'Add b (updated)' })
      .expect(201);
    expect(reused.body).toMatchObject({ number: 1, created: false });

    // Shows up on the (native-branched) pulls list.
    const list = await authedGet(`/api/projects/${id}/pulls`).expect(200);
    expect(list.body.pulls[0]).toMatchObject({
      number: 1,
      title: 'Add b (updated)',
      base: 'main',
      head: branch,
    });
  });

  it('attributes the author via session owner for the global break-glass apiKey path', async () => {
    // Agents call POST /pulls through ah-api.sh, which authenticates with the
    // global break-glass apiKey (Owner role, no per-user `authUserId`). The PR
    // author must still resolve — from the acting session's owner, sent via the
    // X-Agent-Hub-Session-Id header. Regression guard for the hardening that
    // briefly 401'd this documented flow.
    const { id, branch } = await hostedProjectWithBranch();
    const { getDb } = await import('../db.js');
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    getDb()
      .prepare(
        'INSERT INTO sessions (id, agent_id, name, engine, model, use_worktree, ask_mode, wiki_hybrid_rag_budget_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sessionId, 'dev', 'PR attribution session', 'claude', 'sonnet', 0, 0, 0);
    setSessionOwner(sessionId, pullsTestUser.id);

    const priorApiKey = config.apiKey;
    config.apiKey = 'break-glass-test-key';
    try {
      // Break-glass apiKey + session header → author resolves to the owner.
      await request
        .post(`/api/projects/${id}/pulls`)
        .set('x-api-key', 'break-glass-test-key')
        .set('X-Agent-Hub-Session-Id', sessionId)
        .send({ headBranch: branch, title: 'Break-glass PR' })
        .expect(201);

      // Without any attribution signal, the same auth-enabled deployment still
      // refuses (no user to credit).
      const blocked = await request
        .post(`/api/projects/${id}/pulls`)
        .set('x-api-key', 'break-glass-test-key')
        .send({ headBranch: branch, title: 'No attribution PR' })
        .expect(401);
      expect(blocked.body.error).toMatch(/authentication required/i);
    } finally {
      config.apiKey = priorApiKey;
    }
  });

  it('rejects unknown branches, bad input, and non-hosted projects', async () => {
    const { id } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: 'never-pushed', title: 'x' }).expect(404);
    await postPulls(id).send({ title: 'no head' }).expect(400);
    await postPulls(id).send({ headBranch: 'b', title: '' }).expect(400);

    const plainId = `pulls-native-plain-${uuidv4().slice(0, 8)}`;
    await authedPost('/api/projects')
      .send({ id: plainId, name: plainId, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    const res = await postPulls(plainId).send({ headBranch: 'main', title: 'x' }).expect(400);
    expect(res.body.error).toMatch(/not hosted on Agent Hub/);
  });
});

describe('PATCH /api/projects/:projectId/pulls/:number', () => {
  it('edits title/body of an open PR; locks closed PRs', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id)
      .send({ headBranch: branch, title: 'Original', body: 'old body' })
      .expect(201);

    const edited = await authedPatch(`/api/projects/${id}/pulls/1`)
      .send({ title: 'Edited title', body: 'new body' })
      .expect(200);
    expect(edited.body.pr).toMatchObject({ title: 'Edited title', body: 'new body' });

    // Validation: nothing to change / empty title.
    await authedPatch(`/api/projects/${id}/pulls/1`).send({}).expect(400);
    await authedPatch(`/api/projects/${id}/pulls/1`).send({ title: '   ' }).expect(400);
    await authedPatch(`/api/projects/${id}/pulls/99`).send({ title: 'x' }).expect(404);

    // Close it, then edits are locked.
    await authedPost('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await authedPatch(`/api/projects/${id}/pulls/1`).send({ title: 'nope' }).expect(409);
  });
});

describe('POST /api/projects/:projectId/pulls/:number/auto-merge', () => {
  it('arms auto-merge; a green/mergeable PR (no protection) merges immediately', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Auto' }).expect(201);

    // No branch protection → the PR is already mergeable, so arming merges now.
    const armed = await authedPost(`/api/projects/${id}/pulls/1/auto-merge`)
      .send({ enabled: true })
      .expect(200);
    expect(armed.body.merged).toBe(true);
    expect(armed.body.pr).toMatchObject({ status: 'merged' });
  });

  it('persists the flag when the PR is not yet mergeable; disarm clears it', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    // Require an approving review so arming cannot merge immediately.
    await authedPatch(`/api/projects/${id}`)
      .send({ branchProtection: { requiredReview: true } })
      .expect(200);
    await postPulls(id).send({ headBranch: branch, title: 'Deferred' }).expect(201);

    // Action routes return the raw PR row (auto_merge as the stored 0/1),
    // matching the reopen/revert siblings.
    const armed = await authedPost(`/api/projects/${id}/pulls/1/auto-merge`)
      .send({ enabled: true })
      .expect(200);
    expect(armed.body.merged).toBe(false);
    expect(armed.body.pr).toMatchObject({ status: 'open', auto_merge: 1 });

    // The summarized detail payload (what the PR page reads) exposes a boolean.
    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.auto_merge).toBe(true);

    // Disarm.
    const disarmed = await authedPost(`/api/projects/${id}/pulls/1/auto-merge`)
      .send({ enabled: false })
      .expect(200);
    expect(disarmed.body).toMatchObject({ merged: false, pr: { auto_merge: 0 } });
    const detailOff = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detailOff.body.pr.auto_merge).toBe(false);
  });

  it('validates the body and unknown PRs', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Validate' }).expect(201);
    await authedPost(`/api/projects/${id}/pulls/1/auto-merge`).send({}).expect(400);
    await authedPost(`/api/projects/${id}/pulls/1/auto-merge`).send({ enabled: 'yes' }).expect(400);
    await authedPost(`/api/projects/${id}/pulls/99/auto-merge`).send({ enabled: true }).expect(404);
  });

  it('a push-option intent consumed on PR create fires the immediate merge (green head)', async () => {
    // Regression for the `git push -o automerge` race: CI can finish green
    // BEFORE the PR is opened, so the checks-passed hook has already run and
    // will not fire again. Creating the PR consumes the intent (arms it) AND
    // must trigger the merge itself — otherwise it stays armed forever.
    const { id, branch } = await hostedProjectWithBranch();
    const { stmts } = await import('../db.js');
    stmts!.upsertPrAutoMergeIntent.run(id, branch, null, Date.now());

    await postPulls(id).send({ headBranch: branch, title: 'Intent merge' }).expect(201);

    // The create path fires the merge asynchronously (fire-and-forget) — no
    // branch protection, so the PR is immediately mergeable and lands.
    await vi.waitFor(
      async () => {
        const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
        expect(detail.body.pr.merged).toBe(true);
      },
      { timeout: 10_000 },
    );
    // The intent is consumed (one-shot), not left dangling.
    expect(stmts!.getPrAutoMergeIntent.get(id, branch)).toBeUndefined();
  });
});

describe('native PR review lifecycle', () => {
  it('close → reopen round-trips; merged PRs cannot reopen', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Round trip' }).expect(201);

    // Reopen while open → 409.
    await authedPost(`/api/projects/${id}/pulls/1/reopen`).expect(409);

    await authedPost('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    const reopened = await authedPost(`/api/projects/${id}/pulls/1/reopen`).expect(200);
    expect(reopened.body.pr).toMatchObject({ status: 'open', closed_at: null });

    // Merge it, then reopen is permanently refused.
    await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    const refused = await authedPost(`/api/projects/${id}/pulls/1/reopen`).expect(409);
    expect(refused.body.error).toMatch(/merged/);
  });

  it('revert: merged → revert commit on base, recorded on the PR, refused twice', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    const bare = gitHostRepoPath(id);
    await postPulls(id).send({ headBranch: branch, title: 'Adds b' }).expect(201);

    // Not merged yet → refused.
    await authedPost(`/api/projects/${id}/pulls/1/revert`).expect(409);

    await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    expect(git(bare, 'ls-tree --name-only refs/heads/main').split('\n')).toContain('b.txt');

    const res = await authedPost(`/api/projects/${id}/pulls/1/revert`).expect(200);
    expect(res.body.revertSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.body.pr).toMatchObject({ status: 'merged', revert_sha: res.body.revertSha });
    // The merged file is gone from the base branch, on a new commit.
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(res.body.revertSha);
    expect(git(bare, 'ls-tree --name-only refs/heads/main').split('\n')).not.toContain('b.txt');

    // Detail surfaces the reverted state for the PR page badge.
    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr).toMatchObject({ reverted: true, revert_sha: res.body.revertSha });

    const again = await authedPost(`/api/projects/${id}/pulls/1/revert`).expect(409);
    expect(again.body.error).toMatch(/already reverted/i);
  });

  it('request-review flags the PR; a verdict clears it; reviews render in detail', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Needs review' }).expect(201);

    const flagged = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
      .send({})
      .expect(200);
    expect(flagged.body.pr.review_requested_at).toBeTruthy();

    // List rows surface REVIEW_REQUIRED while flagged.
    const list = await authedGet(`/api/projects/${id}/pulls`).expect(200);
    expect(list.body.pulls[0]).toMatchObject({
      review_requested: true,
      review_decision: 'REVIEW_REQUIRED',
    });

    // Comment reviews need a body and do NOT clear the flag.
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'commented', body: '' })
      .expect(400);
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'commented', body: 'looking…' })
      .expect(201);
    let detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_requested).toBe(true);

    // A changes-requested verdict clears the flag and drives the decision.
    const review = await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'Please rename the helper.' })
      .expect(201);
    expect(review.body.review).toMatchObject({ state: 'CHANGES_REQUESTED' });

    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_requested).toBe(false);
    expect(detail.body.pr.review_decision).toBe('CHANGES_REQUESTED');
    expect(detail.body.reviews).toHaveLength(2);
    expect(detail.body.reviews[1]).toMatchObject({
      state: 'CHANGES_REQUESTED',
      body: 'Please rename the helper.',
    });

    // Approval supersedes for the same reviewer.
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'LGTM now' })
      .expect(201);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_decision).toBe('APPROVED');
  });

  it('dismiss review: drops the verdict from the decision, is validated, and is one-way', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Dismissable' }).expect(201);

    // A changes-requested verdict drives the decision.
    const review = await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'please fix' })
      .expect(201);
    const reviewId = review.body.review.id as string;
    let detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_decision).toBe('CHANGES_REQUESTED');

    const dismissUrl = `/api/projects/${id}/pulls/1/reviews/${reviewId}/dismiss`;

    // A reason is required.
    await authedPost(dismissUrl).send({}).expect(400);
    await authedPost(dismissUrl).send({ reason: '   ' }).expect(400);
    // Unknown review → 404.
    await authedPost(`/api/projects/${id}/pulls/1/reviews/nope/dismiss`)
      .send({ reason: 'x' })
      .expect(404);

    const dismissed = await authedPost(dismissUrl)
      .send({ reason: 'Stale — addressed in a later push' })
      .expect(200);
    expect(dismissed.body.review).toMatchObject({
      id: reviewId,
      dismissed: true,
      dismissal_reason: 'Stale — addressed in a later push',
    });
    expect(dismissed.body.review.dismissed_by).toBeTruthy();

    // The dismissed verdict no longer counts toward the decision, but the row
    // (and its dismissal metadata) still renders for history.
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.review_decision).toBeNull();
    expect(detail.body.reviews).toHaveLength(1);
    expect(detail.body.reviews[0]).toMatchObject({
      dismissed: true,
      dismissal_reason: 'Stale — addressed in a later push',
    });
    expect(detail.body.reviews[0].dismissed_at).toBeTruthy();

    // Dismiss is one-way: a second dismiss of the same review is refused.
    await authedPost(dismissUrl).send({ reason: 'again' }).expect(409);

    // A comment review has no verdict to dismiss.
    const commentReview = await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'commented', body: 'just noting' })
      .expect(201);
    await authedPost(`/api/projects/${id}/pulls/1/reviews/${commentReview.body.review.id}/dismiss`)
      .send({ reason: 'nope' })
      .expect(400);

    // Dismiss stays available on a closed PR (reviewers tidy up after the fact).
    const late = await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'lgtm' })
      .expect(201);
    await authedPost('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await authedPost(`/api/projects/${id}/pulls/1/reviews/${late.body.review.id}/dismiss`)
      .send({ reason: 'cleanup' })
      .expect(200);
  });

  it('request-review dispatches the Reviewer agent (manual_request); clearing the flag does not', async () => {
    // The dispatch itself is unit-tested in native-pr/auto-review.test.ts; here
    // we prove the ROUTE is wired to it. The dispatch helper is short-circuited
    // by the test-env AGENT_HUB_DISABLE_AUTO_REVIEW guard, so spy on it directly
    // rather than asserting a spawned session — this catches a regression in the
    // route→dispatch wiring regardless of the guard, and proves the route does
    // NOT pass the test-only `force` seam (production env leaves the guard unset).
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Needs review' }).expect(201);

    const spy = vi
      .spyOn(autoReview, 'maybeRunPrAutoReview')
      .mockResolvedValue({ dispatched: true, sessionId: 'sess-test' });
    try {
      // requested=true → dispatch fires with the manual_request trigger and the
      // PR identity, and crucially WITHOUT `force` (a production-faithful call).
      // The route reports the dispatch outcome back to the caller.
      const res = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({})
        .expect(200);
      expect(res.body.agent_review_dispatched).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0]!;
      const prArg = call[1] as { number: number; head_branch: string; status: string };
      const optsArg = call[3] as { trigger?: string; force?: boolean } | undefined;
      expect((call[0] as { id: string }).id).toBe(id);
      expect(prArg).toMatchObject({ number: 1, head_branch: branch, status: 'open' });
      expect(optsArg?.trigger).toBe('manual_request');
      expect(optsArg?.force).toBeUndefined();

      // Clearing the flag (requested=false) must NOT dispatch.
      await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ requested: false })
        .expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('request-review kind=human flags without dispatching; kind=agent dispatches without flagging', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Split review' }).expect(201);

    const spy = vi
      .spyOn(autoReview, 'maybeRunPrAutoReview')
      .mockResolvedValue({ dispatched: true, sessionId: 'sess-test' });
    try {
      // kind=human: flip the human-review flag, no agent dispatch.
      const human = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ kind: 'human' })
        .expect(200);
      expect(human.body.pr.review_requested_at).toBeTruthy();
      expect(human.body.agent_review_dispatched).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();

      // kind=agent: dispatch the Reviewer agent, leave the human flag untouched
      // (it is still set from the human request above, and not re-cleared).
      const agent = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ kind: 'agent' })
        .expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0]![3] as { trigger?: string }).trigger).toBe('manual_request');
      expect(agent.body.agent_review_dispatched).toBe(true);
      // The flag is unchanged by the agent request.
      expect(agent.body.pr.review_requested_at).toBeTruthy();

      // Clearing via kind=human does not dispatch.
      const cleared = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ requested: false, kind: 'human' })
        .expect(200);
      expect(cleared.body.pr.review_requested_at).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('agent_review_requested surfaces in list + detail; a replayed session id from an untrusted caller cannot clear it', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Agent flag' }).expect(201);

    // Seed an in-flight claim owned by a specific reviewer session id (what a
    // real dispatch records via the atomic claim).
    const { stmts } = await import('../db.js');
    const now = Date.now();
    const OWNER = 'reviewer-session-owner';
    stmts!.claimPullRequestAgentReview.run(now, OWNER, now, id, 1, now - 60_000);

    let detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.agent_review_requested).toBe(true);
    const list = await authedGet(`/api/projects/${id}/pulls`).expect(200);
    expect(list.body.pulls[0].agent_review_requested).toBe(true);

    // ATTACK: a normal JWT user replays the (broadcast) owning session id in the
    // header. Because they are neither the bound spawn session nor the global
    // break-glass key, the id is NOT honored and the claim is NOT cleared.
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .set('X-Agent-Hub-Session-Id', OWNER)
      .send({ state: 'changes_requested', body: 'replayed owner id', reviewer: 'Project Reviewer' })
      .expect(201);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.agent_review_requested).toBe(true);

    // Same for a body-supplied session id from the untrusted caller.
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'via body', session_id: OWNER })
      .expect(201);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.agent_review_requested).toBe(true);

    // TRUSTED: the global break-glass apiKey (server-injected into reviewer
    // spawns) carrying the owning session id DOES clear the claim.
    const priorApiKey = config.apiKey;
    config.apiKey = 'break-glass-test-key';
    try {
      // A trusted caller with the WRONG (stale) session still cannot clear the
      // newer claim — the release is session-scoped.
      await request
        .post(`/api/projects/${id}/pulls/1/reviews`)
        .set('x-api-key', 'break-glass-test-key')
        .set('X-Agent-Hub-Session-Id', 'stale-session')
        .send({ state: 'changes_requested', body: 'stale' })
        .expect(201);
      detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
      expect(detail.body.pr.agent_review_requested).toBe(true);

      // A comment from the owning session does not resolve the review.
      await request
        .post(`/api/projects/${id}/pulls/1/reviews`)
        .set('x-api-key', 'break-glass-test-key')
        .set('X-Agent-Hub-Session-Id', OWNER)
        .send({ state: 'commented', body: 'still looking' })
        .expect(201);
      detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
      expect(detail.body.pr.agent_review_requested).toBe(true);

      // The owning session's verdict clears it.
      await request
        .post(`/api/projects/${id}/pulls/1/reviews`)
        .set('x-api-key', 'break-glass-test-key')
        .set('X-Agent-Hub-Session-Id', OWNER)
        .send({ state: 'changes_requested', body: 'rename this' })
        .expect(201);
      detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
      expect(detail.body.pr.agent_review_requested).toBe(false);
    } finally {
      config.apiKey = priorApiKey;
    }
  });

  it('request-review rejects an unknown kind with 400 (no flag write, no dispatch)', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Bad kind' }).expect(201);

    const spy = vi
      .spyOn(autoReview, 'maybeRunPrAutoReview')
      .mockResolvedValue({ dispatched: true, sessionId: 'sess-test' });
    try {
      const bad = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ kind: 'humna' })
        .expect(400);
      expect(bad.body.error).toMatch(/kind must be/i);
      // Neither the human flag nor an agent dispatch happened.
      expect(spy).not.toHaveBeenCalled();
      const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
      expect(detail.body.pr.review_requested).toBe(false);
      expect(detail.body.pr.agent_review_requested).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('request-review reports agent_review_dispatched=false when no reviewer is dispatched', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'No reviewer' }).expect(201);

    const spy = vi
      .spyOn(autoReview, 'maybeRunPrAutoReview')
      .mockResolvedValue({ dispatched: false, reason: 'no_reviewer' });
    try {
      const res = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ kind: 'agent' })
        .expect(200);
      expect(res.body.agent_review_dispatched).toBe(false);
      expect(res.body.agent_review_reason).toBe('no_reviewer');
    } finally {
      spy.mockRestore();
    }
  });

  it('request-review surfaces already_in_flight when a review is already running', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Concurrent' }).expect(201);

    // The atomic claim inside the helper rejected a concurrent dispatch.
    const spy = vi
      .spyOn(autoReview, 'maybeRunPrAutoReview')
      .mockResolvedValue({ dispatched: false, reason: 'already_in_flight' });
    try {
      const res = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ kind: 'agent' })
        .expect(200);
      expect(res.body.agent_review_dispatched).toBe(false);
      expect(res.body.agent_review_reason).toBe('already_in_flight');
    } finally {
      spy.mockRestore();
    }
  });

  it('request-review requested=false clears the human flag even with kind=agent, and never dispatches', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Clear via agent' }).expect(201);

    const spy = vi
      .spyOn(autoReview, 'maybeRunPrAutoReview')
      .mockResolvedValue({ dispatched: true, sessionId: 'sess-test' });
    try {
      // Set the human flag first.
      const flagged = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ kind: 'human' })
        .expect(200);
      expect(flagged.body.pr.review_requested_at).toBeTruthy();

      // requested=false + kind=agent must still clear the flag (clearing is a
      // human-flag action) and must NOT dispatch the reviewer agent.
      const cleared = await authedPost(`/api/projects/${id}/pulls/1/request-review`)
        .send({ requested: false, kind: 'agent' })
        .expect(200);
      expect(cleared.body.pr.review_requested_at).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('inline comments: add, render in detail + autofix context, validate, delete', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Commented' }).expect(201);

    // Validation.
    await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: '', line: 1, body: 'x' })
      .expect(400);
    await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 0, body: 'x' })
      .expect(400);
    await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, body: '  ' })
      .expect(400);

    const created = await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, side: 'new', body: 'rename this' })
      .expect(201);
    expect(created.body.comment).toMatchObject({
      file_path: 'b.txt',
      line: 1,
      side: 'new',
      body: 'rename this',
    });

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.inline_comments).toHaveLength(1);
    expect(detail.body.inline_comments[0]).toMatchObject({ file_path: 'b.txt', line: 1 });
    // Folded into the issue-comment shape (timeline + autofix context).
    expect(detail.body.comments[0].body).toContain('`b.txt:1` — rename this');

    // Delete round-trip.
    const commentId = created.body.comment.id as string;
    await authedDelete(`/api/projects/${id}/pulls/1/comments/${commentId}`).expect(200);
    const after = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(after.body.inline_comments).toHaveLength(0);
    await authedDelete(`/api/projects/${id}/pulls/1/comments/${commentId}`).expect(404);

    // Comments lock once the PR is closed.
    await authedPost('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, body: 'too late' })
      .expect(409);
  });

  it('anchor validation rejects non-integer lines and unknown sides on both routes', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Strict anchors' }).expect(201);
    const commentsUrl = `/api/projects/${id}/pulls/1/comments`;
    const resolveUrl = `/api/projects/${id}/pulls/1/comment-threads/resolve`;

    // A truncating parse would have accepted these and written to line 1 —
    // a real, neighbouring thread the caller never named.
    for (const line of [1.5, '1.5', '1junk', 'abc', '', null, true]) {
      await authedPost(commentsUrl).send({ filePath: 'b.txt', line, body: 'x' }).expect(400);
      await authedPost(resolveUrl).send({ filePath: 'b.txt', line, resolved: true }).expect(400);
    }

    // An unrecognised side used to be coerced to 'new'. GitHub's review API
    // spells the sides LEFT/RIGHT, so this is the shape a client copying that
    // vocabulary would send.
    for (const side of ['LEFT', 'RIGHT', 'left', 'NEW', '', 42, null]) {
      await authedPost(commentsUrl)
        .send({ filePath: 'b.txt', line: 1, side, body: 'x' })
        .expect(400);
      await authedPost(resolveUrl)
        .send({ filePath: 'b.txt', line: 1, side, resolved: true })
        .expect(400);
    }

    // Integer-valued strings still work — agents post JSON by hand.
    await authedPost(commentsUrl)
      .send({ filePath: 'b.txt', line: '1', side: 'new', body: 'stringy line' })
      .expect(201);
    // Omitting side stays legal and still defaults to 'new'.
    await authedPost(resolveUrl).send({ filePath: 'b.txt', line: 1, resolved: true }).expect(200);
    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.inline_comments[0]).toMatchObject({ line: 1, side: 'new', resolved: true });
  });

  it('comment threads: resolve collapses the anchor, unresolve restores it', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Threaded' }).expect(201);
    const resolveUrl = `/api/projects/${id}/pulls/1/comment-threads/resolve`;

    // No comment at the anchor yet — nothing to resolve.
    await authedPost(resolveUrl)
      .send({ filePath: 'b.txt', line: 1, side: 'new', resolved: true })
      .expect(404);

    const first = await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, side: 'new', body: 'rename this' })
      .expect(201);

    // Validation.
    await authedPost(resolveUrl).send({ filePath: '', line: 1, resolved: true }).expect(400);
    await authedPost(resolveUrl).send({ filePath: 'b.txt', line: 0, resolved: true }).expect(400);
    await authedPost(resolveUrl).send({ filePath: 'b.txt', line: 1 }).expect(400);

    const resolved = await authedPost(resolveUrl)
      .send({ filePath: 'b.txt', line: 1, side: 'new', resolved: true })
      .expect(200);
    expect(resolved.body.thread).toMatchObject({
      file_path: 'b.txt',
      line: 1,
      side: 'new',
      resolved: true,
    });
    expect(resolved.body.thread.resolved_by).toBeTruthy();

    let detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.inline_comments[0]).toMatchObject({ resolved: true });
    expect(detail.body.inline_comments[0].resolved_at).toBeTruthy();

    // A later comment on the same anchor joins the resolved thread rather
    // than leaving it half-resolved.
    await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, side: 'new', body: 'still relevant?' })
      .expect(201);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.inline_comments).toHaveLength(2);
    expect(detail.body.inline_comments.every((c: { resolved: boolean }) => c.resolved)).toBe(true);

    // The other side of the same line is a different thread.
    await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, side: 'old', body: 'separate thread' })
      .expect(201);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(
      detail.body.inline_comments.find((c: { side: string }) => c.side === 'old'),
    ).toMatchObject({ resolved: false, resolved_by: null, resolved_at: null });

    // Unresolve round-trip.
    await authedPost(resolveUrl)
      .send({ filePath: 'b.txt', line: 1, side: 'new', resolved: false })
      .expect(200);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.inline_comments.every((c: { resolved: boolean }) => !c.resolved)).toBe(true);

    // Deleting the last comment at an anchor drops its resolution, so a new
    // comment on that line does not inherit a stale "resolved".
    await authedPost(resolveUrl)
      .send({ filePath: 'b.txt', line: 1, side: 'old', resolved: true })
      .expect(200);
    const oldSide = (
      await authedGet(`/api/projects/${id}/pulls/1`).expect(200)
    ).body.inline_comments.find((c: { side: string }) => c.side === 'old');
    await authedDelete(`/api/projects/${id}/pulls/1/comments/${oldSide.id}`).expect(200);
    await authedPost(`/api/projects/${id}/pulls/1/comments`)
      .send({ filePath: 'b.txt', line: 1, side: 'old', body: 'fresh thread' })
      .expect(201);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(
      detail.body.inline_comments.find((c: { side: string }) => c.side === 'old'),
    ).toMatchObject({ resolved: false });

    // Deleting a comment from a multi-comment thread leaves it resolved.
    await authedPost(resolveUrl)
      .send({ filePath: 'b.txt', line: 1, side: 'new', resolved: true })
      .expect(200);
    await authedDelete(
      `/api/projects/${id}/pulls/1/comments/${first.body.comment.id as string}`,
    ).expect(200);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(
      detail.body.inline_comments.find((c: { side: string }) => c.side === 'new'),
    ).toMatchObject({ resolved: true });

    // Unlike posting a comment, resolving stays available on a closed PR.
    await authedPost('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await authedPost(resolveUrl)
      .send({ filePath: 'b.txt', line: 1, side: 'new', resolved: false })
      .expect(200);
  });

  it('resolve (Autofix) spawns against native PR context', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id)
      .send({ headBranch: branch, title: 'Fix me', body: 'has issues' })
      .expect(201);
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'tighten the loop' })
      .expect(201);

    // No agent configured for the fresh project → expect the agent guard,
    // proving the native PR fetch path succeeded (404 unknown agent, not
    // 400 githubRepo-missing / 502 fetch failure).
    const res = await authedPost(`/api/projects/${id}/pulls/1/resolve`).send({ agentId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown agent/);
  });
});

describe('PR validation passthrough surface', () => {
  it('detail shows finalize_validated + check rows when Finalize validated the head sha', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Validated work' }).expect(201);

    // Before any validation: flag off, no checks.
    let detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
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
    );
    stmts!.markFinalizeRunReadyToPush.run(headSha, runId);
    stmts!.upsertFinalizeRunJob.run(runId, 'unit', '', 'passed', 0, Date.now(), Date.now(), null);

    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
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

    await authedPatch(`/api/projects/${id}`)
      .send({ branchProtection: { requiredChecks: true, requiredReview: true } })
      .expect(200);
    await postPulls(id).send({ headBranch: branch, title: 'Protected' }).expect(201);

    // Blocked: no review yet.
    let res = await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(409);
    expect(res.body.error).toMatch(/approving review/);

    // Detail mirrors the same reason for the Merge button.
    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.merge_blocked_reason).toMatch(/approving review/);

    // Approve — now blocked on checks (ci.yaml exists, no run yet).
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'lgtm' })
      .expect(201);
    res = await authedPost('/api/pr/merge')
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
    );
    stmts!.markFinalizeRunReadyToPush.run(headSha, runId);

    await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
  });

  it('changes-requested blocks merge even without other gates tripping', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await authedPatch(`/api/projects/${id}`)
      .send({ branchProtection: { requiredReview: true } })
      .expect(200);
    await postPulls(id).send({ headBranch: branch, title: 'Blocked by review' }).expect(201);
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'fix first' })
      .expect(201);
    const res = await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(409);
    expect(res.body.error).toMatch(/requested changes/);

    // Approval (same reviewer's later verdict) unblocks; no ci.yaml at the
    // head commit so requiredChecks would be vacuous anyway.
    await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'approved', body: 'fixed' })
      .expect(201);
    await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
  });

  it('gates merge on the merged per-job check verdicts after single-job reruns', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();
    mkdirSync(path.join(work, '.agent-hub'), { recursive: true });
    writeFileSync(
      path.join(work, '.agent-hub', 'ci.yaml'),
      [
        'version: 2',
        'on: [push]',
        'jobs:',
        '  backend:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo backend',
        '  frontend:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo frontend',
        '',
      ].join('\n'),
    );
    git(work, 'add -A');
    git(work, 'commit -m "add ci"');
    git(work, `push origin ${branch}`);

    await authedPatch(`/api/projects/${id}`)
      .send({ branchProtection: { requiredChecks: true } })
      .expect(200);
    await postPulls(id).send({ headBranch: branch, title: 'Protected checks' }).expect(201);

    const { stmts } = await import('../db.js');
    const bare = gitHostRepoPath(id);
    const headSha = execSync(`git -C "${bare}" rev-parse refs/heads/${branch}`, { stdio: 'pipe' })
      .toString()
      .trim();

    stmts!.insertFinalizeRun.run(
      'rerun-base',
      'ci-push',
      null,
      id,
      branch,
      headSha,
      'rerun|base',
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
    );
    stmts!.failFinalizeRun.run('failed', 'checks_failed', 'rerun-base');
    stmts!.upsertFinalizeRunJob.run('rerun-base', 'backend', '', 'failed', 1, 1, 2, null);
    stmts!.upsertFinalizeRunJob.run('rerun-base', 'frontend', '', 'failed', 1, 1, 2, null);

    stmts!.insertFinalizeRun.run(
      'rerun-frontend',
      'ci-push',
      null,
      id,
      branch,
      headSha,
      'rerun|frontend',
      'queued',
      null,
      'pr_push',
      null,
      'system',
      'CI',
      'ci@x',
      null,
      Date.now() - 30_000,
      'checks',
    );
    stmts!.failFinalizeRun.run('succeeded', null, 'rerun-frontend');
    stmts!.upsertFinalizeRunJob.run('rerun-frontend', 'frontend', '', 'passed', 0, 3, 4, null);

    const blocked = await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(409);
    expect(blocked.body.error).toMatch(/checks failed/);

    stmts!.insertFinalizeRun.run(
      'rerun-backend',
      'ci-push',
      null,
      id,
      branch,
      headSha,
      'rerun|backend',
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
    );
    stmts!.failFinalizeRun.run('succeeded', null, 'rerun-backend');
    stmts!.upsertFinalizeRunJob.run('rerun-backend', 'backend', '', 'passed', 0, 5, 6, null);

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(
      Object.fromEntries(
        (detail.body.checks as Array<{ name: string; conclusion: string }>).map((c) => [
          c.name,
          c.conclusion,
        ]),
      ),
    ).toEqual({
      'ci/backend': 'success',
      'ci/frontend': 'success',
    });

    await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
  });

  it('does not satisfy required checks with a partial successful job row', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();
    mkdirSync(path.join(work, '.agent-hub'), { recursive: true });
    writeFileSync(
      path.join(work, '.agent-hub', 'ci.yaml'),
      [
        'version: 2',
        'on: [push]',
        'jobs:',
        '  backend:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo backend',
        '  frontend:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo frontend',
        '',
      ].join('\n'),
    );
    git(work, 'add -A');
    git(work, 'commit -m "add ci"');
    git(work, `push origin ${branch}`);

    await authedPatch(`/api/projects/${id}`)
      .send({ branchProtection: { requiredChecks: true } })
      .expect(200);
    await postPulls(id).send({ headBranch: branch, title: 'Partial checks' }).expect(201);

    const { stmts } = await import('../db.js');
    const bare = gitHostRepoPath(id);
    const headSha = execSync(`git -C "${bare}" rev-parse refs/heads/${branch}`, { stdio: 'pipe' })
      .toString()
      .trim();

    stmts!.insertFinalizeRun.run(
      'partial-frontend',
      'ci-push',
      null,
      id,
      branch,
      headSha,
      'partial|frontend',
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
    );
    stmts!.failFinalizeRun.run('succeeded', null, 'partial-frontend');
    stmts!.upsertFinalizeRunJob.run('partial-frontend', 'frontend', '', 'passed', 0, 1, 2, null);

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks).toHaveLength(1);
    expect(detail.body.checks[0]).toMatchObject({
      name: 'ci/frontend',
      conclusion: 'success',
    });
    expect(detail.body.pr.merge_blocked_reason).toMatch(/every required job/);

    const blocked = await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(409);
    expect(blocked.body.error).toMatch(/every required job/);
  });

  it('blockDirectPushes rejects pushes to the default branch but merges still land', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();
    await authedPatch(`/api/projects/${id}`)
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
    await postPulls(id).send({ headBranch: branch, title: 'Via PR' }).expect(201);
    await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    expect(git(bare, 'rev-parse refs/heads/main')).not.toBe(before);
  });
});

describe('POST /api/projects/:projectId/pulls/branch-changes', () => {
  it('returns file changes for a pushed branch before PR creation', async () => {
    const { id, branch } = await hostedProjectWithBranch();

    const res = await authedPost(`/api/projects/${id}/pulls/branch-changes`)
      .send({ headBranch: branch })
      .expect(200);

    expect(res.body).toMatchObject({
      headBranch: branch,
      baseBranch: 'main',
      stats: { changedFiles: 1, additions: 1, deletions: 0 },
      truncated: false,
    });
    expect(res.body.files).toEqual([
      { filename: 'b.txt', status: 'added', additions: 1, deletions: 0 },
    ]);
  });

  it('uses PR-style merge-base diff semantics when the branch is behind base', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();
    git(work, 'checkout main');
    writeFileSync(path.join(work, 'a.txt'), 'base moved\n');
    git(work, 'add a.txt');
    git(work, 'commit -m "move base forward"');
    git(work, 'push origin main');

    const res = await authedPost(`/api/projects/${id}/pulls/branch-changes`)
      .send({ headBranch: branch })
      .expect(200);

    expect(res.body.stats).toEqual({ changedFiles: 1, additions: 1, deletions: 0 });
    expect(res.body.files).toEqual([
      { filename: 'b.txt', status: 'added', additions: 1, deletions: 0 },
    ]);
  });

  it('validates missing or unknown branches', async () => {
    const { id } = await hostedProjectWithBranch();
    await authedPost(`/api/projects/${id}/pulls/branch-changes`).send({}).expect(400);
    for (const headBranch of ['../evil', 'foo.lock', 'feature//bad', 'feature/..']) {
      await authedPost(`/api/projects/${id}/pulls/branch-changes`).send({ headBranch }).expect(400);
    }
    await authedPost(`/api/projects/${id}/pulls/branch-changes`)
      .send({ headBranch: 'feature/manual', baseBranch: 'base.lock' })
      .expect(400);
    await authedPost(`/api/projects/${id}/pulls/branch-changes`)
      .send({ headBranch: 'missing-branch' })
      .expect(404);
  });
});

describe('recent pushes (Compare & PR banner)', () => {
  it('lists pushed branches, excluding default, managed session branches, and branches with open PRs', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();
    const emptyBranch = `empty-${uuidv4().slice(0, 8)}`;
    git(work, 'checkout main');
    git(work, `checkout -b ${emptyBranch}`);
    git(work, `push -u origin ${emptyBranch}`);

    const manualBranch = `manual-${uuidv4().slice(0, 8)}`;
    git(work, 'checkout main');
    git(work, `checkout -b ${manualBranch}`);
    writeFileSync(path.join(work, 'manual.txt'), 'manual\n');
    git(work, 'add manual.txt');
    git(work, 'commit -m "manual change"');
    git(work, `push -u origin ${manualBranch}`);

    const { recordRecentPush, __clearRecentPushes } = await import('../git-host/recent-pushes.js');
    __clearRecentPushes();
    // Simulate what the notify endpoint records on push.
    recordRecentPush(id, [
      `refs/heads/${branch}`,
      `refs/heads/${emptyBranch}`,
      `refs/heads/${manualBranch}`,
      'refs/heads/main',
      'refs/tags/v1',
    ]);

    let res = await authedGet(`/api/projects/${id}/git-host/recent-pushes`).expect(200);
    expect(res.body.pushes).toHaveLength(1); // main, tag, managed session, and empty branches excluded
    expect(res.body.pushes[0]).toMatchObject({ branch: manualBranch });
    expect(typeof res.body.pushes[0].pushedAt).toBe('number');

    // Opening a PR for the branch removes it from the banner list.
    await postPulls(id).send({ headBranch: manualBranch, title: 'From banner' }).expect(201);
    res = await authedGet(`/api/projects/${id}/git-host/recent-pushes`).expect(200);
    expect(res.body.pushes).toEqual([]);

    // Non-hosted project → 404.
    const plainId = `pulls-rp-plain-${uuidv4().slice(0, 8)}`;
    await authedPost('/api/projects')
      .send({ id: plainId, name: plainId, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    await authedGet(`/api/projects/${plainId}/git-host/recent-pushes`).expect(404);
  });

  it('keeps recent pushes visible when the diff check fails', async () => {
    const { id } = await hostedProjectWithBranch();
    const missingBranch = `missing-${uuidv4().slice(0, 8)}`;
    const { recordRecentPush, __clearRecentPushes } = await import('../git-host/recent-pushes.js');
    __clearRecentPushes();
    recordRecentPush(id, [`refs/heads/${missingBranch}`]);

    const res = await authedGet(`/api/projects/${id}/git-host/recent-pushes`).expect(200);

    expect(res.body.pushes).toEqual([expect.objectContaining({ branch: missingBranch })]);
  });
});

describe('setup-failure surfacing on PR checks', () => {
  it('a run that failed before producing jobs shows a synthetic failed check', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Broken CI' }).expect(201);

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
    );
    stmts!.failFinalizeRun.run('failed', 'ci_config_invalid', runId);

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks).toHaveLength(1);
    expect(detail.body.checks[0]).toMatchObject({
      name: 'ci/setup (ci_config_invalid)',
      status: 'completed',
      conclusion: 'failure',
    });
  });
});

describe('checks_run — detailed run for the PR page', () => {
  it('surfaces the Finalize run (any trigger) with its jobs while ci_run stays null', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Finalized work' }).expect(201);

    const { stmts } = await import('../db.js');
    const bare = gitHostRepoPath(id);
    const headSha = execSync(`git -C "${bare}" rev-parse refs/heads/${branch}`, { stdio: 'pipe' })
      .toString()
      .trim();
    const runId = `fin-${uuidv4().slice(0, 8)}`;
    stmts!.insertFinalizeRun.run(
      runId,
      'card',
      null,
      id,
      branch,
      headSha,
      `finalize|${runId}`,
      'queued',
      null,
      // trigger_source `finalize` → NOT a re-runnable push/pr-ci run.
      'finalize',
      null,
      'system',
      'Dev',
      'dev@x',
      null,
      Date.now(),
      'full',
    );
    stmts!.failFinalizeRun.run('succeeded', null, runId);
    stmts!.upsertFinalizeRunJob.run(runId, 'backend', '', 'passed', 0, 1, 2, null);
    stmts!.upsertFinalizeRunJob.run(runId, 'frontend', '', 'passed', 0, 3, 4, null);

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);

    // Finalize runs are not re-runnable from the PR page → ci_run null.
    expect(detail.body.ci_run).toBeNull();

    // …but the detailed run surfaces with its job rows so the PR page can
    // render the expandable Run → Job → Step view instead of the flat list.
    expect(detail.body.checks_run).toMatchObject({
      id: runId,
      trigger_source: 'finalize',
      status: 'succeeded',
      branch,
      head_sha: headSha,
    });
    const jobs = detail.body.checks_run.jobs as Array<{ job_id: string; state: string }>;
    expect(jobs.map((j) => j.job_id).sort()).toEqual(['backend', 'frontend']);
    expect(jobs.every((j) => j.state === 'passed')).toBe(true);
  });

  it('is null when no run exists for the head', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'No runs yet' }).expect(201);

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks_run).toBeNull();
  });
});

describe('CI empty-state explanation (checks_note)', () => {
  it('explains missing config, an unparseable config, and not-started', async () => {
    // hostedProjectWithBranch seeds no ci.yaml → "No CI is configured".
    const { id, branch, work } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Explain me' }).expect(201);
    let detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks_note).toMatch(/No CI is configured/);

    // A `version: 1` file is no longer a schema the parser accepts, so it
    // reads as a broken config and the note names the conversion.
    mkdirSync(path.join(work, '.agent-hub'), { recursive: true });
    writeFileSync(
      path.join(work, '.agent-hub', 'ci.yaml'),
      'version: 1\non: [finalize]\ntimeout_minutes: 10\nsteps:\n  - name: t\n    run: echo ok\n',
    );
    git(work, 'add -A');
    git(work, 'commit -m "v1 ci"');
    git(work, `push origin ${branch}`);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.checks_note).toMatch(/failed to parse/);
    expect(detail.body.checks_note).toMatch(/version: 2/);

    // Valid config with no run yet → "not started" (PR CI is disabled in
    // tests via AGENT_HUB_DISABLE_PUSH_CI, so no run row appears).
    writeFileSync(
      path.join(work, '.agent-hub', 'ci.yaml'),
      'version: 2\non: [push]\ntimeout_minutes: 10\njobs:\n  unit:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n',
    );
    git(work, 'add -A');
    git(work, 'commit -m "v2 ci"');
    git(work, `push origin ${branch}`);
    detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
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
      );
      if (status !== 'queued') stmts!.failFinalizeRun.run(status, null, runId);
    };

    mkRun('rr-fin', 'ui_button', 'pushed');
    const fin = await authedPost(`/api/projects/${id}/ci-runs/rr-fin/rerun`).send({});
    expect(fin.status).toBe(400);

    mkRun('rr-live', 'pr_push', 'queued');
    const live = await authedPost(`/api/projects/${id}/ci-runs/rr-live/rerun`).send({});
    expect(live.status).toBe(409);

    mkRun('rr-done', 'pr_push', 'failed');
    const done = await authedPost(`/api/projects/${id}/ci-runs/rr-done/rerun`).send({});
    expect(done.status).toBe(202);
    expect(done.body).toEqual({ ok: true });

    await authedPost(`/api/projects/${id}/ci-runs/missing/rerun`).send({}).expect(404);
  });
});

describe('checks merge across runs (per-job re-run keeps all checks visible)', () => {
  it('shows every job with its newest verdict across multiple runs', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Merged checks' }).expect(201);

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
    );
    stmts!.failFinalizeRun.run('failed', 'checks_failed', 'mc-run1');
    stmts!.upsertFinalizeRunJob.run('mc-run1', 'backend-tests', '', 'passed', 0, 1, 2, null);
    stmts!.upsertFinalizeRunJob.run('mc-run1', 'frontend-tests', '', 'failed', 1, 1, 2, null);

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
    );
    stmts!.failFinalizeRun.run('succeeded', null, 'mc-run2');
    stmts!.upsertFinalizeRunJob.run('mc-run2', 'frontend-tests', '', 'passed', 0, 3, 4, null);

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
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
      const res = await authedPost(`/api/projects/${id}/pulls/generate-description`)
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
      const fail = await authedPost(`/api/projects/${id}/pulls/generate-description`)
        .send({ headBranch: branch })
        .expect(502);
      expect(fail.body.error).toMatch(/model exploded/);

      await authedPost(`/api/projects/${id}/pulls/generate-description`)
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

    const ok = await authedPost(`/api/projects/${id}/git-host/default-branch`)
      .send({ branch })
      .expect(200);
    expect(ok.body.defaultBranch).toBe(branch);
    const bare = gitHostRepoPath(id);
    expect(
      execSync(`git -C "${bare}" symbolic-ref HEAD`, { stdio: 'pipe' }).toString().trim(),
    ).toBe(`refs/heads/${branch}`);

    await authedPost(`/api/projects/${id}/git-host/default-branch`)
      .send({ branch: 'does-not-exist' })
      .expect(404);
    await authedPost(`/api/projects/${id}/git-host/default-branch`)
      .send({ branch: '../evil' })
      .expect(400);
  });
});

describe('linked card + list CI status', () => {
  it('list rows and detail carry linked_card and check_rollup', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Card-linked' }).expect(201);

    const { stmts } = await import('../db.js');
    // Link a kanban card to the PR by its native URL.
    stmts!.createKanbanBoard.run('board-x', id, 'Board', 'BRD');
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
    );
    stmts!.failFinalizeRun.run('succeeded', null, 'lk-run');
    stmts!.upsertFinalizeRunJob.run('lk-run', 'unit', '', 'passed', 0, 1, 2, null);

    const list = await authedGet(`/api/projects/${id}/pulls`).expect(200);
    expect(list.body.pulls[0].linked_card).toMatchObject({
      id: 'card-lk1',
      title: 'Ship the widget',
    });
    expect(list.body.pulls[0].check_rollup).toHaveLength(1);
    expect(list.body.pulls[0].check_rollup[0]).toMatchObject({ conclusion: 'success' });

    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.pr.linked_card).toMatchObject({ id: 'card-lk1' });
  });
});

describe('deleteBranchOnMerge setting + branch deletion', () => {
  it('keeps the head branch after merge when deleteBranchOnMerge=false', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await authedPatch(`/api/projects/${id}`).send({ deleteBranchOnMerge: false }).expect(200);
    await postPulls(id).send({ headBranch: branch, title: 'Keep my branch' }).expect(201);
    await authedPost('/api/pr/merge')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    // Branch survives the merge.
    const bare = gitHostRepoPath(id);
    execSync(`git -C "${bare}" rev-parse --verify refs/heads/${branch}`, { stdio: 'pipe' });
  });

  it('default behavior deletes the head branch after merge', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Cleanup me' }).expect(201);
    await authedPost('/api/pr/merge')
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
    const def = await authedDelete(`/api/projects/${id}/git-host/branches/main`).expect(409);
    expect(def.body.error).toMatch(/default branch/);

    // Refuses a branch backing an open PR.
    await postPulls(id).send({ headBranch: branch, title: 'Open PR' }).expect(201);
    const inUse = await authedDelete(
      `/api/projects/${id}/git-host/branches/${encodeURIComponent(branch)}`,
    ).expect(409);
    expect(inUse.body.error).toMatch(/open PR #1/);

    // Close the PR — now deletion succeeds.
    await authedPost('/api/pr/close')
      .send({ prUrl: `/projects/${id}/pulls/1` })
      .expect(200);
    await authedDelete(
      `/api/projects/${id}/git-host/branches/${encodeURIComponent(branch)}`,
    ).expect(200);
    const bare = gitHostRepoPath(id);
    expect(() =>
      execSync(`git -C "${bare}" rev-parse --verify refs/heads/${branch}`, { stdio: 'pipe' }),
    ).toThrow();

    await authedDelete(`/api/projects/${id}/git-host/branches/never-existed`).expect(404);
  });
});

describe('review reviewer-name override', () => {
  it('attributes the review to the supplied reviewer name (agent reviews)', async () => {
    const { id, branch } = await hostedProjectWithBranch();
    await postPulls(id).send({ headBranch: branch, title: 'Agent-reviewed' }).expect(201);
    const res = await authedPost(`/api/projects/${id}/pulls/1/reviews`)
      .send({ state: 'changes_requested', body: 'tighten', reviewer: 'Demo Reviewer' })
      .expect(201);
    expect(res.body.review.user).toBe('Demo Reviewer');
    const detail = await authedGet(`/api/projects/${id}/pulls/1`).expect(200);
    expect(detail.body.reviews[0].user).toBe('Demo Reviewer');
    expect(detail.body.pr.review_decision).toBe('CHANGES_REQUESTED');
  });
});

describe('epic ↔ PR feature-branch linkage', () => {
  it('links PRs to an epic by feature branch and lists them on the epic', async () => {
    const { id, branch, work } = await hostedProjectWithBranch();

    // Epic whose feature branch IS the pushed branch.
    const epicRes = await authedPost(`/api/projects/${id}/board/epics`)
      .send({ name: 'Reliability', prBaseBranch: branch })
      .expect(200);
    const epicId = epicRes.body.id as string;

    // PR #1: head = feature branch, base = main → ships the feature branch (integration).
    await postPulls(id).send({ headBranch: branch, title: 'Ship reliability' }).expect(201);

    // PR #2: a ticket branched off the feature branch, PR'd INTO it (targets).
    const ticket = 'agent-hub/dev/session-cafe0002';
    git(work, `checkout -b ${ticket}`);
    writeFileSync(path.join(work, 'c.txt'), 'c\n');
    git(work, 'add c.txt');
    git(work, 'commit -m "add c"');
    git(work, `push -u origin ${ticket}`);
    await postPulls(id)
      .send({ headBranch: ticket, baseBranch: branch, title: 'Ticket work' })
      .expect(201);

    // List rows carry linked_epic with the right relation.
    const list = await authedGet(`/api/projects/${id}/pulls?state=all`).expect(200);
    const byNum: Record<number, any> = Object.fromEntries(
      list.body.pulls.map((p: any) => [p.number, p]),
    );
    expect(byNum[1].linked_epic).toMatchObject({
      id: epicId,
      relation: 'integration',
      feature_branch: branch,
    });
    expect(byNum[2].linked_epic).toMatchObject({ id: epicId, relation: 'targets' });

    // Detail carries linked_epic too.
    const detail = await authedGet(`/api/projects/${id}/pulls/2`).expect(200);
    expect(detail.body.pr.linked_epic).toMatchObject({ id: epicId, relation: 'targets' });

    // The epic-pulls endpoint returns both PRs, tagged with their relation.
    const epicPulls = await authedGet(`/api/projects/${id}/board/epics/${epicId}/pulls`).expect(
      200,
    );
    expect(epicPulls.body).toMatchObject({ epicId, featureBranch: branch, source: 'agenthub' });
    const relByNum: Record<number, string> = Object.fromEntries(
      epicPulls.body.pulls.map((p: any) => [p.number, p.relation]),
    );
    expect(relByNum).toEqual({ 1: 'integration', 2: 'targets' });
  });

  it('returns an empty list when the epic has no feature branch', async () => {
    const { id } = await hostedProjectWithBranch();
    const epicRes = await authedPost(`/api/projects/${id}/board/epics`)
      .send({ name: 'No branch' })
      .expect(200);
    const res = await authedGet(`/api/projects/${id}/board/epics/${epicRes.body.id}/pulls`).expect(
      200,
    );
    expect(res.body).toMatchObject({ featureBranch: null, pulls: [] });
  });

  it('404s for an unknown epic', async () => {
    const { id } = await hostedProjectWithBranch();
    await authedGet(`/api/projects/${id}/board/epics/does-not-exist/pulls`).expect(404);
  });
});
