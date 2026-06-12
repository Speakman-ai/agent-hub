/**
 * External-push auto-review: dispatches the Reviewer agent for
 * unvalidated PR heads when branch protection requires review.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { Project, RouteDeps } from '../types.js';

let maybeRunPrAutoReview: typeof import('./auto-review.js').maybeRunPrAutoReview;
let __clearAutoReviewDispatches: typeof import('./auto-review.js').__clearAutoReviewDispatches;
let stmts: import('../types.js').Stmts;
let config: import('../types.js').AppConfig;
let request: Awaited<ReturnType<typeof import('../test/helpers.js').getRequest>>;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;

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
      { number: 1, head_branch: branch, status: 'open' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true },
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
      { number: 1, head_branch: branch, status: 'open' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
      { force: true },
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
    await maybeRunPrAutoReview(project, { number: 1, head_branch: branch, status: 'open' }, deps, {
      force: true,
    });
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
    await maybeRunPrAutoReview(project, { number: 1, head_branch: branch, status: 'open' }, deps, {
      force: true,
    });
    expect(handleChat).not.toHaveBeenCalled();

    // No reviewer agent → skip (warn).
    const { findProject } = await import('../project-model.js');
    const p2 = findProject(project.id) as Project;
    p2.agents = p2.agents.filter((a) => a.role !== 'reviewer');
    await maybeRunPrAutoReview(p2, { number: 1, head_branch: branch, status: 'open' }, deps, {
      force: true,
    });
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('is inert under the test-env guard without force', async () => {
    const { project, branch } = await hostedPrProject();
    const handleChat = vi.fn();
    await maybeRunPrAutoReview(
      project,
      { number: 1, head_branch: branch, status: 'open' },
      { stmts, config, broadcast: vi.fn(), handleChat: handleChat as RouteDeps['handleChat'] },
    );
    expect(handleChat).not.toHaveBeenCalled();
  });
});
