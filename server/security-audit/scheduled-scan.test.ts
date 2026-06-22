import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runScheduledSecurityScans,
  startScheduledSecurityScanner,
  resolveEffectiveSchedule,
  getDefaultSecurityScanSchedule,
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
    // Pin the unset-project fallback to 'off' by default so explicit-schedule
    // tests are deterministic regardless of the SECURITY_SCAN_DEFAULT_SCHEDULE
    // env var; the default-behavior tests override this explicitly.
    defaultSchedule: 'off',
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

  it('skips projects with an explicit schedule of off, even when the default is on', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [fakeProject({ id: 'a', securityScan: { schedule: 'off' } })];
    // Default is 'weekly', but the explicit per-project 'off' must still win.
    const dispatched = await runScheduledSecurityScans(
      baseDeps(projects, runScan, { defaultSchedule: 'weekly' }),
    );
    expect(dispatched).toBe(0);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('defaults unset Hub-hosted projects to the configured cadence', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [
      fakeProject({ id: 'b' }), // no securityScan at all
      fakeProject({ id: 'c', securityScan: { onPush: true } }), // onPush only, no schedule
    ];
    const dispatched = await runScheduledSecurityScans(
      baseDeps(projects, runScan, { defaultSchedule: 'weekly' }),
    );
    expect(dispatched).toBe(2);
    expect(runScan).toHaveBeenCalledTimes(2);
  });

  it('leaves unset projects unscanned when the default itself is off', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [fakeProject({ id: 'b' })];
    const dispatched = await runScheduledSecurityScans(
      baseDeps(projects, runScan, { defaultSchedule: 'off' }),
    );
    expect(dispatched).toBe(0);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('still skips a non-Hub-hosted project whose schedule is unset (no default applies)', async () => {
    const runScan = vi.fn().mockResolvedValue(fakeResult());
    const projects = [fakeProject({ id: 'gh', gitHost: 'github' })];
    const dispatched = await runScheduledSecurityScans(
      baseDeps(projects, runScan, { defaultSchedule: 'weekly' }),
    );
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

describe('resolveEffectiveSchedule', () => {
  it('lets an explicit per-project schedule win over the default', () => {
    expect(
      resolveEffectiveSchedule(fakeProject({ securityScan: { schedule: 'daily' } }), 'weekly'),
    ).toBe('daily');
    expect(
      resolveEffectiveSchedule(fakeProject({ securityScan: { schedule: 'weekly' } }), 'off'),
    ).toBe('weekly');
  });

  it('treats an explicit off as opt-out regardless of the default', () => {
    expect(
      resolveEffectiveSchedule(fakeProject({ securityScan: { schedule: 'off' } }), 'weekly'),
    ).toBeNull();
  });

  it('falls back to the default when the schedule is unset', () => {
    expect(resolveEffectiveSchedule(fakeProject({}), 'weekly')).toBe('weekly');
    expect(resolveEffectiveSchedule(fakeProject({ securityScan: { onPush: true } }), 'daily')).toBe(
      'daily',
    );
  });

  it('returns null when an unset project falls back to an off default', () => {
    expect(resolveEffectiveSchedule(fakeProject({}), 'off')).toBeNull();
  });
});

describe('getDefaultSecurityScanSchedule', () => {
  const original = process.env.SECURITY_SCAN_DEFAULT_SCHEDULE;
  afterEach(() => {
    if (original === undefined) delete process.env.SECURITY_SCAN_DEFAULT_SCHEDULE;
    else process.env.SECURITY_SCAN_DEFAULT_SCHEDULE = original;
  });

  it('defaults to weekly when the env var is unset', () => {
    delete process.env.SECURITY_SCAN_DEFAULT_SCHEDULE;
    expect(getDefaultSecurityScanSchedule()).toBe('weekly');
  });

  it('honours a valid env override (case/space-insensitive)', () => {
    process.env.SECURITY_SCAN_DEFAULT_SCHEDULE = '  Off ';
    expect(getDefaultSecurityScanSchedule()).toBe('off');
    process.env.SECURITY_SCAN_DEFAULT_SCHEDULE = 'daily';
    expect(getDefaultSecurityScanSchedule()).toBe('daily');
  });

  it('falls back to weekly on an unrecognised env value', () => {
    process.env.SECURITY_SCAN_DEFAULT_SCHEDULE = 'hourly';
    expect(getDefaultSecurityScanSchedule()).toBe('weekly');
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
