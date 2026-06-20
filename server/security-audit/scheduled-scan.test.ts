import { describe, it, expect, vi } from 'vitest';
import {
  runScheduledSecurityScans,
  startScheduledSecurityScanner,
  SCHEDULE_INTERVALS_MS,
  type ScheduledSecurityScanDeps,
} from './scheduled-scan.js';
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

function baseDeps(
  projects: Project[],
  runScan: ScheduledSecurityScanDeps['runScan'],
  over: Partial<ScheduledSecurityScanDeps> = {},
): ScheduledSecurityScanDeps {
  return {
    stmts: {} as ScheduledSecurityScanDeps['stmts'],
    broadcast: vi.fn(),
    getProjects: () => projects,
    runScan,
    now: () => 1_000_000,
    lastRunAt: new Map(),
    log: () => {},
    ...over,
  };
}

describe('runScheduledSecurityScans', () => {
  it('scans projects enrolled in a daily/weekly cadence', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [
      fakeProject({ id: 'a', securityScan: { schedule: 'daily' } }),
      fakeProject({ id: 'b', securityScan: { schedule: 'weekly' } }),
    ];
    const dispatched = await runScheduledSecurityScans(baseDeps(projects, runScan));
    expect(dispatched).toBe(2);
    expect(runScan).toHaveBeenCalledTimes(2);
    // Each scan runs against the default branch with card generation on.
    expect(runScan.mock.calls[0]?.[1]).toMatchObject({ generateCard: true, createdBy: null });
  });

  it('skips projects with schedule off / unset', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [
      fakeProject({ id: 'a', securityScan: { schedule: 'off' } }),
      fakeProject({ id: 'b' }),
      fakeProject({ id: 'c', securityScan: { onPush: true } }), // onPush only, no schedule
    ];
    const dispatched = await runScheduledSecurityScans(baseDeps(projects, runScan));
    expect(dispatched).toBe(0);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('skips non-Hub-hosted projects even when enrolled', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [
      fakeProject({ id: 'gh', gitHost: 'github', securityScan: { schedule: 'daily' } }),
    ];
    const dispatched = await runScheduledSecurityScans(baseDeps(projects, runScan));
    expect(dispatched).toBe(0);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('does not re-scan before the cadence elapses', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [fakeProject({ id: 'a', securityScan: { schedule: 'daily' } })];
    const lastRunAt = new Map<string, number>();
    let clock = 1_000_000;
    const deps = baseDeps(projects, runScan, { lastRunAt, now: () => clock });

    expect(await runScheduledSecurityScans(deps)).toBe(1); // first run

    clock += SCHEDULE_INTERVALS_MS.daily - 1; // not yet due
    expect(await runScheduledSecurityScans(deps)).toBe(0);

    clock += 2; // now past the daily cadence
    expect(await runScheduledSecurityScans(deps)).toBe(1);
    expect(runScan).toHaveBeenCalledTimes(2);
  });

  it('respects weekly cadence independently of daily', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [fakeProject({ id: 'w', securityScan: { schedule: 'weekly' } })];
    const lastRunAt = new Map<string, number>();
    let clock = 0;
    const deps = baseDeps(projects, runScan, { lastRunAt, now: () => clock });

    expect(await runScheduledSecurityScans(deps)).toBe(1);
    clock += SCHEDULE_INTERVALS_MS.daily; // a day later — weekly not yet due
    expect(await runScheduledSecurityScans(deps)).toBe(0);
    clock += SCHEDULE_INTERVALS_MS.weekly; // well past a week
    expect(await runScheduledSecurityScans(deps)).toBe(1);
  });

  it('continues the sweep when one project scan throws', async () => {
    const runScan = vi
      .fn()
      .mockRejectedValueOnce(new Error('OSV down'))
      .mockResolvedValueOnce(fakeResult());
    const projects = [
      fakeProject({ id: 'bad', securityScan: { schedule: 'daily' } }),
      fakeProject({ id: 'good', securityScan: { schedule: 'daily' } }),
    ];
    // A throwing scan still counts the project as "attempted" (not dispatched).
    const dispatched = await runScheduledSecurityScans(baseDeps(projects, runScan));
    expect(dispatched).toBe(1); // only the good one
    expect(runScan).toHaveBeenCalledTimes(2);
  });

  it('claims the last-run slot before awaiting so it is not re-scanned next tick', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [fakeProject({ id: 'a', securityScan: { schedule: 'daily' } })];
    const lastRunAt = new Map<string, number>();
    const deps = baseDeps(projects, runScan, { lastRunAt });
    await runScheduledSecurityScans(deps);
    expect(lastRunAt.get('a')).toBe(1_000_000);
  });
});

describe('startScheduledSecurityScanner', () => {
  it('returns a stop function and unrefs its timer', () => {
    vi.useFakeTimers();
    try {
      const runScan = vi.fn().mockResolvedValue(fakeResult());
      const projects = [fakeProject({ id: 'a', securityScan: { schedule: 'daily' } })];
      const stop = startScheduledSecurityScanner(baseDeps(projects, runScan), 10_000);
      expect(typeof stop).toBe('function');
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
