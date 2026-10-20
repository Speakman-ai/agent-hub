/**
 * Default-branch watcher: a local bare repo stands in for the GitHub origin
 * (real `git ls-remote` / fetch against a file path, no network), the job
 * phase is stubbed, and runs land in the live test DB.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { FinalizeRunRow, Project, Stmts } from '../types.js';

let stmts: Stmts;
let watcherMod: typeof import('./default-branch-watcher.js');
let pushCi: typeof import('./push-ci.js');
let mirrorMod: typeof import('./origin-mirror.js');
let handleGithubCardOnMerge: typeof import('../github-card-on-merge.js').handleGithubCardOnMerge;
let dataDir: string;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest();
  stmts = (await import('../db.js')).stmts!;
  watcherMod = await import('./default-branch-watcher.js');
  pushCi = await import('./push-ci.js');
  mirrorMod = await import('./origin-mirror.js');
  ({ handleGithubCardOnMerge } = await import('../github-card-on-merge.js'));
  dataDir = path.join(os.tmpdir(), `dbw-data-${uuidv4().slice(0, 8)}`);
});

beforeEach(() => {
  pushCi.__clearPushCiQueues();
});

let stopWatcher: (() => void) | null = null;
afterEach(() => {
  stopWatcher?.();
  stopWatcher = null;
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

const CI_YAML = [
  'version: 2',
  'on: [push]',
  'timeout_minutes: 10',
  'jobs:',
  '  unit:',
  '    runs-on: ubuntu-24.04',
  '    steps:',
  '      - name: test',
  '        run: echo ok',
].join('\n');

/** A bare "GitHub" origin plus a working clone to push new commits from. */
function seedOrigin(): { project: Project; origin: string; work: string; push: () => string } {
  const id = `dbw-${uuidv4().slice(0, 8)}`;
  const root = path.join(os.tmpdir(), `dbw-${id}`);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  mkdirSync(work, { recursive: true });
  execSync(`git init --quiet --bare --initial-branch=main ${origin}`, { stdio: 'pipe' });
  execSync('git init --quiet --initial-branch=main', { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email "t@example.com"');
  git(work, 'config user.name "T"');
  mkdirSync(path.join(work, '.agent-hub'), { recursive: true });
  writeFileSync(path.join(work, '.agent-hub', 'ci.yaml'), CI_YAML);
  let n = 0;
  const push = (): string => {
    writeFileSync(path.join(work, 'src.txt'), `rev ${n++}\n`);
    git(work, 'add -A');
    git(work, `commit --quiet -m "rev ${n}"`);
    // Fetch into the origin rather than push (session shells block `git push`).
    git(origin, `fetch --quiet ${work} +refs/heads/main:refs/heads/main`);
    return git(work, 'rev-parse HEAD');
  };
  const project = {
    id,
    name: id,
    cwd: work,
    ahw: '',
    gitHost: 'github',
    ciOnPush: { enabled: true },
  } as Project;
  return { project, origin, work, push };
}

function runFor(project: Project, sha: string): FinalizeRunRow | undefined {
  return stmts.getFinalizeRunByIdempotencyKey.get(`git-push|${project.id}|${sha}`) as
    | FinalizeRunRow
    | undefined;
}

async function waitForTerminal(project: Project, sha: string): Promise<FinalizeRunRow> {
  let row: FinalizeRunRow | undefined;
  await vi.waitFor(
    () => {
      row = runFor(project, sha);
      expect(row && !['queued', 'running'].includes(row.status)).toBe(true);
    },
    { timeout: 15_000, interval: 50 },
  );
  return row!;
}

function makeDeps(
  projects: Project[],
  origin: string,
  overrides: Partial<import('./default-branch-watcher.js').DefaultBranchWatcherDeps> = {},
) {
  const runJobPhase = vi.fn(async () => ({
    status: 'success' as const,
    stepResults: [],
    activeSecondsBilled: 1,
  }));
  const recordDefaultBranch = vi.fn(async () => {});
  const deps = {
    stmts,
    broadcast: () => {},
    getProjects: () => projects,
    dataDir,
    gitEnv: async () => ({ ...process.env }),
    resolveUrl: async () => origin,
    pushCi: {
      runJobPhase: runJobPhase as never,
      mergeSecrets: () => {},
      recordDefaultBranch: recordDefaultBranch as never,
    },
    ...overrides,
  };
  return { deps, runJobPhase, recordDefaultBranch };
}

describe('parseSymrefHead', () => {
  it('reads the default branch and its head', () => {
    const sha = 'a'.repeat(40);
    expect(mirrorMod.parseSymrefHead(`ref: refs/heads/trunk\tHEAD\n${sha}\tHEAD\n`)).toEqual({
      branch: 'trunk',
      sha,
    });
  });

  it('returns null without a symref or sha', () => {
    expect(mirrorMod.parseSymrefHead(`${'a'.repeat(40)}\tHEAD\n`)).toBeNull();
    expect(mirrorMod.parseSymrefHead('ref: refs/heads/main\tHEAD\n')).toBeNull();
  });
});

describe('default-branch watcher', () => {
  it('runs full CI once per new head and ignores an unchanged head', async () => {
    const { project, origin, push } = seedOrigin();
    const first = push();
    const { deps, runJobPhase, recordDefaultBranch } = makeDeps([project], origin);
    const watcher = watcherMod.createDefaultBranchWatcher(deps);

    const r1 = await watcher.poll(project.id);
    expect(r1).toMatchObject({ status: 'checked', admission: 'admitted' });
    const row1 = await waitForTerminal(project, first);
    expect(row1.status).toBe('succeeded');
    expect(row1.trigger_source).toBe('git_push');
    expect(row1.branch).toBe('main');

    expect(await watcher.poll(project.id)).toEqual({ status: 'skipped', reason: 'unchanged' });
    expect(runJobPhase).toHaveBeenCalledTimes(1);

    const second = push();
    expect(await watcher.poll(project.id)).toMatchObject({ admission: 'admitted' });
    expect((await waitForTerminal(project, second)).status).toBe('succeeded');
    expect(runJobPhase).toHaveBeenCalledTimes(2);

    // Default-branch health sees the run, against the local mirror.
    expect(recordDefaultBranch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: project.id,
        headSha: second,
        outcome: 'succeeded',
        fullRun: true,
        repoDir: mirrorMod.originMirrorPath(project.id, dataDir),
      }),
    );
  });

  it('dedupes per sha across watcher restarts and concurrent polls', async () => {
    const { project, origin, push } = seedOrigin();
    const sha = push();
    const a = makeDeps([project], origin);
    const watcher = watcherMod.createDefaultBranchWatcher(a.deps);
    const [p1, p2, p3] = await Promise.all([
      watcher.poll(project.id),
      watcher.poll(project.id),
      watcher.poll(project.id),
    ]);
    expect(p1).toMatchObject({ admission: 'admitted' });
    // The second and third requests coalesced into one follow-up poll.
    expect(p2).toEqual(p3);
    await waitForTerminal(project, sha);
    expect(a.runJobPhase).toHaveBeenCalledTimes(1);

    // A fresh process has no lastSeen, but push CI's per-sha dedupe holds.
    const b = makeDeps([project], origin);
    const restarted = watcherMod.createDefaultBranchWatcher(b.deps);
    expect(await restarted.poll(project.id)).toMatchObject({ admission: 'nothing' });
    expect(b.runJobPhase).not.toHaveBeenCalled();
  });

  it('records failures like the hosted path', async () => {
    const { project, origin, push } = seedOrigin();
    const sha = push();
    const { deps, recordDefaultBranch } = makeDeps([project], origin, {});
    deps.pushCi.runJobPhase = vi.fn(async () => ({
      status: 'failed' as const,
      stepResults: [],
      activeSecondsBilled: 1,
    })) as never;
    await watcherMod.createDefaultBranchWatcher(deps).poll(project.id);
    const row = await waitForTerminal(project, sha);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('checks_failed');
    expect(recordDefaultBranch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: sha, outcome: 'failed' }),
    );
  });

  it('retries a head whose fetch failed on the next poll', async () => {
    const { project, origin, push } = seedOrigin();
    const sha = push();
    const syncMirror = vi
      .fn<typeof mirrorMod.syncOriginMirror>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation((args) => mirrorMod.syncOriginMirror(args));
    const { deps } = makeDeps([project], origin, { syncMirror });
    const watcher = watcherMod.createDefaultBranchWatcher(deps);
    expect(await watcher.poll(project.id)).toMatchObject({ admission: 'error' });
    expect(runFor(project, sha)).toBeUndefined();
    expect(await watcher.poll(project.id)).toMatchObject({ admission: 'admitted' });
    expect((await waitForTerminal(project, sha)).status).toBe('succeeded');
  });

  it('caches the head admission checked, not the first observation', async () => {
    const { project, origin, push } = seedOrigin();
    const a = push();
    const b = push();
    // The first read still sees A; by the admission re-read origin is at B.
    let calls = 0;
    const lsRemote = async (url: string, env: NodeJS.ProcessEnv) => {
      calls += 1;
      if (calls === 1) return { branch: 'main', sha: a };
      return mirrorMod.lsRemoteDefaultHead(url, env);
    };
    const { deps } = makeDeps([project], origin, { lsRemote });
    const watcher = watcherMod.createDefaultBranchWatcher(deps);
    expect(await watcher.poll(project.id)).toMatchObject({ admission: 'admitted' });
    expect((await waitForTerminal(project, b)).status).toBe('succeeded');
    expect(runFor(project, a)).toBeUndefined();

    // The branch returns to A, which never got CI: it must run now.
    git(origin, `update-ref refs/heads/main ${a}`);
    expect(await watcher.poll(project.id)).toMatchObject({ admission: 'admitted' });
    expect((await waitForTerminal(project, a)).status).toBe('succeeded');
  });

  it('skips Hub-hosted projects and projects without CI on push', async () => {
    const { project, origin } = seedOrigin();
    const lsRemote = vi.fn();
    const hosted = { ...project, gitHost: 'agenthub' } as Project;
    const off = { ...project, id: `${project.id}-off`, ciOnPush: { enabled: false } } as Project;
    const { deps } = makeDeps([hosted, off], origin, { lsRemote });
    const watcher = watcherMod.createDefaultBranchWatcher(deps);
    await watcher.tick();
    expect(await watcher.poll(off.id)).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(lsRemote).not.toHaveBeenCalled();
  });

  it('polls right away when the Hub merges a GitHub PR', async () => {
    const { project, origin, push } = seedOrigin();
    const first = push();
    const { deps } = makeDeps([project], origin);
    // An hour-long interval: only the boot tick and the merge seam can poll.
    const watcher = watcherMod.startDefaultBranchWatcher(deps, { intervalMs: 3_600_000 });
    stopWatcher = watcher.stop;
    await waitForTerminal(project, first);

    const merged = push();
    handleGithubCardOnMerge(
      { stmts, broadcast: () => {} },
      {
        projectId: project.id,
        prUrl: 'https://github.com/acme/widgets/pull/7',
        prNumber: 7,
        mergedBy: 'auto-merge',
      },
    );
    expect((await waitForTerminal(project, merged)).status).toBe('succeeded');
  });

  it('re-runs a GitHub-hosted run from the mirror', async () => {
    const { project, origin, push } = seedOrigin();
    const sha = push();
    const { deps, runJobPhase } = makeDeps([project], origin);
    await watcherMod.createDefaultBranchWatcher(deps).poll(project.id);
    const original = await waitForTerminal(project, sha);

    await pushCi.rerunCiRun(project, original, {
      stmts,
      broadcast: () => {},
      dataDir,
      ...deps.pushCi,
    });
    expect(runJobPhase).toHaveBeenCalledTimes(2);
  });
});
