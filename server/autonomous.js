/**
 * Autonomous Dispatch Engine
 *
 * Manages the full lifecycle of autonomous epic dispatch:
 *   - Core dispatch loop (event-driven + safety-net cron)
 *   - Lead review orchestration (trigger, prompt, outcome handling)
 *   - GitHub review helpers (bot auth, PR review/merge/labels)
 *   - Review session timeout tracking
 *   - Review polling fallback for missed webhooks
 *   - Startup restoration of autonomous crons
 */

import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateBoard } from './routes/board.js';
import { notifyDispatchFailure, dispatchReviewFeedback } from './routes/webhooks.js';
import { defaultModelForEngine } from './config.js';
import { removeWorkspace } from './worktree.js';
import { githubApiRequest } from './github-app.js';

const execFileAsync = promisify(execFile);

// ─── Module-level state ────────────────────────────────────────────────────
const autonomousCrons = new Map(); // key: epicId → safety-net cron
const autonomousProjects = new Set(); // projectIds with active autonomous epics
const lastDispatchedReviewId = new Map(); // cardId → latest review node_id
const reviewSessionCards = new Map(); // key: sessionId → { cardId, prUrl }
const reviewSessionTimers = new Map(); // key: sessionId → timeout handle
const REVIEW_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
let reviewPollCron = null;

// ─── Injected dependencies (set via init()) ────────────────────────────────
let deps = null;

/**
 * Initialize the autonomous engine with dependencies from index.js.
 * Must be called once at startup before any other function is used.
 *
 * @param {Object} d
 * @param {Object} d.stmts - Prepared SQLite statements
 * @param {Function} d.broadcast - WebSocket broadcast
 * @param {Function} d.findProject - (projectId) → project
 * @param {Function} d.findAgent - (agentId) → { project, agent }
 * @param {Function} d.handleChat - (ws, msg) → Promise
 * @param {Function} d.handleCancel - (sessionId) → void
 * @param {Function} d.getActiveProcesses - () → Map
 * @param {Function} d.getProjects - () → projects array
 * @param {Function} d.getConfig - () → config object
 * @param {Function} d.getGhAuthenticatedUser - () → string|null
 * @param {Function} d.getGhBotUser - () → string|null
 * @param {Function} d.getGhAppSlug - () → string|null
 * @param {Function} d.getWebhookHandlerDeps - () → webhookHandlerDeps object
 */
export function initAutonomous(d) {
  deps = d;
}

// ─── Getters for shared state (used by index.js) ───────────────────────────

export { autonomousCrons, autonomousProjects, lastDispatchedReviewId, reviewSessionCards };

// ─── Review Session Tracking ───────────────────────────────────────────────

/**
 * Start a timeout for a review session. If the session doesn't complete within
 * REVIEW_SESSION_TIMEOUT_MS (15 min), kill it, move the card back to In Progress,
 * and broadcast the timeout so a slot is freed.
 */
export function startReviewSessionTimeout(sessionId, projectId) {
  clearReviewSessionTimeout(sessionId); // idempotent — clear any prior timer
  const timer = setTimeout(() => {
    reviewSessionTimers.delete(sessionId);
    const tracked = reviewSessionCards.get(sessionId);

    console.warn(
      `[Review Timeout] Review session ${sessionId} timed out after ${REVIEW_SESSION_TIMEOUT_MS / 60000} min`,
    );

    // 1. Kill the running process
    deps.handleCancel(sessionId);

    // 2. Move card back to In Progress (if we have one)
    const project = deps.findProject(projectId);
    if (tracked?.cardId && project) {
      const boardData = getOrCreateBoard(deps.stmts, projectId);
      if (boardData?.board) {
        const cols = deps.stmts.getKanbanColumns.all(boardData.board.id);
        const inProgressCol = cols.find((c) => c.name === 'In Progress');
        if (inProgressCol) {
          deps.stmts.moveKanbanCard.run(inProgressCol.id, 0, tracked.cardId);

          // Add a comment explaining the timeout
          try {
            deps.stmts.addKanbanComment.run(
              crypto.randomUUID(),
              tracked.cardId,
              'system',
              `Review session timed out after 15 minutes. Card moved back to In Progress. The review will be retried automatically when a slot is available.`,
            );
          } catch (err) {
            console.warn(`[Review Timeout] Failed to add comment to card:`, err.message);
          }

          deps.broadcast({ type: 'kanban_update', projectId });
        }
      }
    }

    // 3. Clean up tracking
    reviewSessionCards.delete(sessionId);

    // 4. Clean up the review session itself
    try {
      const reviewSession = deps.stmts.getSession.get(sessionId);
      if (reviewSession?.worktree_path) {
        removeWorkspace(reviewSession.worktree_path);
      }
      deps.stmts.deleteSession.run(sessionId);
      deps.broadcast({ type: 'session_deleted', sessionId, projectId });
      console.log(`[Review Timeout] Cleaned up review session ${sessionId}`);
    } catch (cleanupErr) {
      console.error(`[Review Timeout] Failed to clean up review session:`, cleanupErr.message);
    }

    // 5. Broadcast timeout event
    deps.broadcast({
      type: 'lead_review_complete',
      sessionId,
      outcome: 'timeout',
      projectId,
    });

    // 6. Try to dispatch next autonomous card since a slot was freed
    if (autonomousProjects.size > 0) {
      setTimeout(() => tryAutonomousDispatch(), 2000);
    }
  }, REVIEW_SESSION_TIMEOUT_MS);

  reviewSessionTimers.set(sessionId, timer);
}

/**
 * Clear a review session timeout (called when the session completes normally).
 */
export function clearReviewSessionTimeout(sessionId) {
  const timer = reviewSessionTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reviewSessionTimers.delete(sessionId);
  }
}

// ─── Core Dispatch ─────────────────────────────────────────────────────────

/**
 * Core dispatch — event-driven. Called immediately when:
 *   - Epic toggled ON
 *   - An agent finishes a card (slot freed)
 *   - A lead review completes (card moved to Done or back to To Do)
 *   - Safety-net fallback timer fires (every 60s)
 */
export async function runAutonomousLoop(projectId) {
  const project = deps.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(deps.stmts, projectId);
  if (!boardData?.board) return;

  const epic = deps.stmts.getAutonomousEpic.get(boardData.board.id);
  if (!epic) return;

  // 1. Find eligible cards (unassigned, in Backlog/To Do, under iteration limit)
  const eligible = deps.stmts.getEligibleAutonomousCards.all(
    epic.id,
    epic.autonomous_max_iterations,
  );
  if (eligible.length === 0) {
    console.log(
      `[Autonomous] No eligible cards for epic "${epic.name}" (all assigned, done, or at max iterations)`,
    );
    return;
  }

  // 2. Find assignable agents and count their active sessions
  const activeProcesses = deps.getActiveProcesses();
  const agentSessionCounts = new Map();
  for (const [sid] of activeProcesses) {
    const session = deps.stmts.getSession.get(sid);
    if (session)
      agentSessionCounts.set(session.agent_id, (agentSessionCounts.get(session.agent_id) || 0) + 1);
  }

  const leadAgent = project.agents.find((a) => a.role === 'lead');
  let assignableAgents;
  if (leadAgent && leadAgent.subAgents?.length > 0) {
    assignableAgents = leadAgent.subAgents
      .map((sa) => {
        const saId = typeof sa === 'string' ? sa : sa.id;
        return project.agents.find((a) => a.id === saId) || deps.findAgent(saId)?.agent;
      })
      .filter(Boolean);
  } else {
    assignableAgents = project.agents.filter((a) => a.role !== 'docs' && a.role !== 'intake');
  }

  // Per-agent concurrency: spread max_concurrent evenly across agents, min 1
  const agentCount = assignableAgents.length;
  if (agentCount === 0) {
    // Informational — not an error, just a config issue. Log + card comment only (no Slack).
    const msg = `No assignable agents for project "${project.name}" — check subAgents config or agent roles`;
    console.log(`[Autonomous] ${msg}`);
    const firstCard = eligible[0];
    if (firstCard?.id) {
      try {
        deps.stmts.createKanbanCardComment.run(
          uuidv4(),
          firstCard.id,
          'system',
          `ℹ️ **Autonomous dispatch skipped**\n\n${msg}`,
        );
        deps.broadcast({ type: 'kanban_update', projectId });
      } catch (_) {
        /* best-effort */
      }
    }
    return;
  }
  const perAgentLimit = Math.max(1, Math.ceil(epic.autonomous_max_concurrent / agentCount));

  // Build a list of (agent, availableSlots) pairs — agents can run multiple sessions
  const agentsWithSlots = assignableAgents
    .map((a) => ({ agent: a, active: agentSessionCounts.get(a.id) || 0 }))
    .filter((a) => a.active < perAgentLimit)
    .map((a) => ({ agent: a.agent, slots: perAgentLimit - a.active }));
  if (agentsWithSlots.length === 0) return;

  // 3. Check concurrent slots (epic-wide)
  // Count cards in BOTH "In Progress" AND "Review" — a slot isn't freed until the PR
  // is fully merged (card moved to Done). This prevents runaway PR accumulation.
  const cols = deps.stmts.getKanbanColumns.all(boardData.board.id);
  const inProgressColId = cols.find((c) => c.name === 'In Progress')?.id;
  const reviewColId = cols.find((c) => c.name === 'Review')?.id;
  const epicCards = deps.stmts.getKanbanCardsByEpic.all(epic.id);
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

  // 4. Assign cards — round-robin across agents, respecting per-agent slots
  let assigned = 0;
  let agentIdx = 0;
  const agentSlotsCopy = agentsWithSlots.map((a) => ({ ...a }));
  const webhookHandlerDeps = deps.getWebhookHandlerDeps();

  while (assigned < slotsAvailable && assigned < eligible.length) {
    // Find next agent with remaining slots
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

    // Rollback helper — restores card to its original column, assignee, and session
    const rollbackCard = (err) => {
      try {
        deps.stmts.updateKanbanCard.run(
          card.title,
          card.description,
          card.priority,
          card.assignee, // restore original assignee (not agent.name)
          card.labels,
          card.session_id, // restore original session_id (not the new one)
          card.github_issue_url,
          card.pr_url,
          card.epic_id,
          card.id,
        );
        deps.stmts.moveKanbanCard.run(card.column_id, card.position, card.id);
      } catch (rollbackErr) {
        console.error(
          `[Autonomous] Rollback failed for card "${card.title}":`,
          rollbackErr.message,
        );
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
      deps.stmts.incrementCardIterations.run(card.id);

      const sessionId = crypto.randomUUID();
      const engine = agent.engine || 'claude-code';
      deps.stmts.createSession.run(
        sessionId,
        agent.id,
        card.title,
        engine,
        agent.model || defaultModelForEngine(engine),
        1,
        0,
      );

      deps.stmts.updateKanbanCard.run(
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
      deps.stmts.moveKanbanCard.run(inProgressColId || card.column_id, 0, card.id);

      const iteration = (card.autonomous_iterations || 0) + 1;
      const contextLines = [`# Task: ${card.title}`];
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

      // Chain .catch() so async handleChat rejections (CLI spawn fail, timeout, etc.)
      // trigger rollback — without awaiting, so dispatch stays concurrent
      deps
        .handleChat(null, {
          agentId: agent.id,
          sessionId,
          content: contextLines.join('\n'),
          hookSpecificOutput: { sessionTitle: card.title },
        })
        .catch(rollbackCard);

      deps.broadcast({
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
    } catch (err) {
      // Handles synchronous failures before handleChat (e.g. DB write errors)
      rollbackCard(err);
    }
  }

  if (assigned > 0) {
    deps.broadcast({ type: 'kanban_update', projectId });
    console.log(`[Autonomous] Dispatched ${assigned} card(s) for epic "${epic.name}"`);
  }
}

/**
 * Try to dispatch for ALL projects that have an active autonomous epic.
 * Called when any agent finishes work — we don't always know which project freed a slot.
 */
export function tryAutonomousDispatch() {
  for (const projectId of autonomousProjects) {
    runAutonomousLoop(projectId).catch((err) => {
      console.error(`[Autonomous] Dispatch error for "${projectId}":`, err.message);
    });
  }
}

/**
 * Schedule or stop the autonomous safety-net for an epic.
 * The safety net runs every 60s as a fallback — primary dispatch is event-driven.
 */
export function scheduleAutonomousEpic(projectId, epic) {
  const key = epic.id;

  // Stop existing safety-net cron
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

  // Register project as having an active autonomous epic
  autonomousProjects.add(projectId);

  // Safety-net: fallback dispatch every 60s in case an event trigger was missed
  const task = cron.schedule('* * * * *', () => {
    runAutonomousLoop(projectId).catch((err) => {
      console.error(`[Autonomous] Safety-net error for "${epic.name}":`, err.message);
    });
  });
  autonomousCrons.set(key, task);
  console.log(
    `[Autonomous] Activated epic "${epic.name}" for project "${projectId}" (event-driven + 60s safety net)`,
  );

  // Dispatch immediately
  runAutonomousLoop(projectId).catch((err) => {
    console.error(`[Autonomous] Initial dispatch error:`, err.message);
  });
}

// ─── Lead Review ───────────────────────────────────────────────────────────

/**
 * Trigger lead review for a card that just landed in the "Review" column.
 * Works for both automated moves (autoCommitAndPR) and manual drag-and-drop.
 */
export function triggerReviewForCard(cardId, project) {
  const card = deps.stmts.getKanbanCard.get(cardId);
  if (!card) return;

  // Need a PR URL to review — check card's pr_url field
  const prUrl = card.pr_url;
  if (!prUrl) {
    console.log(
      `[Lead Review] Card "${card.title}" moved to Review but has no PR URL — skipping review`,
    );
    return;
  }

  // Find the agent that worked on this card (for context in the review)
  const subAgent = card.assignee ? project.agents.find((a) => a.name === card.assignee) : null;

  console.log(
    `[Lead Review] Card "${card.title}" moved to Review — triggering lead review for ${prUrl}`,
  );
  leadReviewPR(project, prUrl, card, subAgent).catch((err) => {
    const webhookHandlerDeps = deps.getWebhookHandlerDeps();
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

/**
 * Check if the GitHub App is fully configured and has an installation.
 */
function hasGitHubApp() {
  const config = deps.getConfig();
  const app = config.githubApp;
  return !!(app?.appId && app?.privateKey && app?.installationId);
}

/**
 * Build an env object that authenticates as the bot GitHub account.
 * If no bot token is configured, returns undefined (use default auth).
 */
export function botGhEnv() {
  const config = deps.getConfig();
  if (!config.botGithubToken) return undefined;
  return { ...process.env, GH_TOKEN: config.botGithubToken };
}

/**
 * Parse a GitHub PR URL into { owner, repo, number } or null.
 */
export function parsePrUrl(prUrl) {
  const match = prUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

/**
 * Add a reviewer on a PR.
 * Priority: GitHub App (requests review from the app bot) > Bot PAT > default gh CLI user.
 * Silently ignores failures (e.g. same-account, permissions).
 */
export async function addSelfAsReviewer(prUrl) {
  const pr = parsePrUrl(prUrl);
  if (!pr) return;

  // Tier 1: GitHub App — no pre-assigned reviewer needed, the app submits its own review
  if (hasGitHubApp()) {
    const ghAppSlug = deps.getGhAppSlug();
    console.log(
      `[Review] Skipping reviewer assignment for PR #${pr.number} — GitHub App "${ghAppSlug}" will submit its own review`,
    );
    return;
  }

  // Tier 2: Bot PAT or default gh CLI user
  const ghBotUser = deps.getGhBotUser();
  const ghAuthenticatedUser = deps.getGhAuthenticatedUser();
  const reviewerUser = ghBotUser || ghAuthenticatedUser;
  if (!reviewerUser) return;
  try {
    const env = botGhEnv();
    await execFileAsync(
      'gh',
      [
        'pr',
        'edit',
        String(pr.number),
        '--repo',
        `${pr.owner}/${pr.repo}`,
        '--add-reviewer',
        reviewerUser,
      ],
      { timeout: 15000, ...(env && { env }) },
    );
    console.log(
      `[Review] Added ${reviewerUser} as reviewer on PR #${pr.number}${ghBotUser ? ' (bot)' : ''}`,
    );
  } catch (err) {
    // Same-account or permission error — not critical
    console.log(
      `[Review] Could not add reviewer on PR #${pr.number}: ${err.message?.split('\n')[0]}`,
    );
  }
}

/**
 * Submit a formal GitHub review (APPROVE or REQUEST_CHANGES).
 * Priority: GitHub App (installation token) > Bot PAT > default gh CLI auth.
 * Falls back to a labeled comment if all formal review methods fail.
 * Returns true if the formal review succeeded, false if it fell back.
 */
export async function submitGitHubReview(prUrl, event, body) {
  const pr = parsePrUrl(prUrl);
  if (!pr) return false;

  // Tier 1: GitHub App — submit review via installation token (REST API)
  if (hasGitHubApp()) {
    try {
      const config = deps.getConfig();
      const app = config.githubApp;
      await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
        method: 'POST',
        body: { event, body },
        appId: app.appId,
        privateKey: app.privateKey,
        installationId: app.installationId,
      });
      const ghAppSlug = deps.getGhAppSlug();
      console.log(
        `[Review] Formal ${event} review submitted on PR #${pr.number} (via GitHub App: ${ghAppSlug})`,
      );
      return true;
    } catch (err) {
      const ghAppSlug = deps.getGhAppSlug();
      console.log(
        `[Review] GitHub App review failed on PR #${pr.number}: ${err.message?.split('\n')[0]} — trying fallbacks`,
      );
    }
  }

  // Tier 2: Bot PAT or default gh CLI — submit review via gh api command
  const env = botGhEnv();
  const usingBot = !!env;
  const ghBotUser = deps.getGhBotUser();

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
      { timeout: 15000, ...(env && { env }) },
    );
    console.log(
      `[Review] Formal ${event} review submitted on PR #${pr.number}${usingBot ? ` (as bot: ${ghBotUser})` : ''}`,
    );
    return true;
  } catch (err) {
    console.log(
      `[Review] Formal review failed on PR #${pr.number} (${err.message?.split('\n')[0]}) — falling back to comment + labels`,
    );
  }

  // Fallback: add a labeled comment and a PR label so status is visible
  // Still use bot env if available (so the comment comes from the bot account)
  const fallbackOpts = { timeout: 15000, ...(env && { env }) };
  try {
    const label = event === 'APPROVE' ? 'approved' : 'changes-requested';
    const prefix = event === 'APPROVE' ? '✅ **APPROVED**' : '🔄 **CHANGES REQUESTED**';
    const comment = `${prefix}\n\n${body}`;
    // Add comment — uses execFileAsync to avoid shell injection
    await execFileAsync(
      'gh',
      ['pr', 'comment', String(pr.number), '--repo', `${pr.owner}/${pr.repo}`, '--body', comment],
      fallbackOpts,
    );
    // Add label (create if needed, ignore failures)
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
    // Remove opposite label, add current one
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
      `[Review] Fallback: comment + label "${label}" added on PR #${pr.number}${usingBot ? ' (bot)' : ''}`,
    );
    return false;
  } catch (err) {
    console.error(`[Review] Fallback comment also failed on PR #${pr.number}:`, err.message);
    return false;
  }
}

/**
 * Attempt to merge a PR.
 * Priority: GitHub App > Bot PAT > default gh CLI auth.
 * Called as a server-side backup after approval — the agent's own `gh pr merge`
 * may have failed (e.g. same-account can't merge, or merge was already done).
 * Returns true if merged successfully, false otherwise.
 */
export async function mergeApprovedPR(prUrl) {
  const pr = parsePrUrl(prUrl);
  if (!pr) return false;

  // Tier 1: GitHub App — merge via REST API with installation token
  if (hasGitHubApp()) {
    try {
      const config = deps.getConfig();
      const app = config.githubApp;
      await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, {
        method: 'PUT',
        body: { merge_method: 'squash' },
        appId: app.appId,
        privateKey: app.privateKey,
        installationId: app.installationId,
      });
      const ghAppSlug = deps.getGhAppSlug();
      console.log(`[Review] PR #${pr.number} merged via GitHub App (${ghAppSlug})`);
      // Delete branch after merge
      try {
        const prData = await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
          appId: app.appId,
          privateKey: app.privateKey,
          installationId: app.installationId,
        });
        if (prData.head?.ref) {
          await githubApiRequest(
            `/repos/${pr.owner}/${pr.repo}/git/refs/heads/${prData.head.ref}`,
            {
              method: 'DELETE',
              appId: app.appId,
              privateKey: app.privateKey,
              installationId: app.installationId,
            },
          );
        }
      } catch {
        /* branch deletion is best-effort */
      }
      return true;
    } catch (err) {
      const msg = err.message || '';
      if (/already.*merged|405/i.test(msg)) {
        console.log(`[Review] PR #${pr.number} was already merged`);
        return true;
      }
      console.log(
        `[Review] GitHub App merge failed for PR #${pr.number}: ${msg.split('\n')[0]} — trying fallback`,
      );
    }
  }

  // Tier 2: Bot PAT or default gh CLI
  const env = botGhEnv();
  const ghBotUser = deps.getGhBotUser();
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
  } catch (err) {
    const msg = err.message?.split('\n')[0] || '';
    // "already merged" is not an error
    if (/already.*merged|405/i.test(msg)) {
      console.log(`[Review] PR #${pr.number} was already merged`);
      return true;
    }
    console.log(`[Review] Server-side merge of PR #${pr.number} failed: ${msg}`);
    return false;
  }
}

/**
 * Check whether all GitHub CI checks are passing for a PR.
 * Returns { ok: true } if all checks pass, or { ok: false, summary } with failure details.
 */
export async function checkCIPassing(prUrl) {
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
    const checks = JSON.parse(stdout || '[]');
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
  } catch (err) {
    // If we can't determine CI status, fail open with a warning
    console.warn(`[Review] CI check query failed for PR #${pr.number}: ${err.message}`);
    return { ok: true, summary: 'Could not query CI status — proceeding' };
  }
}

/**
 * Check whether a PR has unresolved review comment threads.
 * Returns { ok: true } if no unresolved threads, or { ok: false, count } with the count.
 */
export async function checkResolvedComments(prUrl) {
  const pr = parsePrUrl(prUrl);
  if (!pr) return { ok: false, count: 0, summary: 'Invalid PR URL' };
  const env = botGhEnv();
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
    const data = JSON.parse(stdout || '{}');
    const threads = data.reviewThreads || [];
    const unresolved = threads.filter((t) => !t.isResolved);
    if (unresolved.length > 0) {
      return {
        ok: false,
        count: unresolved.length,
        summary: `${unresolved.length} unresolved review thread(s)`,
      };
    }
    return { ok: true, count: 0, summary: 'All review threads resolved' };
  } catch (err) {
    // Fail open — don't block merge if we can't query threads
    console.warn(`[Review] Review thread query failed for PR #${pr.number}: ${err.message}`);
    return { ok: true, count: 0, summary: 'Could not query review threads — proceeding' };
  }
}

/**
 * Extract a meaningful review body from the agent's final output.
 * Looks for the content the agent passed to `gh pr review --body` or falls back
 * to a trimmed excerpt from the end of the output.
 */
export function extractReviewBody(content, type) {
  if (!content) return type === 'approve' ? 'Looks good — approved.' : 'Changes requested.';

  // Try to extract the body from a gh pr review command the agent ran
  // Use [\s\S]+? (non-greedy) instead of [^"']+ to allow quotes in review text
  const reviewBodyMatch = content.match(/gh pr review.*--body\s+["']([\s\S]+?)["']\s*(?:--|$)/s);
  if (reviewBodyMatch) return reviewBodyMatch[1].trim();

  // Try to extract from gh api command
  const apiBodyMatch = content.match(/-f body=["']([\s\S]+?)["']\s*(?:-|$)/s);
  if (apiBodyMatch) return apiBodyMatch[1].trim();

  // Try to find a structured review comment the agent left
  const commentMatch = content.match(/(?:CHANGES REQUESTED|APPROVED)\*?\*?\s*\n([\s\S]{10,800})/i);
  if (commentMatch) return commentMatch[1].trim().slice(0, 1000);

  // Fall back to tail of output
  const tail = content.slice(-500).trim();
  return tail || (type === 'approve' ? 'Looks good — approved.' : 'Changes requested.');
}

/**
 * Lead agent reviews ANY PR created by an agent. Called after autoCommitAndPR.
 * card may be null for ad-hoc work without a kanban card.
 * Uses formal GitHub review process: adds self as reviewer, instructs agent to use
 * gh pr review, and submits server-side backup review via handleReviewOutcome.
 */
export async function leadReviewPR(project, prUrl, card, subAgent) {
  const leadAgent = project.agents.find((a) => a.role === 'lead');
  if (!leadAgent) return; // No lead — skip review

  // Dedup: check if any review session is already running for this PR URL
  const alreadyReviewing = [...reviewSessionCards.values()].find((r) => r.prUrl === prUrl);
  if (alreadyReviewing) {
    console.log(`[Lead Review] Already reviewing ${prUrl} — skipping`);
    return;
  }

  const config = deps.getConfig();

  // If autoReview is explicitly disabled, skip automatic reviews
  const wfAutoReview = project.githubWorkflow?.autoReview;
  if (wfAutoReview === false) {
    console.log(
      `[Lead Review] Auto-review disabled for project "${project.name}" — skipping review of ${prUrl}`,
    );
    return;
  }

  // If the lead IS the sub-agent, spawn a separate review session (self-review)
  const isSelfReview = subAgent ? leadAgent.id === subAgent.id : false;

  // Check if this card belongs to an autonomous epic
  const isAutonomous = card?.epic_id
    ? !!deps.stmts.getKanbanEpic.get(card.epic_id)?.autonomous
    : false;

  // Resolve GitHub workflow settings — project-level overrides autonomous defaults
  const wf = project.githubWorkflow || {};
  const shouldAutoMerge = wf.autoMerge !== undefined ? wf.autoMerge : isAutonomous;
  const shouldWaitForCI = wf.waitForCI !== undefined ? wf.waitForCI : false;
  const shouldWaitForComments =
    wf.waitForResolvedComments !== undefined ? wf.waitForResolvedComments : false;

  const reviewTitle = card?.title || `PR ${prUrl.match(/\d+$/)?.[0] || ''}`;
  console.log(
    `[Lead Review] Lead "${leadAgent.name}" reviewing PR: ${prUrl}${isSelfReview ? ' (self-review)' : ''}${shouldAutoMerge ? ' (will merge if approved)' : ''}`,
  );

  // Formally add the lead as a reviewer on the PR
  await addSelfAsReviewer(prUrl);

  const sessionId = crypto.randomUUID();
  const engine = leadAgent.engine || 'claude-code';
  deps.stmts.createSession.run(
    sessionId,
    leadAgent.id,
    `Review: ${reviewTitle}`,
    engine,
    leadAgent.model || defaultModelForEngine(engine),
    1,
    0,
  );

  const prNumber = prUrl.match(/\d+$/)?.[0] || '';

  // Build pre-review checks based on workflow settings
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
\`\`\`bash
gh pr view ${prNumber} --json reviewThreads --jq '[.reviewThreads[] | select(.isResolved == false)] | length'
\`\`\`
If there are unresolved review threads (count > 0), do NOT approve until they are resolved.
`;
  }

  // When a bot token is configured, the server handles all formal GitHub actions
  // (approve, request-changes, merge) via the bot account. The agent should only
  // read the diff and report findings — NOT run gh pr review / gh pr merge itself,
  // since those would use the user's personal gh CLI auth.
  const hasBotToken = !!config.botGithubToken;

  const agentReviewStep = hasBotToken
    ? `
### If the code looks good:
Report: **"APPROVED"** — and explain briefly why the code is correct.
The server will submit the formal approval${shouldAutoMerge ? ' and merge' : ''} via the bot account automatically.${!shouldAutoMerge ? '\nNote: Auto-merge is disabled — a human will merge the PR after approval.' : ''}

### If you find issues:
Report: **"CHANGES REQUESTED"** — and list each issue with:
- File path and line number
- What's wrong
- What to do instead

The server will submit the formal "request changes" review via the bot account automatically.

Do **NOT** run \`gh pr review\`, \`gh pr merge\`, or \`gh api\` commands — the server handles all formal GitHub actions through the bot account.`
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

  const mergeRule = hasBotToken
    ? `- **Do NOT check out the branch or edit any code** — you are the reviewer, not the author
- **Do NOT run gh pr review, gh pr merge, or gh api commands** — the server handles all formal GitHub actions via the bot account
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
- When reporting your outcome, clearly state whether you APPROVED or REQUESTED CHANGES with detailed reasoning`;

  // Track card→review session linkage for reliable outcome handling
  reviewSessionCards.set(sessionId, { cardId: card?.id || null, prUrl });

  // Start a 15-minute timeout — if the review session hangs, kill it and free the slot
  startReviewSessionTimeout(sessionId, project.id);

  deps.handleChat(null, {
    agentId: leadAgent.id,
    sessionId,
    content: reviewPrompt,
    hookSpecificOutput: { sessionTitle: `Review: ${reviewTitle}` },
  });

  deps.broadcast({
    type: 'lead_review',
    projectId: project.id,
    prUrl,
    cardTitle: reviewTitle,
    reviewerAgent: leadAgent.name,
    sessionId,
    isSelfReview,
  });
}

// ─── Review Outcome ────────────────────────────────────────────────────────

/**
 * After a lead review session completes, check the outcome.
 * If approved — card stays in Review; it only moves to Done when the PR is
 * actually merged (tracked by handleWebhookPrClosed). The reviewer is
 * instructed to merge as part of their approval, so the merge webhook
 * fires shortly after.
 * If changes requested — send review feedback to the ORIGINAL agent's session
 * so they can fix and push to the same branch/PR (like a real dev flow).
 */
export async function handleReviewOutcome(project, sessionId, finalContent) {
  // Clear the timeout — session completed normally before the 15-min limit
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

    // Find the card linked to this review session — prefer tracked Map, fall back to title match
    const session = deps.stmts.getSession.get(sessionId);
    if (!session) return;

    const titleMatch = session.name?.match(/^Review: (.+)$/);
    if (!titleMatch) return;

    const boardData = getOrCreateBoard(deps.stmts, project.id);
    if (!boardData?.board) return;
    const cols = deps.stmts.getKanbanColumns.all(boardData.board.id);

    // Look up card: first via reviewSessionCards Map (reliable), then title match (fallback)
    let card = null;
    const tracked = reviewSessionCards.get(sessionId);
    if (tracked?.cardId) {
      card = deps.stmts.getKanbanCard.get(tracked.cardId);
    }
    if (!card) {
      const allBoardCards = cols.flatMap((col) => deps.stmts.getKanbanCards.all(col.id));
      card = allBoardCards.find((c) => c.title === titleMatch[1]);
    }
    // Clean up tracking
    reviewSessionCards.delete(sessionId);

    console.log(
      `[Review] Outcome for "${titleMatch[1]}": approved=${approved}, changesRequested=${changesRequested}, mergeFailed=${mergeFailed}, cardFound=${!!card}`,
    );

    // Resolve the PR URL — prefer card's pr_url, fall back to tracked data
    const prUrl = card?.pr_url || tracked?.prUrl;
    const webhookHandlerDeps = deps.getWebhookHandlerDeps();

    // Merge failure takes priority — even if "approved" regex also matched,
    // the PR isn't actually merged and needs conflict resolution
    if (mergeFailed && approved && card) {
      // Approved but merge failed due to conflicts — dispatch to original author to resolve
      console.log(
        `[Review] PR approved but merge failed for "${titleMatch[1]}" — dispatching conflict resolution to author`,
      );

      if (prUrl) {
        // Still submit the approval so GitHub reflects the review state
        const reviewBody = extractReviewBody(finalContent, 'approve');
        submitGitHubReview(prUrl, 'APPROVE', reviewBody).catch((err) => {
          console.error(`[Review] Server-side approval submission failed:`, err.message);
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

      // Move card back to In Progress so the author picks it up
      const inProgressCol = cols.find((c) => c.name === 'In Progress');
      if (inProgressCol) {
        deps.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
        deps.broadcast({ type: 'kanban_update', projectId: project.id });
      }

      dispatchReviewFeedback(webhookHandlerDeps, card, project, conflictMessage);

      deps.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'merge_conflict',
        projectId: project.id,
      });
    } else if (approved) {
      // Submit formal GitHub approval as server-side backup
      // (the agent's gh pr review --approve may have failed due to same-account)
      if (prUrl) {
        const reviewBody = extractReviewBody(finalContent, 'approve');
        submitGitHubReview(prUrl, 'APPROVE', reviewBody).catch((err) => {
          console.error(`[Review] Server-side approval submission failed:`, err.message);
        });

        // Respect workflow toggles — only merge if enabled and preconditions are met
        const wf = project.githubWorkflow || {};
        const isAutonomous = card?.epic_id
          ? !!deps.stmts.getKanbanEpic.get(card.epic_id)?.autonomous
          : false;
        const shouldAutoMerge = wf.autoMerge !== undefined ? wf.autoMerge : isAutonomous;
        const shouldWaitForCI = wf.waitForCI !== undefined ? wf.waitForCI : false;
        const shouldWaitForComments =
          wf.waitForResolvedComments !== undefined ? wf.waitForResolvedComments : false;

        if (shouldAutoMerge) {
          // Server-side merge backup — if the agent's own `gh pr merge` failed
          // (e.g. same-account limitation, timeout, or bot token needed), try again here.
          // First, verify preconditions if the respective toggles are on.
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
            mergeApprovedPR(prUrl).catch((err) => {
              console.error(`[Review] Server-side merge attempt failed:`, err.message);
            });
          }
        } else {
          console.log(
            `[Review] Auto-merge disabled — skipping server-side merge for "${titleMatch[1]}"`,
          );
        }
      }

      // Card stays in Review — it only moves to Done when the PR is actually merged
      // (handled by handleWebhookPrClosed). The lead's merge command or
      // human merge will trigger the webhook which moves the card to Done.
      console.log(
        `[Review] Card "${titleMatch[1]}" approved — waiting for PR merge to move to Done`,
      );

      deps.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'approved',
        projectId: project.id,
      });
    } else if (changesRequested && card) {
      // Submit formal GitHub "request changes" review as server-side backup
      if (prUrl) {
        const reviewBody = extractReviewBody(finalContent, 'request_changes');
        submitGitHubReview(prUrl, 'REQUEST_CHANGES', reviewBody).catch((err) => {
          console.error(`[Review] Server-side request-changes submission failed:`, err.message);
        });
      }

      // Send review feedback to the responsible agent (existing session or new one)
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

      // Move card back to In Progress
      const inProgressCol = cols.find((c) => c.name === 'In Progress');
      if (inProgressCol) {
        deps.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
        deps.broadcast({ type: 'kanban_update', projectId: project.id });
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

      deps.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'changes_requested',
        projectId: project.id,
      });
    } else {
      // Neither regex matched — ambiguous outcome. Do NOT auto-approve.
      // Flag for human review instead of making a dangerous assumption.
      console.warn(
        `[Review] Ambiguous outcome for "${titleMatch[1]}" — neither approved nor changes_requested matched. Flagging for human review. Content tail: ${finalContent.slice(-200)}`,
      );

      // Post a comment on the PR so the human knows action is needed
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
          ]).catch((err) => {
            console.error(`[Review] Failed to post ambiguous-review comment on PR:`, err.message);
          });
        }
      }

      // Add a comment to the kanban card if one exists
      if (card) {
        try {
          deps.stmts.addKanbanComment.run(
            crypto.randomUUID(),
            card.id,
            'system',
            '⚠️ Review outcome was ambiguous — flagged for human review. No auto-approve or merge was attempted.',
          );
        } catch (_e) {
          // Non-critical — just logging
        }
      }

      // Card stays in Review — human must decide
      console.log(
        `[Review] Card "${titleMatch[1]}" flagged for human review — no auto-approve or merge attempted`,
      );

      deps.broadcast({
        type: 'lead_review_complete',
        sessionId,
        outcome: 'ambiguous',
        projectId: project.id,
      });
    }

    // Clean up the review session — it's a transient artifact, not worth keeping
    try {
      const reviewSession = deps.stmts.getSession.get(sessionId);
      if (reviewSession?.worktree_path) {
        removeWorkspace(reviewSession.worktree_path);
      }
      deps.stmts.deleteSession.run(sessionId);
      deps.broadcast({ type: 'session_deleted', sessionId, projectId: project.id });
      console.log(`[Review] Cleaned up review session ${sessionId}`);
    } catch (cleanupErr) {
      console.error(`[Review] Failed to clean up review session:`, cleanupErr.message);
    }
  } catch (err) {
    console.error(`[Review] Outcome handling failed:`, err.message);
  }
}

// ─── Startup Restoration ───────────────────────────────────────────────────

/**
 * Restore autonomous crons on server startup.
 */
export function restoreAutonomousCrons() {
  const projects = deps.getProjects();
  for (const project of projects) {
    try {
      const boardData = getOrCreateBoard(deps.stmts, project.id);
      if (!boardData?.board) continue;
      const epic = deps.stmts.getAutonomousEpic.get(boardData.board.id);
      if (epic) {
        scheduleAutonomousEpic(project.id, epic);
      }
    } catch (err) {
      console.error(
        `[Autonomous] Failed to restore cron for project "${project.id}":`,
        err.message,
      );
    }
  }
}

// ─── Review Polling Fallback ───────────────────────────────────────────────
// Periodic check for cards in "Review" or "In Progress" that have open PRs with
// unaddressed review comments. Catches anything the webhook might have missed
// (e.g., webhook delivery failures, server downtime during comment arrival).

export function startReviewPollingFallback() {
  if (reviewPollCron) return;

  // Run once immediately on startup to catch reviews missed during downtime
  setTimeout(async () => {
    try {
      console.log('[ReviewPoll] Running initial startup reconciliation...');
      await reconcileKanbanWithGitHub();
      await pollForMissedReviews();
      console.log('[ReviewPoll] Startup reconciliation complete');
    } catch (err) {
      console.error('[ReviewPoll] Startup reconciliation error:', err.message);
    }
  }, 10_000); // 10s delay to let WebSocket clients reconnect first

  // Then run every 3 minutes as a safety net for missed webhooks
  reviewPollCron = cron.schedule('*/3 * * * *', async () => {
    try {
      await reconcileKanbanWithGitHub();
      await pollForMissedReviews();
    } catch (err) {
      console.error('[ReviewPoll] Polling error:', err.message);
    }
  });
  console.log('[ReviewPoll] Fallback polling started (every 3 minutes)');
}

/**
 * Reconcile kanban cards with GitHub PR state.
 *
 * Catches three gaps the webhook system misses:
 * 1. Cards whose pr_url points at a superseded PR (closed, then a new PR was
 *    opened and merged — but the card never got updated).
 * 2. Cards that were created after their PR was already merged, so the webhook
 *    event fired before the card existed.
 * 3. Cards with a session_id but no pr_url — discovers the PR by searching
 *    GitHub for the session's worktree branch and auto-links it.
 *
 * Scans all non-Done columns, auto-links missing pr_urls, checks PR state via
 * `gh api`, and moves merged-PR cards to Done.
 */
async function reconcileKanbanWithGitHub() {
  const projects = deps.getProjects();

  for (const project of projects) {
    const boardData = getOrCreateBoard(deps.stmts, project.id);
    if (!boardData?.board) continue;

    const cols = deps.stmts.getKanbanColumns.all(boardData.board.id);
    const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
    if (!doneCol) continue;

    // Derive repo full name from project.github or fall back to webhook config
    let repoFullName = project.github?.repo || null;
    if (!repoFullName) {
      const webhookConfigs = deps.stmts.getWebhookConfigsByProject?.all(project.id);
      const repoUrl = webhookConfigs?.[0]?.repo_url;
      if (repoUrl) {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (match) repoFullName = `${match[1]}/${match[2]}`;
      }
    }
    if (!repoFullName) continue;

    // Check all non-Done columns for cards.
    // API calls are sequential per card — fine at current scale but could be
    // parallelized with Promise.all if board sizes grow significantly.
    const nonDoneCols = cols.filter((c) => c.id !== doneCol.id);
    for (const col of nonDoneCols) {
      const cards = deps.stmts.getKanbanCardsByColumn.all(col.id);
      for (const card of cards) {
        // ── Pass 1: Auto-discover pr_url for cards with session but no PR link ──
        if (!card.pr_url && card.session_id) {
          try {
            const session = deps.stmts.getSession?.get(card.session_id);
            const branch = session?.worktree_branch;
            if (branch) {
              const { stdout } = await execFileAsync(
                'gh',
                [
                  'api',
                  `repos/${repoFullName}/pulls?head=${repoFullName.split('/')[0]}:${branch}&state=all`,
                  '--jq',
                  'first | {url: .html_url, state: .state, merged: .merged} // empty',
                ],
                { timeout: 15000 },
              );

              if (stdout.trim()) {
                const pr = JSON.parse(stdout.trim());
                if (pr.url) {
                  deps.stmts.setCardPrUrl.run(pr.url, card.id);
                  card.pr_url = pr.url;
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

        // ── Pass 2: Check pr_url state and move merged cards to Done ──
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

          const pr = JSON.parse(stdout.trim());

          if (pr.state === 'closed' && pr.merged) {
            // PR is merged — move card to Done
            deps.stmts.moveKanbanCard.run(doneCol.id, 0, card.id);
            deps.broadcast({ type: 'kanban_update', projectId: project.id });
            console.log(
              `[Reconcile] PR #${prNumber} already merged — card "${card.title}" moved to Done`,
            );

            // Free up a slot for the next autonomous card
            tryAutonomousDispatch();
          } else if (pr.state === 'closed' && !pr.merged) {
            // PR was closed without merge — leave the card for manual triage.
            console.log(
              `[Reconcile] PR #${prNumber} closed without merge — card "${card.title}" left for triage`,
            );
          }
        } catch (err) {
          console.debug(`[Reconcile] Skipping PR #${prNumber}: ${err.message}`);
        }
      }
    }
  }
}

async function pollForMissedReviews() {
  const projects = deps.getProjects();
  const activeProcesses = deps.getActiveProcesses();
  const ghAuthenticatedUser = deps.getGhAuthenticatedUser();
  const webhookHandlerDeps = deps.getWebhookHandlerDeps();

  for (const project of projects) {
    const boardData = getOrCreateBoard(deps.stmts, project.id);
    if (!boardData?.board) continue;

    const cols = deps.stmts.getKanbanColumns.all(boardData.board.id);
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');
    if (!reviewCol && !inProgressCol) continue;

    // We iterate both Review and In Progress columns to detect PR state, but
    // only dispatch for cards in "Review" — cards already in "In Progress" are
    // being actively worked on, so re-dispatching would be redundant/disruptive.
    const targetCols = [reviewCol, inProgressCol].filter(Boolean);
    for (const col of targetCols) {
      const cards = deps.stmts.getKanbanCardsByColumn.all(col.id);
      for (const card of cards) {
        if (!card.pr_url) continue;

        // Skip cards that already have an active process running
        if (card.session_id && activeProcesses.has(card.session_id)) continue;

        // Extract PR number and repo from the URL
        const prMatch = card.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (!prMatch) continue;

        const [, repoFullName, prNumber] = prMatch;

        try {
          // Fetch CHANGES_REQUESTED reviews with their IDs so we can deduplicate
          const { stdout } = await new Promise((resolve, reject) => {
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
          const reviews = JSON.parse(stdout.trim() || '[]');

          // Filter out reviews we've already dispatched for this card
          const lastDispatched = lastDispatchedReviewId.get(card.id);
          const newReviews = lastDispatched
            ? reviews.filter((r) => r.id > lastDispatched)
            : reviews;

          if (newReviews.length > 0 && col === reviewCol) {
            // Card is in Review with new "changes_requested" reviews — was likely missed
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

            // Move to In Progress
            if (inProgressCol && card.column_id !== inProgressCol.id) {
              deps.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
              deps.broadcast({ type: 'kanban_update', projectId: project.id });
            }

            dispatchReviewFeedback(webhookHandlerDeps, card, project, feedbackMessage);

            // Record the latest review ID so we don't re-dispatch on next poll
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
