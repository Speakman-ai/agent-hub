import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateBoard } from './routes/board.js';
import { notifyDispatchFailure, dispatchReviewFeedback } from './routes/webhooks.js';
import { defaultModelForEngine } from './config.js';
import { removeWorkspace } from './worktree.js';
import { githubApiRequest, resolveInstallationId } from './github-app.js';
import type {
  Stmts,
  Project,
  Agent,
  KanbanEpicRow,
  KanbanCardRow,
  AppConfig,
  GitHubAppConfig,
  BroadcastFn,
  ChatMessage,
} from './types.js';

const execFileAsync = promisify(execFile);

// ─── Dependency Types ───────────────────────────────────────────────────────

interface AutonomousDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  findProject: (projectId: string) => Project | undefined;
  findAgent: (agentId: string) => { project: Project; agent: Agent } | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  handleCancel: (sessionId: string) => void;
  getActiveProcesses: () => Map<string, unknown>;
  getProjects: () => Project[];
  getConfig: () => AppConfig;
  getGhAuthenticatedUser: () => string | null;
  getGhBotUser: () => string | null;
  getGhAppSlug: () => string | null;
  getWebhookHandlerDeps: () => WebhookHandlerDeps;
}

interface WebhookHandlerDeps {
  stmts: Stmts;
  findAgent: (agentId: string) => { project: Project; agent: Agent } | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  broadcast: BroadcastFn;
}

interface ParsedPR {
  owner: string;
  repo: string;
  number: string;
}

interface CICheckResult {
  ok: boolean;
  summary: string;
}

interface ResolvedCommentsResult {
  ok: boolean;
  count: number;
  summary: string;
}

// ─── Module-level state ────────────────────────────────────────────────────
const autonomousCrons = new Map<string, cron.ScheduledTask>();
const autonomousProjects = new Set<string>();
const lastDispatchedReviewId = new Map<string, number>();
const reviewSessionCards = new Map<
  string,
  { cardId: string | null; prUrl: string; reviewerAgent: string }
>();
const reviewSessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const REVIEW_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
let reviewPollCron: cron.ScheduledTask | null = null;

// Round-robin reviewer rotation: tracks the last reviewer index per project
const lastReviewerIndex = new Map<string, number>();

/**
 * Select the next eligible reviewer agent for a project using round-robin.
 * Eligible agents: role === 'lead' OR canReview === true.
 * Setting canReview to false explicitly excludes an agent, even leads.
 * Skips the author agent to prevent self-review.
 */
function selectReviewerAgent(project: Project, authorAgent?: Agent): Agent | null {
  const eligible = project.agents.filter(
    (a) =>
      a.canReview !== false &&
      (a.role === 'lead' || a.canReview === true) &&
      a.active !== false &&
      (!authorAgent || a.id !== authorAgent.id),
  );
  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0];

  const lastIdx = lastReviewerIndex.get(project.id) ?? -1;
  const nextIdx = (lastIdx + 1) % eligible.length;
  lastReviewerIndex.set(project.id, nextIdx);
  return eligible[nextIdx];
}

// ─── Injected dependencies (set via init()) ────────────────────────────────
let deps: AutonomousDeps | null = null;

function getDeps(): AutonomousDeps {
  if (!deps) throw new Error('autonomous: initAutonomous() must be called before use');
  return deps;
}

export function initAutonomous(d: AutonomousDeps): void {
  deps = d;
}

// ─── Getters for shared state (used by index.js) ───────────────────────────

export { autonomousCrons, autonomousProjects, lastDispatchedReviewId, reviewSessionCards };

// ─── Review Session Tracking ───────────────────────────────────────────────

export function startReviewSessionTimeout(sessionId: string, projectId: string): void {
  clearReviewSessionTimeout(sessionId);
  const d = getDeps();
  const timer = setTimeout(() => {
    reviewSessionTimers.delete(sessionId);
    const tracked = reviewSessionCards.get(sessionId);

    console.warn(
      `[Review Timeout] Review session ${sessionId} timed out after ${REVIEW_SESSION_TIMEOUT_MS / 60000} min`,
    );

    d.handleCancel(sessionId);

    const project = d.findProject(projectId);
    if (tracked?.cardId && project) {
      const boardData = getOrCreateBoard(d.stmts, projectId);
      if (boardData?.board) {
        const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
          id: string;
          name: string;
        }>;
        const inProgressCol = cols.find((c) => c.name === 'In Progress');
        if (inProgressCol) {
          d.stmts.moveKanbanCard.run(inProgressCol.id, 0, tracked.cardId);

          try {
            d.stmts.createKanbanCardComment.run(
              crypto.randomUUID(),
              tracked.cardId,
              'system',
              `Review session timed out after 15 minutes. Card moved back to In Progress. The review will be retried automatically when a slot is available.`,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Review Timeout] Failed to add comment to card:`, msg);
          }

          d.broadcast({ type: 'kanban_update', projectId });
        }
      }
    }

    // Update card review_status back to awaiting_review
    if (tracked?.cardId) {
      try {
        d.stmts.setCardReviewStatus.run('awaiting_review', tracked.cardId);
      } catch (_e: unknown) {
        /* non-critical */
      }
    }

    // Log the timeout
    if (tracked?.prUrl) {
      try {
        d.stmts.createReviewLog.run(
          crypto.randomUUID(),
          projectId,
          tracked.cardId || null,
          tracked.prUrl,
          tracked.reviewerAgent || 'unknown',
          null,
          sessionId,
          'timeout',
          'Review session timed out after 15 minutes',
          new Date().toISOString(),
          new Date().toISOString(),
        );
      } catch (_e: unknown) {
        /* non-critical */
      }
    }

    reviewSessionCards.delete(sessionId);

    try {
      const reviewSession = d.stmts.getSession.get(sessionId) as
        | { worktree_path?: string }
        | undefined;
      if (reviewSession?.worktree_path) {
        removeWorkspace(reviewSession.worktree_path);
      }
      d.stmts.deleteSession.run(sessionId);
      d.broadcast({ type: 'session_deleted', sessionId, projectId });
      console.log(`[Review Timeout] Cleaned up review session ${sessionId}`);
    } catch (cleanupErr: unknown) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.error(`[Review Timeout] Failed to clean up review session:`, msg);
    }

    d.broadcast({
      type: 'lead_review_complete',
      sessionId,
      outcome: 'timeout',
      projectId,
      prUrl: tracked?.prUrl || null,
      cardId: tracked?.cardId || null,
      cardTitle: null,
      reviewerAgent: null,
      authorAgent: null,
    });

    if (autonomousProjects.size > 0) {
      setTimeout(() => tryAutonomousDispatch(), 2000);
    }
  }, REVIEW_SESSION_TIMEOUT_MS);

  reviewSessionTimers.set(sessionId, timer);
}

export function clearReviewSessionTimeout(sessionId: string): void {
  const timer = reviewSessionTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reviewSessionTimers.delete(sessionId);
  }
}

// ─── Core Dispatch ─────────────────────────────────────────────────────────

export async function runAutonomousLoop(projectId: string): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return;

  const epic = d.stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
  if (!epic) return;

  const eligible = d.stmts.getEligibleAutonomousCards.all(
    epic.id,
    epic.autonomous_max_iterations,
  ) as KanbanCardRow[];
  if (eligible.length === 0) {
    console.log(
      `[Autonomous] No eligible cards for epic "${epic.name}" (all assigned, done, or at max iterations)`,
    );
    return;
  }

  const activeProcesses = d.getActiveProcesses();
  const agentSessionCounts = new Map<string, number>();
  for (const [sid] of activeProcesses) {
    const session = d.stmts.getSession.get(sid) as { agent_id: string } | undefined;
    if (session)
      agentSessionCounts.set(session.agent_id, (agentSessionCounts.get(session.agent_id) || 0) + 1);
  }

  const leadAgent = project.agents.find((a) => a.role === 'lead');
  let assignableAgents: Agent[];
  if (leadAgent && leadAgent.subAgents?.length) {
    assignableAgents = leadAgent.subAgents
      .map((sa) => {
        const saId = typeof sa === 'string' ? sa : (sa as { id: string }).id;
        return project.agents.find((a) => a.id === saId) || d.findAgent(saId)?.agent;
      })
      .filter((a): a is Agent => !!a);
  } else {
    assignableAgents = project.agents.filter((a) => a.role !== 'docs' && a.role !== 'intake');
  }

  const agentCount = assignableAgents.length;
  if (agentCount === 0) {
    const msg = `No assignable agents for project "${project.name}" — check subAgents config or agent roles`;
    console.log(`[Autonomous] ${msg}`);
    const firstCard = eligible[0];
    if (firstCard?.id) {
      try {
        d.stmts.createKanbanCardComment.run(
          uuidv4(),
          firstCard.id,
          'system',
          `ℹ️ **Autonomous dispatch skipped**\n\n${msg}`,
        );
        d.broadcast({ type: 'kanban_update', projectId });
      } catch (_) {
        /* best-effort */
      }
    }
    return;
  }
  const perAgentLimit = Math.max(1, Math.ceil(epic.autonomous_max_concurrent / agentCount));

  interface AgentSlot {
    agent: Agent;
    active: number;
    slots: number;
  }

  const agentsWithSlots: AgentSlot[] = assignableAgents
    .map((a) => ({ agent: a, active: agentSessionCounts.get(a.id) || 0, slots: 0 }))
    .filter((a) => a.active < perAgentLimit)
    .map((a) => ({ ...a, slots: perAgentLimit - a.active }));
  if (agentsWithSlots.length === 0) return;

  const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
    id: string;
    name: string;
  }>;
  const inProgressColId = cols.find((c) => c.name === 'In Progress')?.id;
  const reviewColId = cols.find((c) => c.name === 'Review')?.id;
  const epicCards = d.stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
  const activeCardCount = epicCards.filter(
    (c) => c.column_id === inProgressColId || c.column_id === reviewColId,
  ).length;
  const slotsAvailable = Math.max(0, epic.autonomous_max_concurrent - activeCardCount);
  if (slotsAvailable === 0) {
    console.log(
      `[Autonomous] No slots for epic "${epic.name}" — ${activeCardCount}/${epic.autonomous_max_concurrent} active (in-progress + in-review)`,
    );
    return;
  }

  let assigned = 0;
  let agentIdx = 0;
  const agentSlotsCopy = agentsWithSlots.map((a) => ({ ...a }));
  const webhookHandlerDeps = d.getWebhookHandlerDeps();

  while (assigned < slotsAvailable && assigned < eligible.length) {
    let found = false;
    for (let tries = 0; tries < agentSlotsCopy.length; tries++) {
      const idx = (agentIdx + tries) % agentSlotsCopy.length;
      if (agentSlotsCopy[idx].slots > 0) {
        agentIdx = idx;
        found = true;
        break;
      }
    }
    if (!found) break;

    const card = eligible[assigned];
    const agent = agentSlotsCopy[agentIdx].agent;
    agentSlotsCopy[agentIdx].slots--;
    agentIdx = (agentIdx + 1) % agentSlotsCopy.length;

    const rollbackCard = (err: unknown): void => {
      try {
        d.stmts.updateKanbanCard.run(
          card.title,
          card.description,
          card.priority,
          card.assignee,
          card.labels,
          card.session_id,
          card.github_issue_url,
          card.pr_url,
          card.epic_id,
          card.id,
        );
        d.stmts.moveKanbanCard.run(card.column_id, card.position, card.id);
      } catch (rollbackErr: unknown) {
        const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        console.error(`[Autonomous] Rollback failed for card "${card.title}":`, msg);
      }
      notifyDispatchFailure(webhookHandlerDeps, {
        source: 'Autonomous',
        cardId: card.id,
        cardTitle: card.title,
        projectId,
        agentName: agent.name,
        reason: 'Failed to create session or start chat for autonomous card',
        error: err,
      });
    };

    try {
      console.log(`[Autonomous] Assigning "${card.title}" to ${agent.name}`);
      d.stmts.incrementCardIterations.run(card.id);

      const sessionId = crypto.randomUUID();
      const engine = agent.engine || 'claude-code';
      d.stmts.createSession.run(
        sessionId,
        agent.id,
        card.title,
        engine,
        agent.model || defaultModelForEngine(engine),
        1,
        0,
      );

      d.stmts.updateKanbanCard.run(
        card.title,
        card.description,
        card.priority,
        agent.name,
        card.labels,
        sessionId,
        card.github_issue_url,
        card.pr_url,
        card.epic_id,
        card.id,
      );
      d.stmts.moveKanbanCard.run(inProgressColId || card.column_id, 0, card.id);

      const iteration = (card.autonomous_iterations || 0) + 1;
      const contextLines: string[] = [`# Task: ${card.title}`];
      if (card.description) contextLines.push(`\n## Description\n${card.description}`);
      if (card.priority) contextLines.push(`\n**Priority:** ${card.priority}`);
      if (card.labels) contextLines.push(`**Labels:** ${card.labels}`);
      if (iteration > 1)
        contextLines.push(
          `\n**Iteration:** ${iteration}/${epic.autonomous_max_iterations} — This task was previously attempted. Check git log and PR comments for prior work and feedback.`,
        );
      contextLines.push(
        `\n---\nYou have been assigned this task by the autonomous dispatch system. Review the description above and begin working on it. When done, commit your changes — a PR will be created automatically.`,
      );

      d.handleChat(null, {
        type: 'chat',
        agentId: agent.id,
        sessionId,
        content: contextLines.join('\n'),
        hookSpecificOutput: { sessionTitle: card.title },
      }).catch(rollbackCard);

      d.broadcast({
        type: 'autonomous_assigned',
        projectId,
        epicId: epic.id,
        cardId: card.id,
        cardTitle: card.title,
        agentId: agent.id,
        agentName: agent.name,
        iteration,
      });
      assigned++;
    } catch (err: unknown) {
      rollbackCard(err);
    }
  }

  if (assigned > 0) {
    d.broadcast({ type: 'kanban_update', projectId });
    console.log(`[Autonomous] Dispatched ${assigned} card(s) for epic "${epic.name}"`);
  }
}

export function tryAutonomousDispatch(): void {
  for (const projectId of autonomousProjects) {
    runAutonomousLoop(projectId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomous] Dispatch error for "${projectId}":`, msg);
    });
  }
}

export function scheduleAutonomousEpic(projectId: string, epic: KanbanEpicRow): void {
  const key = epic.id;

  const existing = autonomousCrons.get(key);
  if (existing) {
    existing.stop();
    autonomousCrons.delete(key);
  }
  autonomousProjects.delete(projectId);

  if (!epic.autonomous) {
    console.log(`[Autonomous] Stopped for epic "${epic.name}"`);
    return;
  }

  autonomousProjects.add(projectId);

  const task = cron.schedule('* * * * *', () => {
    runAutonomousLoop(projectId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomous] Safety-net error for "${epic.name}":`, msg);
    });
  });
  autonomousCrons.set(key, task);
  console.log(
    `[Autonomous] Activated epic "${epic.name}" for project "${projectId}" (event-driven + 60s safety net)`,
  );

  runAutonomousLoop(projectId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Autonomous] Initial dispatch error:`, msg);
  });
}

// ─── Lead Review ───────────────────────────────────────────────────────────

export function triggerReviewForCard(cardId: string, project: Project): void {
  const d = getDeps();
  const card = d.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
  if (!card) return;

  const prUrl = card.pr_url;
  if (!prUrl) {
    console.log(
      `[Lead Review] Card "${card.title}" moved to Review but has no PR URL — skipping review`,
    );
    // Still mark as awaiting_review so it's visible
    try {
      d.stmts.setCardReviewStatus.run('awaiting_review', card.id);
    } catch (_e: unknown) {
      /* non-critical */
    }
    return;
  }

  // Mark card as awaiting_review
  try {
    d.stmts.setCardReviewStatus.run('awaiting_review', card.id);
  } catch (_e: unknown) {
    /* non-critical */
  }

  const subAgent = card.assignee ? project.agents.find((a) => a.name === card.assignee) : null;

  console.log(
    `[Lead Review] Card "${card.title}" moved to Review — triggering lead review for ${prUrl}`,
  );
  leadReviewPR(project, prUrl, card, subAgent ?? undefined).catch((err: unknown) => {
    const webhookHandlerDeps = d.getWebhookHandlerDeps();
    notifyDispatchFailure(webhookHandlerDeps, {
      source: 'LeadReview',
      cardId: card.id,
      cardTitle: card.title,
      projectId: project.id,
      agentName: card.assignee,
      reason: `Failed to start lead review for ${prUrl}`,
      error: err,
    });
  });
}

// ─── GitHub Review Helpers ─────────────────────────────────────────────────

function hasGitHubApp(): boolean {
  const d = getDeps();
  const config = d.getConfig();
  const app = config.githubApp;
  if (!(app?.appId && app?.privateKey)) return false;
  return !!(app.installationId || (app.installations && app.installations.length > 0));
}

export function botGhEnv(): NodeJS.ProcessEnv | undefined {
  const d = getDeps();
  const config = d.getConfig();
  if (!config.botGithubToken) return undefined;
  return { ...process.env, GH_TOKEN: config.botGithubToken };
}

export function parsePrUrl(prUrl: string | null | undefined): ParsedPR | null {
  const match = prUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

export async function addSelfAsReviewer(prUrl: string): Promise<void> {
  const d = getDeps();
  const pr = parsePrUrl(prUrl);
  if (!pr) return;

  if (hasGitHubApp()) {
    const ghAppSlug = d.getGhAppSlug();
    console.log(
      `[Review] Skipping reviewer assignment for PR #${pr.number} — GitHub App "${ghAppSlug}" will submit its own review`,
    );
    return;
  }

  const env = botGhEnv();
  const ghBotUser = d.getGhBotUser();
  if (!env || !ghBotUser) {
    console.log(
      `[Review] Skipping reviewer assignment for PR #${pr.number} — no bot token configured (would use personal profile)`,
    );
    return;
  }
  try {
    await execFileAsync(
      'gh',
      [
        'pr',
        'edit',
        String(pr.number),
        '--repo',
        `${pr.owner}/${pr.repo}`,
        '--add-reviewer',
        ghBotUser,
      ],
      { timeout: 15000, env },
    );
    console.log(
      `[Review] Added ${ghBotUser} as reviewer on PR #${pr.number} (bot)`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message?.split('\n')[0] : String(err);
    console.log(`[Review] Could not add reviewer on PR #${pr.number}: ${msg}`);
  }
}

export async function submitGitHubReview(
  prUrl: string,
  event: string,
  body: string,
): Promise<boolean> {
  const d = getDeps();
  const pr = parsePrUrl(prUrl);
  if (!pr) return false;

  if (hasGitHubApp()) {
    try {
      const config = d.getConfig();
      const app = config.githubApp as GitHubAppConfig;
      const instId = resolveInstallationId(app, pr.owner);
      if (!instId) {
        console.log(`[Review] No GitHub App installation found for owner "${pr.owner}" — skipping`);
        return false;
      }
      await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
        method: 'POST',
        body: { event, body },
        appId: app.appId,
        privateKey: app.privateKey,
        installationId: instId,
      });
      const ghAppSlug = d.getGhAppSlug();
      console.log(
        `[Review] Formal ${event} review submitted on PR #${pr.number} (via GitHub App: ${ghAppSlug})`,
      );
      return true;
    } catch (err: unknown) {
      const ghAppSlug = d.getGhAppSlug();
      const msg = err instanceof Error ? err.message?.split('\n')[0] : String(err);
      console.log(
        `[Review] GitHub App review failed on PR #${pr.number}: ${msg} — trying fallbacks`,
      );
    }
  }

  const env = botGhEnv();
  const ghBotUser = d.getGhBotUser();

  // Refuse to fall back to personal gh CLI — reviews would appear as the user's profile
  if (!env) {
    console.warn(
      `[Review] No bot token configured — refusing to submit review on PR #${pr.number} as personal profile`,
    );
    return false;
  }

  try {
    await execFileAsync(
      'gh',
      [
        'api',
        `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
        '--method',
        'POST',
        '-f',
        `event=${event}`,
        '-f',
        `body=${body}`,
      ],
      { timeout: 15000, env },
    );
    console.log(
      `[Review] Formal ${event} review submitted on PR #${pr.number} (as bot: ${ghBotUser})`,
    );
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message?.split('\n')[0] : String(err);
    console.log(
      `[Review] Formal review failed on PR #${pr.number} (${msg}) — falling back to comment + labels`,
    );
  }

  const fallbackOpts = { timeout: 15000, env };
  try {
    const label = event === 'APPROVE' ? 'approved' : 'changes-requested';
    const prefix = event === 'APPROVE' ? '✅ **APPROVED**' : '🔄 **CHANGES REQUESTED**';
    const comment = `${prefix}\n\n${body}`;
    await execFileAsync(
      'gh',
      ['pr', 'comment', String(pr.number), '--repo', `${pr.owner}/${pr.repo}`, '--body', comment],
      fallbackOpts,
    );
    const color = event === 'APPROVE' ? '0e8a16' : 'e11d48';
    try {
      await execFileAsync(
        'gh',
        ['label', 'create', label, '--repo', `${pr.owner}/${pr.repo}`, '--force', '--color', color],
        fallbackOpts,
      );
    } catch {
      /* label may already exist */
    }
    const oppositeLabel = event === 'APPROVE' ? 'changes-requested' : 'approved';
    try {
      await execFileAsync(
        'gh',
        [
          'pr',
          'edit',
          String(pr.number),
          '--repo',
          `${pr.owner}/${pr.repo}`,
          '--remove-label',
          oppositeLabel,
        ],
        fallbackOpts,
      );
    } catch {
      /* ignore */
    }
    try {
      await execFileAsync(
        'gh',
        ['pr', 'edit', String(pr.number), '--repo', `${pr.owner}/${pr.repo}`, '--add-label', label],
        fallbackOpts,
      );
    } catch {
      /* ignore */
    }
    console.log(
      `[Review] Fallback: comment + label "${label}" added on PR #${pr.number} (bot: ${ghBotUser})`,
    );
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Review] Fallback comment also failed on PR #${pr.number}:`, msg);
    return false;
  }
}

export async function mergeApprovedPR(prUrl: string): Promise<boolean> {
  const d = getDeps();
  const pr = parsePrUrl(prUrl);
  if (!pr) return false;

  if (hasGitHubApp()) {
    try {
      const config = d.getConfig();
      const app = config.githubApp as GitHubAppConfig;
      const instId = resolveInstallationId(app, pr.owner);
      if (!instId) {
        console.log(`[Review] No GitHub App installation found for owner "${pr.owner}" — skipping`);
        return false;
      }
      await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, {
        method: 'PUT',
        body: { merge_method: 'squash' },
        appId: app.appId,
        privateKey: app.privateKey,
        installationId: instId,
      });
      const ghAppSlug = d.getGhAppSlug();
      console.log(`[Review] PR #${pr.number} merged via GitHub App (${ghAppSlug})`);
      try {
        const prData = (await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
          appId: app.appId,
          privateKey: app.privateKey,
          installationId: instId,
        })) as { head?: { ref?: string } };
        if (prData.head?.ref) {
          await githubApiRequest(
            `/repos/${pr.owner}/${pr.repo}/git/refs/heads/${prData.head.ref}`,
            {
              method: 'DELETE',
              appId: app.appId,
              privateKey: app.privateKey,
              installationId: instId,
            },
          );
        }
      } catch {
        /* branch deletion is best-effort */
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (/already.*merged|405/i.test(msg)) {
        console.log(`[Review] PR #${pr.number} was already merged`);
        return true;
      }
      console.log(
        `[Review] GitHub App merge failed for PR #${pr.number}: ${msg.split('\n')[0]} — trying fallback`,
      );
    }
  }

  const env = botGhEnv();
  const ghBotUser = d.getGhBotUser();
  try {
    await execFileAsync(
      'gh',
      [
        'pr',
        'merge',
        String(pr.number),
        '--repo',
        `${pr.owner}/${pr.repo}`,
        '--squash',
        '--delete-branch',
      ],
      { timeout: 30000, ...(env && { env }) },
    );
    console.log(
      `[Review] PR #${pr.number} merged successfully${env ? ` (as bot: ${ghBotUser})` : ''}`,
    );
    return true;
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : '';
    const msg = rawMsg.split('\n')[0] || '';
    if (/already.*merged|405/i.test(msg)) {
      console.log(`[Review] PR #${pr.number} was already merged`);
      return true;
    }
    console.log(`[Review] Server-side merge of PR #${pr.number} failed: ${msg}`);
    return false;
  }
}

export async function checkCIPassing(prUrl: string): Promise<CICheckResult> {
  const pr = parsePrUrl(prUrl);
  if (!pr) return { ok: false, summary: 'Invalid PR URL' };
  const env = botGhEnv();
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'checks',
        String(pr.number),
        '--repo',
        `${pr.owner}/${pr.repo}`,
        '--json',
        'name,state,conclusion',
      ],
      { timeout: 30000, ...(env && { env }) },
    );
    const checks = JSON.parse(stdout || '[]') as Array<{
      name: string;
      state: string;
      conclusion: string | null;
    }>;
    if (checks.length === 0) return { ok: true, summary: 'No CI checks configured' };
    const pending = checks.filter(
      (c) => c.state === 'PENDING' || c.state === 'QUEUED' || c.state === 'IN_PROGRESS',
    );
    const failed = checks.filter(
      (c) =>
        c.conclusion &&
        c.conclusion !== 'SUCCESS' &&
        c.conclusion !== 'NEUTRAL' &&
        c.conclusion !== 'SKIPPED',
    );
    if (pending.length > 0) {
      return {
        ok: false,
        summary: `${pending.length} check(s) still running: ${pending.map((c) => c.name).join(', ')}`,
      };
    }
    if (failed.length > 0) {
      return {
        ok: false,
        summary: `${failed.length} check(s) failing: ${failed.map((c) => `${c.name} (${c.conclusion})`).join(', ')}`,
      };
    }
    return { ok: true, summary: `All ${checks.length} check(s) passing` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Review] CI check query failed for PR #${pr.number}: ${msg}`);
    return { ok: true, summary: 'Could not query CI status — proceeding' };
  }
}

/** Count unresolved review threads via GraphQL (works when `gh pr view --json reviewThreads` is unavailable). */
async function countUnresolvedThreadsGraphql(
  pr: ParsedPR,
  env: NodeJS.ProcessEnv | undefined,
): Promise<number> {
  const query = `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){ nodes { isResolved } }
      }
    }
  }`;
  const payload = JSON.stringify({
    query,
    variables: {
      owner: pr.owner,
      name: pr.repo,
      number: parseInt(pr.number, 10),
    },
  });
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('gh', ['api', 'graphql', '--input', '-'], {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('gh api graphql timed out after 30s'));
    }, 30000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) {
        reject(new Error(err || `gh api graphql exited with ${code}`));
      } else {
        resolve(out);
      }
    });
    child.stdin?.write(payload);
    child.stdin?.end();
  });
  const parsed = JSON.parse(stdout || '{}') as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: { nodes?: Array<{ isResolved?: boolean } | null> | null } | null;
        };
      };
    };
    errors?: unknown;
  };
  if (parsed.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`);
  }
  const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  return nodes.filter((n) => n && !n.isResolved).length;
}

export async function checkResolvedComments(prUrl: string): Promise<ResolvedCommentsResult> {
  const pr = parsePrUrl(prUrl);
  if (!pr) return { ok: false, count: 0, summary: 'Invalid PR URL' };
  const env = botGhEnv();

  const summarizeUnresolved = (unresolved: number): ResolvedCommentsResult =>
    unresolved > 0
      ? {
          ok: false,
          count: unresolved,
          summary: `${unresolved} unresolved review thread(s)`,
        }
      : { ok: true, count: 0, summary: 'All review threads resolved' };

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        String(pr.number),
        '--repo',
        `${pr.owner}/${pr.repo}`,
        '--json',
        'reviewThreads',
      ],
      { timeout: 30000, ...(env && { env }) },
    );
    const data = JSON.parse(stdout || '{}') as { reviewThreads?: Array<{ isResolved: boolean }> };
    const threads = data.reviewThreads || [];
    const unresolved = threads.filter((t) => !t.isResolved).length;
    return summarizeUnresolved(unresolved);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: Buffer | string }).stderr || '')
        : '';
    const combined = `${msg} ${stderr}`;
    // Older `gh` versions do not support `gh pr view --json reviewThreads`; use GraphQL instead.
    const useGraphqlFallback = /Unknown JSON field:\s*"reviewThreads"/i.test(combined);

    if (!useGraphqlFallback) {
      console.warn(`[Review] Review thread query failed for PR #${pr.number}: ${msg}`);
      return { ok: true, count: 0, summary: 'Could not query review threads — proceeding' };
    }

    try {
      const unresolved = await countUnresolvedThreadsGraphql(pr, env);
      return summarizeUnresolved(unresolved);
    } catch (gErr: unknown) {
      const gMsg = gErr instanceof Error ? gErr.message : String(gErr);
      console.warn(
        `[Review] Review thread GraphQL fallback failed for PR #${pr.number}: ${gMsg} (original: ${msg})`,
      );
      return { ok: true, count: 0, summary: 'Could not query review threads — proceeding' };
    }
  }
}

export function extractReviewBody(content: string | null | undefined, type: string): string {
  if (!content) return type === 'approve' ? 'Looks good — approved.' : 'Changes requested.';

  const reviewBodyMatch = content.match(/gh pr review.*--body\s+["']([\s\S]+?)["']\s*(?:--|$)/s);
  if (reviewBodyMatch) return reviewBodyMatch[1].trim();

  const apiBodyMatch = content.match(/-f body=["']([\s\S]+?)["']\s*(?:-|$)/s);
  if (apiBodyMatch) return apiBodyMatch[1].trim();

  const commentMatch = content.match(/(?:CHANGES REQUESTED|APPROVED)\*?\*?\s*\n([\s\S]{10,800})/i);
  if (commentMatch) return commentMatch[1].trim().slice(0, 1000);

  const tail = content.slice(-500).trim();
  return tail || (type === 'approve' ? 'Looks good — approved.' : 'Changes requested.');
}

export async function leadReviewPR(
  project: Project,
  prUrl: string,
  card: KanbanCardRow | null,
  subAgent?: Agent,
): Promise<void> {
  const d = getDeps();

  const alreadyReviewing = [...reviewSessionCards.values()].find((r) => r.prUrl === prUrl);
  if (alreadyReviewing) {
    console.log(`[Lead Review] Already reviewing ${prUrl} — skipping`);
    return;
  }

  const config = d.getConfig();

  // Hard guard: refuse to start reviews if no bot identity is configured
  const hasBotIdentity = !!config.botGithubToken || hasGitHubApp();
  if (!hasBotIdentity) {
    console.warn(
      `[Lead Review] BLOCKED — no bot identity configured (no botGithubToken and no GitHub App). ` +
        `Reviews would appear as the user's personal GitHub profile. Configure a GitHub App or bot token in Settings.`,
    );
    d.broadcast({
      type: 'lead_review_skipped',
      projectId: project.id,
      prUrl,
      reason: 'no_bot_identity',
      cardTitle: card?.title || '',
    });
    return;
  }

  const wfAutoReview = (project as Record<string, unknown>).githubWorkflow as
    | {
        autoReview?: boolean;
        autoMerge?: boolean;
        waitForCI?: boolean;
        waitForResolvedComments?: boolean;
      }
    | undefined;
  if (wfAutoReview?.autoReview === false) {
    console.log(
      `[Lead Review] Auto-review disabled for project "${project.name}" — skipping review of ${prUrl}`,
    );
    return;
  }

  // Round-robin reviewer selection (skips author to prevent self-review)
  let leadAgent = selectReviewerAgent(project, subAgent);
  if (!leadAgent) {
    // Fallback: try the first lead agent
    const fallbackLead = project.agents.find((a) => a.role === 'lead');
    if (!fallbackLead) return;

    // Check if it would be a self-review
    if (subAgent && fallbackLead.id === subAgent.id) {
      console.log(
        `[Lead Review] Skipping self-review for "${card?.title || prUrl}" — no eligible reviewer found that isn't the author`,
      );
      d.broadcast({
        type: 'lead_review_skipped',
        projectId: project.id,
        prUrl,
        reason: 'self-review',
        cardTitle: card?.title || '',
      });
      return;
    }
    leadAgent = fallbackLead;
  }

  const isSelfReview = false; // selectReviewerAgent already excludes the author

  const isAutonomous = card?.epic_id
    ? !!(d.stmts.getKanbanEpic.get(card.epic_id) as KanbanEpicRow | undefined)?.autonomous
    : false;

  const wf = wfAutoReview || {};
  const shouldAutoMerge = wf.autoMerge !== undefined ? wf.autoMerge : isAutonomous;
  const shouldWaitForCI = wf.waitForCI !== undefined ? wf.waitForCI : false;
  const shouldWaitForComments =
    wf.waitForResolvedComments !== undefined ? wf.waitForResolvedComments : false;

  const reviewTitle = card?.title || `PR ${prUrl.match(/\d+$/)?.[0] || ''}`;
  console.log(
    `[Lead Review] Lead "${leadAgent.name}" reviewing PR: ${prUrl}${isSelfReview ? ' (self-review)' : ''}${shouldAutoMerge ? ' (will merge if approved)' : ''}`,
  );

  await addSelfAsReviewer(prUrl);

  const sessionId = crypto.randomUUID();
  const engine = leadAgent.engine || 'claude-code';
  d.stmts.createSession.run(
    sessionId,
    leadAgent.id,
    `Review: ${reviewTitle}`,
    engine,
    leadAgent.model || defaultModelForEngine(engine),
    1,
    0,
  );

  const prNumber = prUrl.match(/\d+$/)?.[0] || '';

  let preReviewChecks = '';
  if (shouldWaitForCI) {
    preReviewChecks += `
## Step 0 — Wait for CI checks to pass
Before reviewing, verify all GitHub checks are passing:
\`\`\`bash
gh pr checks ${prNumber}
\`\`\`
If any checks are still running, wait 30 seconds and check again. If checks are failing, note the failures in your review and request changes.
`;
  }
  if (shouldWaitForComments) {
    preReviewChecks += `
## Step 0b — Check for unresolved review comments
On the PR’s **Files changed** tab, confirm there are no **unresolved** review conversations before approving.
(If your \`gh\` is recent, you can try: \`gh pr view ${prNumber} --json reviewThreads\`; older CLIs omit that field — the server uses the GitHub API when needed.)
If there are unresolved threads, do NOT approve until they are resolved.
`;
  }

  const hasBotToken = !!config.botGithubToken;
  const serverHandlesReview = hasBotToken || hasGitHubApp();

  const agentReviewStep = serverHandlesReview
    ? `
### If the code looks good:
Report: **"APPROVED"** — and explain briefly why the code is correct.
The server will submit the formal approval${shouldAutoMerge ? ' and merge' : ''} via the ${hasGitHubApp() ? 'GitHub App' : 'bot account'} automatically.${!shouldAutoMerge ? '\nNote: Auto-merge is disabled — a human will merge the PR after approval.' : ''}

### If you find issues:
Report: **"CHANGES REQUESTED"** — and list each issue with:
- File path and line number
- What's wrong
- What to do instead

The server will submit the formal "request changes" review via the ${hasGitHubApp() ? 'GitHub App' : 'bot account'} automatically.

Do **NOT** run \`gh pr review\`, \`gh pr merge\`, or \`gh api\` commands — the server handles all formal GitHub actions through the ${hasGitHubApp() ? 'GitHub App' : 'bot account'}.`
    : shouldAutoMerge
      ? `
### If the code looks good:
Submit a formal approval review:
\`\`\`bash
gh pr review ${prNumber} --approve --body "Looks good — approved."
\`\`\`
If the above fails, use the API:
\`\`\`bash
gh api repos/{owner}/{repo}/pulls/${prNumber}/reviews --method POST -f event=APPROVE -f body="Looks good — approved."
\`\`\`
Then **merge the PR**:
\`\`\`bash
gh pr merge ${prNumber} --squash --delete-branch
\`\`\`

### If the merge fails due to conflicts:
If the merge command fails (e.g., "merge conflict", "not mergeable", "out of date"), try to resolve it yourself:
1. Check out the branch and rebase onto main:
   \`\`\`bash
   gh pr checkout ${prNumber}
   git fetch origin main
   git rebase origin/main
   \`\`\`
2. Resolve any conflicts, then force-push the updated branch:
   \`\`\`bash
   git add -A -- ':!node_modules' ':!*/node_modules'
   git rebase --continue
   git push --force-with-lease
   \`\`\`
3. After the rebase succeeds, retry the merge:
   \`\`\`bash
   gh pr merge ${prNumber} --squash --delete-branch
   \`\`\`
4. If you **cannot resolve the conflicts** (e.g., too complex, unclear intent), report clearly:
   "MERGE FAILED — conflicts could not be resolved" and describe what conflicted.

Report the final outcome: whether you approved and merged, approved but merge failed, or requested changes.

### If you find issues:
Submit a formal "request changes" review with specific, actionable feedback:
\`\`\`bash
gh pr review ${prNumber} --request-changes --body "Your detailed feedback here — list each issue with file path, what's wrong, and what to do instead"
\`\`\`
If the above command fails (e.g. same-account limitation), fall back to the API:
\`\`\`bash
gh api repos/{owner}/{repo}/pulls/${prNumber}/reviews --method POST -f event=REQUEST_CHANGES -f body="Your detailed feedback here"
\`\`\`
If that also fails, leave a comment prefixed with **🔄 CHANGES REQUESTED** so the outcome is clear:
\`\`\`bash
gh pr comment ${prNumber} --body "🔄 **CHANGES REQUESTED**\\n\\nYour feedback here"
\`\`\``
      : `
### If the code looks good:
Submit a formal approval review:
\`\`\`bash
gh pr review ${prNumber} --approve --body "Looks good — approved."
\`\`\`
If the above fails, use the API:
\`\`\`bash
gh api repos/{owner}/{repo}/pulls/${prNumber}/reviews --method POST -f event=APPROVE -f body="Looks good — approved."
\`\`\`
Do **NOT** merge the PR — auto-merge is disabled. A human will merge it after approval.

### If you find issues:
Submit a formal "request changes" review with specific, actionable feedback:
\`\`\`bash
gh pr review ${prNumber} --request-changes --body "Your detailed feedback here — list each issue with file path, what's wrong, and what to do instead"
\`\`\`
If the above command fails (e.g. same-account limitation), fall back to the API:
\`\`\`bash
gh api repos/{owner}/{repo}/pulls/${prNumber}/reviews --method POST -f event=REQUEST_CHANGES -f body="Your detailed feedback here"
\`\`\`
If that also fails, leave a comment prefixed with **🔄 CHANGES REQUESTED** so the outcome is clear:
\`\`\`bash
gh pr comment ${prNumber} --body "🔄 **CHANGES REQUESTED**\\n\\nYour feedback here"
\`\`\``;

  const mergeRule = serverHandlesReview
    ? `- **Do NOT check out the branch or edit any code** — you are the reviewer, not the author
- **Do NOT run gh pr review, gh pr merge, or gh api commands** — the server handles all formal GitHub actions via the ${hasGitHubApp() ? 'GitHub App' : 'bot account'}
- Just read the diff, analyze it, and clearly report APPROVED or CHANGES REQUESTED with detailed reasoning
- Leave clear, specific feedback so the author can act on it`
    : shouldAutoMerge
      ? `- **Do NOT check out the branch or edit any code** — you are the reviewer, not the author
- If approved, **merge the PR** using \`gh pr merge --squash --delete-branch\` — approval and merge should be a single action
- Leave clear, specific comments so the author can act on them
- After leaving your review, report what you found and what action you took`
      : `- **Do NOT check out the branch or edit any code** — you are the reviewer, not the author
- If approved, submit the approval review but do **NOT** merge — auto-merge is disabled, a human will merge
- Leave clear, specific comments so the author can act on them
- After leaving your review, report what you found and what action you took`;

  const reviewPrompt = `# In-House PR Review

**PR:** ${prUrl}
**Task:** ${reviewTitle}
**Author:** ${subAgent?.name || 'unknown'}
${card?.description ? `**Description:** ${card.description}` : ''}

You are the lead code reviewer. Review this PR like a senior dev reviewing a teammate's work. You do NOT fix the code yourself — you leave review comments and the original author addresses them.
${preReviewChecks}
## Step 1 — Read the PR diff
\`\`\`bash
gh pr diff ${prNumber}
\`\`\`
Read the full diff carefully. Understand what was changed and why.

## Step 2 — Review for real issues
Check for:
- **Bugs**: Logic errors, off-by-one, null/undefined access, race conditions
- **Security**: Injection, unvalidated input, exposed secrets
- **Correctness**: Does the implementation actually solve the task?
- **Missing edge cases**: Error handling, empty states, boundary conditions
- **Breaking changes**: Does this break existing functionality?

Do NOT nitpick style, naming, or minor formatting. Focus on real problems only.

## Step 3 — Report your review
${agentReviewStep}

## Rules
${mergeRule}

## Important
- When reporting your outcome, clearly state whether you APPROVED or REQUESTED CHANGES with detailed reasoning
- **Do NOT create kanban cards** — this is a review session, not new work. The task card already exists and is being tracked automatically.`;

  reviewSessionCards.set(sessionId, {
    cardId: card?.id || null,
    prUrl,
    reviewerAgent: leadAgent.name || leadAgent.id,
  });

  // Set card review_status to 'reviewing'
  if (card) {
    try {
      d.stmts.setCardReviewStatus.run('reviewing', card.id);
    } catch (_e: unknown) {
      /* non-critical */
    }
  }

  startReviewSessionTimeout(sessionId, project.id);

  d.handleChat(null, {
    type: 'chat',
    agentId: leadAgent.id,
    sessionId,
    content: reviewPrompt,
    hookSpecificOutput: { sessionTitle: `Review: ${reviewTitle}` },
  });

  d.broadcast({
    type: 'lead_review',
    projectId: project.id,
    prUrl,
    cardTitle: reviewTitle,
    reviewerAgent: leadAgent.name,
    authorAgent: subAgent?.name || null,
    sessionId,
    isSelfReview,
    cardId: card?.id || null,
  });
}

// ─── Review Outcome ────────────────────────────────────────────────────────

export async function handleReviewOutcome(
  project: Project,
  sessionId: string,
  finalContent: string,
): Promise<void> {
  const d = getDeps();
  clearReviewSessionTimeout(sessionId);

  try {
    const approved = /approv|pr review.*--approve|ready for.*merge|looks good|lgtm|no issues/i.test(
      finalContent,
    );
    const changesRequested = /request.changes|changes.needed|needs?.fix|--request-changes/i.test(
      finalContent,
    );
    const mergeFailed =
      /merge failed|merge conflict|cannot.*merge|not mergeable|could not.*resolve.*conflict|conflicts? could not/i.test(
        finalContent,
      );

    const session = d.stmts.getSession.get(sessionId) as
      | { name?: string; worktree_path?: string }
      | undefined;
    if (!session) return;

    const titleMatch = session.name?.match(/^Review: (.+)$/);
    if (!titleMatch) return;

    const boardData = getOrCreateBoard(d.stmts, project.id);
    if (!boardData?.board) return;
    const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
      id: string;
      name: string;
    }>;

    let card: KanbanCardRow | null = null;
    const tracked = reviewSessionCards.get(sessionId);
    if (tracked?.cardId) {
      card = (d.stmts.getKanbanCard.get(tracked.cardId) as KanbanCardRow | undefined) ?? null;
    }
    if (!card) {
      const allBoardCards = cols.flatMap(
        (col) => d.stmts.getKanbanCards.all(col.id) as KanbanCardRow[],
      );
      card = allBoardCards.find((c) => c.title === titleMatch[1]) ?? null;
    }
    reviewSessionCards.delete(sessionId);

    console.log(
      `[Review] Outcome for "${titleMatch[1]}": approved=${approved}, changesRequested=${changesRequested}, mergeFailed=${mergeFailed}, cardFound=${!!card}`,
    );

    const prUrl = card?.pr_url || tracked?.prUrl;
    const webhookHandlerDeps = d.getWebhookHandlerDeps();

    // Determine outcome for logging
    const reviewOutcome =
      mergeFailed && approved
        ? 'merge_conflict'
        : approved
          ? 'approved'
          : changesRequested
            ? 'changes_requested'
            : 'ambiguous';

    // Update card review_status
    if (card) {
      const statusMap: Record<string, string> = {
        approved: 'approved',
        changes_requested: 'changes_requested',
        merge_conflict: 'approved', // approved but merge failed
        ambiguous: 'awaiting_review',
      };
      try {
        d.stmts.setCardReviewStatus.run(statusMap[reviewOutcome] || null, card.id);
      } catch (_e: unknown) {
        /* non-critical */
      }
    }

    // Create review log entry
    if (prUrl) {
      const reviewerName =
        tracked?.reviewerAgent || project.agents.find((a) => a.role === 'lead')?.name || 'unknown';
      const authorAgent = card?.assignee || null;
      try {
        d.stmts.createReviewLog.run(
          crypto.randomUUID(),
          project.id,
          card?.id || null,
          prUrl,
          reviewerName,
          authorAgent,
          sessionId,
          reviewOutcome,
          finalContent.slice(-2000),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      } catch (_e: unknown) {
        console.error('[Review] Failed to create review log entry');
      }
    }

    if (mergeFailed && approved && card) {
      console.log(
        `[Review] PR approved but merge failed for "${titleMatch[1]}" — dispatching conflict resolution to author`,
      );

      if (prUrl) {
        const reviewBody = extractReviewBody(finalContent, 'approve');
        submitGitHubReview(prUrl, 'APPROVE', reviewBody).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Review] Server-side approval submission failed:`, msg);
        });
      }

      const prNumber = prUrl?.match(/\/pull\/(\d+)/)?.[1] || '';
      const conflictMessage = `# Merge Conflict Resolution Needed

Your PR was **approved** by the lead reviewer, but it could not be merged due to merge conflicts with the main branch.

## What to do:
1. Rebase your branch onto main:
   \`\`\`bash
   git fetch origin main
   git rebase origin/main
   \`\`\`
2. Resolve any conflicts that arise, then continue the rebase:
   \`\`\`bash
   # After resolving conflicts in each file:
   git add <resolved-files>
   git rebase --continue
   \`\`\`
3. Force-push the rebased branch:
   \`\`\`bash
   git push --force-with-lease
   \`\`\`
4. Verify the build still passes: \`npm run build\`
5. The lead will automatically re-review and merge once conflicts are resolved.

${prNumber ? `**PR:** ${prUrl}\nCheck the current conflict status: \`gh pr view ${prNumber} --json mergeable,mergeStateStatus\`` : ''}

## Reviewer's notes:
${finalContent.slice(-1500)}`;

      const inProgressCol = cols.find((c) => c.name === 'In Progress');
      if (inProgressCol) {
        d.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
        d.broadcast({ type: 'kanban_update', projectId: project.id });
      }

      dispatchReviewFeedback(webhookHandlerDeps, card, project, conflictMessage);

      d.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'merge_conflict',
        projectId: project.id,
        prUrl,
        cardId: card?.id || null,
        cardTitle: titleMatch[1],
        reviewerAgent: project.agents.find((a) => a.role === 'lead')?.name || null,
        authorAgent: card?.assignee || null,
      });
    } else if (approved) {
      if (prUrl) {
        const reviewBody = extractReviewBody(finalContent, 'approve');
        submitGitHubReview(prUrl, 'APPROVE', reviewBody).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Review] Server-side approval submission failed:`, msg);
        });

        const wf = ((project as Record<string, unknown>).githubWorkflow || {}) as {
          autoMerge?: boolean;
          waitForCI?: boolean;
          waitForResolvedComments?: boolean;
        };
        const isAutonomous = card?.epic_id
          ? !!(d.stmts.getKanbanEpic.get(card.epic_id) as KanbanEpicRow | undefined)?.autonomous
          : false;
        const shouldAutoMerge = wf.autoMerge !== undefined ? wf.autoMerge : isAutonomous;
        const shouldWaitForCI = wf.waitForCI !== undefined ? wf.waitForCI : false;
        const shouldWaitForComments =
          wf.waitForResolvedComments !== undefined ? wf.waitForResolvedComments : false;

        if (shouldAutoMerge) {
          const prLabel = titleMatch[1] || `PR ${prUrl}`;
          let canMerge = true;

          if (shouldWaitForCI) {
            const ci = await checkCIPassing(prUrl);
            if (!ci.ok) {
              console.log(
                `[Review] Blocking merge for "${prLabel}" — CI not passing: ${ci.summary}`,
              );
              canMerge = false;
            } else {
              console.log(`[Review] CI check passed for "${prLabel}": ${ci.summary}`);
            }
          }

          if (canMerge && shouldWaitForComments) {
            const threads = await checkResolvedComments(prUrl);
            if (!threads.ok) {
              console.log(`[Review] Blocking merge for "${prLabel}" — ${threads.summary}`);
              canMerge = false;
            } else {
              console.log(`[Review] Comment check passed for "${prLabel}": ${threads.summary}`);
            }
          }

          if (canMerge) {
            mergeApprovedPR(prUrl).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[Review] Server-side merge attempt failed:`, msg);
            });
          }
        } else {
          console.log(
            `[Review] Auto-merge disabled — skipping server-side merge for "${titleMatch[1]}"`,
          );
        }
      }

      console.log(
        `[Review] Card "${titleMatch[1]}" approved — waiting for PR merge to move to Done`,
      );

      d.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'approved',
        projectId: project.id,
        prUrl,
        cardId: card?.id || null,
        cardTitle: titleMatch[1],
        reviewerAgent: project.agents.find((a) => a.role === 'lead')?.name || null,
        authorAgent: card?.assignee || null,
      });
    } else if (changesRequested && card) {
      if (prUrl) {
        const reviewBody = extractReviewBody(finalContent, 'request_changes');
        submitGitHubReview(prUrl, 'REQUEST_CHANGES', reviewBody).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Review] Server-side request-changes submission failed:`, msg);
        });
      }

      const prNumForFeedback = card.pr_url?.match(/\d+$/)?.[0] || '';
      const feedbackMessage = `# PR Review Feedback

Your PR has received review feedback from the lead reviewer. Please read the comments on the PR, address each issue, and push your fixes to the same branch.

## What to do:
1. Read the review comments: \`gh pr view ${prNumForFeedback} --comments\`
2. Address each comment — fix the code or explain why no change is needed
3. Check for merge conflicts before pushing:
   \`\`\`bash
   git fetch origin main
   git rebase origin/main
   \`\`\`
   If there are conflicts, resolve them before continuing.
4. Commit and push to the same branch:
   \`\`\`bash
   git add -A -- ':!node_modules' ':!*/node_modules'
   git commit -m "Address review feedback"
   git push
   \`\`\`
   If you rebased, use \`git push --force-with-lease\` instead.
5. Once done, the lead will re-review automatically.

## Review summary:
${finalContent.slice(-2000)}`;

      const inProgressCol = cols.find((c) => c.name === 'In Progress');
      if (inProgressCol) {
        d.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
        d.broadcast({ type: 'kanban_update', projectId: project.id });
      }

      const feedbackSessionId = dispatchReviewFeedback(
        webhookHandlerDeps,
        card,
        project,
        feedbackMessage,
      );
      console.log(
        `[Review] Changes requested on "${titleMatch[1]}" — dispatched to session ${feedbackSessionId || '(no eligible agent)'}`,
      );

      d.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'changes_requested',
        projectId: project.id,
        prUrl,
        cardId: card?.id || null,
        cardTitle: titleMatch[1],
        reviewerAgent: project.agents.find((a) => a.role === 'lead')?.name || null,
        authorAgent: card?.assignee || null,
      });
    } else {
      console.warn(
        `[Review] Ambiguous outcome for "${titleMatch[1]}" — neither approved nor changes_requested matched. Flagging for human review. Content tail: ${finalContent.slice(-200)}`,
      );

      if (prUrl) {
        const prMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (prMatch) {
          const commentBody =
            '⚠️ **Review outcome was ambiguous — flagged for human review.**\n\n' +
            'The automated reviewer completed but the system could not determine whether the review ' +
            'was an approval or a request for changes. A human should read the review output and decide.\n\n' +
            `<details><summary>Review tail (last 500 chars)</summary>\n\n\`\`\`\n${finalContent.slice(-500)}\n\`\`\`\n</details>`;
          execFileAsync('gh', [
            'pr',
            'comment',
            prMatch[2],
            '--repo',
            prMatch[1],
            '--body',
            commentBody,
          ]).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Review] Failed to post ambiguous-review comment on PR:`, msg);
          });
        }
      }

      if (card) {
        try {
          d.stmts.createKanbanCardComment.run(
            crypto.randomUUID(),
            card.id,
            'system',
            '⚠️ Review outcome was ambiguous — flagged for human review. No auto-approve or merge was attempted.',
          );
        } catch (_e: unknown) {
          // Non-critical
        }
      }

      console.log(
        `[Review] Card "${titleMatch[1]}" flagged for human review — no auto-approve or merge attempted`,
      );

      d.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'ambiguous',
        projectId: project.id,
        prUrl,
        cardId: card?.id || null,
        cardTitle: titleMatch[1],
        reviewerAgent: project.agents.find((a) => a.role === 'lead')?.name || null,
        authorAgent: card?.assignee || null,
      });
    }

    try {
      const reviewSession = d.stmts.getSession.get(sessionId) as
        | { worktree_path?: string }
        | undefined;
      if (reviewSession?.worktree_path) {
        removeWorkspace(reviewSession.worktree_path);
      }
      d.stmts.deleteSession.run(sessionId);
      d.broadcast({ type: 'session_deleted', sessionId, projectId: project.id });
      console.log(`[Review] Cleaned up review session ${sessionId}`);
    } catch (cleanupErr: unknown) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.error(`[Review] Failed to clean up review session:`, msg);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Review] Outcome handling failed:`, msg);
  }
}

// ─── Startup Restoration ───────────────────────────────────────────────────

export function restoreAutonomousCrons(): void {
  const d = getDeps();
  const projects = d.getProjects();
  for (const project of projects) {
    try {
      const boardData = getOrCreateBoard(d.stmts, project.id);
      if (!boardData?.board) continue;
      const epic = d.stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
      if (epic) {
        scheduleAutonomousEpic(project.id, epic);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomous] Failed to restore cron for project "${project.id}":`, msg);
    }
  }
}

// ─── Review Polling Fallback ───────────────────────────────────────────────

export function startReviewPollingFallback(): void {
  if (reviewPollCron) return;

  setTimeout(async () => {
    try {
      console.log('[ReviewPoll] Running initial startup reconciliation...');
      await reconcileKanbanWithGitHub();
      await pollForMissedReviews();
      console.log('[ReviewPoll] Startup reconciliation complete');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ReviewPoll] Startup reconciliation error:', msg);
    }
  }, 10_000);

  reviewPollCron = cron.schedule('*/3 * * * *', async () => {
    try {
      await reconcileKanbanWithGitHub();
      await pollForMissedReviews();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ReviewPoll] Polling error:', msg);
    }
  });
  console.log('[ReviewPoll] Fallback polling started (every 3 minutes)');
}

async function reconcileKanbanWithGitHub(): Promise<void> {
  const d = getDeps();
  const projects = d.getProjects();

  for (const project of projects) {
    const boardData = getOrCreateBoard(d.stmts, project.id);
    if (!boardData?.board) continue;

    const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
      id: string;
      name: string;
    }>;
    const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
    if (!doneCol) continue;

    let repoFullName: string | null = (project as Record<string, unknown>).github
      ? (((project as Record<string, unknown>).github as { repo?: string })?.repo ?? null)
      : null;
    if (!repoFullName) {
      const webhookConfigs = d.stmts.getWebhookConfigsByProject?.all(project.id) as
        | Array<{ repo_url: string }>
        | undefined;
      const repoUrl = webhookConfigs?.[0]?.repo_url;
      if (repoUrl) {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (match) repoFullName = `${match[1]}/${match[2]}`;
      }
    }
    if (!repoFullName) continue;

    const nonDoneCols = cols.filter((c) => c.id !== doneCol.id);
    for (const col of nonDoneCols) {
      const cards = d.stmts.getKanbanCardsByColumn.all(col.id) as KanbanCardRow[];
      for (const card of cards) {
        if (!card.pr_url && card.session_id) {
          try {
            const session = d.stmts.getSession?.get(card.session_id) as
              | { worktree_branch?: string }
              | undefined;
            const branch = session?.worktree_branch;
            if (branch) {
              const { stdout } = await execFileAsync(
                'gh',
                [
                  'api',
                  `repos/${repoFullName}/pulls?head=${repoFullName!.split('/')[0]}:${branch}&state=all`,
                  '--jq',
                  'first | {url: .html_url, state: .state, merged: .merged} // empty',
                ],
                { timeout: 15000 },
              );

              if (stdout.trim()) {
                const pr = JSON.parse(stdout.trim()) as {
                  url?: string;
                  state?: string;
                  merged?: boolean;
                };
                if (pr.url) {
                  d.stmts.setCardPrUrl.run(pr.url, card.id);
                  (card as { pr_url: string | null }).pr_url = pr.url;
                  console.log(
                    `[Reconcile] Auto-linked PR URL on card "${card.title}" via session branch "${branch}"`,
                  );
                }
              }
            }
          } catch {
            // gh CLI not available or API error — skip silently
          }
        }

        if (!card.pr_url) continue;

        const prMatch = card.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (!prMatch) continue;

        const [, cardRepo, prNumber] = prMatch;

        try {
          const { stdout } = await execFileAsync(
            'gh',
            [
              'api',
              `repos/${cardRepo}/pulls/${prNumber}`,
              '--jq',
              '{state: .state, merged: .merged}',
            ],
            { timeout: 15000 },
          );

          const pr = JSON.parse(stdout.trim()) as { state: string; merged: boolean };

          if (pr.state === 'closed' && pr.merged) {
            d.stmts.moveKanbanCard.run(doneCol.id, 0, card.id);
            d.broadcast({ type: 'kanban_update', projectId: project.id });
            console.log(
              `[Reconcile] PR #${prNumber} already merged — card "${card.title}" moved to Done`,
            );

            tryAutonomousDispatch();
          } else if (pr.state === 'closed' && !pr.merged) {
            console.log(
              `[Reconcile] PR #${prNumber} closed without merge — card "${card.title}" left for triage`,
            );
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.debug(`[Reconcile] Skipping PR #${prNumber}: ${msg}`);
        }
      }
    }
  }
}

async function pollForMissedReviews(): Promise<void> {
  const d = getDeps();
  const projects = d.getProjects();
  const activeProcesses = d.getActiveProcesses();
  const ghAuthenticatedUser = d.getGhAuthenticatedUser();
  const webhookHandlerDeps = d.getWebhookHandlerDeps();

  for (const project of projects) {
    const boardData = getOrCreateBoard(d.stmts, project.id);
    if (!boardData?.board) continue;

    const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
      id: string;
      name: string;
    }>;
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');
    if (!reviewCol && !inProgressCol) continue;

    const targetCols = [reviewCol, inProgressCol].filter(
      (c): c is { id: string; name: string } => !!c,
    );
    for (const col of targetCols) {
      const cards = d.stmts.getKanbanCardsByColumn.all(col.id) as KanbanCardRow[];
      for (const card of cards) {
        if (!card.pr_url) continue;

        if (card.session_id && activeProcesses.has(card.session_id)) continue;

        const prMatch = card.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (!prMatch) continue;

        const [, repoFullName, prNumber] = prMatch;

        // --- Orphan detector: cards in Review with pr_url but no active review session ---
        if (col === reviewCol) {
          const hasActiveReview = [...reviewSessionCards.values()].some(
            (r) => r.prUrl === card.pr_url,
          );
          if (!hasActiveReview) {
            console.log(
              `[ReviewPoll] Orphan detected: card "${card.title}" in Review column with PR but no active review session — triggering review`,
            );
            triggerReviewForCard(card.id, project);
            continue; // Don't also process as missed-feedback — let the new review handle it
          }
        }

        try {
          const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
            execFile(
              'gh',
              [
                'api',
                `repos/${repoFullName}/pulls/${prNumber}/reviews`,
                '--jq',
                '[.[] | select(.state == "CHANGES_REQUESTED") | {id: .id, submitted_at: .submitted_at}]',
              ],
              { timeout: 15000 },
              (err, stdout, _stderr) => {
                if (err) reject(err);
                else resolve({ stdout });
              },
            );
          });
          const reviews = JSON.parse(stdout.trim() || '[]') as Array<{
            id: number;
            submitted_at: string;
          }>;

          const lastDispatched = lastDispatchedReviewId.get(card.id);
          const newReviews = lastDispatched
            ? reviews.filter((r) => r.id > lastDispatched)
            : reviews;

          if (newReviews.length > 0 && col === reviewCol) {
            console.log(
              `[ReviewPoll] Card "${card.title}" has ${newReviews.length} new change request(s) — dispatching`,
            );

            const feedbackMessage = `# Missed Review Feedback Detected (Polling)

Your PR #${prNumber} has **${newReviews.length}** pending "changes requested" review(s) that may not have been addressed yet.

## What to do:
1. Read the review comments: \`gh pr view ${prNumber} --comments\`
2. Check for inline comments: \`gh api repos/${repoFullName}/pulls/${prNumber}/comments --jq '.[] | select(.user.login != "${ghAuthenticatedUser || ''}") | {user: .user.login, body: .body, path: .path, line: .line}'\`
3. Address each issue — fix the code or explain why no change is needed
4. Commit and push:
   \`\`\`bash
   git add -A -- ':!node_modules' ':!*/node_modules'
   git commit -m "Address review feedback"
   git push
   \`\`\``;

            if (inProgressCol && card.column_id !== inProgressCol.id) {
              d.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
              d.broadcast({ type: 'kanban_update', projectId: project.id });
            }

            dispatchReviewFeedback(webhookHandlerDeps, card, project, feedbackMessage);

            const latestId = Math.max(...newReviews.map((r) => r.id));
            lastDispatchedReviewId.set(card.id, latestId);
          }
        } catch {
          // gh CLI not available or API error — skip silently
        }
      }
    }
  }
}
