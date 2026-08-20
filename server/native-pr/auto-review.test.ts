/**
 * External-push auto-review: dispatches the Reviewer agent for every
 * unvalidated native PR head.
 */
import '../test/setup.js';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { Project, RouteDeps } from '../types.js';
import * as engineAvailability from '../engine-availability.js';
import { createUser } from '../users-store.js';
import { replaceUserPreferencesJson } from '../user-preferences-store.js';

let maybeRunPrAutoReview: typeof import('./auto-review.js').maybeRunPrAutoReview;
let __clearAutoReviewDispatches: typeof import('./auto-review.js').__clearAutoReviewDispatches;
let stmts: import('../types.js').Stmts;
let config: import('../types.js').AppConfig;
let request: Awaited<ReturnType<typeof import('../test/helpers.js').getRequest>>;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;
let probeSpy: MockInstance<typeof engineAvailability.probeEngineAvailability>;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  request = await helpers.getRequest();
  ({ maybeRunPrAutoReview, __clearAutoReviewDispatches } = await import('./auto-review.js'));
  stmts = (await import('../db.js')).stmts!;
  config = (await import('../config.js')).default;
  ({ gitHostRepoPath } = await import('../git-host/repo-store.js'));
});

beforeEach(() => {
  __clearAutoReviewDispatches();
  probeSpy = vi.spyOn(engineAvailability, 'probeEngineAvailability').mockResolvedValue({
    engine: 'claude-code',
    available: true,
  });
});

afterEach(() => {
  probeSpy.mockRestore();
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

async function hostedPrProject(): Promise<{ project: Project; branch: string; headSha: string }> {
  const id = `autorev-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  await request
    .post(`/api/projects/${id}/git-host/enable`)
    .send({ importFrom: 'empty' })
    .expect(202);
  await vi.waitFor(async () => {
    const res = await request.get(`/api/projects/${id}/git-host`).expect(200);
    expect(res.body.importState?.status).toBe('ready');
  });
  const bare = gitHostRepoPath(id);
  const work = path.join(os.tmpdir(), `autorev-work-${uuidv4().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email "t@example.com"');
  git(work, 'config user.name "T"');
  writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add -A');
  git(work, 'commit -m base');
  git(work, `remote add origin "${bare}"`);
  git(work, 'push -u origin main');
  const branch = 'external/change';
  git(work, `checkout -b ${branch}`);
  writeFileSync(path.join(work, 'b.txt'), 'b\n');
  git(work, 'add -A');
  git(work, 'commit -m external');
  git(work, `push -u origin ${branch}`);
  const headSha = git(bare, `rev-parse refs/heads/${branch}`);

  const { findProject } = await import('../project-model.js');
  const project = findProject(id) as Project;
  project.branchProtection = { requiredReview: true };
  project.agents.push({
    id: `${id}-reviewer`,
    name: `${id} Reviewer`,
    engine: 'claude-code',
    role: 'reviewer',
  } as Project['agents'][number]);
  return { project, branch, headSha };
}

describe('maybeRunPrAutoReview', () => {
  it('dispatches the reviewer session for an unvalidated external head', async () => {
    const { project, branch, headSha } = await hostedPrProject();
    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as {
      agentId: string;
      sessionId: string;
      content: string;
    };
    expect(msg.agentId).toBe(`${project.id}-reviewer`);
    expect(msg.content).toContain(`/projects/${project.id}/pulls/1`);
    expect(msg.content).toContain('"reviewer": "' + project.id + ' Reviewer"');
    // The prompt bakes the reviewer's own session id into the verdict POST so the
    // verdict can prove it owns the in-flight claim.
    expect(msg.content).toContain(`X-Agent-Hub-Session-Id: ${msg.sessionId}`);
    const session = stmts.getSession.get(msg.sessionId) as { agent_id: string; name: string };
    expect(session.agent_id).toBe(`${project.id}-reviewer`);
    expect(session.name).toContain(headSha.slice(0, 8));

    // The Hub-PR review prompt carries the unmet-AC blocking rule so an
    // undelivered criterion cannot be approved on this path either (PR #922).
    expect(msg.content).toContain(
      'an acceptance criterion the change does not fully deliver scores > 3',
    );
    expect(msg.content).toContain('even when the card is titled `[Partial]`');

    // Dedupe: same head sha never dispatches twice.
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it('stamps the durable agent-review-in-flight flag on dispatch', async () => {
    const { project, branch } = await hostedPrProject();
    const now = Date.now();
    // A persisted PR row for the durable flag to land on (the flag is keyed by
    // project+number). Without a row the stamp is a harmless no-op UPDATE.
    stmts.insertPullRequest.run(
      `pr-${project.id}-1`,
      project.id,
      1,
      'T',
      '',
      branch,
      'main',
      'deadbeef',
      'ryan',
      now,
      now,
    );
    const before = stmts.getPullRequestByNumber.get(project.id, 1) as {
      agent_review_requested_at: number | null;
      agent_review_session_id: string | null;
    };
    expect(before.agent_review_requested_at).toBeNull();

    // A never-settling reviewer turn keeps the claim in flight so we can observe
    // the durable flag (a settled turn would release it via the terminal path).
    const handleChat = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const result = await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'manual_request' },
    );
    expect(handleChat).toHaveBeenCalledOnce();
    expect(result.dispatched).toBe(true);
    expect(result.sessionId).toBeTruthy();
    const after = stmts.getPullRequestByNumber.get(project.id, 1) as {
      agent_review_requested_at: number | null;
      agent_review_session_id: string | null;
    };
    expect(after.agent_review_requested_at).toBeTruthy();
    // The claim records the owning session id (the atomic-guard key).
    expect(after.agent_review_session_id).toBe(result.sessionId);
  });

  it('atomic claim blocks a second concurrent dispatch (no duplicate reviewer session)', async () => {
    const { project, branch } = await hostedPrProject();
    const now = Date.now();
    stmts.insertPullRequest.run(
      `pr-${project.id}-1`,
      project.id,
      1,
      'T',
      '',
      branch,
      'main',
      'deadbeef',
      'ryan',
      now,
      now,
    );
    // First dispatch claims and stays in flight (never-settling turn).
    const handleChat = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const deps = {
      stmts,
      config,
      broadcast: vi.fn(),
      handleChat: handleChat as RouteDeps['handleChat'],
    };
    const first = await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'manual_request' },
    );
    expect(first.dispatched).toBe(true);

    // A second manual request (bypasses per-sha dedup) must NOT dispatch again.
    const second = await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'manual_request' },
    );
    expect(second.dispatched).toBe(false);
    expect(second.reason).toBe('already_in_flight');
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it('reclaims a STALE claim (crash recovery) instead of blocking forever', async () => {
    const { project, branch } = await hostedPrProject();
    const now = Date.now();
    stmts.insertPullRequest.run(
      `pr-${project.id}-1`,
      project.id,
      1,
      'T',
      '',
      branch,
      'main',
      'deadbeef',
      'ryan',
      now,
      now,
    );
    // Simulate a claim left behind by a crashed server: flag set two hours ago
    // (older than the 60-min TTL), with no live release possible.
    stmts.setPullRequestAgentReviewRequested.run(now - 2 * 60 * 60 * 1000, now, project.id, 1);

    const handleChat = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const result = await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'manual_request' },
    );
    // The stale claim was reclaimed rather than rejected as already_in_flight.
    expect(result.dispatched).toBe(true);
    expect(handleChat).toHaveBeenCalledOnce();
    const row = stmts.getPullRequestByNumber.get(project.id, 1) as {
      agent_review_requested_at: number | null;
      agent_review_session_id: string | null;
    };
    expect(row.agent_review_requested_at).toBeGreaterThan(now - 60 * 60 * 1000);
    expect(row.agent_review_session_id).toBe(result.sessionId);
  });

  it('rolls the in-flight claim back when the reviewer turn fails', async () => {
    const { project, branch } = await hostedPrProject();
    const now = Date.now();
    stmts.insertPullRequest.run(
      `pr-${project.id}-1`,
      project.id,
      1,
      'T',
      '',
      branch,
      'main',
      'deadbeef',
      'ryan',
      now,
      now,
    );
    // The reviewer turn rejects — the terminal resolver must clear the flag.
    const handleChat = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const result = await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'manual_request' },
    );
    expect(result.dispatched).toBe(true);
    // Let the rejection's terminal .finally run.
    await vi.waitFor(() => {
      const row = stmts.getPullRequestByNumber.get(project.id, 1) as {
        agent_review_requested_at: number | null;
      };
      expect(row.agent_review_requested_at).toBeNull();
    });
    const cleared = stmts.getPullRequestByNumber.get(project.id, 1) as {
      agent_review_session_id: string | null;
    };
    expect(cleared.agent_review_session_id).toBeNull();
  });

  it('reports dispatched:false with a reason when no reviewer agent exists', async () => {
    const { project, branch } = await hostedPrProject();
    // Strip the reviewer agent that hostedPrProject added.
    project.agents = project.agents.filter((a) => a.role !== 'reviewer');
    const handleChat = vi.fn();
    const result = await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'manual_request' },
    );
    expect(handleChat).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('no_reviewer');
  });

  it('dispatches even when approval is not required to merge', async () => {
    // Regression: auto-review used to be coupled to branch protection, so a
    // newly pushed native PR received no review at all when requiredReview was
    // off. Review policy controls merging, not whether Reviewer runs.
    const { project, branch } = await hostedPrProject();
    project.branchProtection = { requiredReview: false };
    const handleChat = vi.fn();

    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );

    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { content: string };
    expect(msg.content).toContain('every unvalidated PR head');
  });

  it('skips when the head is validated or no reviewer exists', async () => {
    const { project, branch, headSha } = await hostedPrProject();
    const handleChat = vi.fn();
    const deps = {
      stmts,
      config,
      broadcast: vi.fn(),
      handleChat: handleChat as RouteDeps['handleChat'],
    };

    // Finalize-validated head → passthrough skip (session reviews own it).
    const runId = `fin-${uuidv4().slice(0, 8)}`;
    stmts.insertFinalizeRun.run(
      runId,
      'card',
      null,
      project.id,
      branch,
      headSha,
      `t|${runId}`,
      'queued',
      null,
      'ui_button',
      null,
      'u',
      'U',
      'u@x',
      null,
      Date.now(),
      'full',
    );
    stmts.markFinalizeRunReadyToPush.run(headSha, runId);
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).not.toHaveBeenCalled();

    // No reviewer agent → skip (warn).
    const { findProject } = await import('../project-model.js');
    const p2 = findProject(project.id) as Project;
    p2.agents = p2.agents.filter((a) => a.role !== 'reviewer');
    await maybeRunPrAutoReview(
      p2,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('skips a Finalize run still in the transient "pushing" status (validated head mid-push)', async () => {
    // Regression: the actual `git push` + native-PR creation happen while the
    // finalize run sits in 'pushing' (claimFinalizeRunPush flips ready_to_push
    // → pushing; markFinalizeRunPushed flips it to 'pushed' only after the push
    // returns). The onPrHeadChanged('created') hook fires maybeRunPrAutoReview
    // synchronously inside that window. validated_head_sha is already stamped,
    // so the head is Finalize-validated and the external-push reviewer must NOT
    // dispatch. Before the fix, the passthrough excluded 'pushing' and a
    // redundant reviewer was dispatched (often "changes requested").
    const { project, branch, headSha } = await hostedPrProject();
    const handleChat = vi.fn();
    const deps = {
      stmts,
      config,
      broadcast: vi.fn(),
      handleChat: handleChat as RouteDeps['handleChat'],
    };

    const runId = `fin-${uuidv4().slice(0, 8)}`;
    stmts.insertFinalizeRun.run(
      runId,
      'card',
      null,
      project.id,
      branch,
      headSha,
      `t|${runId}`,
      'queued',
      null,
      'ui_button',
      null,
      'u',
      'U',
      'u@x',
      null,
      Date.now(),
      'full',
    );
    // Stamp validated_head_sha (ready_to_push), then claim the push so the row
    // sits in the transient 'pushing' status exactly as it does mid-push.
    stmts.markFinalizeRunReadyToPush.run(headSha, runId);
    const claim = stmts.claimFinalizeRunPush.run(runId, headSha);
    expect(claim.changes).toBe(1);
    const row = stmts.getFinalizeRun.get(runId) as { status: string };
    expect(row.status).toBe('pushing');

    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('skips when Finalize validated the same sha on the session branch', async () => {
    const { project, branch, headSha } = await hostedPrProject();
    const handleChat = vi.fn();
    const deps = {
      stmts,
      config,
      broadcast: vi.fn(),
      handleChat: handleChat as RouteDeps['handleChat'],
    };

    // Regression for PR 291: the Finalize run was recorded under the original
    // session worktree branch, but the worktree had checked out a feature
    // branch by push time. The native PR head branch points at the same
    // validated commit and must not be treated as an external push.
    const runId = `fin-${uuidv4().slice(0, 8)}`;
    stmts.insertFinalizeRun.run(
      runId,
      'card',
      null,
      project.id,
      'agent-hub/agent-hub-dev/session-a93e0b3e',
      headSha,
      `t|${runId}`,
      'queued',
      null,
      'agent_block',
      null,
      'u',
      'U',
      'u@x',
      null,
      Date.now(),
      'full',
    );
    stmts.markFinalizeRunReadyToPush.run(headSha, runId);

    await maybeRunPrAutoReview(
      project,
      { number: 291, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('skips when the PR already shipped through Finalize, even after a rebase changed the head sha', async () => {
    // Regression: a Finalize run that rebased before pushing mints a NEW head
    // sha. The sha-exact `getValidatedFinalizeRunForSha` passthrough is keyed on
    // the sha it validated, so the pushed (rebased) sha slips past it and a
    // redundant reviewer fires on a session that already shipped and is locked.
    // The PR-keyed post-push lock must catch it regardless of sha.
    const { project, branch, headSha } = await hostedPrProject();
    const { buildNativePrUrl } = await import('./url.js');
    const prNumber = 412;
    const prUrl = buildNativePrUrl(project.id, prNumber);
    const handleChat = vi.fn();
    const deps = {
      stmts,
      config,
      broadcast: vi.fn(),
      handleChat: handleChat as RouteDeps['handleChat'],
    };

    // A pushed Finalize run for THIS PR, but validated under a DIFFERENT (pre
    // rebase) sha — the sha-exact passthrough would not match the current head.
    const runId = `fin-${uuidv4().slice(0, 8)}`;
    stmts.insertFinalizeRun.run(
      runId,
      'card',
      null,
      project.id,
      branch,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      `t|${runId}`,
      'queued',
      null,
      'ui_button',
      null,
      'u',
      'U',
      'u@x',
      null,
      Date.now(),
      'full',
    );
    stmts.markFinalizeRunReadyToPush.run('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', runId);
    stmts.claimFinalizeRunPush.run(runId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    stmts.updateFinalizeRunPrUrl.run(prUrl, runId);
    stmts.markFinalizeRunPushed.run(runId);

    // Sanity: the sha-exact passthrough does NOT cover the current head sha,
    // so only the PR-keyed lock can suppress this dispatch.
    expect(stmts.getValidatedFinalizeRunForSha.get(project.id, headSha)).toBeUndefined();

    await maybeRunPrAutoReview(
      project,
      { number: prNumber, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'head_update', pushedByUserId: 'ryan' },
    );
    expect(handleChat).not.toHaveBeenCalled();

    // A manual "Request review" is explicit human intent and overrides the lock.
    await maybeRunPrAutoReview(
      project,
      { number: prNumber, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'manual_request', pushedByUserId: 'ryan' },
    );
    expect(handleChat).toHaveBeenCalledTimes(1);
  });

  it('still dispatches for an external push when no pushed Finalize run shipped this PR', async () => {
    // Guard-off half of the PR-keyed post-push lock: the guard must NOT
    // suppress an ordinary external push. It fires only when a *pushed*
    // Finalize run exists for *this* PR — so a head update with no finalize
    // run, and a head update while another PR has a pushed run, both dispatch.
    const { project, branch, headSha } = await hostedPrProject();
    const { buildNativePrUrl } = await import('./url.js');
    const handleChat = vi.fn();
    const deps = {
      stmts,
      config,
      broadcast: vi.fn(),
      handleChat: handleChat as RouteDeps['handleChat'],
    };

    // A pushed Finalize run for a DIFFERENT PR must not suppress this one — the
    // lock is keyed on (project_id, pr_url), not the project. Give it an
    // unrelated validated sha so the sha-exact passthrough can't mask the
    // PR-keyed guard we're actually exercising.
    const otherSha = 'cafecafecafecafecafecafecafecafecafecafe';
    const otherRunId = `fin-${uuidv4().slice(0, 8)}`;
    stmts.insertFinalizeRun.run(
      otherRunId,
      'card',
      null,
      project.id,
      branch,
      otherSha,
      `t|${otherRunId}`,
      'queued',
      null,
      'ui_button',
      null,
      'u',
      'U',
      'u@x',
      null,
      Date.now(),
      'full',
    );
    stmts.markFinalizeRunReadyToPush.run(otherSha, otherRunId);
    stmts.claimFinalizeRunPush.run(otherRunId, otherSha);
    stmts.updateFinalizeRunPrUrl.run(buildNativePrUrl(project.id, 999), otherRunId);
    stmts.markFinalizeRunPushed.run(otherRunId);

    // Sanity: this PR's real head sha is not Finalize-validated, so only the
    // PR-keyed guard could suppress — and it must not, since PR #7 never shipped.
    expect(stmts.getValidatedFinalizeRunForSha.get(project.id, headSha)).toBeUndefined();

    // This PR (#7) has no pushed Finalize run — an external push must review.
    await maybeRunPrAutoReview(
      project,
      { number: 7, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'head_update', pushedByUserId: 'ryan' },
    );
    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { agentId: string; content: string };
    expect(msg.agentId).toBe(`${project.id}-reviewer`);
    expect(msg.content).toContain(`/projects/${project.id}/pulls/7`);
  });

  it('is inert under the test-env guard without force', async () => {
    const { project, branch } = await hostedPrProject();
    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
    );
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('skips instead of falling back when the reviewer engine is unavailable', async () => {
    const { project, branch } = await hostedPrProject();
    const reviewer = project.agents.find((a) => a.role === 'reviewer')!;
    reviewer.engine = 'codex-cli';
    reviewer.model = 'gpt-5.5';

    probeSpy.mockResolvedValue({
      engine: 'codex-cli',
      available: false,
      reason: 'no-credentials',
      detail: 'No Codex credentials',
    });

    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );

    expect(handleChat).not.toHaveBeenCalled();
  });

  it('probes against the per-user spawn env (per-user HOME), not bare process.env', async () => {
    // Regression: the availability probe used to run with no `env`, so
    // probeEngineAvailability read the host process.env HOME/config instead of
    // the per-user spawn environment handleChat builds for the owned reviewer
    // session. A reviewer authenticated only through their own login (per-user
    // HOME OAuth cache, or a per-user GEMINI_API_KEY) could then be pre-skipped
    // as `no-credentials` even though the spawn would have authenticated. The
    // probe must receive the same per-user spawn env (HOME pinned to the acting
    // user's tree).
    const { project, branch } = await hostedPrProject();
    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );

    expect(probeSpy).toHaveBeenCalledOnce();
    const probeOpts = probeSpy.mock.calls[0]![2];
    expect(probeOpts?.userId).toBe('ryan');
    expect(probeOpts?.env).toBeDefined();
    const { perUserHomePath } = await import('../per-user-home.js');
    expect(probeOpts!.env!.HOME).toBe(perUserHomePath('ryan', config.dataDir));
  });

  it('uses the reviewer assignment even when a host-global engine is available', async () => {
    const { project, branch } = await hostedPrProject();
    const reviewer = project.agents.find((a) => a.role === 'reviewer')!;
    reviewer.engine = 'codex-cli';

    probeSpy.mockImplementation(async (engine) => ({
      engine,
      available: engine === 'codex-cli' || engine === 'grok-cli',
    }));

    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );

    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { sessionId: string };
    const session = stmts.getSession.get(msg.sessionId) as { engine: string };
    expect(session.engine).toBe('codex-cli');
    expect(probeSpy).toHaveBeenCalledWith(
      'codex-cli',
      config,
      expect.objectContaining({ userId: 'ryan' }),
    );
  });

  it('uses the reviewer assignment instead of a stale personal reviewer engine', async () => {
    const { project, branch } = await hostedPrProject();
    const reviewer = project.agents.find((a) => a.role === 'reviewer')!;
    reviewer.engine = 'codex-cli';

    const ownerId = `legacy-reviewer-owner-${uuidv4().slice(0, 8)}`;
    createUser({ id: ownerId, username: ownerId, passwordHash: 'x' });
    replaceUserPreferencesJson(ownerId, {
      agentEngineOverrides: { [reviewer.id]: { engine: 'claude-code' } },
    });

    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: ownerId },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );

    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { sessionId: string };
    const session = stmts.getSession.get(msg.sessionId) as { engine: string };
    expect(session.engine).toBe('codex-cli');
    expect(probeSpy).toHaveBeenCalledWith(
      'codex-cli',
      config,
      expect.objectContaining({ userId: ownerId }),
    );
  });

  it('runs as the pushing user on the reviewer assignment', async () => {
    const { project, branch } = await hostedPrProject();
    const reviewer = project.agents.find((a) => a.role === 'reviewer')!;
    reviewer.engine = 'cursor-agent';

    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'other-user' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, pushedByUserId: 'ryan' },
    );

    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { sessionId: string };
    const session = stmts.getSession.get(msg.sessionId) as {
      engine: string;
      owner_user_id: string | null;
    };
    expect(session.engine).toBe('cursor-agent');
    expect(session.owner_user_id).toBe('ryan');
  });

  it('skips a head update with no attributed pusher instead of using the PR author', async () => {
    const { project, branch } = await hostedPrProject();
    const reviewer = project.agents.find((a) => a.role === 'reviewer')!;
    reviewer.engine = 'codex-cli';

    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'head_update', pushedByUserId: null },
    );

    expect(handleChat).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled();
  });

  describe('manual "Request review" trigger', () => {
    it('dispatches even when branch protection does not require review', async () => {
      const { project, branch } = await hostedPrProject();
      // Manual review uses different prompt/lifecycle semantics and remains
      // available even though ordinary external pushes now review too.
      project.branchProtection = {};
      const handleChat = vi.fn();
      await maybeRunPrAutoReview(
        project,
        { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
        { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
        { force: true, trigger: 'manual_request' },
      );
      expect(handleChat).toHaveBeenCalledOnce();
      const msg = handleChat.mock.calls[0]![1] as { sessionId: string; content: string };
      expect(msg.content).toContain('review requested');
      const session = stmts.getSession.get(msg.sessionId) as {
        agent_id: string;
        name: string;
        owner_user_id: string | null;
      };
      expect(session.agent_id).toBe(`${project.id}-reviewer`);
      expect(session.name).toContain('requested @');
      // Falls back to the PR author when no explicit pusher is attributed.
      expect(session.owner_user_id).toBe('ryan');
    });

    it('bypasses the Finalize-validated passthrough and the per-head-sha dedup', async () => {
      const { project, branch, headSha } = await hostedPrProject();
      project.branchProtection = {};

      // Mark the head Finalize-validated — the external-push path would skip.
      const runId = `fin-${uuidv4().slice(0, 8)}`;
      stmts.insertFinalizeRun.run(
        runId,
        'card',
        null,
        project.id,
        branch,
        headSha,
        `t|${runId}`,
        'queued',
        null,
        'ui_button',
        null,
        'u',
        'U',
        'u@x',
        null,
        Date.now(),
        'full',
      );
      stmts.markFinalizeRunReadyToPush.run(headSha, runId);

      const handleChat = vi.fn();
      const deps = {
        stmts,
        config,
        broadcast: vi.fn(),
        handleChat: handleChat as RouteDeps['handleChat'],
      };
      const pr = { number: 1, head_branch: branch, status: 'open' as const, author: 'ryan' };
      await maybeRunPrAutoReview(project, pr, deps, { force: true, trigger: 'manual_request' });
      // A second manual request on the SAME head still dispatches (re-review).
      await maybeRunPrAutoReview(project, pr, deps, { force: true, trigger: 'manual_request' });
      expect(handleChat).toHaveBeenCalledTimes(2);
    });

    it('no-ops without a reviewer agent (flag-only, no crash)', async () => {
      const { project, branch } = await hostedPrProject();
      project.branchProtection = {};
      project.agents = project.agents.filter((a) => a.role !== 'reviewer');
      const handleChat = vi.fn();
      await maybeRunPrAutoReview(
        project,
        { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
        { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
        { force: true, trigger: 'manual_request' },
      );
      expect(handleChat).not.toHaveBeenCalled();
    });
  });

  it('uses the PR author as acting user on PR creation when receive-pack attribution is absent', async () => {
    const { project, branch } = await hostedPrProject();
    const reviewer = project.agents.find((a) => a.role === 'reviewer')!;
    reviewer.engine = 'codex-cli';

    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );

    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { sessionId: string };
    const session = stmts.getSession.get(msg.sessionId) as {
      engine: string;
      owner_user_id: string | null;
    };
    expect(session.engine).toBe('codex-cli');
    expect(session.owner_user_id).toBe('ryan');
  });
});
