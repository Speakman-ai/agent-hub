/**
 * NativePrService.updateBranch: live test DB + real git in a hosted bare
 * repo. The git step is wrapped so a test can land a concurrent PR edit
 * while the merge is in flight.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, Project, PullRequestRow, Stmts } from '../types.js';

const hooks = vi.hoisted(() => ({ duringUpdate: null as null | (() => void) }));

vi.mock('./update-branch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./update-branch.js')>();
  return {
    ...real,
    updatePullRequestBranch: async (args: Parameters<typeof real.updatePullRequestBranch>[0]) => {
      const result = await real.updatePullRequestBranch(args);
      hooks.duringUpdate?.();
      return result;
    },
  };
});

let stmts: Stmts;
let createNativePrService: typeof import('./service.js').createNativePrService;
let createHostedRepo: typeof import('../git-host/repo-store.js').createHostedRepo;
let gitHostRepoPath: typeof import('../git-host/repo-store.js').gitHostRepoPath;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest();
  stmts = (await import('../db.js')).stmts!;
  ({ createNativePrService } = await import('./service.js'));
  ({ createHostedRepo, gitHostRepoPath } = await import('../git-host/repo-store.js'));
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

const TEST_PR_AUTHOR = '00000000-0000-4000-8000-000000000010';

/** Hosted repo with a feature branch, then one more commit on main. */
async function seedBehindBranch(projectId: string, branch: string) {
  const work = path.join(os.tmpdir(), `npr-ub-${projectId}-${Math.random().toString(36).slice(2)}`);
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
  writeFileSync(path.join(work, 'main.txt'), 'main\n');
  git(work, 'add main.txt');
  git(work, 'commit -m "main moves"');
  git(work, 'push origin main');
  return { bare, headSha };
}

describe('NativePrService.updateBranch', () => {
  it('moves the head and keeps a title/body edit saved while the merge ran', async () => {
    const projectId = `npr-ub-${uuidv4().slice(0, 8)}`;
    const project = {
      id: projectId,
      name: projectId,
      cwd: '',
      ahw: '',
      gitHost: 'agenthub',
    } as Project;
    const branch = 'agent-hub/dev/session-ub000001';
    const { bare, headSha } = await seedBehindBranch(projectId, branch);

    const broadcasts: Array<Record<string, unknown>> = [];
    const broadcast: BroadcastFn = (data) => broadcasts.push(data);
    const afterHeadBranchMoved = vi.fn(async () => {});
    const service = createNativePrService({ stmts, broadcast, afterHeadBranchMoved });
    const { row } = service.createOrGetOpenPr({
      project,
      headBranch: branch,
      baseBranch: 'main',
      headSha,
      title: 'Original title',
      body: 'Original body',
      author: TEST_PR_AUTHOR,
    });

    const detail = await service.getDetail({ project, number: row.number });
    expect(detail.pr).toMatchObject({ behind_by: 1, mergeable: true });

    hooks.duringUpdate = () => {
      stmts.updatePullRequestText.run('Edited title', 'Edited body', Date.now(), row.id);
    };
    try {
      const result = await service.updateBranch({ project, number: row.number, actor: 'u1' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(git(bare, `rev-parse refs/heads/${branch}`)).toBe(result.headSha);

      const after = stmts.getPullRequestByNumber.get(projectId, row.number) as PullRequestRow;
      expect(after).toMatchObject({
        head_sha: result.headSha,
        title: 'Edited title',
        body: 'Edited body',
      });
      expect(afterHeadBranchMoved).toHaveBeenCalledTimes(1);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'native_pr_update', action: 'updated' }),
      );
    } finally {
      hooks.duringUpdate = null;
    }
  });
});
