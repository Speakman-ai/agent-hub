/**
 * GitHub-Actions-style CI for Agent Hub-hosted repos, two
 * triggers sharing one engine:
 *
 *   1. **CI on push** (`trigger_source: 'git_push'`, opt-in via
 *      `Project.ciOnPush.enabled`): the default branch moved (smart-HTTP
 *      push or native PR merge) → run `.agent-hub/ci.yaml` against the
 *      new commit. Missing/invalid config records a failed run (the
 *      operator opted in, so silence would be a lie).
 *
 *   2. **PR-level CI fallback** (`trigger_source: 'pr_push'`, automatic):
 *      an open native PR targeting the repo default branch is NOT covered by a
 *      fully-validated Finalize run (review + checks on that exact sha). Someone pushed
 *      with "push anyway", pushed externally, or added commits after
 *      validation. Run CI against the PR head so the PR still shows
 *      check results. Validated heads SKIP this entirely — that's the
 *      session-validation passthrough. No ci.yaml at the sha → skip
 *      silently (nothing was configured to run).
 *
 * Reuses the Finalize CI machinery wholesale: results land in
 * `finalize_runs` / `finalize_run_jobs` / `finalize_run_steps`, execution
 * goes through `runJobPhase` (DinD / remote fleet runners), and step
 * output persists under a sentinel session so the existing step-output
 * endpoint serves logs.
 *
 * Deliberate differences from a Finalize run: no reviewer, no
 * fix-dispatch loop, no push step — report-only. One run per
 * (project, sha) across BOTH triggers via the shared idempotency key.
 *
 * Concurrency: every branch is its own group (see push-concurrency.ts).
 * Pushes are admitted one at a time per branch (`admitPush`): each reads the
 * live head and runs every skip check, and joins only when it will actually
 * build a new head. It then drops an older push still waiting in the group, and in
 * `cancel` mode stops the group's running CI for a different head, which
 * records `cancelled` / `superseded`. A head the group already has queued or
 * running is a no-op.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import type { BroadcastFn, FinalizeRunRow, Project, PullRequestRow, Stmts } from '../types.js';
import { gitHostRepoPath, hostedRepoDefaultBranch, hostedRepoExists } from './repo-store.js';
import { loadCiConfigFromFile } from '../finalize/ci-config.js';
import { runJobPhase } from '../finalize/job-runner.js';
import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';
import { createFinalizeRunSignal } from '../finalize/run-abort-registry.js';
import type { CancelSignal } from '../finalize/fix-dispatch.js';
import { resolvePushConcurrency } from './push-concurrency.js';

const execFileP = promisify(execFile);

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const CI_CONFIG_RELATIVE_PATH = '.agent-hub/ci.yaml';
/** Sentinel agent id for the per-run log session (not a real agent). */
const CI_PUSH_AGENT_ID = 'ci-push';
/** Sentinel card id — finalize_runs.card_id is NOT NULL but un-FK'd. */
const CI_PUSH_CARD_ID = 'ci-push';

export interface PushCiDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  dataDir?: string;
  /** Test seam — defaults to {@link runJobPhase}. */
  runJobPhase?: typeof runJobPhase;
  /** Test seam — defaults to {@link mergeProjectSecretsSpawnEnv}. */
  mergeSecrets?: typeof mergeProjectSecretsSpawnEnv;
  /** Test seam: awaited during admission, after the head sha is resolved. */
  onAdmissionHead?: (headSha: string) => Promise<void>;
}

/**
 * Fired when a CI run (`git_push` / `pr_push`) for a hosted-repo head
 * concludes **success**. The native Auto-Merge re-attempt subscribes to this
 * so a PR whose one-shot auto-merge raced an in-flight required check still
 * merges once the check goes green (native PRs have no `gh pr merge --auto`).
 */
export type ChecksPassedHook = (args: {
  project: Project;
  branch: string;
  headSha: string;
  trigger: 'git_push' | 'pr_push';
}) => void;

let checksPassedHook: ChecksPassedHook | null = null;

/** Register (or clear with `null`) the checks-passed hook. Wired once at boot. */
export function setChecksPassedHook(fn: ChecksPassedHook | null): void {
  checksPassedHook = fn;
}

/**
 * One concurrency group per (project, branch). `generation` counts pushes so
 * a queued item can tell it was superseded; `latestSha` is the head the
 * newest push resolved to (queued or running); `active` is the running
 * item's head and abort handle.
 */
interface CiGroup {
  /** Serial admission lane: pushes are checked and admitted one at a time. */
  admission: Promise<void>;
  /** Run lane: admitted CI runs, one at a time. */
  tail: Promise<void>;
  generation: number;
  latestSha: string | null;
  active: { headSha: string; abort: () => void } | null;
}

const groups = new Map<string, CiGroup>();

function ciGroupKey(projectId: string, branch: string): string {
  return `${projectId}|${branch}`;
}

function getGroup(key: string): CiGroup {
  let group = groups.get(key);
  if (!group) {
    group = {
      admission: Promise.resolve(),
      tail: Promise.resolve(),
      generation: 0,
      latestSha: null,
      active: null,
    };
    groups.set(key, group);
  }
  return group;
}

/** What an admitted push builds; `null` from a preflight means "nothing to run". */
interface AdmissionPlan {
  headSha: string;
  work: (signal: CancelSignal) => Promise<void>;
}

/**
 * The only way a push enters its branch group.
 *
 * Every push's preflight (resolve the LIVE branch head, then every skip
 * check) runs through the group's admission lane one at a time, and the
 * supersede decision is made inside that same lane step. Because the head is
 * read inside the lane, a later admission always sees a head at least as new
 * as an earlier one, whatever order notifications arrived in or however long
 * any check took. So no push can supersede or cancel work for a newer head,
 * and a push that turns out to have nothing to run touches nothing.
 *
 * The admission lane never waits on CI runs, only on other preflights.
 * Resolves once the admitted run (if any) finishes.
 */
function admitPush(
  key: string,
  mode: 'queue' | 'cancel',
  preflight: () => Promise<AdmissionPlan | null>,
): Promise<void> {
  const g = getGroup(key);
  let runDone: Promise<void> = Promise.resolve();
  const admitted = g.admission
    .then(async () => {
      const plan = await preflight();
      if (!plan) return;
      runDone = enqueueInGroup(key, { supersede: true, mode, headSha: plan.headSha }, plan.work);
    })
    .catch((err: unknown) => {
      console.error(
        `[push-ci] admission failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  g.admission = admitted;
  return admitted.then(() => runDone);
}

/**
 * Serialize `work` for `headSha` inside its branch group's run lane.
 *
 * Pushes reach this only through {@link admitPush}, never directly: joining
 * with `supersede` has side effects on other pushes, so it must happen in
 * admission order and only for a push that will actually build `headSha`.
 *
 * `supersede` (a push): a head the group already has queued or running is a
 * no-op. A new head bumps the generation so any older push still waiting
 * skips itself, and in `cancel` mode aborts the running item unless it is
 * already building that same head. A re-run passes `supersede: false`: it
 * waits its turn without dropping anything, but a later push of a different
 * head can still supersede or cancel it.
 */
function enqueueInGroup(
  key: string,
  opts: { supersede: boolean; mode: 'queue' | 'cancel'; headSha: string },
  work: (signal: CancelSignal) => Promise<void>,
): Promise<void> {
  const g = getGroup(key);
  if (opts.supersede) {
    if (g.latestSha === opts.headSha) {
      console.log(`[push-ci] ${key}: ${opts.headSha.slice(0, 8)} already queued or running`);
      return g.tail;
    }
    g.generation += 1;
    g.latestSha = opts.headSha;
    if (opts.mode === 'cancel' && g.active && g.active.headSha !== opts.headSha) {
      console.log(`[push-ci] ${key}: newer push cancels the in-progress run`);
      g.active.abort();
    }
  }
  const myGeneration = g.generation;
  const next = g.tail
    .then(async () => {
      if (myGeneration !== g.generation) {
        console.log(`[push-ci] ${key}: skipping a queued push superseded by a newer one`);
        return;
      }
      const handle = { headSha: opts.headSha, ...createFinalizeRunSignal() };
      g.active = handle;
      try {
        await work(handle.signal);
      } finally {
        if (g.active === handle) g.active = null;
      }
    })
    .catch((err: unknown) => {
      console.error(
        `[push-ci] unexpected failure for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  g.tail = next;
  return next;
}

export function ciOnPushEnabled(project: Project): boolean {
  return project.gitHost === 'agenthub' && project.ciOnPush?.enabled === true;
}

export function isFeatureIntegrationBranch(
  stmts: Stmts,
  projectId: string,
  branch: string | null | undefined,
): boolean {
  const trimmed = branch?.trim();
  if (!trimmed) return false;
  const board = stmts.getKanbanBoard.get(projectId) as { id: string } | undefined;
  if (!board) return false;
  const epics = stmts.getKanbanEpics.all(board.id) as Array<{ pr_base_branch?: string | null }>;
  return epics.some((epic) => epic.pr_base_branch?.trim() === trimmed);
}

/**
 * Test guard: vitest (server/test/setup.ts) sets this so app-wired
 * triggers (PR-create hooks, smart-HTTP pushes in route tests) never
 * spawn the REAL job runner — which would `docker run --privileged`.
 * Tests that exercise the engine inject a mock `runJobPhase`, which
 * bypasses the guard.
 */
function realRunnerDisabled(deps: PushCiDeps): boolean {
  return process.env.AGENT_HUB_DISABLE_PUSH_CI === '1' && !deps.runJobPhase;
}

async function revParse(bare: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', bare, 'rev-parse', ref], {
      timeout: 30_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** True when push/PR CI already recorded a run for this sha (either trigger). */
function shaHasCiRun(stmts: Stmts, projectId: string, sha: string): boolean {
  return Boolean(stmts.getFinalizeRunByIdempotencyKey.get(`git-push|${projectId}|${sha}`));
}

/** True when the sha was fully validated by Finalize (review + checks). */
export function isShaFinalizeValidated(stmts: Stmts, projectId: string, sha: string): boolean {
  const row = stmts.getValidatedFinalizeRunForSha.get(projectId, sha) as { id: string } | undefined;
  return Boolean(row);
}

/**
 * "CI on push" — default-branch trigger. Called from the post-receive
 * notify endpoint and the native-PR merge hook. Fire-and-forget safe;
 * returns the chain tail so tests can await it.
 */
export function maybeRunPushCi(
  project: Project,
  updatedRefs: string[],
  deps: PushCiDeps,
): Promise<void> {
  if (!ciOnPushEnabled(project)) return Promise.resolve();
  if (realRunnerDisabled(deps)) return Promise.resolve();
  const dataDir = deps.dataDir ?? config.dataDir;
  if (!hostedRepoExists(project.id, dataDir)) return Promise.resolve();

  const mode = resolvePushConcurrency(project, 'ci');
  return (async () => {
    // Only the group key is resolved outside the admission lane. It is stable
    // across pushes, so resolving it here cannot reorder anything.
    const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
    for (const ref of updatedRefs) {
      if (!ref.startsWith('refs/heads/')) continue;
      const branch = ref.slice('refs/heads/'.length);
      if (branch !== defaultBranch && isFeatureIntegrationBranch(deps.stmts, project.id, branch)) {
        console.log(`[push-ci] ${branch} is a feature integration branch, skipping push CI`);
      }
    }
    if (!updatedRefs.includes(`refs/heads/${defaultBranch}`)) return;

    await admitPush(ciGroupKey(project.id, defaultBranch), mode, async () => {
      const bare = gitHostRepoPath(project.id, dataDir);
      const headSha = await revParse(bare, `refs/heads/${defaultBranch}`);
      if (!headSha) return null; // branch vanished between notify and now
      await deps.onAdmissionHead?.(headSha);
      if (shaHasCiRun(deps.stmts, project.id, headSha)) return null;
      return {
        headSha,
        work: (signal) =>
          runCiForSha(project, deps, dataDir, {
            branch: defaultBranch,
            headSha,
            trigger: 'git_push',
            skipWhenNoConfig: false,
            signal,
          }),
      };
    });
  })().catch((err: unknown) => {
    console.error(
      `[push-ci] unexpected failure for ${project.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

/**
 * PR-level CI fallback: run CI against an open native PR's head only when
 * it targets the repository's default branch and that exact sha was not fully
 * validated by Finalize. Fire-and-forget safe.
 */
export function maybeRunPrCi(
  project: Project,
  pr: Pick<PullRequestRow, 'number' | 'head_branch' | 'base_branch'>,
  deps: PushCiDeps,
): Promise<void> {
  if (project.gitHost !== 'agenthub') return Promise.resolve();
  if (realRunnerDisabled(deps)) return Promise.resolve();
  const dataDir = deps.dataDir ?? config.dataDir;
  if (!hostedRepoExists(project.id, dataDir)) return Promise.resolve();

  const mode = resolvePushConcurrency(project, 'ci');
  return (async () => {
    const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
    if (pr.base_branch !== defaultBranch) {
      console.log(
        `[push-ci] pr#${pr.number} targets non-default branch ${pr.base_branch}, skipping PR CI`,
      );
      return;
    }

    await admitPush(ciGroupKey(project.id, pr.head_branch), mode, async () => {
      const bare = gitHostRepoPath(project.id, dataDir);
      const headSha = await revParse(bare, `refs/heads/${pr.head_branch}`);
      if (!headSha) return null; // head branch gone (merged + deleted)
      await deps.onAdmissionHead?.(headSha);

      // The passthrough: a Finalize-validated head needs no PR-level CI —
      // checks and review already passed for this exact commit.
      if (isShaFinalizeValidated(deps.stmts, project.id, headSha)) {
        console.log(
          `[push-ci] pr#${pr.number} head ${headSha.slice(0, 8)} is Finalize-validated — skipping PR CI`,
        );
        return null;
      }
      if (shaHasCiRun(deps.stmts, project.id, headSha)) return null;

      // Presence probe only. No ci.yaml at this sha means nothing is configured
      // to run, so skip silently (unlike the opt-in default-branch trigger,
      // which records a failure). A committed-but-invalid config is NOT skipped:
      // it falls through so `runCiForSha` records `ci_config_invalid` with the
      // parser's actionable message, because that IS a broken CI setup worth
      // surfacing.
      try {
        await execFileP('git', ['-C', bare, 'show', `${headSha}:${CI_CONFIG_RELATIVE_PATH}`], {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        return null;
      }

      return {
        headSha,
        work: (signal) =>
          runCiForSha(project, deps, dataDir, {
            branch: pr.head_branch,
            headSha,
            trigger: 'pr_push',
            skipWhenNoConfig: true,
            signal,
          }),
      };
    });
  })().catch((err: unknown) => {
    console.error(
      `[push-ci] unexpected failure for ${project.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

/**
 * Combined push handler for the smart-HTTP notify endpoint: default-branch CI on push, plus
 * PR-level CI for any moved branch that backs an open default-branch native PR (covers external
 * pushes and "push anyway" bypasses).
 */
export function handleHostedRepoPush(
  project: Project,
  updatedRefs: string[],
  deps: PushCiDeps,
): void {
  void maybeRunPushCi(project, updatedRefs, deps);
  for (const ref of updatedRefs) {
    if (!ref.startsWith('refs/heads/')) continue;
    const branch = ref.slice('refs/heads/'.length);
    const open = deps.stmts.getOpenPullRequestByHeadBranch.get(project.id, branch) as
      | PullRequestRow
      | undefined;
    if (open) void maybeRunPrCi(project, open, deps);
  }
}

/**
 * Re-run a finished CI run (git_push / pr_push) against the SAME commit —
 * GitHub's "Re-run all jobs" / "Re-run this job". A fresh idempotency key
 * sidesteps the one-run-per-sha dedupe; `jobId` narrows to a single job.
 * Fire-and-forget safe; returns the chain tail so tests can await it.
 */
export function rerunCiRun(
  project: Project,
  original: Pick<FinalizeRunRow, 'branch' | 'head_sha' | 'trigger_source'>,
  deps: PushCiDeps,
  opts: { jobId?: string } = {},
): Promise<void> {
  if (project.gitHost !== 'agenthub') return Promise.resolve();
  if (realRunnerDisabled(deps)) return Promise.resolve();
  const dataDir = deps.dataDir ?? config.dataDir;
  if (!hostedRepoExists(project.id, dataDir)) return Promise.resolve();
  const trigger = original.trigger_source === 'git_push' ? 'git_push' : 'pr_push';

  const key = ciGroupKey(project.id, original.branch);
  const mode = resolvePushConcurrency(project, 'ci');
  return enqueueInGroup(key, { supersede: false, mode, headSha: original.head_sha }, (signal) =>
    runCiForSha(project, deps, dataDir, {
      branch: original.branch,
      headSha: original.head_sha,
      trigger,
      skipWhenNoConfig: false, // a re-run of a real run: failures surface
      idempotencyKey: `rerun|${uuidv4()}`,
      jobFilter: opts.jobId,
      signal,
    }),
  );
}

/** Shared engine: run ci.yaml jobs for one commit, record results. */
async function runCiForSha(
  project: Project,
  deps: PushCiDeps,
  dataDir: string,
  args: {
    branch: string;
    headSha: string;
    trigger: 'git_push' | 'pr_push';
    /** PR trigger: missing config skips silently instead of failing. */
    skipWhenNoConfig: boolean;
    /** Override for re-runs — the default key dedupes one run per sha. */
    idempotencyKey?: string;
    /** Run only this job from the config (per-job re-run). */
    jobFilter?: string;
    /** Tripped when a newer push to the branch cancels this run. */
    signal?: CancelSignal;
  },
): Promise<void> {
  const { branch, headSha, trigger, signal } = args;
  if (signal?.aborted) return;
  const bare = gitHostRepoPath(project.id, dataDir);

  // One run per (project, sha) ACROSS triggers. UNIQUE(idempotency_key)
  // is the real guard; the lookup avoids burning a uuid + clone on replay.
  const idempotencyKey = args.idempotencyKey ?? `git-push|${project.id}|${headSha}`;
  const existing = deps.stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
    | { id: string }
    | undefined;
  if (existing) return;

  const runId = uuidv4();
  const sessionId = uuidv4();
  const shortSha = headSha.slice(0, 8);

  // Sentinel session: real row (messages.session_id has an enforced FK) so
  // step output persists and the step-output endpoint can serve logs. The
  // sentinel agent id keeps it out of every agent-scoped session list.
  try {
    deps.stmts.createSession.run(
      sessionId,
      CI_PUSH_AGENT_ID,
      `CI · ${branch} @ ${shortSha}`,
      'claude-code',
      'none', // model is NOT NULL; sentinel — this session never spawns a CLI
      0,
      0,
      1, // wiki_hybrid_rag_budget_version — NOT NULL; matches spawn sites
    );
  } catch (err: unknown) {
    console.error(
      `[push-ci] session create failed for ${project.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  try {
    deps.stmts.insertFinalizeRun.run(
      runId,
      CI_PUSH_CARD_ID,
      sessionId,
      project.id,
      branch,
      headSha,
      idempotencyKey,
      'queued',
      null,
      trigger,
      null, // worktree_path — filled in once the clone exists
      'system',
      'Agent Hub CI',
      'ci@agent-hub.local',
      null,
      Date.now(),
      'checks',
    );
  } catch {
    return; // UNIQUE(idempotency_key) race — another path already ran this sha
  }

  console.log(
    `[push-ci] run=${runId} project=${project.id} trigger=${trigger} ${branch}@${shortSha} starting`,
  );

  // Ephemeral workspace: clone the bare repo at the pushed sha. Local
  // path clone is cheap (hardlinked objects) and the job phase ships a
  // `git bundle` of HEAD to runners anyway.
  const workRoot = path.join(dataDir, 'push-ci');
  const workDir = path.join(workRoot, `${project.id}-${shortSha}-${runId.slice(0, 8)}`);
  const cancelled = (): void => {
    console.log(`[push-ci] run=${runId} cancelled: superseded by a newer push`);
    deps.stmts.failFinalizeRun.run('cancelled', 'superseded', runId);
    deps.broadcast({
      type: 'finalize_run_phase_changed',
      run_id: runId,
      session_id: sessionId,
      phase: null,
      status: 'cancelled',
      failure_reason: 'superseded',
    });
  };
  const fail = (reason: string, detail: string): void => {
    console.warn(`[push-ci] run=${runId} failed: ${reason} — ${detail}`);
    deps.stmts.failFinalizeRun.run('failed', reason, runId);
    deps.broadcast({
      type: 'finalize_run_phase_changed',
      run_id: runId,
      session_id: sessionId,
      phase: null,
      status: 'failed',
      failure_reason: reason,
    });
  };

  try {
    mkdirSync(workRoot, { recursive: true });
    await execFileP('git', ['clone', '--quiet', bare, workDir], { timeout: CLONE_TIMEOUT_MS });
    await execFileP('git', ['-C', workDir, 'checkout', '--quiet', headSha], { timeout: 60_000 });
    if (signal?.aborted) {
      cancelled();
      return;
    }

    const parsed = await loadCiConfigFromFile(path.join(workDir, CI_CONFIG_RELATIVE_PATH));
    if (!parsed.ok) {
      fail('ci_config_invalid', parsed.error.message);
      return;
    }
    let ciConfig = parsed.config;
    if (args.jobFilter) {
      const job = ciConfig.jobs?.[args.jobFilter];
      if (!job) {
        fail('ci_config_invalid', `job "${args.jobFilter}" not found in ci.yaml at this commit`);
        return;
      }
      ciConfig = { ...ciConfig, jobs: { [args.jobFilter]: job } };
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    (deps.mergeSecrets ?? mergeProjectSecretsSpawnEnv)(env, {
      projectId: project.id,
      sessionId: null,
      overwriteExisting: true,
    });

    const result = await (deps.runJobPhase ?? runJobPhase)(
      { stmts: deps.stmts, broadcast: deps.broadcast },
      {
        runId,
        config: ciConfig,
        worktreePath: workDir,
        sessionId,
        branch,
        headSha,
        env,
        projectId: project.id,
        ...(signal ? { signal } : {}),
      },
    );

    if (signal?.aborted) {
      cancelled();
    } else if (result.status === 'success') {
      deps.stmts.failFinalizeRun.run('succeeded', null, runId);
      deps.broadcast({
        type: 'finalize_run_phase_changed',
        run_id: runId,
        session_id: sessionId,
        phase: null,
        status: 'succeeded',
      });
      console.log(`[push-ci] run=${runId} succeeded ${branch}@${shortSha}`);
      // Checks for this head just went green — let a deferred native
      // Auto-Merge complete. Never let a hook error fail the CI run.
      try {
        checksPassedHook?.({ project, branch, headSha, trigger });
      } catch (err: unknown) {
        console.warn(
          `[push-ci] checksPassedHook threw for ${project.id} ${branch}@${shortSha}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      // Report-only by design: record the red/infra outcome and stop —
      // no fix-dispatch, no reviewer (the commit already landed).
      const reason =
        result.status === 'infra_error'
          ? 'infra_error'
          : result.status === 'timeout'
            ? 'timeout'
            : 'checks_failed';
      fail(reason, result.infraErrorDetail ?? 'one or more jobs failed');
    }
  } catch (err: unknown) {
    if (signal?.aborted) cancelled();
    else fail('infra_error', err instanceof Error ? err.message : String(err));
  } finally {
    if (existsSync(workDir)) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup; the next run uses a fresh dir anyway */
      }
    }
  }
}

/** Test seam: drop queued chains between tests. */
export function __clearPushCiQueues(): void {
  groups.clear();
}
