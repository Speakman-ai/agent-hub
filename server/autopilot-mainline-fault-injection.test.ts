/**
 * Mainline Autopilot fault-injection suite: one full cycle (push, deploy,
 * report) run end to end, then run again with a fault injected at every step.
 *
 * Real: the session row and messages (SQLite), the deployment rows, a bare
 * git remote plus a working clone, the push, the remote check, deploy.yaml
 * reads, and every production module on the path (Finalize's default-branch
 * push, the deploy watcher, the push reconciler, result delivery).
 * Fake: the deploy orchestrator (a created row succeeds on the next tick),
 * `handleChat` (persists the user message after the acceptance gate), and
 * Finalize's run bookkeeping, which follows the same rules as the real one
 * (park on a refused push, boot recovery re-triggers an interrupted run, an
 * owed restart pushes a parked run or starts a fresh one, and the idle-slot
 * resume pushes a parked or stranded run or re-runs the auto-start).
 *
 * Faults are injected one per run. A second fault during recovery (say, a
 * crash and then a failed write in boot recovery) is out of scope.
 *
 * A "process" owns all in-memory state: watcher backoffs, reconciler and
 * report records, live pushes. A crash kills it right after a durable write
 * or side effect: every later call it makes throws, and a fresh process boots
 * on the same database and repositories. Whatever was injected, the run must
 * end with the commit moved onto the default branch by exactly one push, one
 * deployment for it, and exactly one delivered report.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb, getStmts } from './db.js';
import type { Project, Stmts } from './types.js';
import { createMainlineDeployWatcher } from './autopilot-mainline-deploy-watcher.js';
import {
  createMainlineReconciler,
  type MainlineRestartResult,
} from './autopilot-mainline-reconciler.js';
import {
  checkCommitOnRemoteBranch,
  runRemoteCheckGit,
  type RemoteCheckGitRunner,
} from './autopilot-mainline-remote-check.js';
import {
  createMainlineReportDelivery,
  findMainlineReportKey,
} from './autopilot-mainline-report.js';
import {
  isMainlinePushLive,
  pushValidatedCommitToDefaultBranch,
  runGitCapturingOutput,
  type DefaultBranchGitRunner,
} from './finalize/push-to-default-branch.js';
import {
  setMainlineSlotFreedListener,
  setMainlineSlotLandedListener,
  type AutopilotRowStmts,
} from './session-autopilot-slot.js';
import { postAutopilotSystemNotice } from './session-autopilot.js';
import {
  type AutopilotSessionConfig,
  parseAutopilotSessionConfig,
} from '../shared/utils/sessionAutopilot.js';
import { idleMainlineSlot } from '../shared/utils/autopilotMainlineSlot.js';
import {
  createDeployment,
  getDeployment,
  listDeployments,
  listDeploymentsByLandingKey,
  updateDeploymentStatus,
} from './deploy/deployment-store.js';
import { readDeployYamlAtCommit } from './deploy/deployment-checkout.js';

const AGENT = 'agent-ml-fault';
/** Real time: the push stamps `enteredAt` from the wall clock, not the injected one. */
const T0 = Date.now();
/** Longer than every backoff (the longest is 10 minutes), so each tick retries. */
const TICK_MS = 11 * 60_000;
const MAX_TICKS = 40;
const DEPLOY_YAML =
  'version: 1\nenvironments:\n  prod:\n    steps:\n      - name: ship\n        run: echo ship\n';

/**
 * Agent sessions put a git wrapper that refuses `git push` first on PATH.
 * These pushes only reach a temporary bare repository, so use plain git.
 */
const PLAIN_GIT_PATH = (process.env.PATH ?? '')
  .split(':')
  .filter((dir) => !dir.includes('spawn-guards'))
  .join(':');

const GIT_ENV = {
  ...process.env,
  PATH: PLAIN_GIT_PATH,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@e',
};

class Crash extends Error {}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

interface Faults {
  /** Kill the process right after the Nth durable write or side effect (1-based). */
  crashAfterEvent?: number;
  /** Fail the Nth database write (1-based): throw, or refuse the whole compare-and-set. */
  failWrite?: { index: number; kind: 'throw' | 'refuse' };
  /** The first push: `output_lost` ran and moved the branch; `killed` never reached the remote. */
  push?: 'output_lost' | 'killed';
  /** Remote-check git calls (1-based) that come back killed, with no exit code. */
  failCheckCalls?: (call: number) => boolean;
  /** The first deploy.yaml read fails like a broken checkout. */
  failDeployYamlRead?: boolean;
  /**
   * After the cycle settles, Finalize pushes the same commit again (a run
   * re-triggered after a restart). The remote answers `=`, and the session's
   * landing record must stop a second deploy and report.
   */
  repush?: boolean;
  /** Someone else pushed the slice to the default branch before this session did. */
  alreadyOnRemote?: boolean;
}

type RunStatus =
  | 'validating'
  | 'pushing'
  | 'ready_to_push'
  | 'pushed'
  | 'failed'
  | 'infra_error'
  | 'cancelled';

/** Everything that survives a crash: the database, the repositories, the run table. */
interface World {
  root: string;
  remote: string;
  work: string;
  sha: string;
  sessionId: string;
  project: Project;
  faults: Faults;
  clock: { now: number };
  events: string[];
  writes: number;
  /** What each database write was, in order. */
  writeLabels: string[];
  checkCalls: number;
  pushFaultUsed: boolean;
  deployYamlFaultUsed: boolean;
  /** Push invocations that moved the default branch. */
  movingPushes: number;
  runs: Array<{ id: string; status: RunStatus }>;
  boots: number;
  repushed: boolean;
}

let seq = 0;

function createWorld(faults: Faults): World {
  const root = mkdtempSync(join(tmpdir(), 'mainline-fault-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'remote', 'add', 'origin', remote);
  mkdirSync(join(work, '.agent-hub'));
  writeFileSync(join(work, '.agent-hub', 'deploy.yaml'), DEPLOY_YAML);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(remote, 'fetch', '-q', work, '+HEAD:refs/heads/main');
  writeFileSync(join(work, 'slice.txt'), 'slice');
  git(work, 'add', 'slice.txt');
  git(work, 'commit', '-q', '-m', 'slice');
  const sha = git(work, 'rev-parse', 'HEAD');
  if (faults.alreadyOnRemote) git(remote, 'fetch', '-q', work, '+HEAD:refs/heads/main');

  const n = ++seq;
  const sessionId = `ml-fault-${n}-${uuidv4()}`;
  const cfg: AutopilotSessionConfig = {
    durationHours: 0,
    brief: 'Ship the slice',
    goal: 'The slice is live',
    escalation: 'medium',
    branch: 'main',
    startedAt: new Date(T0).toISOString(),
    deadlineAt: null,
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: { deployEnvironment: 'prod', landedCount: 0, slot: idleMainlineSlot() },
  };
  const stmts = getStmts();
  stmts.createSession.run(sessionId, AGENT, 'Autopilot', 'claude-code', 'test', 1, 0, 1);
  stmts.updateSessionMode.run('autopilot', sessionId);
  stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), sessionId);

  return {
    root,
    remote,
    work,
    sha,
    sessionId,
    project: { id: `proj-ml-fault-${n}`, cwd: work } as unknown as Project,
    faults,
    clock: { now: T0 },
    events: [],
    writes: 0,
    writeLabels: [],
    checkCalls: 0,
    pushFaultUsed: false,
    deployYamlFaultUsed: false,
    movingPushes: 0,
    runs: [],
    boots: 0,
    repushed: false,
  };
}

function killedGit(): { exitCode: null; stdout: string; stderr: string } {
  return { exitCode: null, stdout: '', stderr: 'killed' };
}

/** One Hub process: all in-memory state lives here and dies with it. */
function bootProcess(world: World) {
  world.boots++;
  const real = getStmts();
  const pending = new Set<Promise<unknown>>();
  const proc = { dead: false };

  const guard = () => {
    if (proc.dead) throw new Crash('the process is gone');
  };
  /** A durable write or side effect just happened; the process may die here. */
  const event = (label: string) => {
    world.events.push(label);
    if (world.faults.crashAfterEvent === world.events.length) {
      proc.dead = true;
      throw new Crash(`crash after #${world.events.length} ${label}`);
    }
  };
  const writeFault = (label: string): 'throw' | 'refuse' | null => {
    world.writes++;
    world.writeLabels.push(label);
    const f = world.faults.failWrite;
    if (!f) return null;
    if (f.kind === 'throw') return world.writes === f.index ? 'throw' : null;
    // Refuse every retry of that compare-and-set, not just the first try.
    return world.writes >= f.index && world.writes < f.index + 5 ? 'refuse' : null;
  };
  const ioError = () => new Error('SQLITE_IOERR: disk I/O error');
  /**
   * The only path for a modeled durable write: the session row, messages,
   * deployment rows, and Finalize run rows all go through here. The write can
   * fail (the Nth write throws, or a compare-and-set is refused), and the
   * process can die right after it commits. A clean run's events other than
   * `git push` are exactly its writes, which the suite checks, so a write that
   * skips this helper fails the suite instead of escaping fault injection.
   */
  const durable = <T>(
    label: string,
    apply: () => T,
    opts: { refused?: () => T; committed?: (out: T) => boolean } = {},
  ): T => {
    guard();
    const fault = writeFault(label);
    if (fault === 'refuse' && opts.refused) return opts.refused();
    if (fault) throw ioError();
    const out = apply();
    if (opts.committed?.(out) ?? true) event(label);
    return out;
  };
  /** Real Finalize wraps its run-status writes in try/catch; a failed one is logged and skipped. */
  const bestEffort = (write: () => void) => {
    try {
      write();
    } catch (err) {
      if (err instanceof Crash) throw err;
    }
  };
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.then(
      () => pending.delete(p),
      () => pending.delete(p),
    );
    return p;
  };

  const stmts = {
    getSession: {
      get: (id: string) => {
        guard();
        return real.getSession.get(id);
      },
    },
    casSessionAutopilotConfig: {
      run: (next: string, id: string, prev: string | null) =>
        durable(
          `slot write (${parseAutopilotSessionConfig(next)?.mainline?.slot.phase})`,
          () => real.casSessionAutopilotConfig.run(next, id, prev),
          {
            refused: () => ({ changes: 0, lastInsertRowid: 0 }),
            committed: (info) => info.changes === 1,
          },
        ),
    },
    addMessage: {
      run: (...args: unknown[]) =>
        durable(`message (${String(args[2])})`, () => real.addMessage.run(...args)),
    },
  };
  const rowStmts = stmts as unknown as AutopilotRowStmts;
  const postNotice = (sessionId: string, content: string) =>
    postAutopilotSystemNotice(
      { stmts: stmts as unknown as Stmts, broadcast: () => {} },
      sessionId,
      content,
    );

  // --- git ---------------------------------------------------------------
  const pushGit: DefaultBranchGitRunner = async (argv, opts) => {
    guard();
    if (world.faults.push === 'killed' && !world.pushFaultUsed) {
      world.pushFaultUsed = true;
      return killedGit();
    }
    const result = await runGitCapturingOutput(argv, opts);
    const line = result.stdout.split('\n').find((l) => l.includes('refs/heads/main'));
    if (line && [' ', '*', '+'].includes(line[0]!)) world.movingPushes++;
    guard();
    event('git push');
    if (world.faults.push === 'output_lost' && !world.pushFaultUsed) {
      world.pushFaultUsed = true;
      return killedGit();
    }
    return result;
  };
  const checkGit: RemoteCheckGitRunner = async (argv, opts) => {
    guard();
    world.checkCalls++;
    if (world.faults.failCheckCalls?.(world.checkCalls)) return killedGit();
    const result = await runRemoteCheckGit(argv, opts);
    guard();
    return result;
  };

  // --- Finalize (run bookkeeping only; the push is the production code) ----
  // Mirrors push-run.ts / automation-runner.ts: run creation can fail (the
  // caller sees the error), status writes around the push are best-effort,
  // and a run left at `pushing` with no push in progress is parked again.
  const pushing = new Set<string>();
  const setRun = (run: World['runs'][number], status: RunStatus) =>
    durable(`finalize run ${status}`, () => {
      run.status = status;
    });
  const latestRun = () => world.runs[world.runs.length - 1];
  const startRun = () =>
    durable('finalize run created', () => {
      const run = { id: `run-${world.runs.length + 1}`, status: 'validating' as RunStatus };
      world.runs.push(run);
      return run;
    });
  /** Push a validated or parked run. Takes the run synchronously, so two callers never both push it. */
  const pushRun = async (
    run: World['runs'][number],
  ): Promise<'pushed' | 'parked' | 'failed' | 'skipped'> => {
    guard();
    if (pushing.has(run.id)) return 'skipped';
    if (run.status !== 'validating' && run.status !== 'ready_to_push') return 'skipped';
    pushing.add(run.id);
    try {
      bestEffort(() => setRun(run, 'pushing'));
      const result = await pushValidatedCommitToDefaultBranch({
        stmts: rowStmts,
        sessionId: world.sessionId,
        project: world.project,
        worktreePath: world.work,
        sha: world.sha,
        defaultBranch: 'main',
        env: GIT_ENV,
        git: pushGit,
        guardOrigin: async () => guard(),
        log: () => {},
      });
      guard();
      if (result.kind === 'refused') {
        bestEffort(() => setRun(run, 'ready_to_push'));
        return 'parked';
      }
      if (result.kind === 'landed' || result.kind === 'already_landed') {
        bestEffort(() => setRun(run, 'pushed'));
        return 'pushed';
      }
      bestEffort(() => setRun(run, 'failed'));
      return 'failed';
    } finally {
      pushing.delete(run.id);
    }
  };
  /** retryParkedPushAfterSlotFreed, and the parked-run branch of the others. */
  const pushParked = async (): Promise<MainlineRestartResult> => {
    const run = latestRun();
    if (run?.status !== 'ready_to_push') return { kind: 'accepted', detail: 'nothing parked' };
    const out = await pushRun(run);
    if (out === 'pushed') return { kind: 'accepted', detail: 'parked run pushed' };
    if (out === 'failed') return { kind: 'dropped', detail: 'push failed' };
    return { kind: 'retry', detail: 'still parked' };
  };
  /** Whether the session has work Finalize has not landed (getSessionCommittableChanges). */
  const committable = () => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', world.sha, 'refs/heads/main'], {
        cwd: world.remote,
        env: GIT_ENV,
        stdio: 'ignore',
      });
      return false;
    } catch {
      return true;
    }
  };
  /** resumeMainlineFinalize: the reconciler's idle-slot resume. */
  const resumeFinalize = async (): Promise<MainlineRestartResult> => {
    guard();
    const run = latestRun();
    if (run?.status === 'pushing' && !pushing.has(run.id)) {
      try {
        setRun(run, 'ready_to_push');
      } catch (err) {
        if (err instanceof Crash) throw err;
        return { kind: 'retry', detail: 'could not re-park' };
      }
    }
    if (run?.status === 'ready_to_push') return pushParked();
    if (run && (run.status === 'validating' || run.status === 'pushing')) {
      return { kind: 'accepted', detail: 'in flight' };
    }
    // maybeAutoStartFinalizeForSession: an agent_block kickoff reuses any run
    // already created for this head, so it only starts one when none exists.
    // A failed creation throws, which is `retry`.
    if (world.runs.length === 0 && committable()) startRun();
    return { kind: 'accepted', detail: 'auto-start checked' };
  };
  /** restartFinalizeAfterMainlineAbsent. A failed run creation throws, which is `retry`. */
  const restartAfterAbsent = async (): Promise<MainlineRestartResult> => {
    guard();
    const run = latestRun();
    if (run?.status === 'ready_to_push') return pushParked();
    if (run?.status === 'cancelled') return { kind: 'dropped', detail: 'cancelled' };
    if (run && (run.status === 'validating' || run.status === 'pushing')) {
      return { kind: 'accepted', detail: 'in flight' };
    }
    startRun();
    return { kind: 'accepted', detail: 'fresh run started' };
  };

  // Boot recovery: an interrupted run is failed and re-triggered from scratch.
  if (world.boots > 1) {
    for (const run of [...world.runs]) {
      if (run.status !== 'validating' && run.status !== 'pushing') continue;
      bestEffort(() => {
        setRun(run, 'infra_error');
        startRun();
      });
    }
  }

  // --- the production loop -------------------------------------------------
  const reconciler = createMainlineReconciler({
    stmts: rowStmts,
    isPushLive: isMainlinePushLive,
    checkRemote: async ({ sha, branch }) => {
      guard();
      return checkCommitOnRemoteBranch({
        source: { kind: 'fetch', repoPath: world.work, env: GIT_ENV },
        sha,
        branch,
        git: checkGit,
      });
    },
    restartFinalize: () => track(restartAfterAbsent()),
    resumeFinalize: () => track(resumeFinalize()),
    postNotice,
    now: () => world.clock.now,
    log: () => {},
  });
  const reporter = createMainlineReportDelivery({
    stmts: rowStmts,
    findReportKey: (sessionId, key) => {
      guard();
      return findMainlineReportKey(getDb(), sessionId, key);
    },
    // Stands in for handleChat: check the gate right before persisting.
    dispatchTurn: (session, content, acceptTurn) =>
      track(
        (async () => {
          await Promise.resolve();
          guard();
          if (!acceptTurn({ busy: false })) throw new Error('turn refused');
          stmts.addMessage.run(uuidv4(), session.id, 'user', content, ...Array(7).fill(null));
        })(),
      ),
    postNotice,
    now: () => world.clock.now,
    log: () => {},
  });
  const watcher = createMainlineDeployWatcher({
    stmts: rowStmts,
    listCandidates: () => {
      guard();
      return [{ id: world.sessionId, agent_id: AGENT, owner_user_id: null }];
    },
    findProjectForAgent: () => {
      guard();
      return world.project;
    },
    readDeployYamlAtCommit: async (project, sha) => {
      guard();
      if (world.faults.failDeployYamlRead && !world.deployYamlFaultUsed) {
        world.deployYamlFaultUsed = true;
        throw new Error('git show timed out');
      }
      return readDeployYamlAtCommit({ project, sha });
    },
    isEnvironmentDeployable: () => {
      guard();
      return true;
    },
    prepareCheckout: async (_project, sha) => {
      guard();
      return { worktreePath: join(world.root, `checkout-${sha.slice(0, 7)}`), resolvedRef: sha };
    },
    // The orchestrator: creates the row carrying the landing key; it runs on the next tick.
    triggerDeployment: async (input) =>
      durable('deployment created', () =>
        createDeployment({
          projectId: input.projectId,
          environment: input.environment,
          ref: input.ref,
          trigger: input.trigger,
          triggeredBy: null,
          status: 'pending',
          meta: input.meta,
        }),
      ),
    listDeploymentsByLandingKey: (projectId, key) => {
      guard();
      return listDeploymentsByLandingKey(projectId, key);
    },
    getDeployment: (id) => {
      guard();
      return getDeployment(id);
    },
    postNotice,
    reconcile: (session) => reconciler.reconcile(session),
    report: (session) => reporter.deliver(session),
    now: () => world.clock.now,
    log: () => {},
  });

  setMainlineSlotFreedListener(() => {
    setImmediate(() => {
      if (!proc.dead) void track(pushParked()).catch(() => {});
    });
  });

  return {
    proc,
    startRun,
    /** Finalize finishes validating and pushes. */
    async finalizeStep(): Promise<void> {
      for (const run of [...world.runs]) {
        if (run.status === 'validating') await track(pushRun(run));
      }
    },
    sweep: () => watcher.sweep(),
    /** The orchestrator finishes every deployment it started. */
    orchestratorTick(): void {
      guard();
      for (const row of listDeployments(world.project.id)) {
        if (row.status !== 'pending' && row.status !== 'running') continue;
        // A failed status write leaves the row running; the orchestrator
        // writes the result again on its next tick.
        bestEffort(() =>
          durable('deployment finished', () => updateDeploymentStatus(row.id, 'success')),
        );
      }
    },
    /** Let deferred work (restarts, dispatches, slot-freed retries) finish. */
    async drain(): Promise<void> {
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await reconciler.settled().catch(() => {});
        if (pending.size === 0 && i > 2) return;
        await Promise.allSettled([...pending]);
      }
    },
  };
}

type Proc = ReturnType<typeof bootProcess>;

function storedConfig(world: World): AutopilotSessionConfig {
  const row = getStmts().getSession.get(world.sessionId) as {
    autopilot_session_config: string | null;
  };
  return parseAutopilotSessionConfig(row.autopilot_session_config)!;
}

function reportMessages(world: World): string[] {
  const rows = getDb()
    .prepare(
      `SELECT content FROM messages WHERE session_id = ? AND instr(content, 'autopilot-report:') > 0`,
    )
    .all(world.sessionId) as Array<{ content: string }>;
  return rows.map((r) => r.content);
}

function settled(world: World): boolean {
  const cfg = storedConfig(world);
  const busyRun = world.runs.some((r) =>
    ['validating', 'pushing', 'ready_to_push'].includes(r.status),
  );
  return (
    cfg.mainline!.slot.phase === 'idle' &&
    !cfg.mainline!.restartOwed &&
    !busyRun &&
    reportMessages(world).length > 0
  );
}

async function runCycle(world: World): Promise<void> {
  let proc: Proc = bootProcess(world);
  const step = async (fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof Crash)) throw err;
    }
  };
  // The agent's turn ended with committable work: Finalize starts. If
  // creating the run fails, auto-start only logs it; the reconciler's idle
  // resume starts it again.
  await step(() => proc.startRun()).catch(() => {});
  let quietTicks = 0;
  for (let tick = 0; tick < MAX_TICKS && quietTicks < 3; tick++) {
    await step(() => proc.finalizeStep());
    await step(() => proc.sweep());
    await step(() => proc.drain());
    await step(() => proc.orchestratorTick());
    await step(() => proc.sweep());
    await step(() => proc.drain());
    if (proc.proc.dead) {
      await proc.drain();
      proc = bootProcess(world);
      continue;
    }
    // Keep going a few ticks after it settles: nothing more may happen.
    if (settled(world)) {
      if (world.faults.repush && !world.repushed) {
        world.repushed = true;
        // A failed creation means no re-push; the cycle's end state stands.
        await step(() => proc.startRun()).catch(() => {});
        world.clock.now += TICK_MS;
        continue;
      }
      quietTicks++;
    }
    world.clock.now += TICK_MS;
  }
}

/** The end state every scenario must reach. Returns what is wrong, if anything. */
function endStateProblems(world: World): string[] {
  const problems: string[] = [];
  const tip = git(world.remote, 'rev-parse', 'refs/heads/main');
  if (tip !== world.sha) problems.push(`remote main is ${tip}, not the slice`);
  const moves = world.faults.alreadyOnRemote ? 0 : 1;
  if (world.movingPushes !== moves) problems.push(`${world.movingPushes} pushes moved main`);
  const deployments = listDeployments(world.project.id);
  if (deployments.length !== 1) problems.push(`${deployments.length} deployments`);
  else if (deployments[0]!.ref !== world.sha) problems.push('deployment is for another ref');
  else if (deployments[0]!.status !== 'success') {
    problems.push(`deployment ${deployments[0]!.status}`);
  }
  const reports = reportMessages(world);
  if (reports.length !== 1) problems.push(`${reports.length} reports delivered`);
  const cfg = storedConfig(world);
  if (cfg.mainline!.slot.phase !== 'idle') problems.push(`slot ${cfg.mainline!.slot.phase}`);
  if (cfg.mainline!.restartOwed) problems.push('a Finalize restart is still owed');
  if (cfg.mainline!.landedCount !== 1) problems.push(`landedCount ${cfg.mainline!.landedCount}`);
  const stuck = world.runs.filter((r) =>
    ['validating', 'pushing', 'ready_to_push'].includes(r.status),
  );
  if (stuck.length) problems.push(`runs not finished: ${stuck.map((r) => r.status).join(',')}`);
  return problems;
}

const worlds: World[] = [];

async function scenario(faults: Faults): Promise<World> {
  const world = createWorld(faults);
  worlds.push(world);
  await runCycle(world);
  return world;
}

/** Run every variant; report each one that did not reach the end state. */
async function everyVariant(variants: Array<{ label: string; faults: Faults }>) {
  const failures: string[] = [];
  for (const v of variants) {
    const world = await scenario(v.faults);
    const problems = endStateProblems(world);
    if (problems.length) {
      failures.push(`${v.label}: ${problems.join('; ')} [events: ${world.events.join(' > ')}]`);
    }
  }
  return failures;
}

let clean: World;

beforeAll(async () => {
  setMainlineSlotLandedListener(null);
  clean = await scenario({});
}, 60_000);

afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

afterAll(() => {
  setMainlineSlotFreedListener(null);
  getDb().prepare('DELETE FROM sessions WHERE agent_id = ?').run(AGENT);
});

describe('mainline Autopilot under faults', () => {
  it('a clean cycle pushes, deploys, and reports once', () => {
    expect(endStateProblems(clean)).toEqual([]);
    expect(clean.boots).toBe(1);
    // The walk covers every kind of step the fault runs inject at.
    expect(clean.events).toEqual(
      expect.arrayContaining([
        'finalize run created',
        'slot write (pushing)',
        'git push',
        'slot write (landed)',
        'deployment created',
        'slot write (deploying)',
        'deployment finished',
        'slot write (reporting)',
        'message (user)',
        'slot write (idle)',
      ]),
    );
    // Every durable write goes through the one faultable path: the clean
    // run's writes are exactly its events other than the push itself, so the
    // write sweeps below reach every one of them.
    expect(clean.writeLabels).toEqual(clean.events.filter((e) => e !== 'git push'));
    expect(clean.writeLabels).toEqual(
      expect.arrayContaining([
        'finalize run created',
        'finalize run pushing',
        'finalize run pushed',
        'deployment created',
        'deployment finished',
      ]),
    );
  });

  it('a restart after every durable write and side effect still ends with one push, one deploy, one report', async () => {
    const total = clean.events.length;
    const failures = await everyVariant(
      clean.events.map((label, i) => ({
        label: `crash after #${i + 1} ${label}`,
        faults: { crashAfterEvent: i + 1 },
      })),
    );
    expect(failures).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(10);
  }, 300_000);

  it.each(['throw', 'refuse'] as const)(
    'a database write that fails (%s) at any step reaches the same end state',
    async (kind) => {
      const variants = Array.from({ length: clean.writes }, (_, i) => ({
        label: `write #${i + 1} ${kind}`,
        faults: { failWrite: { index: i + 1, kind } },
      }));
      expect(await everyVariant(variants)).toEqual([]);
    },
    300_000,
  );

  it.each(['output_lost', 'killed'] as const)(
    'a push whose outcome is unknown (%s) is settled by the remote, with every remote read failing once in turn',
    async (push) => {
      // How many git calls the remote checks make when nothing else fails.
      const probe = await scenario({ push });
      expect(endStateProblems(probe)).toEqual([]);
      expect(probe.checkCalls).toBeGreaterThan(0);
      const variants = Array.from({ length: probe.checkCalls }, (_, i) => ({
        label: `push ${push}, remote-check git call #${i + 1} killed`,
        faults: { push, failCheckCalls: (call: number) => call === i + 1 },
      }));
      expect(await everyVariant(variants)).toEqual([]);
    },
    300_000,
  );

  it('remote reads that keep failing hold the landing, escalate once, and recover', async () => {
    const world = await scenario({
      push: 'output_lost',
      failCheckCalls: (call) => call <= 12,
    });
    expect(endStateProblems(world)).toEqual([]);
    const escalations = (
      getDb()
        .prepare(`SELECT content FROM messages WHERE session_id = ? AND content LIKE ?`)
        .all(world.sessionId, '%still cannot tell whether%') as unknown[]
    ).length;
    expect(escalations).toBe(1);
  }, 60_000);

  it('each failed Finalize run write still ends with one push, one deploy, one report', async () => {
    const runWrites = clean.writeLabels
      .map((label, i) => ({ label, index: i + 1 }))
      .filter(({ label }) => label.startsWith('finalize run') && label !== 'finalize run created');
    expect(runWrites.map((w) => w.label)).toEqual(['finalize run pushing', 'finalize run pushed']);
    const failures = await everyVariant(
      runWrites.map(({ label, index }) => ({
        label: `${label} fails`,
        faults: { failWrite: { index, kind: 'throw' as const } },
      })),
    );
    expect(failures).toEqual([]);
  }, 60_000);

  it('a first Finalize run that cannot be created is started again by the idle resume', async () => {
    expect(clean.writeLabels[0]).toBe('finalize run created');
    const world = await scenario({ failWrite: { index: 1, kind: 'throw' } });
    // The failed kickoff wrote nothing; the retry created the only run.
    expect(world.writeLabels.filter((l) => l === 'finalize run created')).toHaveLength(2);
    expect(world.runs).toHaveLength(1);
    expect(endStateProblems(world)).toEqual([]);
  }, 60_000);

  it('a failed deployment-status write is written again on a later tick: one deploy, one report', async () => {
    const index = clean.writeLabels.indexOf('deployment finished') + 1;
    expect(index).toBeGreaterThan(0);
    const world = await scenario({ failWrite: { index, kind: 'throw' } });
    expect(world.writeLabels.filter((l) => l === 'deployment finished')).toHaveLength(2);
    expect(endStateProblems(world)).toEqual([]);
  }, 60_000);

  describe('the same commit pushed again after its cycle finished', () => {
    let repush: World;
    beforeAll(async () => {
      repush = await scenario({ repush: true });
    }, 60_000);

    it('frees the slot with no second deploy or report', () => {
      expect(repush.repushed).toBe(true);
      expect(repush.events.filter((e) => e === 'git push')).toHaveLength(2);
      expect(endStateProblems(repush)).toEqual([]);
    });

    it('holds under a restart after every step and every failed write of the re-push', async () => {
      const firstRepushEvent = repush.events.lastIndexOf('finalize run created') + 1;
      const firstRepushWrite = repush.writeLabels.length;
      const crashes = repush.events
        .map((label, i) => ({ label, i }))
        .filter(({ i }) => i + 1 >= firstRepushEvent)
        .map(({ label, i }) => ({
          label: `re-push, crash after #${i + 1} ${label}`,
          faults: { repush: true, crashAfterEvent: i + 1 },
        }));
      // Writes of the re-push: the ones the clean re-push run adds over a single cycle.
      const writes = (['throw', 'refuse'] as const).flatMap((kind) =>
        Array.from({ length: firstRepushWrite - clean.writes }, (_, j) => ({
          label: `re-push, write #${clean.writes + j + 1} ${kind}`,
          faults: { repush: true, failWrite: { index: clean.writes + j + 1, kind } },
        })),
      );
      expect(crashes.length).toBeGreaterThan(3);
      expect(writes.length).toBeGreaterThan(0);
      expect(await everyVariant([...crashes, ...writes])).toEqual([]);
    }, 300_000);
  });

  it('a commit someone else already pushed is still deployed and reported by this session', async () => {
    const world = await scenario({ alreadyOnRemote: true });
    expect(endStateProblems(world)).toEqual([]);
    expect(storedConfig(world).mainline!.lastLandedSha).toBe(world.sha);
  }, 60_000);

  it('a deploy.yaml read that fails at the deploy step retries instead of giving up', async () => {
    const world = await scenario({ failDeployYamlRead: true });
    expect(world.deployYamlFaultUsed).toBe(true);
    expect(endStateProblems(world)).toEqual([]);
  }, 60_000);
});
