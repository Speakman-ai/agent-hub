/**
 * initial-build.ts — the wizard's description is the BASELINE, not just a
 * scaffold hint. After provisioning completes (and the hosted-git
 * bootstrap settles), this kicks off the first real build:
 *
 *   1. Seeds the project's lead dev agent (provisioned projects start
 *      with an empty roster).
 *   2. Creates a kanban card — "Build the initial version" — carrying
 *      the full description as the acceptance bar.
 *   3. Spawns a worktree session against that card with a four-phase
 *      build prompt: implement → set up CI → set up preview → PAUSE.
 *      No auto-ship: the operator verifies in the preview and clicks
 *      Finalize, so the first merge lands app + CI + preview together.
 *
 * The user lands on a project where the described product is being
 * built; from there work continues through normal issues/features.
 * Best-effort: any failure leaves a usable scaffolded project.
 */

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Agent, Project, RouteDeps } from '../types.js';
import { getOrCreateBoard } from '../routes/board.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';
import { setSessionOwner } from '../session-ownership.js';

export interface InitialBuildOpts {
  project: Project;
  description: string;
  deps: Pick<
    RouteDeps,
    | 'stmts'
    | 'config'
    | 'findAgent'
    | 'saveProjects'
    | 'broadcast'
    | 'handleChat'
    | 'getProjectDataDir'
  >;
  requestingUserId?: string | null;
  /**
   * Test override: vitest sets AGENT_HUB_DISABLE_INITIAL_BUILD so the
   * app-wired path never dispatches a real agent session (the chat
   * handler would spawn a CLI, which tests forbid). Unit tests that
   * exercise this module with mocked deps pass `force: true`.
   */
  force?: boolean;
}

/** Seed the lead dev agent when the roster is empty. Returns the agent. */
function ensureLeadDevAgent(opts: InitialBuildOpts): Agent {
  const { project, deps } = opts;
  const existing = project.agents.find((a) => a.role !== 'reviewer');
  if (existing) return existing;

  const agentId = `${project.id}-dev`;
  const agent: Agent = {
    id: agentId,
    name: `${project.name} Dev`,
    engine: 'claude-code',
    role: 'dev',
    color: project.color,
    systemPrompt: `You are the lead developer agent for the ${project.name} project on Agent Hub. You build features end-to-end in session worktrees: implement, test, commit. The platform handles pushing, pull requests, CI, and review. Use the kanban board at /api/projects/${project.id}/board to track work.`,
    heartbeat: { enabled: false, interval: '', prompt: '' },
  } as Agent;

  try {
    const agentDir = path.join(opts.deps.getProjectDataDir(project.id), 'agents', agentId);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, 'IDENTITY.md'),
      `# ${project.name} Dev\n\nLead developer agent for ${project.name}. Builds features in session worktrees; the platform ships PRs and runs CI.\n`,
    );
  } catch {
    /* identity file is a nicety */
  }
  project.agents.push(agent);
  deps.saveProjects();
  return agent;
}

/**
 * The Finalize review phase and native PR reviews need the project
 * Reviewer; seed it once the roster is non-empty (ensureReviewerAgents
 * skips agent-less projects). Lazy import avoids a static cycle with
 * project-model.
 */
async function ensureReviewer(projectId: string): Promise<void> {
  try {
    const { ensureReviewerAgents } = await import('../project-model.js');
    ensureReviewerAgents();
  } catch (err: unknown) {
    console.warn(
      `[provisioning] ${projectId}: reviewer seeding failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** See module header. Never throws. */
export function kickoffInitialBuild(opts: InitialBuildOpts): void {
  const { project, description, deps } = opts;
  try {
    if (process.env.AGENT_HUB_DISABLE_INITIAL_BUILD === '1' && !opts.force) return;
    if (!description.trim()) return;
    const agent = ensureLeadDevAgent(opts);
    void ensureReviewer(project.id);

    // Kanban card — the baseline's tracking anchor.
    const boardData = getOrCreateBoard(deps.stmts, project.id);
    const todo = boardData?.columns?.find((c) => /to ?do/i.test(c.name)) ?? boardData?.columns?.[0];
    let cardId: string | null = null;
    if (boardData?.board && todo) {
      cardId = uuidv4();
      deps.stmts.createKanbanCard.run(
        cardId,
        todo.id,
        boardData.board.id,
        'Build the initial version',
        `Build the baseline described at project creation:\n\n> ${description.trim()}\n\nAcceptance: the description above works end to end on the scaffold. Follow-up features and issues come as separate cards.`,
        'high',
        agent.name,
        '[]',
        null,
        null,
        'provisioning',
        null,
        0,
      );
    }

    // Build session in a worktree (pauses for Finalize at the end).
    const sessionId = uuidv4();
    const taskId = uuidv4();
    const model = resolveEffectiveModel(deps.config, agent.engine || 'claude-code', {
      agentModel: agent.model,
      ownerUserId: opts.requestingUserId ?? null,
      agentId: agent.id,
    });
    const wt = defaultSessionUseWorktreeFlag(project);
    deps.stmts.createSession.run(
      sessionId,
      agent.id,
      `[Build] ${project.name} — initial version`.slice(0, 100),
      agent.engine || 'claude-code',
      model,
      wt,
      0,
      1,
    );
    setSessionOwner(sessionId, opts.requestingUserId ?? null);
    if (cardId) {
      deps.stmts.reassignCardToSession.run(sessionId, agent.name, cardId);
    }

    // No auto-ship automation: the contract is implement → CI → preview →
    // PAUSE. The operator verifies (via preview) and clicks Finalize —
    // the first merge lands the app, its CI config, and its preview
    // config together.
    const prompt =
      `## Build the initial version\n\n` +
      `This project was just scaffolded from a template; the repo in your worktree is the baseline skeleton. ` +
      `Work through the phases below IN ORDER. This is the BASELINE — follow-up features and fixes come later ` +
      `as separate cards.\n\n` +
      `### Product description\n${description.trim()}\n\n` +
      (cardId
        ? `### Tracking\nKanban card: ${cardId} (move it forward as you progress).\n\n`
        : '') +
      `### Phase 1 — Implement\n` +
      `Build the described product so it works end to end. Add tests for what you build; keep the scaffold's ` +
      `checks passing. Commit as you go on the current session branch.\n\n` +
      `### Phase 2 — CI\n` +
      `The scaffold seeded \`.agent-hub/ci.yaml\` (version 2). Update it so the jobs run the REAL test/lint ` +
      `commands your implementation ended up with, and make sure they pass locally. Commit the result.\n\n` +
      `### Phase 3 — Preview\n` +
      `Configure the web preview so a human can try the app from the browser: create a compose-based preview ` +
      `and persist it via \`POST $AGENT_HUB_URL/api/projects/${project.id}/preview/setup-apply\` with ` +
      `\`session_id\` set to YOUR session id and \`preview.compose\` (entry service, port, healthPath) — this ` +
      `writes \`.agent-hub/preview.json\` and commits it. Validate with \`POST .../preview/build\` (or ` +
      `\`.../preview/test\`) and report pass/fail. Never use script/startScript preview mode.\n\n` +
      `### Phase 4 — Pause for verification\n` +
      `STOP after Phase 3 with a clean committed tree. Do NOT push and do NOT open a PR. Post a short summary ` +
      `of what was built and how to verify it in the preview. The operator will verify and click ` +
      `**Finalize Code Changes** — review, checks, push, and the PR all happen there, so the first merge ` +
      `contains the app, its CI, and its preview together.`;

    deps.stmts.insertBackgroundTask.run(taskId, sessionId, agent.id, prompt);
    deps.handleChat(null, {
      type: 'chat',
      agentId: agent.id,
      sessionId,
      content: prompt,
    });
    deps.broadcast({
      type: 'initial_build_started',
      projectId: project.id,
      sessionId,
      cardId,
    });
    console.log(`[provisioning] ${project.id}: initial build session ${sessionId} dispatched`);
  } catch (err: unknown) {
    console.warn(
      `[provisioning] ${project.id}: initial-build kickoff failed (scaffold remains usable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
