/**
 * Push-CI engine tests: real git bare repos + live test DB, with the job
 * phase stubbed (running real DinD/runners in unit tests is forbidden).
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { FinalizeRunRow, Project, Stmts } from '../types.js';

let stmts: Stmts;
let maybeRunPushCi: typeof import('./push-ci.js').maybeRunPushCi;
let maybeRunPrCi: typeof import('./push-ci.js').maybeRunPrCi;
let rerunCiRun: typeof import('./push-ci.js').rerunCiRun;
let isFeatureIntegrationBranch: typeof import('./push-ci.js').isFeatureIntegrationBranch;
let __clearPushCiQueues: typeof import('./push-ci.js').__clearPushCiQueues;
let setChecksPassedHook: typeof import('./push-ci.js').setChecksPassedHook;
let createHostedRepo: typeof import('./repo-store.js').createHostedRepo;
let gitHostRepoPath: typeof import('./repo-store.js').gitHostRepoPath;
let configDataDir: string;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest(); // boots app + initDb into the test data dir
  stmts = (await import('../db.js')).stmts!;
  ({
    maybeRunPushCi,
    maybeRunPrCi,
    rerunCiRun,
    isFeatureIntegrationBranch,
    __clearPushCiQueues,
    setChecksPassedHook,
  } = await import('./push-ci.js'));
  ({ createHostedRepo, gitHostRepoPath } = await import('./repo-store.js'));
  configDataDir = (await import('../config.js')).default.dataDir;
});

beforeEach(() => {
  __clearPushCiQueues();
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

const VALID_CI_YAML = [
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

/** Seed a hosted repo whose default branch carries a ci.yaml. */
async function seedHostedProject(
  opts: { ciYaml?: string | null; defaultBranch?: string } = {},
): Promise<{
  project: Project;
  headSha: string;
}> {
  const id = `pushci-${uuidv4().slice(0, 8)}`;
  const work = path.join(os.tmpdir(), `pushci-seed-${id}`);
  const defaultBranch = opts.defaultBranch ?? 'main';
  mkdirSync(work, { recursive: true });
  execSync(`git init --initial-branch=${defaultBranch}`, { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email "t@example.com"');
  git(work, 'config user.name "T"');
  if (opts.ciYaml !== null) {
    mkdirSync(path.join(work, '.agent-hub'), { recursive: true });
    writeFileSync(path.join(work, '.agent-hub', 'ci.yaml'), opts.ciYaml ?? VALID_CI_YAML);
  }
  writeFileSync(path.join(work, 'src.txt'), 'code\n');
  git(work, 'add -A');
  git(work, 'commit -m initial');
  await createHostedRepo({ id, cwd: work, repoUrl: null }, {});
  const headSha = git(gitHostRepoPath(id), `rev-parse refs/heads/${defaultBranch}`);
  const project = {
    id,
    name: id,
    cwd: '',
    ahw: '',
    gitHost: 'agenthub',
    ciOnPush: { enabled: true },
  } as Project;
  return { project, headSha };
}

function runRowFor(project: Project, sha: string): FinalizeRunRow | undefined {
  return stmts.getFinalizeRunByIdempotencyKey.get(`git-push|${project.id}|${sha}`) as
    | FinalizeRunRow
    | undefined;
}

describe('push CI engine', () => {
  it('runs ci.yaml jobs on a default-branch push and records a succeeded run', async () => {
    const { project, headSha } = await seedHostedProject();
    const broadcasts: Array<Record<string, unknown>> = [];
    const runJobPhase = vi.fn(async (_deps: unknown, opts: Record<string, unknown>) => {
      // The clone handed to the job phase is a real checkout of the sha.
      expect(git(String(opts.worktreePath), 'rev-parse HEAD')).toBe(headSha);
      expect(existsSync(path.join(String(opts.worktreePath), 'src.txt'))).toBe(true);
      return { status: 'success' as const, stepResults: [], activeSecondsBilled: 1 };
    });

    await maybeRunPushCi(project, ['refs/heads/main'], {
      stmts,
      broadcast: (d) => broadcasts.push(d),
      runJobPhase: runJobPhase as never,
      mergeSecrets: () => {},
    });

    expect(runJobPhase).toHaveBeenCalledOnce();
    const callOpts = runJobPhase.mock.calls[0][1] as Record<string, unknown>;
    expect(callOpts).toMatchObject({ branch: 'main', headSha, projectId: project.id });

    const run = runRowFor(project, headSha);
    expect(run).toMatchObject({
      status: 'succeeded',
      trigger_source: 'git_push',
      mode: 'checks',
      branch: 'main',
      head_sha: headSha,
    });
    expect(run?.ended_at).toBeTruthy();
    // Ephemeral clone is removed afterwards.
    expect(existsSync(String(callOpts.worktreePath))).toBe(false);
    // Sentinel log session exists for step output.
    expect(run?.session_id).toBeTruthy();
    expect(
      broadcasts.some((b) => b.type === 'finalize_run_phase_changed' && b.status === 'succeeded'),
    ).toBe(true);
  });

  it('fires the checks-passed hook on a successful run (drives deferred auto-merge)', async () => {
    const { project, headSha } = await seedHostedProject();
    const calls: Array<{ branch: string; headSha: string; trigger: string }> = [];
    setChecksPassedHook((a) => {
      calls.push({ branch: a.branch, headSha: a.headSha, trigger: a.trigger });
    });
    try {
      await maybeRunPushCi(project, ['refs/heads/main'], {
        stmts,
        broadcast: () => {},
        runJobPhase: vi.fn(async () => ({
          status: 'success' as const,
          stepResults: [],
          activeSecondsBilled: 1,
        })) as never,
        mergeSecrets: () => {},
      });
    } finally {
      setChecksPassedHook(null); // don't leak the hook into sibling tests
    }
    expect(calls).toEqual([{ branch: 'main', headSha, trigger: 'git_push' }]);
  });

  it('does NOT fire the checks-passed hook when jobs fail', async () => {
    const { project, headSha } = await seedHostedProject();
    let fired = false;
    setChecksPassedHook(() => {
      fired = true;
    });
    try {
      await maybeRunPushCi(project, ['refs/heads/main'], {
        stmts,
        broadcast: () => {},
        runJobPhase: vi.fn(async () => ({
          status: 'failure' as const,
          stepResults: [],
          activeSecondsBilled: 1,
        })) as never,
        mergeSecrets: () => {},
      });
    } finally {
      setChecksPassedHook(null);
    }
    expect(fired).toBe(false);
    expect(runRowFor(project, headSha)?.status).toBe('failed');
  });

  it('records checks_failed when jobs fail — report-only, no fix dispatch', async () => {
    const { project, headSha } = await seedHostedProject();
    await maybeRunPushCi(project, ['refs/heads/main'], {
      stmts,
      broadcast: () => {},
      runJobPhase: vi.fn(async () => ({
        status: 'failure' as const,
        stepResults: [],
        activeSecondsBilled: 1,
      })) as never,
      mergeSecrets: () => {},
    });
    expect(runRowFor(project, headSha)).toMatchObject({
      status: 'failed',
      failure_reason: 'checks_failed',
    });
  });

  it('dedupes by (project, sha): a replayed push does not re-run', async () => {
    const { project, headSha } = await seedHostedProject();
    const runJobPhase = vi.fn(async () => ({
      status: 'success' as const,
      stepResults: [],
      activeSecondsBilled: 1,
    }));
    const deps = {
      stmts,
      broadcast: () => {},
      runJobPhase: runJobPhase as never,
      mergeSecrets: () => {},
    };
    await maybeRunPushCi(project, ['refs/heads/main'], deps);
    await maybeRunPushCi(project, ['refs/heads/main'], deps);
    expect(runJobPhase).toHaveBeenCalledOnce();
    expect(runRowFor(project, headSha)?.status).toBe('succeeded');
  });

  it('skips when disabled, when not hosted, or when only a feature branch moved', async () => {
    const { project } = await seedHostedProject();
    const runJobPhase = vi.fn();
    const deps = {
      stmts,
      broadcast: () => {},
      runJobPhase: runJobPhase as never,
      mergeSecrets: () => {},
    };

    await maybeRunPushCi({ ...project, ciOnPush: { enabled: false } }, ['refs/heads/main'], deps);
    await maybeRunPushCi({ ...project, ciOnPush: undefined }, ['refs/heads/main'], deps);
    await maybeRunPushCi({ ...project, gitHost: 'github' }, ['refs/heads/main'], deps);
    await maybeRunPushCi(project, ['refs/heads/feature-x'], deps);
    expect(runJobPhase).not.toHaveBeenCalled();
  });

  it('recognizes configured feature integration branches and leaves them exempt from push CI', async () => {
    const { project } = await seedHostedProject();
    const boardId = uuidv4();
    stmts.createKanbanBoard.run(boardId, project.id, 'Board', 'TST');
    stmts.createKanbanEpic.run(uuidv4(), boardId, 'Feature A', null, '#6366F1', 0, null);
    const epic = (stmts.getKanbanEpics.all(boardId) as Array<{ id: string }>)[0];
    const row = stmts.getKanbanEpic.get(epic.id) as {
      name: string;
      description: string | null;
      color: string;
      autonomous: number;
      autonomous_interval: number;
      autonomous_max_concurrent: number;
      autonomous_model: string | null;
      orchestration_budgets_json?: string | null;
      labels?: string | null;
    };
    stmts.updateKanbanEpic.run(
      row.name,
      row.description,
      row.color,
      row.autonomous,
      row.autonomous_interval,
      row.autonomous_max_concurrent,
      row.autonomous_model,
      row.orchestration_budgets_json ?? null,
      'feature/feature-a',
      row.labels ?? null,
      epic.id,
    );

    expect(isFeatureIntegrationBranch(stmts, project.id, 'feature/feature-a')).toBe(true);

    const runJobPhase = vi.fn();
    await maybeRunPushCi(project, ['refs/heads/feature/feature-a'], {
      stmts,
      broadcast: () => {},
      runJobPhase: runJobPhase as never,
      mergeSecrets: () => {},
    });

    expect(runJobPhase).not.toHaveBeenCalled();
  });

  it('records ci_config_invalid for a missing or version-1 ci.yaml', async () => {
    const missing = await seedHostedProject({ ciYaml: null });
    const v1 = await seedHostedProject({
      ciYaml: 'version: 1\non: [push]\nsteps:\n  - name: t\n    run: echo ok\n',
    });
    const deps = {
      stmts,
      broadcast: () => {},
      runJobPhase: vi.fn() as never,
      mergeSecrets: () => {},
    };

    await maybeRunPushCi(missing.project, ['refs/heads/main'], deps);
    expect(runRowFor(missing.project, missing.headSha)).toMatchObject({
      status: 'failed',
      failure_reason: 'ci_config_invalid',
    });

    await maybeRunPushCi(v1.project, ['refs/heads/main'], deps);
    expect(runRowFor(v1.project, v1.headSha)).toMatchObject({
      status: 'failed',
      failure_reason: 'ci_config_invalid',
    });
  });

  it('step output written under the sentinel session survives FK enforcement', async () => {
    const { project, headSha } = await seedHostedProject();
    const runJobPhase = vi.fn(async (deps2: { stmts: Stmts }, opts: { sessionId: string }) => {
      // Simulate what the real step-runner does: persist an output line
      // as a session message — must not violate the messages FK.
      deps2.stmts.addMessage.run(
        uuidv4(),
        opts.sessionId,
        'system',
        '[stdout] hello from CI',
        null,
        null,
        null,
        JSON.stringify({ kind: 'finalize_step_output', stepIndex: 1 }),
        null,
        null,
        null,
      );
      return { status: 'success' as const, stepResults: [], activeSecondsBilled: 1 };
    });
    await maybeRunPushCi(project, ['refs/heads/main'], {
      stmts,
      broadcast: () => {},
      runJobPhase: runJobPhase as never,
      mergeSecrets: () => {},
    });
    const run = runRowFor(project, headSha)!;
    const messages = stmts.getMessages.all(run.session_id) as Array<{ content: string }>;
    expect(messages.some((m) => m.content.includes('hello from CI'))).toBe(true);
  });

  it('cleans up the ephemeral clone dir even on failure', async () => {
    const { project, headSha } = await seedHostedProject();
    let seenDir = '';
    await maybeRunPushCi(project, ['refs/heads/main'], {
      stmts,
      broadcast: () => {},
      runJobPhase: vi.fn(async (_d: unknown, opts: Record<string, unknown>) => {
        seenDir = String(opts.worktreePath);
        throw new Error('runner exploded');
      }) as never,
      mergeSecrets: () => {},
    });
    expect(runRowFor(project, headSha)).toMatchObject({
      status: 'failed',
      failure_reason: 'infra_error',
    });
    expect(seenDir).toContain(path.join(configDataDir, 'push-ci'));
    expect(existsSync(seenDir)).toBe(false);
  });
});

describe('PR-level CI (maybeRunPrCi) — session-validation passthrough', () => {
  it('runs only for pull requests targeting the repository default branch', async () => {
    const { project, headSha } = await seedHostedProject({ defaultBranch: 'trunk' });
    const runJobPhase = vi.fn(async () => ({
      status: 'success' as const,
      stepResults: [],
      activeSecondsBilled: 1,
    }));
    const deps = {
      stmts,
      broadcast: () => {},
      runJobPhase: runJobPhase as never,
      mergeSecrets: () => {},
    };

    await maybeRunPrCi(
      project,
      { number: 6, head_branch: 'trunk', base_branch: 'feature/integration' },
      deps,
    );
    expect(runJobPhase).not.toHaveBeenCalled();
    expect(runRowFor(project, headSha)).toBeUndefined();

    await maybeRunPrCi(project, { number: 7, head_branch: 'trunk', base_branch: 'trunk' }, deps);
    expect(runJobPhase).toHaveBeenCalledOnce();
  });

  it('skips entirely when the head sha was fully validated by Finalize', async () => {
    const { project, headSha } = await seedHostedProject();
    // Seed a fully-validated finalize run for this exact (branch, sha).
    const finRunId = uuidv4();
    stmts.insertFinalizeRun.run(
      finRunId,
      'card-x',
      null,
      project.id,
      'main',
      headSha,
      `test|${finRunId}`,
      'queued',
      null,
      'ui_button',
      null,
      'user',
      'Test User',
      't@example.com',
      null,
      Date.now(),
      'full',
    );
    stmts.markFinalizeRunReadyToPush.run(headSha, finRunId);

    const runJobPhase = vi.fn();
    await maybeRunPrCi(
      project,
      { number: 1, head_branch: 'main', base_branch: 'main' },
      { stmts, broadcast: () => {}, runJobPhase: runJobPhase as never, mergeSecrets: () => {} },
    );

    expect(runJobPhase).not.toHaveBeenCalled();
    expect(runRowFor(project, headSha)).toBeUndefined();
  });

  it('skips when Finalize validated the same sha on the session branch', async () => {
    const { project, headSha } = await seedHostedProject();
    const prBranch = 'feature/replay-upload-retry';
    git(gitHostRepoPath(project.id), `branch ${prBranch} ${headSha}`);

    // Regression for PR 291: Finalize validated the session worktree branch,
    // then pushed the currently checked-out feature branch as the native PR
    // head. The commit object is the same and should satisfy the passthrough.
    const finRunId = uuidv4();
    stmts.insertFinalizeRun.run(
      finRunId,
      'card-x',
      null,
      project.id,
      'agent-hub/agent-hub-dev/session-a93e0b3e',
      headSha,
      `test|${finRunId}`,
      'queued',
      null,
      'agent_block',
      null,
      'user',
      'Test User',
      't@example.com',
      null,
      Date.now(),
      'full',
    );
    stmts.markFinalizeRunReadyToPush.run(headSha, finRunId);

    const runJobPhase = vi.fn();
    await maybeRunPrCi(
      project,
      { number: 291, head_branch: prBranch, base_branch: 'main' },
      { stmts, broadcast: () => {}, runJobPhase: runJobPhase as never, mergeSecrets: () => {} },
    );

    expect(runJobPhase).not.toHaveBeenCalled();
    expect(runRowFor(project, headSha)).toBeUndefined();
  });

  it('runs CI for an unvalidated head and records trigger pr_push', async () => {
    const { project, headSha } = await seedHostedProject();
    const runJobPhase = vi.fn(async () => ({
      status: 'success' as const,
      stepResults: [],
      activeSecondsBilled: 1,
    }));

    await maybeRunPrCi(
      project,
      { number: 7, head_branch: 'main', base_branch: 'main' },
      { stmts, broadcast: () => {}, runJobPhase: runJobPhase as never, mergeSecrets: () => {} },
    );

    expect(runJobPhase).toHaveBeenCalledOnce();
    expect(runRowFor(project, headSha)).toMatchObject({
      status: 'succeeded',
      trigger_source: 'pr_push',
      branch: 'main',
      head_sha: headSha,
    });
  });

  it('skips silently when the head sha carries no ci.yaml', async () => {
    const { project, headSha } = await seedHostedProject({ ciYaml: null });
    const runJobPhase = vi.fn();
    await maybeRunPrCi(
      project,
      { number: 2, head_branch: 'main', base_branch: 'main' },
      { stmts, broadcast: () => {}, runJobPhase: runJobPhase as never, mergeSecrets: () => {} },
    );
    expect(runJobPhase).not.toHaveBeenCalled();
    expect(runRowFor(project, headSha)).toBeUndefined();
  });

  it('dedupes against a prior run of the same sha (either trigger)', async () => {
    const { project, headSha } = await seedHostedProject();
    const ok = async () => ({
      status: 'success' as const,
      stepResults: [],
      activeSecondsBilled: 1,
    });
    const first = vi.fn(ok);
    const second = vi.fn(ok);
    await maybeRunPushCi(project, ['refs/heads/main'], {
      stmts,
      broadcast: () => {},
      runJobPhase: first as never,
      mergeSecrets: () => {},
    });
    await maybeRunPrCi(
      project,
      { number: 3, head_branch: 'main', base_branch: 'main' },
      { stmts, broadcast: () => {}, runJobPhase: second as never, mergeSecrets: () => {} },
    );
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(runRowFor(project, headSha)?.trigger_source).toBe('git_push');
  });
});

describe('PR-level CI — rejected configs', () => {
  it('fails loudly with ci_config_invalid when ci.yaml declares version 1', async () => {
    // `version: 1` is not a schema the parser accepts any more. A committed
    // v1 file is present-but-invalid, so PR CI must surface a red run the
    // author can act on rather than skipping as if CI were never configured.
    const v1 = [
      'version: 1',
      'on: [finalize, manual]',
      'timeout_minutes: 30',
      'steps:',
      '  - name: backend-tests',
      '    run: echo hi',
    ].join('\n');
    const { project, headSha } = await seedHostedProject({ ciYaml: v1 });
    const runJobPhase = vi.fn();
    await maybeRunPrCi(
      project,
      { number: 9, head_branch: 'main', base_branch: 'main' },
      { stmts, broadcast: () => {}, runJobPhase: runJobPhase as never, mergeSecrets: () => {} },
    );
    expect(runJobPhase).not.toHaveBeenCalled();
    expect(runRowFor(project, headSha)).toMatchObject({
      status: 'failed',
      failure_reason: 'ci_config_invalid',
    });
  });

  it('still skips silently when the commit has no ci.yaml at all', async () => {
    const { project, headSha } = await seedHostedProject({ ciYaml: null });
    const runJobPhase = vi.fn();
    await maybeRunPrCi(
      project,
      { number: 10, head_branch: 'main', base_branch: 'main' },
      { stmts, broadcast: () => {}, runJobPhase: runJobPhase as never, mergeSecrets: () => {} },
    );
    expect(runJobPhase).not.toHaveBeenCalled();
    expect(runRowFor(project, headSha)).toBeUndefined();
  });
});

describe('re-run (rerunCiRun)', () => {
  it('re-runs the same sha despite the per-sha dedupe; jobId narrows to one job', async () => {
    const { project, headSha } = await seedHostedProject();
    const ok = async () => ({
      status: 'success' as const,
      stepResults: [],
      activeSecondsBilled: 1,
    });
    const first = vi.fn(ok);
    await maybeRunPushCi(project, ['refs/heads/main'], {
      stmts,
      broadcast: () => {},
      runJobPhase: first as never,
      mergeSecrets: () => {},
    });
    const original = runRowFor(project, headSha)!;
    expect(original.status).toBe('succeeded');

    // Whole-run re-run: a NEW run row appears for the same sha.
    const second = vi.fn(ok);
    await rerunCiRun(project, original, {
      stmts,
      broadcast: () => {},
      runJobPhase: second as never,
      mergeSecrets: () => {},
    });
    expect(second).toHaveBeenCalledOnce();
    const all = stmts.listFinalizeRunsForProject.all(project.id, 'all', 'all', 10) as Array<{
      id: string;
      head_sha: string;
      status: string;
    }>;
    expect(all.filter((r) => r.head_sha === headSha)).toHaveLength(2);

    // Per-job re-run: the job phase receives a config narrowed to that job.
    const third = vi.fn(ok);
    await rerunCiRun(
      project,
      original,
      { stmts, broadcast: () => {}, runJobPhase: third as never, mergeSecrets: () => {} },
      { jobId: 'unit' },
    );
    expect(third).toHaveBeenCalledOnce();
    const cfg = (
      (third.mock.calls[0] as unknown[])[1] as { config: { jobs: Record<string, unknown> } }
    ).config;
    expect(Object.keys(cfg.jobs)).toEqual(['unit']);

    // Unknown job → run records ci_config_invalid.
    const fourth = vi.fn(ok);
    await rerunCiRun(
      project,
      original,
      { stmts, broadcast: () => {}, runJobPhase: fourth as never, mergeSecrets: () => {} },
      { jobId: 'nope' },
    );
    expect(fourth).not.toHaveBeenCalled();
    const latest = stmts.listFinalizeRunsForProject.all(project.id, 'all', 'all', 1) as Array<{
      failure_reason: string | null;
    }>;
    expect(latest[0].failure_reason).toBe('ci_config_invalid');
  });
});
