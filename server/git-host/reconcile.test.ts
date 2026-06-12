/**
 * Reconcile tests. "GitHub" is a second local bare repo reached via
 * `fetchUrlOverride` + `pushUrlOverride` (no network, no tokens). Each
 * test drives a real divergence shape between the hosted bare repo and
 * "GitHub" and asserts the reconcile outcome + recorded mirror state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

const mocks = vi.hoisted(() => ({
  config: { apiKey: null as string | null, dataDir: '/unused-by-tests' },
  getAuthRecord: vi.fn((): unknown => null),
  getActiveOrgId: vi.fn((): string => 'org-1'),
  getUserById: vi.fn((): { id: string; username: string } | null => null),
  getMembershipRole: vi.fn((): string | null => null),
  verifyApiKey: vi.fn((_t: unknown): unknown => null),
}));

vi.mock('../config.js', () => ({ default: mocks.config }));
vi.mock('../auth-store.js', () => ({ getAuthRecord: mocks.getAuthRecord }));
vi.mock('../orgs.js', () => ({ getActiveOrgId: mocks.getActiveOrgId }));
vi.mock('../users-store.js', () => ({ getUserById: mocks.getUserById }));
vi.mock('../memberships-store.js', () => ({ getMembershipRole: mocks.getMembershipRole }));
vi.mock('../api-keys-store.js', () => ({ verifyApiKey: mocks.verifyApiKey }));

const { reconcileMirror } = await import('./reconcile.js');
const { readMirrorState, __clearMirrorQueues } = await import('./mirror.js');
const { createHostedRepo, gitHostRepoPath } = await import('./repo-store.js');
import type { Project } from '../types.js';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    cwd: '',
    ahw: '',
    gitHost: 'agenthub',
    repoUrl: 'https://github.com/owner/repo.git',
    ...overrides,
  } as Project;
}

describe('git-host mirror reconcile', () => {
  let tmpRoot: string;
  let dataDir: string;
  let githubBare: string;
  let broadcast: ReturnType<typeof vi.fn<(data: Record<string, unknown>) => void>>;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    dataDir = path.join(tmpRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    githubBare = path.join(tmpRoot, 'github.git');
    mkdirSync(githubBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: githubBare, stdio: 'pipe' });
    broadcast = vi.fn();
    __clearMirrorQueues();
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Seed a hosted bare repo + GitHub sharing one common base commit. */
  async function seedShared(projectId: string): Promise<{ bare: string; base: string }> {
    const seed = path.join(tmpRoot, `${projectId}-seed`);
    mkdirSync(seed, { recursive: true });
    git(seed, 'init --initial-branch=main');
    git(seed, 'config user.email t@example.com');
    git(seed, 'config user.name T');
    writeFileSync(path.join(seed, 'base.txt'), 'base\n');
    git(seed, 'add base.txt');
    git(seed, 'commit -m base');
    await createHostedRepo({ id: projectId, cwd: seed, repoUrl: null }, { dataDir });
    // Push the same base into "GitHub" so the two share history.
    git(seed, `remote add gh "${githubBare}"`);
    git(seed, 'push gh main');
    return { bare: gitHostRepoPath(projectId, dataDir), base: git(seed, 'rev-parse HEAD') };
  }

  /** Seed a hosted bare repo only; "GitHub" stays empty (no default branch). */
  async function seedHubOnly(projectId: string): Promise<{ bare: string; sha: string }> {
    const seed = path.join(tmpRoot, `${projectId}-seed`);
    mkdirSync(seed, { recursive: true });
    git(seed, 'init --initial-branch=main');
    git(seed, 'config user.email t@example.com');
    git(seed, 'config user.name T');
    writeFileSync(path.join(seed, 'base.txt'), 'base\n');
    git(seed, 'add base.txt');
    git(seed, 'commit -m base');
    await createHostedRepo({ id: projectId, cwd: seed, repoUrl: null }, { dataDir });
    const bare = gitHostRepoPath(projectId, dataDir);
    return { bare, sha: git(bare, 'rev-parse refs/heads/main') };
  }

  /** Clone a bare, add a commit, push it back. Returns the new sha. */
  function commitOnto(bare: string, label: string, file: string, content: string): string {
    const work = path.join(tmpRoot, `work-${label}-${Math.random().toString(36).slice(2)}`);
    git(tmpRoot, `clone "${bare}" "${work}"`);
    git(work, 'config user.email t@example.com');
    git(work, 'config user.name T');
    writeFileSync(path.join(work, file), content);
    git(work, `add ${file}`);
    git(work, `commit -m ${label}`);
    git(work, 'push origin HEAD:main');
    return git(work, 'rev-parse HEAD');
  }

  const deps = () => ({
    broadcast,
    dataDir,
    fetchUrlOverride: githubBare,
    pushUrlOverride: githubBare,
  });

  it('reports synced when the branches match', async () => {
    await seedShared('r1');
    const result = await reconcileMirror(makeProject('r1'), deps());
    expect(result.status).toBe('synced');
    expect(result.action).toBe('none');
    expect(readMirrorState('r1', dataDir).status).toBe('synced');
  });

  it('pulls GitHub-only commits into the Hub when GitHub is ahead (the release-bot case)', async () => {
    const { bare } = await seedShared('r2');
    const ghSha = commitOnto(githubBare, 'release', 'package.json', '{"version":"2.8.0"}\n');

    const result = await reconcileMirror(makeProject('r2'), deps());

    expect(result.action).toBe('pulled');
    expect(result.status).toBe('synced');
    // Hub default branch fast-forwarded to GitHub's tip.
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(ghSha);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git_host_mirror', status: 'pulled' }),
    );
    const state = readMirrorState('r2', dataDir);
    // After FF both sides are at GitHub's tip with zeroed divergence.
    expect(state).toMatchObject({
      status: 'synced',
      diverged: false,
      hubSha: ghSha,
      githubSha: ghSha,
      aheadBy: 0,
      behindBy: 0,
    });
  });

  it('creates the GitHub branch when the mirror target is empty (no default branch yet)', async () => {
    const { bare, sha } = await seedHubOnly('r7');

    const result = await reconcileMirror(makeProject('r7'), deps());

    // The previously-unreachable !githubSha path: fetch of a missing remote
    // ref is recognized as "branch absent" and we push to create it.
    expect(result.action).toBe('pushed');
    expect(result.status).toBe('synced');
    expect(git(githubBare, 'rev-parse refs/heads/main')).toBe(sha);
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(sha);
    const state = readMirrorState('r7', dataDir);
    expect(state).toMatchObject({
      status: 'synced',
      aheadBy: 0,
      behindBy: 0,
      githubSha: sha,
      hubSha: sha,
    });
  });

  it('pushes Hub-only commits to GitHub when the Hub is ahead', async () => {
    const { bare } = await seedShared('r3');
    const hubSha = commitOnto(bare, 'feature', 'feature.txt', 'feat\n');

    const result = await reconcileMirror(makeProject('r3'), deps());

    expect(result.action).toBe('pushed');
    expect(result.status).toBe('synced');
    expect(git(githubBare, 'rev-parse refs/heads/main')).toBe(hubSha);
    // Terminal synced state reflects the final tips, not the pre-push inputs.
    expect(result).toMatchObject({ hubSha, githubSha: hubSha, aheadBy: 0, behindBy: 0 });
    const state = readMirrorState('r3', dataDir);
    expect(state).toMatchObject({ hubSha, githubSha: hubSha, aheadBy: 0, behindBy: 0 });
  });

  it('auto-merges a clean divergence and pushes the merge to GitHub', async () => {
    const { bare } = await seedShared('r4');
    // Two unique commits touching DIFFERENT files → conflict-free merge.
    const hubSha = commitOnto(bare, 'hubwork', 'hub.txt', 'hub\n');
    const ghSha = commitOnto(githubBare, 'release', 'package.json', '{"version":"2.8.0"}\n');

    const result = await reconcileMirror(makeProject('r4'), deps());

    expect(result.action).toBe('merged');
    expect(result.status).toBe('synced');
    const hubTip = git(bare, 'rev-parse refs/heads/main');
    // Merge commit has both sides as parents and is now on GitHub too.
    const parents = git(bare, `rev-list --parents -n1 ${hubTip}`).split(' ').slice(1);
    expect(parents).toContain(hubSha);
    expect(parents).toContain(ghSha);
    expect(git(githubBare, 'rev-parse refs/heads/main')).toBe(hubTip);
    // Terminal synced state points at the merge commit on BOTH sides with
    // zeroed divergence — not the pre-merge diverged inputs.
    expect(result).toMatchObject({ hubSha: hubTip, githubSha: hubTip, aheadBy: 0, behindBy: 0 });
    expect(readMirrorState('r4', dataDir)).toMatchObject({
      status: 'synced',
      diverged: false,
      hubSha: hubTip,
      githubSha: hubTip,
      aheadBy: 0,
      behindBy: 0,
    });
  });

  it('does NOT mutate the Hub when a clean merge cannot be pushed to GitHub', async () => {
    const { bare } = await seedShared('r8');
    const hubSha = commitOnto(bare, 'hubwork', 'hub.txt', 'hub\n');
    const ghSha = commitOnto(githubBare, 'release', 'package.json', '{"version":"2.8.0"}\n');

    // Fetch from the real "GitHub" bare, but aim the push at a broken target
    // so the post-merge push fails after a clean merge-tree.
    const result = await reconcileMirror(makeProject('r8'), {
      broadcast,
      dataDir,
      fetchUrlOverride: githubBare,
      pushUrlOverride: path.join(tmpRoot, 'does-not-exist.git'),
    });

    expect(result.action).toBe('diverged');
    expect(result.status).toBe('diverged');
    // The served Hub ref is UNCHANGED — no auto-merge commit was left
    // behind, so a transient push failure can't turn divergence into a
    // permanent Hub-ahead state.
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(hubSha);
    // GitHub is untouched too (the push never landed).
    expect(git(githubBare, 'rev-parse refs/heads/main')).toBe(ghSha);
    const state = readMirrorState('r8', dataDir);
    expect(state.diverged).toBe(true);
    expect(state.status).toBe('diverged');
    expect(state.lastError).toBeTruthy();
  });

  it('flags diverged (no mutation) when the branches cannot be merged automatically', async () => {
    const { bare } = await seedShared('r5');
    // Both edit the SAME file with conflicting content → merge conflict.
    const hubSha = commitOnto(bare, 'hubedit', 'base.txt', 'hub-change\n');
    commitOnto(githubBare, 'ghedit', 'base.txt', 'github-change\n');

    const result = await reconcileMirror(makeProject('r5'), deps());

    expect(result.action).toBe('diverged');
    expect(result.status).toBe('diverged');
    // Hub branch is UNCHANGED — no force, no rewrite.
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(hubSha);
    const state = readMirrorState('r5', dataDir);
    expect(state.diverged).toBe(true);
    expect(state.status).toBe('diverged');
    expect(state.aheadBy).toBe(1);
    expect(state.behindBy).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git_host_mirror', status: 'diverged' }),
    );
  });

  it('skips non-hosted / mirror-disabled projects', async () => {
    await seedShared('r6');
    expect((await reconcileMirror(makeProject('r6', { gitHost: 'github' }), deps())).action).toBe(
      'skipped',
    );
    expect(
      (await reconcileMirror(makeProject('r6', { gitMirror: { enabled: false } }), deps())).action,
    ).toBe('skipped');
  });
});
