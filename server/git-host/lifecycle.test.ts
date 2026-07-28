import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../config.js', () => ({
  default: { dataDir: '/unused-default', apiKey: null },
  resolveAgentHubApiBaseForSpawn: () => 'http://127.0.0.1:3051',
}));
vi.mock('../server-port.js', () => ({ getActualPort: () => 3051 }));

const {
  enableGitHost,
  disableGitHost,
  getGitHostStatus,
  getGitHostImportState,
  refreshGitHostNotifyConfigs,
  __clearGitHostImportStates,
} = await import('./lifecycle.js');
const { gitHostRepoPath, readNotifyConfig, hostedBarePathForProject } =
  await import('./repo-store.js');
import type { Project } from '../types.js';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

describe('git-host lifecycle', () => {
  let tmpRoot: string;
  let dataDir: string;
  let saveProjects: ReturnType<typeof vi.fn<() => void>>;
  let broadcast: ReturnType<typeof vi.fn<(data: Record<string, unknown>) => void>>;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    dataDir = path.join(tmpRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    saveProjects = vi.fn();
    broadcast = vi.fn();
    __clearGitHostImportStates();
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  function seedProjectCwd(dir: string): void {
    mkdirSync(dir, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: dir, stdio: 'pipe' });
    git(dir, 'config user.email "t@example.com"');
    git(dir, 'config user.name "T"');
    writeFileSync(path.join(dir, 'a.txt'), '1\n');
    git(dir, 'add a.txt');
    git(dir, 'commit -m initial');
  }

  function makeProject(id: string, overrides: Partial<Project> = {}): Project {
    return { id, name: id, cwd: '', ahw: '', ...overrides } as Project;
  }

  async function waitForImport(projectId: string): Promise<void> {
    await vi.waitFor(
      () => {
        const state = getGitHostImportState(projectId);
        expect(state?.status === 'ready' || state?.status === 'error').toBe(true);
      },
      { timeout: 10_000 },
    );
  }

  it('enable imports from cwd, rewrites origin, sets gitHost + default mirror policy off (no repoUrl)', async () => {
    const cwd = path.join(tmpRoot, 'proj-cwd');
    seedProjectCwd(cwd);
    const project = makeProject('p1', { cwd });

    const state = enableGitHost(project, { saveProjects, broadcast, dataDir });
    expect(state.status).toBe('importing');
    await waitForImport('p1');

    expect(getGitHostImportState('p1')?.status).toBe('ready');
    expect(project.gitHost).toBe('agenthub');
    expect(project.gitMirror).toBeUndefined();
    expect(saveProjects).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git_host_update', status: 'enabled' }),
    );

    // cwd origin now points at the bare repo → pushes land on the Hub.
    const bare = gitHostRepoPath('p1', dataDir);
    expect(git(cwd, 'remote get-url origin')).toBe(bare);
    git(cwd, 'push origin main');
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(git(cwd, 'rev-parse HEAD'));
  });

  it('enable with repoUrl defaults the mirror policy to default-branch', async () => {
    const cwd = path.join(tmpRoot, 'proj2-cwd');
    seedProjectCwd(cwd);
    const project = makeProject('p2', {
      cwd,
      repoUrl: 'https://github.com/owner/repo.git',
    });

    // importFrom: 'cwd' avoids hitting GitHub in tests; repoUrl only
    // drives the mirror default here.
    enableGitHost(project, { saveProjects, broadcast, dataDir, importFrom: 'cwd' });
    await waitForImport('p2');

    expect(getGitHostImportState('p2')?.status).toBe('ready');
    expect(project.gitMirror).toEqual({ enabled: true, refs: 'default-branch' });
  });

  it('enable failure records error state and leaves gitHost unchanged', async () => {
    const project = makeProject('p3', { cwd: path.join(tmpRoot, 'missing') });
    enableGitHost(project, { saveProjects, broadcast, dataDir, importFrom: 'cwd' });
    await waitForImport('p3');

    expect(getGitHostImportState('p3')?.status).toBe('error');
    expect(project.gitHost).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git_host_update', status: 'error' }),
    );
  });

  it('disable restores origin to repoUrl and keeps the bare repo on disk', async () => {
    const cwd = path.join(tmpRoot, 'proj4-cwd');
    seedProjectCwd(cwd);
    const project = makeProject('p4', {
      cwd,
      repoUrl: 'https://github.com/owner/repo.git',
    });
    enableGitHost(project, { saveProjects, broadcast, dataDir, importFrom: 'cwd' });
    await waitForImport('p4');
    expect(project.gitHost).toBe('agenthub');

    await disableGitHost(project, { saveProjects, broadcast, dataDir });
    expect(project.gitHost).toBe('github');
    expect(git(cwd, 'remote get-url origin')).toBe('https://github.com/owner/repo.git');
    expect(existsSync(gitHostRepoPath('p4', dataDir))).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git_host_update', status: 'disabled' }),
    );
  });

  it('getGitHostStatus reports clone URL, default branch, and mirror policy', async () => {
    const cwd = path.join(tmpRoot, 'proj5-cwd');
    seedProjectCwd(cwd);
    const project = makeProject('p5', { cwd, repoUrl: 'https://github.com/o/r.git' });
    enableGitHost(project, { saveProjects, broadcast, dataDir, importFrom: 'cwd' });
    await waitForImport('p5');

    const status = await getGitHostStatus(project, dataDir);
    expect(status.enabled).toBe(true);
    expect(status.cloneUrl).toBe('http://127.0.0.1:3051/git/p5.git');
    expect(status.defaultBranch).toBe('main');
    expect(status.branchCount).toBe(1);
    expect(status.mirror).toEqual({
      enabled: true,
      refs: 'default-branch',
      githubRepo: 'o/r',
      repoUrl: 'https://github.com/o/r.git',
    });

    const off = await getGitHostStatus(makeProject('p-none'), dataDir);
    expect(off.enabled).toBe(false);
    expect(off.cloneUrl).toBeNull();
  });

  it('refreshGitHostNotifyConfigs rewrites notify URLs for hosted projects only', async () => {
    const cwd = path.join(tmpRoot, 'proj6-cwd');
    seedProjectCwd(cwd);
    const hosted = makeProject('p6', { cwd });
    enableGitHost(hosted, { saveProjects, broadcast, dataDir, importFrom: 'cwd' });
    await waitForImport('p6');

    refreshGitHostNotifyConfigs([hosted, makeProject('p-other')], dataDir);
    const conf = readNotifyConfig('p6', dataDir);
    expect(conf?.url).toBe('http://127.0.0.1:3051/git/internal/hooks/post-receive');
    expect(conf?.projectId).toBe('p6');
  });

  it('hostedBarePathForProject is null unless gitHost is agenthub', () => {
    expect(hostedBarePathForProject(makeProject('x'), dataDir)).toBeNull();
    expect(hostedBarePathForProject(makeProject('x', { gitHost: 'github' }), dataDir)).toBeNull();
    expect(hostedBarePathForProject(makeProject('x', { gitHost: 'agenthub' }), dataDir)).toBe(
      gitHostRepoPath('x', dataDir),
    );
  });
});
