import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateBoard } from './routes/board.js';
import { notifyDispatchFailure, dispatchReviewFeedback } from './routes/webhooks.js';
import { createEscalation } from './routes/escalations.js';
import { defaultModelForEngine } from './config.js';
import { loadBoardBlockers, hasUnresolvedBlockers } from './kanban-blockers.js';
import type {
  Stmts,
  Project,
  Agent,
  KanbanEpicRow,
  KanbanCardRow,
  AppConfig,
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

// ─── Module-level state ────────────────────────────────────────────────────
const autonomousCrons = new Map<string, cron.ScheduledTask>();
const autonomousProjects = new Set<string>();
/**
 * Tracks the highest GitHub review id we've already dispatched feedback for,
 * keyed by kanban card id. Used by `pollForMissedReviews` so we don't re-dispatch
 * the same `changes_requested` review when webhook delivery is missed.
 */
const lastDispatchedReviewId = new Map<string, number>();
let reviewPollCron: cron.ScheduledTask | null = null;

// ─── Injected dependencies (set via init()) ────────────────────────────────
let deps: AutonomousDeps | null = null;

function getDeps(): AutonomousDeps {
  if (!deps) throw new Error('autonomous: initAutonomous() must be called before use');
  return deps;
}

export function initAutonomous(d: AutonomousDeps): void {
  deps = d;
}

// ─── Getters for shared state (used by index.ts) ───────────────────────────

export { autonomousCrons, autonomousProjects, lastDispatchedReviewId };

// ─── Core Dispatch ─────────────────────────────────────────────────────────

export async function runAutonomousLoop(projectId: string): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return;

  const epic = d.stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
  if (!epic) return;

  const rawEligible = d.stmts.getEligibleAutonomousCards.all(
    epic.id,
    epic.autonomous_max_iterations,
  ) as KanbanCardRow[];

  // Filter out cards whose blockers aren't all Done. We log each skip so
  // operators can see WHY autonomous mode isn't picking up a card that
  // otherwise matches the SQL eligibility criteria.
  const blockerIndex = loadBoardBlockers(d.stmts, boardData.board.id);
  const eligible: KanbanCardRow[] = [];
  for (const card of rawEligible) {
    if (hasUnresolvedBlockers(card.id, blockerIndex)) {
      const unresolved = (blockerIndex.blockersByCard.get(card.id) ?? [])
        .filter((b) => !b.done)
        .map((b) => b.title);
      console.log(
        `[Autonomous] Skipping "${card.title}" — blocked by ${unresolved.length} unresolved card(s): ${unresolved.join(', ')}`,
      );
      continue;
    }
    eligible.push(card);
  }

  if (eligible.length === 0) {
    console.log(
      `[Autonomous] No eligible cards for epic "${epic.name}" (all assigned, done, blocked, or at max iterations)`,
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
    // Reviewer/docs/intake are out-of-band roles — never autonomously assigned.
    assignableAgents = project.agents.filter(
      (a) => a.role !== 'docs' && a.role !== 'intake' && a.role !== 'reviewer',
    );
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

// ─── Polling Fallback ──────────────────────────────────────────────────────
//
// The webhook handler is the primary path for both:
//   • dispatching the Reviewer agent on PR opened/synchronize
//   • dispatching changes_requested feedback to the original session
//
// This polling cron is a safety net for missed webhook deliveries. It:
//   1. reconciles merged PRs back to the Done column (`reconcileKanbanWithGitHub`)
//   2. catches `changes_requested` reviews we never received a webhook for
//      (`pollForMissedReviews`)

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

/**
 * Lowercased merge states GitHub returns when a PR cannot cleanly merge into
 * its base. `dirty` means textual conflicts; `behind` means the head is behind
 * a protected base that requires strict status checks. Both are "blocked until
 * human (or agent) reconciles the branch" from our perspective.
 *
 * Note: `mergeable_state` is a docs-level REST field — GitHub does not
 * formally commit to its set of values, but the ones we care about have been
 * stable for years. We treat anything else (clean, blocked, unstable, …) as
 * not-our-problem-for-this-check.
 */
const DIRTY_MERGE_STATES = new Set(['dirty', 'behind']);

/**
 * Does this PR need a merge-conflict escalation? True when GitHub has already
 * computed a merge state AND that state is known-dirty. We intentionally
 * return false when `mergeable` is `null` (GitHub hasn't finished the async
 * computation yet) so the next poll cycle catches it once the state lands.
 */
export function isPrMergeDirty(pr: {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}): boolean {
  if (pr.mergeable === false) return true;
  const state = typeof pr.mergeable_state === 'string' ? pr.mergeable_state.toLowerCase() : null;
  return state !== null && DIRTY_MERGE_STATES.has(state);
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
              '{state: .state, merged: .merged, mergeable: .mergeable, mergeable_state: .mergeable_state, html_url: .html_url}',
            ],
            { timeout: 15000 },
          );

          const pr = JSON.parse(stdout.trim()) as {
            state: string;
            merged: boolean;
            mergeable: boolean | null;
            mergeable_state: string | null;
            html_url: string | null;
          };

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
          } else if (pr.state === 'open' && isPrMergeDirty(pr)) {
            // GitHub does NOT emit a webhook when PR A merges and dirties PR B
            // (the base changed, not the head). The only way to detect this
            // failure mode is to poll GET /pulls/:n and inspect mergeable /
            // mergeable_state. See `handleWebhookPrSynchronize` in
            // server/routes/webhooks.ts — this branch mirrors its escalation
            // behavior so the polling path surfaces the conflict in the UI.
            const prNum = Number.parseInt(prNumber, 10);
            const existing = d.stmts.getRecentEscalationByTypeAndPr?.get(
              project.id,
              'merge_conflict',
              prNum,
            );
            if (!existing) {
              createEscalation(
                { stmts: d.stmts, broadcast: d.broadcast },
                {
                  projectId: project.id,
                  type: 'merge_conflict',
                  title: `Merge conflicts on PR #${prNum}`,
                  description: `PR "${card.title}" has merge conflicts detected by the reconciliation poller (mergeable=${pr.mergeable}, mergeable_state=${pr.mergeable_state}). Rebase or merge the base branch to resolve.`,
                  prNumber: prNum,
                  prUrl: pr.html_url || card.pr_url,
                  cardId: card.id,
                  source: 'poller',
                },
              );
              console.log(
                `[Reconcile] PR #${prNumber} is DIRTY (${pr.mergeable_state}) — escalation created for card "${card.title}"`,
              );
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.debug(`[Reconcile] Skipping PR #${prNumber}: ${msg}`);
        }
      }
    }
  }
}

/**
 * Catch `changes_requested` reviews where the GitHub webhook was missed.
 * For each project's Review-column cards with PRs, look at the most recent
 * `CHANGES_REQUESTED` review on the PR. If we've never dispatched feedback
 * for a review id higher than what we've already seen, push it through the
 * standard `dispatchReviewFeedback` path.
 *
 * Note: this used to also dispatch the lead-review pipeline for "orphan"
 * cards in Review without an active review session. That path is no longer
 * needed — review now fires from the GitHub webhook on every push, not from
 * card movement.
 */
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
    if (!reviewCol) continue;

    const cards = d.stmts.getKanbanCardsByColumn.all(reviewCol.id) as KanbanCardRow[];
    for (const card of cards) {
      if (!card.pr_url) continue;
      if (card.session_id && activeProcesses.has(card.session_id)) continue;

      const prMatch = card.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      if (!prMatch) continue;
      const [, repoFullName, prNumber] = prMatch;

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
          ? reviews.filter((r) => r.id > Number(lastDispatched))
          : reviews;

        if (newReviews.length > 0) {
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
   git add -A
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
