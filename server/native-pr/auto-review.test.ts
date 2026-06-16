/**
 * External-push auto-review: dispatches the Reviewer agent for
 * unvalidated PR heads when branch protection requires review.
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
    const session = stmts.getSession.get(msg.sessionId) as { agent_id: string; name: string };
    expect(session.agent_id).toBe(`${project.id}-reviewer`);
    expect(session.name).toContain(headSha.slice(0, 8));

    // Dedupe: same head sha never dispatches twice.
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it('skips when review is not required, head is validated, or no reviewer exists', async () => {
    const { project, branch, headSha } = await hostedPrProject();
    const handleChat = vi.fn();
    const deps = {
      stmts,
      config,
      broadcast: vi.fn(),
      handleChat: handleChat as RouteDeps['handleChat'],
    };

    // requiredReview off → skip.
    project.branchProtection = {};
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open', author: 'ryan' },
      deps,
      { force: true, trigger: 'pr_create' },
    );
    expect(handleChat).not.toHaveBeenCalled();
    project.branchProtection = { requiredReview: true };

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
      null,
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
