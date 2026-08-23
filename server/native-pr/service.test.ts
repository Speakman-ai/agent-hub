/**
 * NativePrService tests — live test DB (test/setup) + real git against a
 * hosted bare repo in the per-process test data dir. Covers the PR
 * lifecycle end-to-end including the kanban Done-move, the revert path, and
 * the base-branch-moved mirror hook.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, KanbanCardRow, Project, Stmts } from '../types.js';

let stmts: Stmts;
let createNativePrService: typeof import('./service.js').createNativePrService;
let NativePrError: typeof import('./service.js').NativePrError;
let createHostedRepo: typeof import('../git-host/repo-store.js').createHostedRepo;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;
let getOrCreateBoard: typeof import('../routes/board.js').getOrCreateBoard;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest(); // boots app + initDb into the test data dir
  stmts = (await import('../db.js')).stmts!;
  ({ createNativePrService, NativePrError } = await import('./service.js'));
  ({ createHostedRepo, gitHostRepoPath } = await import('../git-host/repo-store.js'));
  ({ getOrCreateBoard } = await import('../routes/board.js'));
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function makeProject(id: string): Project {
  return { id, name: id, cwd: '', ahw: '', gitHost: 'agenthub' } as Project;
}

/** Seed a hosted repo with main + a feature branch carrying one commit. */
async function seedHostedRepoWithBranch(
  projectId: string,
  branch: string,
  opts: { conflictOnMain?: boolean } = {},
): Promise<{ work: string; bare: string; headSha: string }> {
  const work = path.join(
    os.tmpdir(),
    `npr-svc-${projectId}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(work, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email "t@example.com"');
  git(work, 'config user.name "T"');
  writeFileSync(path.join(work, 'base.txt'), 'base\n');
  git(work, 'add base.txt');
  git(work, 'commit -m initial');

  await createHostedRepo({ id: projectId, cwd: work, repoUrl: null }, {});
  const bare = gitHostRepoPath(projectId);
  git(work, `remote add origin "${bare}"`);

  git(work, `checkout -b ${branch}`);
  writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
  git(work, 'add feature.txt');
  git(work, 'commit -m "add feature"');
  const headSha = git(work, 'rev-parse HEAD');
  git(work, `push -u origin ${branch}`);
  git(work, 'checkout main');

  if (opts.conflictOnMain) {
    writeFileSync(path.join(work, 'feature.txt'), 'conflicting\n');
    git(work, 'add feature.txt');
    git(work, 'commit -m "conflicting main change"');
    git(work, 'push origin main');
  }

  return { work, bare, headSha };
}

const TEST_PR_AUTHOR = '00000000-0000-4000-8000-000000000010';

describe('NativePrService', () => {
  it('full lifecycle: create → list/detail shapes → merge → card Done + events + base-branch-moved hook', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'agent-hub/dev/session-abcd1234';
    const { bare, headSha } = await seedHostedRepoWithBranch(projectId, branch);

    const broadcasts: Array<Record<string, unknown>> = [];
    const broadcast: BroadcastFn = (data) => broadcasts.push(data);
    const afterBaseBranchMoved = vi.fn<
      (args: {
        project: Project;
        baseBranch: string;
        sha: string;
        reason: 'merge' | 'revert';
      }) => Promise<void>
    >(async () => {});
    const service = createNativePrService({ stmts, broadcast, afterBaseBranchMoved });

    // Kanban card matched by title (the webhook-era discovery path).
    const board = getOrCreateBoard(stmts, projectId);
    const cardId = uuidv4();
    stmts.createKanbanCard.run(
      cardId,
      board.columns[0].id,
      board.board.id,
      'Add feature flag',
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

    const created = service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'Add feature flag',
      body: 'Adds the feature.',
      author: TEST_PR_AUTHOR,
    });
    expect(created.created).toBe(true);
    expect(created.prUrl).toBe(`/projects/${projectId}/pulls/1`);

    // List shape — the fields PullRequestsPage consumes.
    const pulls = await service.listPulls({ project, state: 'open', limit: 30 });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      number: 1,
      title: 'Add feature flag',
      state: 'open',
      draft: false,
      html_url: created.prUrl,
      user: TEST_PR_AUTHOR,
      head: branch,
      base: 'main',
      labels: [],
      mergeable: true,
      merge_blocked_reason: null,
    });
    expect(typeof pulls[0].created_at).toBe('string');

    // Detail computes mergeability + stat + commits from the bare repo.
    const detail = await service.getDetail({ project, number: 1 });
    expect(detail.source).toBe('agenthub');
    expect(detail.pr).toMatchObject({ mergeable: true, changed_files: 1, additions: 1 });
    expect(detail.headSha).toBe(headSha);
    expect(detail.commits[0]).toMatchObject({ subject: 'add feature' });

    const diff = await service.diff({ project, number: 1 });
    expect(diff.diff).toContain('feature.txt');
    const files = await service.files({ project, number: 1 });
    expect(files.files[0]).toMatchObject({ filename: 'feature.txt', status: 'added' });

    // Merge: bare main advances, row flips, card moves to Done, events fire.
    const mainBefore = git(bare, 'rev-parse refs/heads/main');
    const result = await service.merge({
      project,
      number: 1,
      mergeMethod: 'squash',
      actor: 'u-tester',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(result.mergedSha);
    expect(git(bare, `rev-list --parents -n1 ${result.mergedSha}`)).toContain(mainBefore);

    const merged = await service.listPulls({ project, state: 'closed', limit: 10 });
    expect(merged[0]).toMatchObject({ number: 1, state: 'closed', merged: true });
    expect(merged[0].merged_at).toBeTruthy();

    const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow;
    expect(card.pr_url).toBe(created.prUrl);
    const doneCol = board.columns.find((c) => c.name === 'Done');
    expect(card.column_id).toBe(doneCol?.id);

    expect(broadcasts.some((b) => b.type === 'webhook_pr_merged')).toBe(true);
    expect(broadcasts.some((b) => b.type === 'card_moved' && b.columnName === 'Done')).toBe(true);
    await vi.waitFor(() => expect(afterBaseBranchMoved).toHaveBeenCalledOnce());
    expect(afterBaseBranchMoved.mock.calls[0][0]).toMatchObject({
      baseBranch: 'main',
      sha: result.mergedSha,
      reason: 'merge',
    });
  });

  it('merge conflict → 409 with mergeable:false; PR stays open', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'agent-hub/dev/session-ffff0000';
    const { headSha } = await seedHostedRepoWithBranch(projectId, branch, {
      conflictOnMain: true,
    });

    const service = createNativePrService({ stmts, broadcast: () => {} });
    service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'Conflicting change',
      body: '',
      author: TEST_PR_AUTHOR,
    });

    const detail = await service.getDetail({ project, number: 1 });
    expect(detail.pr.mergeable).toBe(false);

    const result = await service.merge({
      project,
      number: 1,
      mergeMethod: 'squash',
      actor: 'u-tester',
    });
    expect(result).toMatchObject({ ok: false, status: 409, mergeable: false });
    const [summary] = await service.listPulls({ project, state: 'open', limit: 10 });
    expect(summary).toMatchObject({ number: 1, mergeable: false });
  });

  it('revert: undoes the merge on the base branch, records it, and re-fires the branch-moved hook', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'agent-hub/dev/session-revert01';
    const { bare, headSha } = await seedHostedRepoWithBranch(projectId, branch);

    const broadcasts: Array<Record<string, unknown>> = [];
    const afterBaseBranchMoved = vi.fn<
      (args: {
        project: Project;
        baseBranch: string;
        sha: string;
        reason: 'merge' | 'revert';
      }) => Promise<void>
    >(async () => {});
    const service = createNativePrService({
      stmts,
      broadcast: (data) => broadcasts.push(data),
      afterBaseBranchMoved,
    });
    service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'Add feature',
      body: '',
      author: TEST_PR_AUTHOR,
    });
    const merged = await service.merge({
      project,
      number: 1,
      mergeMethod: 'squash',
      actor: 'u-tester',
    });
    expect(merged.ok).toBe(true);
    expect(git(bare, 'ls-tree --name-only refs/heads/main').split('\n')).toContain('feature.txt');

    const result = await service.revert({ project, number: 1, actor: 'u-reverter' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The file the PR added is gone from the base branch, without a rewrite.
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(result.revertSha);
    expect(git(bare, 'ls-tree --name-only refs/heads/main').split('\n')).not.toContain(
      'feature.txt',
    );

    // The PR stays merged; the revert is recorded alongside it.
    const [summary] = await service.listPulls({ project, state: 'closed', limit: 10 });
    expect(summary).toMatchObject({
      number: 1,
      merged: true,
      reverted: true,
      revert_sha: result.revertSha,
      reverted_by: 'u-reverter',
    });
    expect(summary.reverted_at).toBeTruthy();

    expect(broadcasts.some((b) => b.type === 'native_pr_update' && b.action === 'reverted')).toBe(
      true,
    );
    // The mirror/CI hook must fire again — otherwise the revert stays local
    // to the Hub and GitHub keeps serving the reverted code.
    await vi.waitFor(() => expect(afterBaseBranchMoved).toHaveBeenCalledTimes(2));
    expect(afterBaseBranchMoved.mock.calls[1][0]).toMatchObject({
      baseBranch: 'main',
      sha: result.revertSha,
      reason: 'revert',
    });
  });

  it('revert is refused for an unmerged PR and for an already-reverted one', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'agent-hub/dev/session-revert02';
    const { bare, headSha } = await seedHostedRepoWithBranch(projectId, branch);
    const service = createNativePrService({ stmts, broadcast: () => {} });
    service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'Add feature',
      body: '',
      author: TEST_PR_AUTHOR,
    });

    const whileOpen = await service.revert({ project, number: 1, actor: 'u' });
    expect(whileOpen).toMatchObject({ ok: false, status: 409 });

    await service.merge({ project, number: 1, mergeMethod: 'squash', actor: 'u-tester' });
    expect((await service.revert({ project, number: 1, actor: 'u' })).ok).toBe(true);
    const tipAfterFirst = git(bare, 'rev-parse refs/heads/main');

    // Second revert is refused by the DB guard, before git runs — no second
    // revert commit stacks onto the branch.
    const second = await service.revert({ project, number: 1, actor: 'u' });
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(tipAfterFirst);
  });

  it('marks PR head-change callbacks as created vs reused-head update', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'agent-hub/dev/session-reused';
    const { work, headSha } = await seedHostedRepoWithBranch(projectId, branch);
    const onPrHeadChanged = vi.fn();
    const service = createNativePrService({
      stmts,
      broadcast: () => {},
      onPrHeadChanged,
    });

    service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'Initial PR',
      body: '',
      author: TEST_PR_AUTHOR,
    });

    git(work, 'checkout ' + branch);
    writeFileSync(path.join(work, 'feature.txt'), 'feature\nmore\n');
    git(work, 'add feature.txt');
    git(work, 'commit -m "update feature"');
    const updatedHeadSha = git(work, 'rev-parse HEAD');
    git(work, `push origin ${branch}`);

    service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha: updatedHeadSha,
      title: 'Updated PR',
      body: 'new body',
      author: TEST_PR_AUTHOR,
    });

    expect(onPrHeadChanged).toHaveBeenCalledTimes(2);
    expect(onPrHeadChanged.mock.calls[0][2]).toEqual({ reason: 'created' });
    expect(onPrHeadChanged.mock.calls[1][2]).toEqual({ reason: 'head_updated' });
  });

  it('close transitions the row; double-close and non-hosted projects are rejected', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'agent-hub/dev/session-22220000';
    const { headSha } = await seedHostedRepoWithBranch(projectId, branch);

    const service = createNativePrService({ stmts, broadcast: () => {} });
    service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'To be closed',
      body: '',
      author: 'u1',
    });

    expect(service.close({ project, number: 1 }).row.status).toBe('closed');
    expect(() => service.close({ project, number: 1 })).toThrow(NativePrError);
    await expect(
      service.listPulls({ project: { ...project, gitHost: 'github' }, state: 'open', limit: 5 }),
    ).rejects.toThrow(NativePrError);
    await expect(service.getDetail({ project, number: 99 })).rejects.toThrow('not found');
  });

  it('listPullsForBranch: branch-scoped rows carry linked_epic; non-hosted throws', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'feature/reliability';
    const { headSha } = await seedHostedRepoWithBranch(projectId, branch);
    const service = createNativePrService({ stmts, broadcast: () => {} });

    // Epic whose feature branch IS the pushed branch.
    const board = getOrCreateBoard(stmts, projectId);
    const epicId = uuidv4();
    stmts.createKanbanEpic.run(epicId, board.board.id, 'Reliability', null, '#111', 0, null);
    const { getDb } = await import('../db.js');
    getDb().prepare('UPDATE kanban_epics SET pr_base_branch = ? WHERE id = ?').run(branch, epicId);

    // PR whose head IS the feature branch → relation `integration`.
    service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'Ship reliability',
      body: '',
      author: TEST_PR_AUTHOR,
    });

    const rows = service.listPullsForBranch({ project, branch });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 1, head: branch, base: 'main' });
    expect(rows[0].linked_epic).toMatchObject({
      id: epicId,
      relation: 'integration',
      feature_branch: branch,
    });

    // Guard: a non-hosted project throws rather than returning []. The board
    // endpoint relies on this surfacing (5xx) instead of masking as "no PRs".
    expect(() =>
      service.listPullsForBranch({ project: { ...project, gitHost: 'github' }, branch }),
    ).toThrow(NativePrError);
  });
});
