/**
 * NativePrService tests — live test DB (test/setup) + real git against a
 * hosted bare repo in the per-process test data dir. Covers the PR
 * lifecycle end-to-end including the kanban Done-move and the afterMerge
 * mirror hook.
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
  it('full lifecycle: create → list/detail shapes → merge → card Done + events + afterMerge', async () => {
    const projectId = `npr-${uuidv4().slice(0, 8)}`;
    const project = makeProject(projectId);
    const branch = 'agent-hub/dev/session-abcd1234';
    const { bare, headSha } = await seedHostedRepoWithBranch(projectId, branch);

    const broadcasts: Array<Record<string, unknown>> = [];
    const broadcast: BroadcastFn = (data) => broadcasts.push(data);
    const afterMerge = vi.fn<
      (args: { project: Project; baseBranch: string; mergedSha: string }) => Promise<void>
    >(async () => {});
    const service = createNativePrService({ stmts, broadcast, afterMerge });

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
    const pulls = service.listPulls({ project, state: 'open', limit: 30 });
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

    const merged = service.listPulls({ project, state: 'closed', limit: 10 });
    expect(merged[0]).toMatchObject({ number: 1, state: 'closed', merged: true });
    expect(merged[0].merged_at).toBeTruthy();

    const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow;
    expect(card.pr_url).toBe(created.prUrl);
    const doneCol = board.columns.find((c) => c.name === 'Done');
    expect(card.column_id).toBe(doneCol?.id);

    expect(broadcasts.some((b) => b.type === 'webhook_pr_merged')).toBe(true);
    expect(broadcasts.some((b) => b.type === 'card_moved' && b.columnName === 'Done')).toBe(true);
    await vi.waitFor(() => expect(afterMerge).toHaveBeenCalledOnce());
    expect(afterMerge.mock.calls[0][0]).toMatchObject({
      baseBranch: 'main',
      mergedSha: result.mergedSha,
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
    expect(service.listPulls({ project, state: 'open', limit: 10 })).toHaveLength(1);
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
    expect(() =>
      service.listPulls({ project: { ...project, gitHost: 'github' }, state: 'open', limit: 5 }),
    ).toThrow(NativePrError);
    await expect(service.getDetail({ project, number: 99 })).rejects.toThrow('not found');
  });
});
