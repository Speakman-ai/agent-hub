/**
 * Canned live plan -> implement -> finalize driver for the disposable todo
 * fixture. Used by Vitest (`live-cycle.test.ts`) and
 * `run-baseline-cycle.ts --deterministic`.
 *
 * Uses the production adapter constructors (buildPlannerOps, buildBoardOps,
 * buildSessionOps, buildFinalizeOps, buildAutopilotRuntime). handleChat and
 * Finalize kickoff are deterministic fakes: no agent CLI, no Finalize CI.
 * The outside-Vitest integrated path is `integrated-cycle.ts`.
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { setImmediate as setImmediateAsync } from 'timers/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, getStmts } from '../../db.js';
import config from '../../config.js';
import type { ChatMessage, Project, RouteDeps } from '../../types.js';
import { notifyFinalizeSessionTurnEnd } from '../../finalize/turn-end.js';
import { createAutopilotController } from '../controller.js';
import { AutopilotStore } from '../store.js';
import {
  buildAutopilotRuntime,
  type AutopilotStartFinalizeRun,
  type AutopilotWiringDeps,
} from '../wiring.js';
import type { AutopilotDeployResult } from '../orchestrator.js';
import { buildAutopilotControllerDeps } from '../../routes/autopilot.js';
import { removeAutopilotWorkerToken, writeAutopilotWorkerToken } from '../worker-token.js';
import { validateTodoApp } from './validate-todo-app.js';

export const FIXTURE_PROJECT_ID = 'autopilot-fixture-app';
export const FIXTURE_AGENT_ID = 'fixture-agent';

const FIXTURE_APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'todo-app');

export const FIXTURE_SPEC = {
  assumptions: ['single-user', 'disposable in-memory data'],
  acceptanceJourneys: [
    {
      action: 'submit a new todo via the add form',
      expectedResult: 'the new item appears in the todo list',
    },
    {
      action: 'open the list page',
      expectedResult: 'existing todos are shown',
    },
  ],
  nonGoals: ['authentication'],
  specDecisions: [
    { key: 'storage', decision: 'in-memory array' },
    { key: 'runtime', decision: 'static html and js' },
  ],
  storageRecovery: 'disposable',
  qualityRubricVersion: 1,
};

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

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function seedFixtureRepo(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  cpSync(FIXTURE_APP_DIR, targetDir, { recursive: true });
  git(targetDir, ['init', '-b', 'main']);
  git(targetDir, ['config', 'user.email', 'autopilot-fixture@example.test']);
  git(targetDir, ['config', 'user.name', 'Autopilot Fixture']);
  git(targetDir, ['add', '.']);
  git(targetDir, ['commit', '-m', 'baseline fixture todo app']);
  const baseline = validateTodoApp(targetDir);
  if (!baseline.ok) {
    throw new Error(`fixture app failed baseline validation: ${baseline.reasons.join('; ')}`);
  }
  return git(targetDir, ['rev-parse', 'HEAD']);
}

export function applyCompleteTodo(appDir: string): string {
  const jsPath = path.join(appDir, 'app.js');
  const js = readFileSync(jsPath, 'utf8');
  const next = js.replace(
    'li.textContent = todo.title;\n    list.appendChild(li);',
    `li.textContent = todo.title;
    li.dataset.complete = todo.done ? 'true' : 'false';
    li.addEventListener('click', () => {
      todo.done = !todo.done;
      render();
    });
    list.appendChild(li);`,
  );
  if (next === js) throw new Error('could not apply complete-todo change to fixture app.js');
  writeFileSync(jsPath, next);
  git(appDir, ['add', 'app.js']);
  git(appDir, ['commit', '-m', 'complete a todo from the list']);
  const after = validateTodoApp(appDir, { requireComplete: true });
  if (!after.ok) {
    throw new Error(`fixture app failed post-implement validation: ${after.reasons.join('; ')}`);
  }
  return git(appDir, ['rev-parse', 'HEAD']);
}

function stubRouteDeps(args: { project: Project; handleChat: RouteDeps['handleChat'] }): RouteDeps {
  const stmts = getStmts();
  return {
    stmts,
    broadcast: () => undefined,
    findProject: (id: string) => (id === args.project.id ? args.project : null),
    findAgent: (id: string) =>
      id === FIXTURE_AGENT_ID
        ? ({ agent: { id, name: 'Fixture agent', engine: 'gemini-cli' } } as never)
        : null,
    getEnrichedAgent: () => null,
    allAgents: () => [],
    saveProjects: () => undefined,
    handleChat: args.handleChat,
    lastDispatchedReviewId: new Map(),
    scheduleAutonomousEpic: () => undefined,
    autonomousCrons: new Map(),
    runAutonomousLoop: async () => undefined,
    config,
    getProjects: () => [args.project],
    setProjects: () => undefined,
    serverDir: path.dirname(fileURLToPath(import.meta.url)),
    buildTranscript: () => '',
    summarizeTranscript: async () => '',
    DEFAULT_MODEL: 'gemini-2.5-flash',
    activeProcesses: new Map(),
    getProjectDataDir: () => config.dataDir,
    retireIntakeAgents: () => undefined,
    ensureSkillBuilderAgents: () => undefined,
    ensureReviewerAgents: () => false,
    ensureContextFiles: () => undefined,
  } as unknown as RouteDeps;
}

export interface LiveBaselineCycleResult {
  runId: string;
  cardId: string;
  epicId: string;
  sessionId: string;
  finalizeRunId: string;
  deploymentId: string;
  baselineSha: string;
  mergedSha: string;
  fixtureRepo: string;
}

export async function runLiveBaselineCycle(opts: {
  fixtureRepo: string;
}): Promise<LiveBaselineCycleResult> {
  const db = getDb();
  const stmts = getStmts();
  const store = new AutopilotStore(db);
  const baselineSha = seedFixtureRepo(opts.fixtureRepo);
  let implementedSha = baselineSha;

  const project: Project = {
    id: FIXTURE_PROJECT_ID,
    name: 'Autopilot fixture todo',
    cwd: opts.fixtureRepo,
    ahw: path.join(opts.fixtureRepo, '.agent-hub'),
    agents: [],
  };

  const handleChat: RouteDeps['handleChat'] = async (_ws, msg: ChatMessage) => {
    const sessionId = msg.sessionId;
    if (typeof msg.content === 'string' && msg.content.includes('Return ONLY a fenced')) {
      stmts.addMessage.run(
        randomUUID(),
        sessionId,
        'assistant',
        `\`\`\`json\n${JSON.stringify(FIXTURE_SPEC)}\n\`\`\``,
        'gemini-cli',
        'gemini-2.5-flash',
        null,
        null,
        FIXTURE_AGENT_ID,
        'Fixture agent',
        '#6366F1',
      );
    } else {
      implementedSha = applyCompleteTodo(opts.fixtureRepo);
      stmts.updateSessionChangesReady.run(JSON.stringify({ commitSha: implementedSha }), sessionId);
    }
    notifyFinalizeSessionTurnEnd(sessionId);
  };

  const startFinalizeRun: AutopilotStartFinalizeRun = async (_deps, args) => {
    const finalizeRunId = randomUUID();
    const now = Date.now();
    stmts.insertFinalizeRun.run(
      finalizeRunId,
      args.card.id,
      args.session.id,
      args.project.id,
      'main',
      implementedSha,
      `autopilot-fixture-${finalizeRunId}`,
      'pushed',
      'push',
      'agent_block',
      opts.fixtureRepo,
      'autopilot',
      'Autopilot',
      'autopilot@example.test',
      null,
      now,
      'full',
    );
    const prId = randomUUID();
    stmts.insertPullRequest.run(
      prId,
      args.project.id,
      1,
      'Autopilot baseline',
      '',
      'feat/fixture',
      'main',
      implementedSha,
      'autopilot',
      now,
      now,
    );
    stmts.markPullRequestMerged.run(implementedSha, 'autopilot', 'squash', now, now, prId);
    stmts.updateFinalizeRunPrUrl.run(`/projects/${args.project.id}/pulls/1`, finalizeRunId);
    stmts.updateFinalizeRunReviewerVerdict.run('approved', finalizeRunId);
    return { ok: true, runId: finalizeRunId, status: 'pushed' };
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

  let deployOutcome: AutopilotDeployResult | null = null;

  const wiring: AutopilotWiringDeps = {
    routeDeps: stubRouteDeps({ project, handleChat }),
    resolveWorkerAgent: (projectId) =>
      projectId === FIXTURE_PROJECT_ID
        ? { agentId: FIXTURE_AGENT_ID, engine: 'gemini-cli', model: 'gemini-2.5-flash' }
        : null,
    getActiveSessionIds: () => new Set(),
    controllerOptions,
    startFinalizeRun,
    startDeployment: async () => ({ deploymentId: 'dep-fixture' }),
    runRollback: async (args) => ({
      status: 'success',
      deploymentId: 'dep-rb',
      deployedSha: args.priorSha,
    }),
    readDeployOutcome: () => deployOutcome,
  };
  const runtime = buildAutopilotRuntime(wiring);

  await runtime.tick();
  if (store.getRun(runId)?.stage !== 'implementing') {
    throw new Error(`expected implementing after plan, got ${store.getRun(runId)?.stage}`);
  }
  const cycle = store.getCycle(runId, 1);
  if (!cycle?.cardId) throw new Error('planning did not persist a card');
  const epicId = (stmts.getKanbanCard.get(cycle.cardId) as { epic_id?: string } | undefined)
    ?.epic_id;
  if (!epicId) throw new Error('primary card is not linked to an epic');

  await runtime.tick();
  const sessionId = store.getCycle(runId, 1)?.sessionId;
  if (!sessionId) throw new Error('implementation session was not dispatched');
  const implementDeadline = Date.now() + 2000;
  while (Date.now() < implementDeadline) {
    const session = stmts.getSession.get(sessionId) as
      | { changes_ready?: string | null }
      | undefined;
    if (session?.changes_ready) break;
    await setImmediateAsync();
  }
  await runtime.settleSession(sessionId);
  if (store.getRun(runId)?.stage !== 'finalizing') {
    throw new Error(`expected finalizing after implement, got ${store.getRun(runId)?.stage}`);
  }

  await runtime.tick();
  const finalizeRunId = store.getCycle(runId, 1)?.finalizeRunId;
  if (!finalizeRunId) throw new Error('Finalize run was not started');
  await runtime.settleFinalize(finalizeRunId);

  const mergedSha = store.getCycle(runId, 1)?.testedCommitSha;
  if (mergedSha !== implementedSha) {
    throw new Error(`merged SHA ${mergedSha} did not match fixture HEAD ${implementedSha}`);
  }
  if (store.getRun(runId)?.stage !== 'deploying') {
    throw new Error(`expected deploying after merge, got ${store.getRun(runId)?.stage}`);
  }

  await runtime.tick();
  const deploymentId = store.getCycle(runId, 1)?.deploymentId;
  if (deploymentId !== 'dep-fixture') {
    throw new Error(`expected dep-fixture, got ${deploymentId}`);
  }
  deployOutcome = {
    status: 'success',
    deploymentId: 'dep-fixture',
    deployedSha: implementedSha,
  };
  await runtime.settleDeployment('dep-fixture');
  if (store.getRun(runId)?.stage !== 'verifying') {
    throw new Error(`expected verifying after exact-SHA deploy, got ${store.getRun(runId)?.stage}`);
  }
  if (store.getRun(runId)?.lastVerifiedSha) {
    throw new Error('candidate deploy must not become last-known-good');
  }

  return {
    runId,
    cardId: cycle.cardId,
    epicId,
    sessionId,
    finalizeRunId,
    deploymentId,
    baselineSha,
    mergedSha: implementedSha,
    fixtureRepo: opts.fixtureRepo,
  };
}
