import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the repo-store so the on-push module never touches a real bare repo.
const hostedRepoExists = vi.fn<(id: string, dataDir?: string) => boolean>();
const hostedRepoDefaultBranch = vi.fn<(id: string, dataDir?: string) => Promise<string | null>>();
vi.mock('../git-host/repo-store.js', () => ({
  hostedRepoExists: (id: string, dataDir?: string) => hostedRepoExists(id, dataDir),
  hostedRepoDefaultBranch: (id: string, dataDir?: string) => hostedRepoDefaultBranch(id, dataDir),
  gitHostRepoPath: (id: string) => `/tmp/${id}.git`,
}));

const { maybeRunPushSecurityScan, securityScanOnPushEnabled, __clearPushSecurityScanQueues } =
  await import('./on-push.js');
import type { Project } from '../types.js';
import type { RunSecurityScanResult } from './run.js';

function fakeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj',
    name: 'Proj',
    cwd: '/tmp/proj',
    gitHost: 'agenthub',
    ...over,
  } as Project;
}

function fakeResult(over: Partial<RunSecurityScanResult> = {}): RunSecurityScanResult {
  return {
    ref: 'main',
    scannedManifests: [],
    presentManifests: [],
    failedManifests: [],
    truncated: false,
    dependencyCount: 0,
    vulnerableFindings: 0,
    dryRun: false,
    summary: { newFindings: [], reopenedFindings: [], updated: 0, fixed: 0, suppressed: 0 },
    cardId: null,
    autoPr: null,
    ...over,
  };
}

function deps(runScan: ReturnType<typeof vi.fn>) {
  return {
    stmts: {} as never,
    broadcast: vi.fn(),
    runScan: runScan as never,
    dataDir: '/tmp/data',
    log: () => {},
  };
}

beforeEach(() => {
  __clearPushSecurityScanQueues();
  hostedRepoExists.mockReturnValue(true);
  hostedRepoDefaultBranch.mockResolvedValue('main');
});
afterEach(() => vi.clearAllMocks());

describe('securityScanOnPushEnabled', () => {
  it('is true only for Hub-hosted projects with onPush enabled', () => {
    expect(securityScanOnPushEnabled(fakeProject({ securityScan: { onPush: true } }))).toBe(true);
    expect(securityScanOnPushEnabled(fakeProject({ securityScan: { onPush: false } }))).toBe(false);
    expect(securityScanOnPushEnabled(fakeProject())).toBe(false);
    expect(
      securityScanOnPushEnabled(fakeProject({ gitHost: 'github', securityScan: { onPush: true } })),
    ).toBe(false);
  });
});

describe('maybeRunPushSecurityScan', () => {
  it('does nothing when onPush is not enabled', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    await maybeRunPushSecurityScan(fakeProject(), ['refs/heads/main'], deps(runScan));
    expect(runScan).not.toHaveBeenCalled();
  });

  it('does nothing when the hosted repo does not exist', async () => {
    hostedRepoExists.mockReturnValue(false);
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    await maybeRunPushSecurityScan(
      fakeProject({ securityScan: { onPush: true } }),
      ['refs/heads/main'],
      deps(runScan),
    );
    expect(runScan).not.toHaveBeenCalled();
  });

  it('skips when the default branch did not move', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    await maybeRunPushSecurityScan(
      fakeProject({ securityScan: { onPush: true } }),
      ['refs/heads/feature/x'],
      deps(runScan),
    );
    expect(runScan).not.toHaveBeenCalled();
  });

  it('runs a scan when the default branch moved', async () => {
    const runScan = vi.fn().mockResolvedValue(
      fakeResult({
        summary: {
          newFindings: [{ id: 'f1' }],
          reopenedFindings: [],
          updated: 0,
          fixed: 0,
          suppressed: 0,
        } as never,
      }),
    );
    await maybeRunPushSecurityScan(
      fakeProject({ securityScan: { onPush: true } }),
      ['refs/heads/main', 'refs/heads/other'],
      deps(runScan),
    );
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(runScan.mock.calls[0]?.[1]).toMatchObject({ generateCard: true, createdBy: null });
  });

  it('honours a non-main default branch', async () => {
    hostedRepoDefaultBranch.mockResolvedValue('develop');
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    await maybeRunPushSecurityScan(
      fakeProject({ securityScan: { onPush: true } }),
      ['refs/heads/develop'],
      deps(runScan),
    );
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it('swallows scan failures (never rejects)', async () => {
    const runScan = vi.fn().mockRejectedValue(new Error('OSV down'));
    await expect(
      maybeRunPushSecurityScan(
        fakeProject({ securityScan: { onPush: true } }),
        ['refs/heads/main'],
        deps(runScan),
      ),
    ).resolves.toBeUndefined();
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent pushes for the same project', async () => {
    let active = 0;
    let maxActive = 0;
    const runScan = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return fakeResult();
    });
    const project = fakeProject({ securityScan: { onPush: true } });
    await Promise.all([
      maybeRunPushSecurityScan(project, ['refs/heads/main'], deps(runScan)),
      maybeRunPushSecurityScan(project, ['refs/heads/main'], deps(runScan)),
    ]);
    expect(runScan).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1); // never overlapped
  });
});

// ── autofix dispatch ──────────────────────────────────────────────────────
// Before the shared autofix module, `securityAutoPr.enabled` only fired on the
// REST scan route, so a project that opted in never got an automatic fix from
// the scan that actually runs unattended. These pin the wiring.
describe('maybeRunPushSecurityScan — autofix', () => {
  const autofixDeps = {
    stmts: {} as never,
    config: {} as never,
    findAgent: vi.fn() as never,
    handleChat: vi.fn() as never,
    store: { listFindings: vi.fn(() => []) } as never,
  };

  it('dispatches a fix session when the project opted in and the scan found something new', async () => {
    const runScan = vi.fn().mockResolvedValue(
      fakeResult({
        summary: { newFindings: [{}], reopenedFindings: [], updated: 0, fixed: 0, suppressed: 0 },
      } as never),
    );
    const dispatchAutofix = vi.fn(() => ({ session: null, error: null }));
    await maybeRunPushSecurityScan(
      fakeProject({ securityScan: { onPush: true }, securityAutoPr: { enabled: true } }),
      ['refs/heads/main'],
      { ...deps(runScan), autofix: autofixDeps, dispatchAutofix: dispatchAutofix as never },
    );
    expect(dispatchAutofix).toHaveBeenCalledWith(
      autofixDeps,
      expect.objectContaining({ scan: { dryRun: false, newFindings: 1, reopened: 0 } }),
    );
  });

  it('does not dispatch when the project did not opt into autofix', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const dispatchAutofix = vi.fn(() => ({ session: null, error: null }));
    await maybeRunPushSecurityScan(
      fakeProject({ securityScan: { onPush: true } }),
      ['refs/heads/main'],
      { ...deps(runScan), autofix: autofixDeps, dispatchAutofix: dispatchAutofix as never },
    );
    expect(dispatchAutofix).not.toHaveBeenCalled();
  });
});
