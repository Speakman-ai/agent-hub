/**
 * Outside-Vitest integration driver: real createChatHandler dispatch
 * (stub CLI, never claude/cursor/gemini/codex) plus real
 * startFinalizeRunBackground. The fixture app has no ci.yaml, so Finalize
 * is checks-free (rebase → in-session review → ready_to_push). Auto-push
 * and native merge then run against a Hub-hosted bare repo so
 * reconcileFinalize sees an approved review and a real merged SHA.
 *
 * Vitest must not import this module. The canned driver in baseline-cycle.ts
 * is the in-suite path.
 */
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, getStmts } from '../../db.js';
import config from '../../config.js';
import type { Agent, EnrichedAgent, Project, RouteDeps, SessionRow } from '../../types.js';
import createChatHandler from '../../chat.js';
import type { ActiveChatProcess } from '../../active-chat-process.js';
import { setReadyToPushAutomationHook } from '../../finalize/orchestrator.js';
import {
  maybeAutoPushReadyFinalizeRun,
  setFinalizeAutomationRouteDeps,
} from '../../finalize/automation-runner.js';
import { createNativePrService } from '../../native-pr/service.js';
import { createHostedRepo, gitHostRepoPath } from '../../git-host/repo-store.js';
import { createAutopilotController } from '../controller.js';
import { AutopilotStore } from '../store.js';
import { buildAutopilotRuntime, readFinalizeOutcome, type AutopilotWiringDeps } from '../wiring.js';
import { buildAutopilotControllerDeps } from '../../routes/autopilot.js';
import { removeAutopilotWorkerToken, writeAutopilotWorkerToken } from '../worker-token.js';
import { FIXTURE_AGENT_ID, FIXTURE_PROJECT_ID, git, seedFixtureRepo } from './baseline-cycle.js';
import { validateTodoApp } from './validate-todo-app.js';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_BIN = path.join(FIXTURE_DIR, 'fixture-worker.sh');
const FIXTURE_REVIEWER_ID = 'fixture-reviewer';

const READY = {
  brief: 'Build a disposable todo list with a browser-testable add-and-list flow.',
  target: {
    targetId: 'local-preview',
    origin: 'http://127.0.0.1:4310',
    readinessProbeUrl: 'http://127.0.0.1:4310/health',
  },
  limits: {
    cycleMode: 'continuous' as const,
    maxWallTimeMs: 60 * 60 * 1000,
    maxStageTimeoutMs: 10 * 60 * 1000,
    maxRetriesPerStage: 2,
  },
  credentialOwnerUserId: 'user-1',
};

interface FinalizeRunLite {
  session_id?: string;
  card_id?: string;
  head_sha?: string;
  status?: string;
  reviewer_verdict?: string | null;
  pr_url?: string | null;
  failure_reason?: string | null;
}

export interface IntegratedBaselineCycleResult {
  runId: string;
  cardId: string;
  epicId: string;
  sessionId: string;
  finalizeRunId: string;
  baselineSha: string;
  implementedSha: string;
  finalizeHeadSha: string;
  finalizeStatus: string;
  mergedSha: string;
  fixtureRepo: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function lookupAgent(
  id: string,
  project: Project,
  worker: Agent,
  reviewer: Agent,
): { project: Project; agent: Agent } | null {
  if (id === FIXTURE_AGENT_ID) return { project, agent: worker };
  if (id === FIXTURE_REVIEWER_ID) return { project, agent: reviewer };
  return null;
}

function lookupEnriched(
  id: string,
  worker: EnrichedAgent,
  reviewer: EnrichedAgent,
): EnrichedAgent | null {
  if (id === FIXTURE_AGENT_ID) return worker;
  if (id === FIXTURE_REVIEWER_ID) return reviewer;
  return null;
}

function prNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/(\d+)(?:\/?)$/);
  return m ? Number(m[1]) : null;
}

function dumpFinalize(stmts: ReturnType<typeof getStmts>, finalizeRunId: string): string {
  const row = stmts.getFinalizeRun.get(finalizeRunId) as FinalizeRunLite | undefined;
  if (!row) return `finalize ${finalizeRunId}: missing row`;
  const number = prNumberFromUrl(row.pr_url);
  const pr =
    number != null
      ? (stmts.getPullRequestByNumber.get(FIXTURE_PROJECT_ID, number) as
          | { status?: string; merged_sha?: string | null }
          | undefined)
      : undefined;
  return (
    `finalize ${finalizeRunId}: status=${row.status ?? 'none'} ` +
    `verdict=${row.reviewer_verdict ?? 'none'} failure=${row.failure_reason ?? 'none'} ` +
    `pr=${row.pr_url ?? 'none'} prStatus=${pr?.status ?? 'none'} mergedSha=${pr?.merged_sha ?? 'none'}`
  );
}

export async function runIntegratedBaselineCycle(opts: {
  fixtureRepo: string;
}): Promise<IntegratedBaselineCycleResult> {
  chmodSync(WORKER_BIN, 0o755);
  const db = getDb();
  const stmts = getStmts();
  const store = new AutopilotStore(db);
  const baselineSha = seedFixtureRepo(opts.fixtureRepo);
  await createHostedRepo({ id: FIXTURE_PROJECT_ID, cwd: opts.fixtureRepo });
  const hostedBare = gitHostRepoPath(FIXTURE_PROJECT_ID);
  const worktreeRoot = path.join(config.dataDir, 'fixture-worktrees');
  mkdirSync(worktreeRoot, { recursive: true });

  const agent = {
    id: FIXTURE_AGENT_ID,
    name: 'Fixture agent',
    engine: 'gemini-cli',
  } as Agent;
  const reviewerAgent = {
    id: FIXTURE_REVIEWER_ID,
    name: 'Fixture reviewer',
    engine: 'gemini-cli',
    role: 'reviewer',
  } as Agent;

  const project: Project = {
    id: FIXTURE_PROJECT_ID,
    name: 'Autopilot fixture todo',
    cwd: opts.fixtureRepo,
    ahw: '',
    gitHost: 'agenthub',
    agents: [agent, reviewerAgent],
  };

  const enriched = {
    id: FIXTURE_AGENT_ID,
    name: 'Fixture agent',
    engine: 'gemini-cli',
    model: 'gemini-2.5-flash',
    projectId: project.id,
    cwd: project.cwd,
    ahw: '',
    workspace: project.cwd,
  } as EnrichedAgent;
  const reviewerEnriched = {
    id: FIXTURE_REVIEWER_ID,
    name: 'Fixture reviewer',
    engine: 'gemini-cli',
    model: 'gemini-2.5-flash',
    projectId: project.id,
    cwd: project.cwd,
    ahw: '',
    workspace: project.cwd,
  } as EnrichedAgent;

  const activeProcesses = new Map<string, ActiveChatProcess>();
  let lastChatError: string | null = null;

  const { handleChat: innerHandleChat } = createChatHandler({
    broadcast: () => undefined,
    findAgent: (id) => lookupAgent(id, project, agent, reviewerAgent),
    getEnrichedAgent: (id) => lookupEnriched(id, enriched, reviewerEnriched),
    activeProcesses,
    autonomousProjects: new Set(),
    getClaudeBin: () => WORKER_BIN,
    getCursorBin: () => WORKER_BIN,
    getGeminiBin: () => WORKER_BIN,
    getCodexBin: () => WORKER_BIN,
    getGrokBin: () => WORKER_BIN,
    uploadsDir: path.join(config.dataDir, 'uploads'),
    resolveSlashSkill: () => null,
    createCursorChat: undefined,
    ensureWorktree: async (session) => {
      const dest = path.join(worktreeRoot, session.id);
      const branch = `agent-hub/${FIXTURE_AGENT_ID}/session-${session.id}`;
      if (!existsSync(dest)) {
        execFileSync('git', ['clone', '--', hostedBare, dest], { encoding: 'utf8' });
        git(dest, ['config', 'user.email', 'autopilot-fixture@example.test']);
        git(dest, ['config', 'user.name', 'Autopilot Fixture']);
        git(dest, ['checkout', '-b', branch]);
      }
      stmts.updateSessionWorktreePath.run(dest, branch, session.id);
      return dest;
    },
    drainQueue: () => undefined,
    autoCommitAndPR: async (sessionId, _agentId, _project, _agent, cwd) => {
      const head = git(cwd, ['rev-parse', 'HEAD']);
      if (head && head !== baselineSha) {
        stmts.updateSessionChangesReady.run(JSON.stringify({ commitSha: head }), sessionId);
      }
    },
    tryAutonomousDispatch: () => undefined,
  });

  const handleChat: RouteDeps['handleChat'] = async (ws, msg) => {
    try {
      await innerHandleChat(ws as never, msg);
    } catch (err) {
      lastChatError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

  const controllerOptions = {
    credentialOwnerExists: () => true,
    holderId: 'hub-fixture',
    assertContainment: () => undefined,
    issueWorkerCredential: ({ projectId, runId: id }: { projectId: string; runId: string }) => {
      const token = `ahub_worker_${id}`;
      writeAutopilotWorkerToken(id, token, config.dataDir);
      return { keyName: `autopilot:${projectId}:${id}`, keyId: `key-${id}`, token };
    },
    revokeWorkerCredential: ({ runId: id }: { runId: string }) => {
      removeAutopilotWorkerToken(id, config.dataDir);
    },
  };
  const controller = createAutopilotController(buildAutopilotControllerDeps(controllerOptions));
  controller.putConfig(FIXTURE_PROJECT_ID, { enabled: true, ...READY }, { userId: 'user-1' });
  const runId = controller.start(FIXTURE_PROJECT_ID, {}, { userId: 'user-1' }).run.id;

  const nativePr = createNativePrService({
    stmts,
    broadcast: () => undefined,
  });

  const routeDeps = {
    stmts,
    broadcast: () => undefined,
    findProject: (id: string) => (id === project.id ? project : null),
    findAgent: (id: string) => lookupAgent(id, project, agent, reviewerAgent),
    getEnrichedAgent: (id: string) => lookupEnriched(id, enriched, reviewerEnriched),
    allAgents: () => [enriched, reviewerEnriched],
    saveProjects: () => undefined,
    handleChat,
    lastDispatchedReviewId: new Map(),
    scheduleAutonomousEpic: () => undefined,
    autonomousCrons: new Map(),
    runAutonomousLoop: async () => undefined,
    config,
    getProjects: () => [project],
    setProjects: () => undefined,
    serverDir: FIXTURE_DIR,
    buildTranscript: () => '',
    summarizeTranscript: async () => '',
    DEFAULT_MODEL: 'gemini-2.5-flash',
    activeProcesses,
    getProjectDataDir: () => config.dataDir,
    retireIntakeAgents: () => undefined,
    ensureSkillBuilderAgents: () => undefined,
    ensureReviewerAgents: () => false,
    ensureContextFiles: () => undefined,
    getClaudeBin: () => WORKER_BIN,
    setClaudeBin: () => undefined,
    getCursorBin: () => WORKER_BIN,
    getGeminiBin: () => WORKER_BIN,
    getCodexBin: () => WORKER_BIN,
    getGrokBin: () => WORKER_BIN,
    nativePr,
    initDb: () => undefined,
    reloadProjects: () => undefined,
    setActiveDataDir: () => undefined,
    restoreAutonomousCrons: () => undefined,
    scheduleAll: () => undefined,
  } as unknown as RouteDeps;

  setFinalizeAutomationRouteDeps(routeDeps);
  setReadyToPushAutomationHook((sessionId, finalizeId) => {
    void maybeAutoPushReadyFinalizeRun({ sessionId, runId: finalizeId });
  });

  const wiring: AutopilotWiringDeps = {
    routeDeps,
    resolveWorkerAgent: (projectId) =>
      projectId === FIXTURE_PROJECT_ID
        ? { agentId: FIXTURE_AGENT_ID, engine: 'gemini-cli', model: 'gemini-2.5-flash' }
        : null,
    getActiveSessionIds: () => new Set(activeProcesses.keys()),
    controllerOptions,
    startDeployment: async () => ({ deploymentId: 'dep-fixture' }),
    runRollback: async (args) => ({
      status: 'success',
      deploymentId: 'dep-rb',
      deployedSha: args.priorSha,
    }),
    readDeployOutcome: () => null,
  };
  const runtime = buildAutopilotRuntime(wiring);

  try {
    await runtime.tick();
    if (store.getRun(runId)?.stage !== 'implementing') {
      const run = store.getRun(runId);
      throw new Error(
        `expected implementing after plan, got ${run?.stage} (${run?.failureReason ?? 'no failure'})` +
          (lastChatError ? `; chat: ${lastChatError}` : ''),
      );
    }
    const cycle = store.getCycle(runId, 1);
    if (!cycle?.cardId) throw new Error('planning did not persist a card');
    const epicId = (stmts.getKanbanCard.get(cycle.cardId) as { epic_id?: string } | undefined)
      ?.epic_id;
    if (!epicId) throw new Error('primary card is not linked to an epic');

    await runtime.tick();
    const sessionId = store.getCycle(runId, 1)?.sessionId;
    if (!sessionId) throw new Error('implementation session was not dispatched');

    await waitUntil(
      () => {
        const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
        return Boolean(session?.changes_ready) && !activeProcesses.has(sessionId);
      },
      30_000,
      'implementation changes_ready after real dispatch',
    );

    const implSession = stmts.getSession.get(sessionId) as SessionRow;
    if (!implSession.worktree_path || !implSession.worktree_branch) {
      throw new Error('implementation session has no worktree after real dispatch');
    }
    const implementedSha = git(implSession.worktree_path, ['rev-parse', 'HEAD']);
    if (implementedSha === baselineSha) {
      throw new Error('implementation worker did not commit on the fixture worktree');
    }
    const worktreeOk = validateTodoApp(implSession.worktree_path, { requireComplete: true });
    if (!worktreeOk.ok) {
      throw new Error(`worktree failed validation: ${worktreeOk.reasons.join('; ')}`);
    }

    await runtime.settleSession(sessionId);
    if (store.getRun(runId)?.stage !== 'finalizing') {
      throw new Error(`expected finalizing after implement, got ${store.getRun(runId)?.stage}`);
    }

    await runtime.tick();
    const finalizeRunId = store.getCycle(runId, 1)?.finalizeRunId;
    if (!finalizeRunId) {
      throw new Error(
        `Finalize run was not started by startFinalizeRunBackground` +
          (lastChatError ? `; chat: ${lastChatError}` : ''),
      );
    }

    const kickoff = stmts.getFinalizeRun.get(finalizeRunId) as FinalizeRunLite | undefined;
    if (!kickoff) throw new Error('Finalize kickoff did not insert a finalize_runs row');
    if (kickoff.session_id !== sessionId) {
      throw new Error(
        `Finalize session correlation failed: ${kickoff.session_id} !== ${sessionId}`,
      );
    }
    if (kickoff.card_id !== cycle.cardId) {
      throw new Error(`Finalize card correlation failed: ${kickoff.card_id} !== ${cycle.cardId}`);
    }
    if (kickoff.head_sha !== implementedSha) {
      throw new Error(
        `Finalize head SHA ${kickoff.head_sha} did not match implemented ${implementedSha}`,
      );
    }

    try {
      await waitUntil(
        () => {
          const row = stmts.getFinalizeRun.get(finalizeRunId) as FinalizeRunLite | undefined;
          if (
            row?.status === 'failed' ||
            row?.status === 'timed_out' ||
            row?.status === 'infra_error'
          ) {
            throw new Error(`Finalize ended ${row.status}: ${dumpFinalize(stmts, finalizeRunId)}`);
          }
          const outcome = readFinalizeOutcome(stmts, finalizeRunId);
          return outcome?.status === 'merged' && Boolean(outcome.mergedSha);
        },
        120_000,
        'Finalize review + native merge',
      );
    } catch (err) {
      const extra = dumpFinalize(stmts, finalizeRunId);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(extra)) throw err;
      throw new Error(`${message} (${extra})`);
    }

    await runtime.settleFinalize(finalizeRunId);
    const outcome = readFinalizeOutcome(stmts, finalizeRunId);
    if (outcome?.status !== 'merged' || !outcome.mergedSha) {
      throw new Error(
        `reconcileFinalize did not observe a merged outcome (${dumpFinalize(stmts, finalizeRunId)})`,
      );
    }

    const testedCommitSha = store.getCycle(runId, 1)?.testedCommitSha;
    if (testedCommitSha !== outcome.mergedSha) {
      throw new Error(
        `cycle testedCommitSha ${testedCommitSha} did not match merged ${outcome.mergedSha}`,
      );
    }

    const implementedTree = git(implSession.worktree_path, [
      'rev-parse',
      `${implementedSha}^{tree}`,
    ]);
    const mergedTree = git(hostedBare, ['rev-parse', `${outcome.mergedSha}^{tree}`]);
    if (implementedTree !== mergedTree) {
      throw new Error(
        `merged tree ${mergedTree} did not match implemented tree ${implementedTree}`,
      );
    }

    const finalizeRow = stmts.getFinalizeRun.get(finalizeRunId) as FinalizeRunLite;
    return {
      runId,
      cardId: cycle.cardId,
      epicId,
      sessionId,
      finalizeRunId,
      baselineSha,
      implementedSha,
      finalizeHeadSha: kickoff.head_sha ?? '',
      finalizeStatus: finalizeRow.status ?? '',
      mergedSha: outcome.mergedSha,
      fixtureRepo: opts.fixtureRepo,
    };
  } finally {
    setReadyToPushAutomationHook(null);
  }
}
