/**
 * worktree-process-clone-pat.test.ts
 *
 * Heartbeat/cron process clones use the same repo-aware GitHub token
 * resolution and `-c http.…extraheader` injection as session clones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp', githubApp: null },
}));

vi.mock('./github-app.js', () => ({
  getInstallationToken: vi.fn(async () => null),
  resolveInstallationId: vi.fn(async () => null),
}));

const mockResolveOwnerWithRepoAccess = vi.fn(async (_repo: string) => 'repo-owner-1');
vi.mock('./repo-aware-token.js', () => ({
  resolveOwnerWithRepoAccess: (repo: string) => mockResolveOwnerWithRepoAccess(repo),
}));

const mockResolveUserGithubToken = vi.fn(
  async (_userId: string | null, _opts?: unknown): Promise<string | null> => null,
);
vi.mock('./skill-credentials-github.js', () => ({
  resolveUserGithubToken: (userId: string | null, _opts: unknown) =>
    mockResolveUserGithubToken(userId, _opts),
  gitAuthArgsForGithubPat: (token: string | null | undefined): string[] => {
    if (!token) return [];
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    return ['-c', `http.https://github.com/.extraheader=Authorization: basic ${basic}`];
  },
}));

vi.mock('./spawn-github-credentials.js', () => ({
  resolveOAuthAppCredentials: () => null,
}));

type GitCallRecord = { args: string[]; opts: Record<string, unknown> };
const recorded: { calls: GitCallRecord[] } = { calls: [] };
let cloneFailMessage: string | null = null;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const stubExecFile = (
    _file: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
  ): void => {
    recorded.calls.push({ args: [...args], opts });
    if (args.includes('rev-parse') && args.includes('--git-dir')) {
      setImmediate(() => cb(null, { stdout: '.git', stderr: '' }));
      return;
    }
    if (args.includes('remote') && args.includes('get-url')) {
      setImmediate(() =>
        cb(null, { stdout: 'https://github.com/owner/private-repo.git', stderr: '' }),
      );
      return;
    }
    if (args.includes('clone') && cloneFailMessage !== null) {
      const msg = cloneFailMessage;
      setImmediate(() => cb(new Error(msg), { stdout: '', stderr: msg }));
      return;
    }
    setImmediate(() => cb(null, { stdout: '', stderr: '' }));
  };
  return { ...actual, execFile: stubExecFile };
});

const { getOrCreateProcessWorktree, removeWorkspace } = await import('./worktree.js');
const { execSync: realExecSync } =
  await vi.importActual<typeof import('child_process')>('child_process');

describe('getOrCreateProcessWorktree — heartbeat PAT injection', () => {
  let sourceRepo: string;
  let tmpRoot: string;
  let createdWorkspace: string | null = null;

  function git(cwd: string, cmd: string): string {
    return realExecSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
  }

  beforeEach(() => {
    recorded.calls = [];
    cloneFailMessage = null;
    mockResolveOwnerWithRepoAccess.mockClear();
    mockResolveUserGithubToken.mockReset();

    tmpRoot = path.join(
      os.tmpdir(),
      `wt-process-pat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });

    const originBare = path.join(tmpRoot, 'origin.git');
    mkdirSync(originBare, { recursive: true });
    realExecSync('git init --bare --initial-branch=main', { cwd: originBare, stdio: 'pipe' });

    sourceRepo = path.join(tmpRoot, 'source');
    realExecSync(`git clone --quiet "${originBare}" "${sourceRepo}"`, { stdio: 'pipe' });
    git(sourceRepo, 'config user.email "test@example.com"');
    git(sourceRepo, 'config user.name "Test"');
    git(sourceRepo, 'remote set-url origin https://github.com/owner/private-repo.git');
    createdWorkspace = null;
  });

  afterEach(() => {
    if (createdWorkspace) {
      removeWorkspace(createdWorkspace);
    }
    try {
      const wsParent = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(sourceRepo));
      if (existsSync(wsParent)) {
        rmSync(wsParent, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('resolves repo-aware owner and forwards PAT auth args into process clone', async () => {
    const PAT = 'ghp_process_clone_pat_xyz';
    mockResolveUserGithubToken.mockResolvedValue(PAT);

    const cloneDir = await getOrCreateProcessWorktree(
      sourceRepo,
      'heartbeat-agent-1',
      undefined,
      undefined,
      null,
      'proj-1',
      'owner/private-repo',
    );
    createdWorkspace = cloneDir;

    expect(mockResolveOwnerWithRepoAccess).toHaveBeenCalledWith('owner/private-repo');
    expect(mockResolveUserGithubToken).toHaveBeenCalledWith('repo-owner-1', expect.any(Object));

    const cloneCall = recorded.calls.find((c) => c.args.includes('clone'));
    expect(cloneCall, 'expected git clone').toBeDefined();
    expect(cloneCall!.args[0]).toBe('-c');
    expect(cloneCall!.args[1]).toMatch(/extraheader=Authorization: basic /);
    expect(cloneCall!.args.join(' ')).toContain('https://github.com/owner/private-repo.git');
  });

  it('logs info (not error) when no credential is available for a private remote', async () => {
    mockResolveUserGithubToken.mockResolvedValue(null);
    cloneFailMessage =
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await getOrCreateProcessWorktree(
      sourceRepo,
      'heartbeat-agent-2',
      undefined,
      undefined,
      null,
      'proj-2',
      'owner/private-repo',
    );

    expect(infoSpy).toHaveBeenCalled();
    const infoText = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(infoText).toMatch(/Skipping process clone/i);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('Failed to create clone'))).toBe(
      false,
    );

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('surfaces HTTP 401 when auth header was sent but git reports flush-after-ref', async () => {
    const PAT = 'ghp_bad_cred_flush_test';
    mockResolveUserGithubToken.mockResolvedValue(PAT);
    cloneFailMessage = 'fatal: expected flush after ref listing';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await getOrCreateProcessWorktree(
      sourceRepo,
      'heartbeat-agent-3',
      undefined,
      undefined,
      null,
      'proj-3',
      'owner/private-repo',
    );

    expect(errorSpy).toHaveBeenCalled();
    const errText = errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(errText).toContain('HTTP 401');
    expect(errText).toContain('expected flush after ref listing');

    errorSpy.mockRestore();
  });
});
