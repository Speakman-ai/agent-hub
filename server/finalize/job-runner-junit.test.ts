import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { parseCiConfig } from './ci-config.js';
import { runJobPhase } from './job-runner.js';
import {
  inventoriedJobs,
  JUNIT_COLLECT_STEP_INDEX,
  type InstanceJunitReport,
} from './test-inventory.js';
import type { SpawnedStep, SpawnStepArgs, StepRunnerDeps } from './step-runner.js';

const VITEST_XML = `<testsuites><testsuite name="src/a.test.ts"><testcase classname="src/a.test.ts" name="x"/></testsuite></testsuites>`;

function child(stdout: string, code: number): SpawnedStep {
  const dataListeners: Array<(c: string) => void> = [];
  const c: SpawnedStep = {
    stdout: {
      on: (event: string, l: (chunk: string) => void) => {
        if (event === 'data') dataListeners.push(l);
        return c.stdout;
      },
    } as unknown as NodeJS.ReadableStream,
    stderr: null,
    on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
      if (event === 'close')
        setTimeout(() => {
          for (const l of dataListeners) l(stdout);
          (listener as (code: number | null) => void)(code);
        }, 0);
      return c;
    },
    kill: vi.fn(() => true),
  };
  return c;
}

const CONFIG = `
version: 2
on: [finalize]
jobs:
  unit:
    runs-on: host
    matrix:
      include:
        - shard: '1'
        - shard: '2'
    steps:
      - run: npx vitest --reporter=junit
  lint:
    runs-on: host
    steps:
      - run: echo lint
`;

function deps(spawn: (args: SpawnStepArgs) => SpawnedStep): StepRunnerDeps {
  return {
    stmts: {
      getFinalizeRun: { get: vi.fn() },
      updateFinalizeRunPhase: { run: vi.fn() },
      updateFinalizeRunActiveSeconds: { run: vi.fn() },
      failFinalizeRun: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn() },
      upsertFinalizeRunStep: { run: vi.fn() },
      beginFinalizeRunStepAttempt: { run: vi.fn() },
      finishFinalizeRunStepIfAttempt: { run: vi.fn(() => ({ changes: 1 })) },
      listFinalizeRunStepsForRun: { all: vi.fn(() => []) },
      upsertFinalizeRunJob: { run: vi.fn() },
      listFinalizeRunJobsForRun: { all: vi.fn(() => []) },
    } as unknown as StepRunnerDeps['stmts'],
    broadcast: vi.fn(),
    spawnStep: vi.fn(spawn),
  };
}

function config() {
  const parsed = parseCiConfig(CONFIG);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

const OPTS = {
  runId: 'run-1',
  worktreePath: '/tmp/wt',
  sessionId: 'sess',
  branch: 'main',
  headSha: 'abc',
};

type Report = { jobId: string; matrixKey: string; testFiles: string[]; status: string };

function collectorOut(xml: string | null): string {
  if (xml === null) return '\n@@FINALIZE_JUNIT_DONE 0\n';
  const b64 = Buffer.from(xml).toString('base64');
  return `\n@@FINALIZE_JUNIT_FILE junit.xml\n${b64}\n@@FINALIZE_JUNIT_END\n\n@@FINALIZE_JUNIT_DONE 1\n`;
}

describe('runJobPhase JUnit collection', () => {
  it('gives every step its own FINALIZE_JUNIT_DIR and reports each instance', async () => {
    const stepDirs: string[] = [];
    const d = deps((args) => {
      const dir = String(args.env?.FINALIZE_JUNIT_DIR ?? '');
      if (args.index === JUNIT_COLLECT_STEP_INDEX) {
        // Only the vitest shards wrote a report.
        const shard = /shard-(\d)/.exec(dir)?.[1];
        return child(
          collectorOut(
            dir.includes('-unit-') ? VITEST_XML.replaceAll('src/a', `src/${shard}`) : null,
          ),
          0,
        );
      }
      stepDirs.push(dir);
      return child('', 0);
    });
    const reports: Report[] = [];
    const result = await runJobPhase(d, {
      ...OPTS,
      config: config(),
      onJunitReport: (r) => reports.push(r),
    });

    expect(result.status).toBe('success');
    expect(stepDirs.every((x) => x.startsWith('/tmp/finalize-junit/run-1-'))).toBe(true);
    expect(new Set(stepDirs).size).toBe(3);
    const byKey = Object.fromEntries(reports.map((r) => [`${r.jobId}/${r.matrixKey}`, r]));
    expect(Object.keys(byKey).sort()).toEqual(['lint/', 'unit/shard=1', 'unit/shard=2']);
    // lint wrote no JUnit: absence of evidence, not zero tests.
    expect(byKey['lint/']).toMatchObject({ testFiles: [], status: 'no_reports' });
    expect(byKey['unit/shard=1']).toMatchObject({
      testFiles: ['src/1.test.ts'],
      status: 'reported',
    });
    expect(byKey['unit/shard=2']).toMatchObject({
      testFiles: ['src/2.test.ts'],
      status: 'reported',
    });
  });

  it('collects nothing when no caller asked for reports', async () => {
    const d = deps(() => child('', 0));
    await runJobPhase(d, { ...OPTS, config: config() });
    const indexes = (d.spawnStep as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as SpawnStepArgs).index,
    );
    expect(indexes).not.toContain(JUNIT_COLLECT_STEP_INDEX);
    // The env var is still set for every step, so jobs behave the same in
    // session and default-branch runs.
    for (const c of (d.spawnStep as ReturnType<typeof vi.fn>).mock.calls) {
      expect((c[0] as SpawnStepArgs).env?.FINALIZE_JUNIT_DIR).toMatch(/^\/tmp\/finalize-junit\//);
    }
  });

  it('a failed instance is incomplete: it may have bailed before running every test', async () => {
    const d = deps((args) =>
      args.index === JUNIT_COLLECT_STEP_INDEX
        ? child(collectorOut(VITEST_XML), 0)
        : child('', args.step.run.includes('vitest') ? 1 : 0),
    );
    const reports: Report[] = [];
    const result = await runJobPhase(d, {
      ...OPTS,
      config: config(),
      onJunitReport: (r) => reports.push(r),
    });
    expect(result.status).toBe('failure');
    const unit = reports.filter((r) => r.jobId === 'unit');
    expect(unit).toHaveLength(2);
    expect(unit.every((r) => r.status === 'incomplete' && r.testFiles.length === 0)).toBe(true);
    expect(reports.find((r) => r.jobId === 'lint')?.status).toBe('reported');
  });

  it('an incomplete collection reports the instance incomplete', async () => {
    const d = deps((args) =>
      args.index === JUNIT_COLLECT_STEP_INDEX
        ? child('\n@@FINALIZE_JUNIT_INCOMPLETE 501 report(s)\n', 0)
        : child('', 0),
    );
    const reports: Report[] = [];
    await runJobPhase(d, { ...OPTS, config: config(), onJunitReport: (r) => reports.push(r) });
    expect(reports).toHaveLength(3);
    expect(reports.every((r) => r.status === 'incomplete' && r.testFiles.length === 0)).toBe(true);
  });

  it('a passing shard that writes no JUnit reports no_reports, not an empty test set', async () => {
    const d = deps((args) => {
      const dir = String(args.env?.FINALIZE_JUNIT_DIR ?? '');
      if (args.index !== JUNIT_COLLECT_STEP_INDEX) return child('', 0);
      return child(collectorOut(dir.includes('shard-1') ? VITEST_XML : null), 0);
    });
    const reports: Report[] = [];
    await runJobPhase(d, { ...OPTS, config: config(), onJunitReport: (r) => reports.push(r) });
    const byKey = Object.fromEntries(reports.map((r) => [`${r.jobId}/${r.matrixKey}`, r.status]));
    expect(byKey['unit/shard=1']).toBe('reported');
    expect(byKey['unit/shard=2']).toBe('no_reports');
    expect([...inventoriedJobs(reports as InstanceJunitReport[])]).not.toContain('unit');
  });

  it('a report with testcases that name no file makes the instance incomplete', async () => {
    const jestDefault =
      '<testsuites><testsuite name="Form"><testcase classname="Form renders" name="renders"/></testsuite></testsuites>';
    const d = deps((args) =>
      args.index === JUNIT_COLLECT_STEP_INDEX ? child(collectorOut(jestDefault), 0) : child('', 0),
    );
    const reports: Report[] = [];
    await runJobPhase(d, { ...OPTS, config: config(), onJunitReport: (r) => reports.push(r) });
    expect(reports.every((r) => r.status === 'incomplete' && r.testFiles.length === 0)).toBe(true);
  });

  it('an instance skipped by a failed prerequisite still gets an incomplete report', async () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  build:
    runs-on: host
    steps:
      - run: exit 1
  unit:
    runs-on: host
    needs: [build]
    steps:
      - run: npx vitest
`);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const d = deps((args) => child('', args.step.run.includes('exit 1') ? 1 : 0));
    const reports: Report[] = [];
    await runJobPhase(d, { ...OPTS, config: parsed.config, onJunitReport: (r) => reports.push(r) });
    expect(reports.map((r) => [r.jobId, r.status]).sort()).toEqual([
      ['build', 'incomplete'],
      ['unit', 'incomplete'],
    ]);
  });

  it('removes a host job JUnit dir whether or not the run collects', async () => {
    for (const collect of [false, true]) {
      const dirs: string[] = [];
      const d = deps((args) => {
        const dir = String(args.env?.FINALIZE_JUNIT_DIR ?? '');
        if (args.index !== JUNIT_COLLECT_STEP_INDEX) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, 'r.xml'), '<testsuite/>');
          dirs.push(dir);
        }
        // A collector that never finishes its output: incomplete, so the
        // job runner must clean up after it.
        return child(args.index === JUNIT_COLLECT_STEP_INDEX ? 'partial' : '', 0);
      });
      await runJobPhase(d, {
        ...OPTS,
        runId: `run-clean-${collect}`,
        config: config(),
        ...(collect ? { onJunitReport: () => {} } : {}),
      });
      expect(dirs.length).toBeGreaterThan(0);
      for (const dir of dirs) expect(existsSync(dir)).toBe(false);
    }
  });
});
