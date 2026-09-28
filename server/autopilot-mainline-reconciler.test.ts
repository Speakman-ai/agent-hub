/**
 * Mainline push reconciler against the real session row and real git: a bare
 * remote plus a working clone. The remote check is the production
 * `checkCommitOnRemoteBranch`; failures are injected by breaking the remote
 * or wrapping the git runner.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts } from './db.js';
import { wipeTables } from './test/destructive-db.js';
import type { DeploymentRow, Project } from './types.js';
import {
  MAINLINE_RECONCILE_BACKOFF_MAX_MS,
  MAINLINE_RECONCILE_ESCALATE_AFTER_MS,
  createMainlineReconciler,
  mainlineReconcileBackoffMs,
  type MainlineReconcilerDeps,
} from './autopilot-mainline-reconciler.js';
import {
  checkCommitOnRemoteBranch,
  runRemoteCheckGit,
  type RemoteCheckGitRunner,
} from './autopilot-mainline-remote-check.js';
import { createMainlineDeployWatcher } from './autopilot-mainline-deploy-watcher.js';
import type { AutopilotRowStmts } from './session-autopilot-slot.js';
import {
  isMainlinePushLive,
  pushValidatedCommitToDefaultBranch,
  type GitRunResult,
} from './finalize/push-to-default-branch.js';
import {
  type AutopilotSessionConfig,
  parseAutopilotSessionConfig,
} from '../shared/utils/sessionAutopilot.js';
import { type MainlineSlot, idleMainlineSlot } from '../shared/utils/autopilotMainlineSlot.js';
import {
  createDeployment,
  getDeployment,
  listDeploymentsByLandingKey,
} from './deploy/deployment-store.js';
import type { TriggerDeploymentInput } from './deploy/deploy-orchestrator.js';

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const ATTEMPT = 'attempt-r1';
const PROJECT_ID = 'proj-mainline-reconcile';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@e',
};

let root: string;
let remote: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(name: string): string {
  writeFileSync(join(work, name), name);
  git(work, 'add', name);
  git(work, 'commit', '-q', '-m', name);
  return git(work, 'rev-parse', 'HEAD');
}

/** Land the clone's HEAD on the remote (a fetch into the bare repo, not a push). */
function publish(): void {
  git(remote, 'fetch', '-q', work, '+HEAD:refs/heads/main');
}

function config(slot: Partial<MainlineSlot>): AutopilotSessionConfig {
  return {
    durationHours: 0,
    brief: 'Ship it',
    goal: 'Live and healthy',
    escalation: 'medium',
    branch: 'main',
    startedAt: new Date(T0).toISOString(),
    deadlineAt: null,
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: {
      deployEnvironment: 'prod',
      landedCount: 0,
      slot: { ...idleMainlineSlot(), enteredAt: new Date(T0).toISOString(), ...slot },
    },
  };
}

let seq = 0;
function seedSession(cfg: AutopilotSessionConfig): string {
  const stmts = getStmts();
  const id = `ml-rec-${++seq}-${Date.now()}`;
  stmts.createSession.run(id, 'agent-ml-rec', 'Autopilot', 'claude-code', 'test', 1, 0, 1);
  stmts.updateSessionMode.run('autopilot', id);
  stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), id);
  return id;
}

function stored(id: string): AutopilotSessionConfig {
  const row = getStmts().getSession.get(id) as { autopilot_session_config: string | null };
  return parseAutopilotSessionConfig(row.autopilot_session_config)!;
}

function storedSlot(id: string): MainlineSlot {
  return stored(id).mainline!.slot;
}

function overwriteSlot(id: string, slot: Partial<MainlineSlot>): void {
  getStmts().updateSessionAutopilotConfig.run(JSON.stringify(config(slot)), id);
}

interface Harness {
  deps: MainlineReconcilerDeps;
  clock: { now: number };
  notices: string[];
  restart: ReturnType<typeof vi.fn>;
  checks: { count: number };
  failCas: { value: boolean };
  live: Set<string>;
}

function harness(overrides: Partial<MainlineReconcilerDeps> = {}, runner?: RemoteCheckGitRunner) {
  const real = getStmts();
  const failCas = { value: false };
  const stmts: AutopilotRowStmts = {
    getSession: real.getSession,
    casSessionAutopilotConfig: {
      run: (...args: [string, string, string | null]) =>
        failCas.value
          ? { changes: 0, lastInsertRowid: 0 }
          : real.casSessionAutopilotConfig.run(...args),
    } as unknown as AutopilotRowStmts['casSessionAutopilotConfig'],
  };
  const clock = { now: T0 };
  const notices: string[] = [];
  const restart = vi.fn(async () => ({ kind: 'accepted' as const, detail: 'run started' }));
  const checks = { count: 0 };
  const live = new Set<string>();
  const deps: MainlineReconcilerDeps = {
    stmts,
    isPushLive: (sessionId, attemptId) => live.has(`${sessionId}:${attemptId}`),
    checkRemote: async ({ sha, branch }) => {
      checks.count++;
      return checkCommitOnRemoteBranch({
        source: { kind: 'fetch', repoPath: work, env: GIT_ENV },
        sha,
        branch,
        git: runner,
      });
    },
    restartFinalize: restart,
    postNotice: (_id, content) => notices.push(content),
    now: () => clock.now,
    log: () => {},
    ...overrides,
  };
  const h: Harness = { deps, clock, notices, restart, checks, failCas, live };
  return h;
}

beforeEach(() => {
  getDb().prepare(`DELETE FROM sessions WHERE agent_id = 'agent-ml-rec'`).run();
  root = mkdtempSync(join(tmpdir(), 'mainline-reconcile-'));
  remote = join(root, 'remote.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'remote', 'add', 'origin', remote);
  commit('base');
  publish();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('stranded pushes', () => {
  it('moves a pushing slot with no live push to uncertain, then to landed when the remote has it', async () => {
    const sha = commit('a');
    publish();
    const h = harness();
    const id = seedSession(config({ phase: 'pushing', attemptId: ATTEMPT, sha }));

    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });

    const slot = storedSlot(id);
    expect(slot).toMatchObject({ phase: 'landed', attemptId: ATTEMPT, sha });
    expect(stored(id).mainline!.landedCount).toBe(1);
    expect(h.notices).toEqual([
      expect.stringContaining('lost track of the push'),
      expect.stringContaining('confirmed ' + sha.slice(0, 7) + ' is on main'),
    ]);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('leaves a pushing slot alone while this process still has that push in flight', async () => {
    const sha = commit('a');
    const h = harness();
    const id = seedSession(config({ phase: 'pushing', attemptId: ATTEMPT, sha }));
    h.live.add(`${id}:${ATTEMPT}`);

    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });

    expect(storedSlot(id).phase).toBe('pushing');
    expect(h.checks.count).toBe(0);
    expect(h.notices).toEqual([]);
  });

  it('a real in-flight push is registered live, and the sweep never marks it uncertain', async () => {
    const sha = commit('a');
    const id = seedSession(config({ phase: 'idle' }));
    let release!: (r: GitRunResult) => void;
    const pushGit = () => new Promise<GitRunResult>((resolve) => (release = resolve));
    const pushing = pushValidatedCommitToDefaultBranch({
      stmts: getStmts(),
      sessionId: id,
      project: { id: PROJECT_ID, cwd: work } as unknown as Project,
      worktreePath: work,
      sha,
      defaultBranch: 'main',
      env: GIT_ENV,
      git: pushGit,
      guardOrigin: async () => {},
      mintAttemptId: () => ATTEMPT,
      log: () => {},
    });
    await vi.waitFor(() => expect(storedSlot(id).phase).toBe('pushing'));
    expect(isMainlinePushLive(id, ATTEMPT)).toBe(true);

    const h = harness({ isPushLive: isMainlinePushLive });
    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id).phase).toBe('pushing');

    release({
      exitCode: 0,
      stdout: `To x\n \t${sha}:refs/heads/main\t[up to date]\nDone\n`,
      stderr: '',
    });
    await pushing;
    expect(isMainlinePushLive(id, ATTEMPT)).toBe(false);
    expect(storedSlot(id).phase).toBe('landed');
  });

  it('does not overwrite a push that settled while the sweep was deciding', async () => {
    const sha = commit('a');
    const h = harness();
    const id = seedSession(config({ phase: 'pushing', attemptId: ATTEMPT, sha }));
    h.deps.isPushLive = () => {
      // The live push writes its outcome just as the sweep looks.
      overwriteSlot(id, { phase: 'landed', attemptId: ATTEMPT, sha });
      return false;
    };
    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id).phase).toBe('landed');
    expect(h.notices).toEqual([]);
  });
});

describe('uncertain slots', () => {
  it('absent moves to idle and restarts Finalize', async () => {
    const sha = commit('a'); // never reached the remote
    const h = harness();
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));

    let owedWhenCalled: unknown = null;
    h.restart.mockImplementationOnce(async () => {
      owedWhenCalled = stored(id).mainline!.restartOwed;
      return { kind: 'accepted', detail: 'run started' };
    });
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    await reconciler.settled();

    expect(storedSlot(id)).toMatchObject({ phase: 'idle', attemptId: null, sha: null });
    // The debt was written with the slot write, before the restart ran.
    expect(owedWhenCalled).toMatchObject({ attemptId: ATTEMPT, sha });
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.restart).toHaveBeenCalledWith(id);
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
    expect(h.notices).toEqual([expect.stringContaining('did not reach main')]);
  });

  it('unknown keeps the slot, backs off, and does not ask again inside the window', async () => {
    const sha = commit('a');
    publish();
    git(work, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const h = harness();
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const reconciler = createMainlineReconciler(h.deps);

    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id)).toMatchObject({ phase: 'uncertain', attemptId: ATTEMPT, sha });
    expect(h.checks.count).toBe(1);
    expect(reconciler.backoffFor(`${id}:${ATTEMPT}`)).toEqual({
      failures: 1,
      nextAt: T0 + mainlineReconcileBackoffMs(1),
    });

    h.clock.now = T0 + mainlineReconcileBackoffMs(1) - 1;
    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(h.checks.count).toBe(1);

    h.clock.now = T0 + mainlineReconcileBackoffMs(1);
    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(h.checks.count).toBe(2);
    expect(reconciler.backoffFor(`${id}:${ATTEMPT}`)?.failures).toBe(2);
    expect(h.restart).not.toHaveBeenCalled();
    expect(h.notices).toEqual([]);
  });

  it('a timed-out fetch is unknown and never clears the attempt', async () => {
    const sha = commit('a');
    const runner: RemoteCheckGitRunner = async (argv, opts) =>
      argv[0] === 'fetch'
        ? { exitCode: null, stdout: '', stderr: 'timed out' }
        : runRemoteCheckGit(argv, opts);
    const h = harness({}, runner);
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));

    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });

    expect(storedSlot(id).phase).toBe('uncertain');
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('a remote check that throws is unknown', async () => {
    const sha = commit('a');
    const h = harness({
      checkRemote: async () => {
        throw new Error('worktree gone');
      },
    });
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id).phase).toBe('uncertain');
    expect(reconciler.backoffFor(`${id}:${ATTEMPT}`)?.failures).toBe(1);
  });

  it('escalates once after the slot has been uncertain for the threshold', async () => {
    const sha = commit('a');
    const h = harness({
      checkRemote: async () => ({ kind: 'unknown', detail: 'remote down' }),
    });
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const reconciler = createMainlineReconciler(h.deps);

    h.clock.now = T0 + MAINLINE_RECONCILE_ESCALATE_AFTER_MS - 1;
    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id).escalatedAt).toBeNull();

    for (let i = 0; i < 3; i++) {
      h.clock.now += 11 * 60_000;
      await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    }
    const slot = storedSlot(id);
    expect(slot.phase).toBe('uncertain');
    expect(slot.escalatedAt).not.toBeNull();
    expect(h.notices.filter((n) => n.includes('still cannot tell'))).toHaveLength(1);
  });

  it('a late present answer does not overwrite a newer attempt', async () => {
    const sha = commit('a');
    publish();
    const h = harness();
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const realCheck = h.deps.checkRemote;
    h.deps.checkRemote = async (args) => {
      const answer = await realCheck(args);
      // While the answer was in flight a newer attempt took the slot.
      overwriteSlot(id, { phase: 'pushing', attemptId: 'attempt-newer', sha });
      return answer;
    };
    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id)).toMatchObject({ phase: 'pushing', attemptId: 'attempt-newer' });
    expect(h.notices).toEqual([]);
  });

  it('a late absent answer does not free a newer attempt or restart Finalize', async () => {
    const sha = commit('a');
    const h = harness();
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const realCheck = h.deps.checkRemote;
    h.deps.checkRemote = async (args) => {
      const answer = await realCheck(args);
      overwriteSlot(id, { phase: 'uncertain', attemptId: 'attempt-newer', sha });
      return answer;
    };
    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id)).toMatchObject({ phase: 'uncertain', attemptId: 'attempt-newer' });
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('a refused slot write after a real answer backs off instead of acting', async () => {
    const sha = commit('a');
    const h = harness();
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    h.failCas.value = true;
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(storedSlot(id).phase).toBe('uncertain');
    expect(h.restart).not.toHaveBeenCalled();
    expect(reconciler.backoffFor(`${id}:${ATTEMPT}`)?.failures).toBe(1);
  });
});

describe('recovery through the deploy watcher sweep', () => {
  beforeEach(() => {
    wipeTables(getDb(), ['deployment_steps', 'deployments', 'deployment_environments']);
  });

  it('reads fail, then succeed: the stranded push is found landed and deployed in the same sweep', async () => {
    const sha = commit('a');
    publish();
    git(work, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const h = harness();
    const reconciler = createMainlineReconciler(h.deps);
    const id = seedSession(config({ phase: 'pushing', attemptId: ATTEMPT, sha }));
    const trigger = vi.fn(async (input: TriggerDeploymentInput) =>
      createDeployment({
        projectId: input.projectId,
        environment: input.environment,
        ref: input.ref,
        trigger: input.trigger,
        triggeredBy: null,
        status: 'pending',
        meta: input.meta as Record<string, unknown>,
      }),
    );
    const watcher = createMainlineDeployWatcher({
      stmts: h.deps.stmts,
      listCandidates: () => [{ id, agent_id: 'agent-ml-rec', owner_user_id: null }],
      findProjectForAgent: () => ({ id: PROJECT_ID, cwd: work }) as unknown as Project,
      readDeployYamlAtCommit: async () => ({
        kind: 'present',
        raw: 'version: 1\nenvironments:\n  prod:\n    steps:\n      - name: ship\n        run: echo ship\n',
      }),
      isEnvironmentDeployable: () => true,
      prepareCheckout: async () => ({ worktreePath: join(root, 'checkout'), resolvedRef: sha }),
      triggerDeployment: trigger,
      listDeploymentsByLandingKey,
      getDeployment: (deploymentId: string): DeploymentRow | null => getDeployment(deploymentId),
      postNotice: (_id, content) => h.notices.push(content),
      reconcile: (session) => reconciler.reconcile(session),
      now: () => h.clock.now,
      log: () => {},
    });

    await watcher.sweep();
    expect(storedSlot(id).phase).toBe('uncertain');
    expect(trigger).not.toHaveBeenCalled();

    h.clock.now += 5_000;
    await watcher.sweep();
    expect(h.checks.count).toBe(1); // still inside the backoff window

    git(work, 'remote', 'set-url', 'origin', remote);
    h.clock.now = T0 + mainlineReconcileBackoffMs(1);
    await watcher.sweep();

    expect(h.checks.count).toBe(2);
    const slot = storedSlot(id);
    expect(slot.phase).toBe('deploying');
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(listDeploymentsByLandingKey(PROJECT_ID, `${id}:${ATTEMPT}`)).toHaveLength(1);
    expect(h.restart).not.toHaveBeenCalled();
  });
});

describe('owed Finalize restarts', () => {
  const session = (id: string) => ({ id, agent_id: 'agent-ml-rec' });

  async function absent(h: Harness) {
    const sha = commit('a');
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    return { id, sha, reconciler };
  }

  it('a failed start keeps the restart owed, backs off, and retries until accepted', async () => {
    const h = harness();
    h.restart
      .mockResolvedValueOnce({ kind: 'retry', detail: 'could not load the session context' })
      .mockRejectedValueOnce(new Error('kickoff blew up'));
    const { id, reconciler } = await absent(h);
    const key = `restart:${id}:${ATTEMPT}`;

    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(storedSlot(id).phase).toBe('idle');
    expect(stored(id).mainline!.restartOwed?.attemptId).toBe(ATTEMPT);
    expect(reconciler.backoffFor(key)?.failures).toBe(1);

    h.clock.now = T0 + mainlineReconcileBackoffMs(1) - 1;
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(h.restart).toHaveBeenCalledTimes(1);

    h.clock.now = T0 + mainlineReconcileBackoffMs(1);
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(h.restart).toHaveBeenCalledTimes(2); // threw: still owed
    expect(stored(id).mainline!.restartOwed?.attemptId).toBe(ATTEMPT);
    expect(reconciler.backoffFor(key)?.failures).toBe(2);

    h.clock.now += mainlineReconcileBackoffMs(2);
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(h.restart).toHaveBeenCalledTimes(3);
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
    expect(reconciler.backoffFor(key)).toBeUndefined();

    h.clock.now += 60 * 60_000;
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(h.restart).toHaveBeenCalledTimes(3);
  });

  it('the owed restart survives a Hub restart (a fresh reconciler picks it up from the row)', async () => {
    const h = harness();
    h.restart.mockResolvedValueOnce({
      kind: 'retry',
      detail: 'Finalize automation is not ready yet',
    });
    const { id } = await absent(h);
    expect(stored(id).mainline!.restartOwed?.attemptId).toBe(ATTEMPT);

    const afterBoot = createMainlineReconciler(h.deps);
    await afterBoot.reconcile(session(id));
    await afterBoot.settled();
    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
  });

  it('a dropped restart (stopped, expired, cancelled) clears the debt and says why', async () => {
    const h = harness();
    h.restart.mockResolvedValueOnce({
      kind: 'dropped',
      detail: 'Autopilot has stopped or its time is up',
    });
    const { id, reconciler } = await absent(h);
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
    expect(h.notices.at(-1)).toContain('did not restart Finalize');

    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('only one restart request is in flight at a time', async () => {
    const h = harness();
    let finish!: () => void;
    h.restart.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: 'accepted', detail: 'run started' });
        }),
    );
    const sha = commit('a');
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile(session(id));
    await reconciler.reconcile(session(id));
    await reconciler.reconcile(session(id));
    expect(h.restart).toHaveBeenCalledTimes(1);
    finish();
    await reconciler.settled();
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
  });

  it('settling an old attempt never clears a debt owed for a newer one', async () => {
    const h = harness();
    let finish!: () => void;
    h.restart.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: 'accepted', detail: 'run started' });
        }),
    );
    const sha = commit('a');
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile(session(id));
    // A newer attempt went uncertain and absent while the old request ran.
    const newer = {
      ...config({ phase: 'idle' }),
    };
    newer.mainline!.restartOwed = { attemptId: 'attempt-newer', sha, since: 'x' };
    getStmts().updateSessionAutopilotConfig.run(JSON.stringify(newer), id);
    finish();
    await reconciler.settled();
    expect(stored(id).mainline!.restartOwed?.attemptId).toBe('attempt-newer');
  });

  it('a new push drops the debt', async () => {
    const h = harness();
    h.restart.mockResolvedValue({ kind: 'retry', detail: 'down' });
    const { id } = await absent(h);
    const next = await pushValidatedCommitToDefaultBranch({
      stmts: getStmts(),
      sessionId: id,
      project: { id: PROJECT_ID, cwd: work } as unknown as Project,
      worktreePath: work,
      sha: commit('b'),
      defaultBranch: 'main',
      env: GIT_ENV,
      git: async () => ({ exitCode: null, stdout: '', stderr: 'killed' }),
      guardOrigin: async () => {},
      mintAttemptId: () => 'attempt-2',
      log: () => {},
    });
    expect(next.kind).toBe('unknown');
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
  });

  it('through the watcher sweep: the first restart fails and a later sweep succeeds', async () => {
    const h = harness();
    h.restart.mockResolvedValueOnce({ kind: 'retry', detail: 'Finalize did not start: lock busy' });
    const sha = commit('a'); // never reached the remote
    const id = seedSession(config({ phase: 'pushing', attemptId: ATTEMPT, sha }));
    const reconciler = createMainlineReconciler(h.deps);
    const watcher = createMainlineDeployWatcher({
      stmts: h.deps.stmts,
      listCandidates: () => [{ id, agent_id: 'agent-ml-rec', owner_user_id: null }],
      findProjectForAgent: () => ({ id: PROJECT_ID, cwd: work }) as unknown as Project,
      readDeployYamlAtCommit: async () => ({ kind: 'absent' }),
      isEnvironmentDeployable: () => true,
      prepareCheckout: async () => ({ worktreePath: join(root, 'checkout'), resolvedRef: sha }),
      triggerDeployment: vi.fn(),
      listDeploymentsByLandingKey,
      getDeployment,
      postNotice: (_id, content) => h.notices.push(content),
      reconcile: (s) => reconciler.reconcile(s),
      now: () => h.clock.now,
      log: () => {},
    });

    await watcher.sweep();
    await reconciler.settled();
    expect(storedSlot(id).phase).toBe('idle');
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(stored(id).mainline!.restartOwed?.attemptId).toBe(ATTEMPT);

    h.clock.now = T0 + mainlineReconcileBackoffMs(1);
    await watcher.sweep();
    await reconciler.settled();
    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
  });
});

describe('parked pushes on an idle slot', () => {
  const session = (id: string) => ({ id, agent_id: 'agent-ml-rec' });

  it('asks Finalize to push a parked run, one request at a time, backing off on retry', async () => {
    const id = seedSession(config({ phase: 'idle' }));
    let release!: (r: { kind: 'retry'; detail: string }) => void;
    const resume = vi.fn(
      () => new Promise<{ kind: 'retry'; detail: string }>((resolve) => (release = resolve)),
    );
    const h = harness({ resumeFinalize: resume });
    const reconciler = createMainlineReconciler(h.deps);

    await reconciler.reconcile(session(id));
    await reconciler.reconcile(session(id));
    expect(resume).toHaveBeenCalledTimes(1);

    release({ kind: 'retry', detail: 'still parked' });
    await reconciler.settled();
    expect(reconciler.backoffFor(`resume:${id}`)).toEqual({
      failures: 1,
      nextAt: T0 + mainlineReconcileBackoffMs(1),
    });
    await reconciler.reconcile(session(id));
    expect(resume).toHaveBeenCalledTimes(1);

    h.clock.now = T0 + mainlineReconcileBackoffMs(1);
    resume.mockResolvedValueOnce({ kind: 'accepted', detail: 'pushed' } as never);
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(reconciler.backoffFor(`resume:${id}`)).toBeUndefined();
  });

  it('a parked run waiting on something else is asked again only after the longest backoff', async () => {
    const id = seedSession(config({ phase: 'idle' }));
    const resume = vi.fn(async () => ({ kind: 'dropped' as const, detail: 'manual push' }));
    const h = harness({ resumeFinalize: resume });
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(reconciler.backoffFor(`resume:${id}`)?.nextAt).toBe(
      T0 + MAINLINE_RECONCILE_BACKOFF_MAX_MS,
    );
  });

  it('an owed restart takes precedence over resuming', async () => {
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha: commit('a') }));
    const resume = vi.fn(async () => ({ kind: 'accepted' as const, detail: 'nothing parked' }));
    const h = harness({ resumeFinalize: resume });
    h.restart.mockImplementation(async () => ({ kind: 'retry', detail: 'lock busy' }) as never);
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile(session(id)); // absent: idle with a restart owed
    await reconciler.settled();
    h.clock.now += MAINLINE_RECONCILE_BACKOFF_MAX_MS;
    await reconciler.reconcile(session(id));
    await reconciler.settled();
    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('re-pushed commits', () => {
  it("present, and already this session's last landing: frees the slot with no deploy and no restart owed", async () => {
    const sha = commit('a');
    publish();
    const h = harness();
    const base = config({ phase: 'uncertain', attemptId: ATTEMPT, sha });
    const id = seedSession({
      ...base,
      mainline: { ...base.mainline!, landedCount: 1, lastLandedSha: sha },
    });
    const reconciler = createMainlineReconciler(h.deps);
    await reconciler.reconcile({ id, agent_id: 'agent-ml-rec' });
    await reconciler.settled();

    expect(stored(id).mainline).toMatchObject({
      slot: { phase: 'idle', attemptId: null },
      landedCount: 1,
      lastLandedSha: sha,
    });
    expect(stored(id).mainline!.restartOwed ?? null).toBeNull();
    expect(h.restart).not.toHaveBeenCalled();
    expect(h.notices).toEqual([expect.stringContaining('already on main')]);
  });

  it('present for a commit this session never landed: lands and records it', async () => {
    const sha = commit('a');
    publish();
    const h = harness();
    const id = seedSession(config({ phase: 'uncertain', attemptId: ATTEMPT, sha }));
    await createMainlineReconciler(h.deps).reconcile({ id, agent_id: 'agent-ml-rec' });
    expect(stored(id).mainline).toMatchObject({
      slot: { phase: 'landed' },
      landedCount: 1,
      lastLandedSha: sha,
    });
  });
});
