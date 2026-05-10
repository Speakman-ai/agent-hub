import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateBoard } from './routes/board.js';
import { notifyDispatchFailure, dispatchReviewFeedback } from './routes/webhooks.js';
import { createEscalation } from './routes/escalations.js';
import {
  lastDispatchedReviewId,
  recordDispatchedChangesRequestedReview,
} from './review-feedback-dedup.js';
import { defaultModelForEngine } from './config.js';
import { loadBoardBlockers, hasUnresolvedBlockers, isColumnDone } from './kanban-blockers.js';
import { pickAgentForCard, pickLead } from './routing.js';
import type {
  Stmts,
  Project,
  Agent,
  KanbanEpicRow,
  KanbanCardRow,
  KanbanColumnRow,
  AppConfig,
  BroadcastFn,
  ChatMessage,
  SessionRow,
} from './types.js';
import { defaultSessionUseWorktreeFlag } from './project-mode.js';
import { setSessionOwner, getOrgOwnerUserId } from './session-ownership.js';
import { cardNeedsDevHubKey, getDevHubApiKey } from './secrets.js';

const execFileAsync = promisify(execFile);

// ─── Umbrella feature-branch management ────────────────────────────────────
//
// When an autonomous run kicks off, we create a single shared feature branch
// (e.g. `feature/autonomous-{epicId8}-{uuid8}`) on the remote and store it
// as `epic.pr_base_branch`. Every worktree spawned for that run branches FROM
// it, and every PR targets it — so the whole run lands as one coherent unit
// rather than a spray of PRs directly onto main.
//
// Lifecycle:
//   1. First dispatch tick with eligible cards AND `pr_base_branch` is null or
//      starts with our `feature/autonomous-` prefix (stale branch from a
//      previous completed run) → create a fresh umbrella branch.
//   2. Operator-set custom `pr_base_branch` (doesn't start with our prefix) →
//      always respected, never overwritten or cleared.
//   3. Run completes (all epic cards Done) → log the umbrella branch name so
//      the operator knows to open a final PR, but leave `pr_base_branch` set
//      so the next run creates a fresh one automatically (it'll detect the
//      stale `feature/autonomous-` prefix).

const AUTONOMOUS_BRANCH_PREFIX = 'feature/autonomous-';

/**
 * Creates an umbrella feature branch on the remote rooted at the current
 * remote HEAD (main/master). Returns the branch name on success, null on any
 * failure (caller falls back to PR-to-main behaviour).
 *
 * Exported for unit testing.
 */
export async function createUmbrellaBranch(
  project: Project,
  epic: KanbanEpicRow,
): Promise<string | null> {
  const cwd = project.cwd;
  if (!cwd) return null;

  const epicShort = epic.id.replace(/-/g, '').substring(0, 8);
  const runShort = crypto.randomUUID().replace(/-/g, '').substring(0, 8);
  const branchName = `${AUTONOMOUS_BRANCH_PREFIX}${epicShort}-${runShort}`;

  try {
    // Fetch to ensure remote refs are current (shallow ok — we just need the SHA).
    await execFileAsync('git', ['fetch', 'origin', '--depth=1'], { cwd, timeout: 30_000 });

    // Resolve the remote HEAD SHA. Try symbolic-ref first (fastest), then
    // fall back to explicit branch names used by most repos.
    let sha: string | null = null;
    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', ref], { cwd, timeout: 5_000 });
        sha = stdout.trim();
        if (sha) break;
      } catch {
        // try next candidate
      }
    }

    if (!sha) {
      console.warn(
        `[Autonomous] Cannot resolve remote HEAD for project "${project.name}" — umbrella branch skipped, PRs will target default branch`,
      );
      return null;
    }

    // Push the SHA directly as the new branch — no local checkout needed.
    await execFileAsync('git', ['push', 'origin', `${sha}:refs/heads/${branchName}`], {
      cwd,
      timeout: 30_000,
    });

    console.log(
      `[Autonomous] ✅ Created umbrella branch "${branchName}" for epic "${epic.name}" (base SHA: ${sha.substring(0, 7)})`,
    );
    return branchName;
  } catch (err) {
    console.error(
      `[Autonomous] Failed to create umbrella branch for epic "${epic.name}": ${(err as Error).message} — PRs will target default branch`,
    );
    return null;
  }
}

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
let reviewPollCron: cron.ScheduledTask | null = null;

// ─── Injected dependencies (set via init()) ────────────────────────────────
let deps: AutonomousDeps | null = null;

function getDeps(): AutonomousDeps {
  if (!deps) throw new Error('autonomous: initAutonomous() must be called before use');
  return deps;
}

/** Model for a new autonomous session: epic override when valid for the agent's engine, else agent default. */
function sessionModelForAutonomousDispatch(
  epic: KanbanEpicRow,
  agent: Agent,
  engineValidModels: Record<string, string[]>,
): string {
  const engine = agent.engine || 'claude-code';
  const raw = typeof epic.autonomous_model === 'string' ? epic.autonomous_model.trim() : '';
  if (raw) {
    const allowed = engineValidModels[engine] || [];
    if (allowed.includes(raw)) return raw;
  }
  return agent.model || defaultModelForEngine(engine);
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

  const colsForDoneCheck = d.stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];
  const colNameByIdForEpic = Object.fromEntries(colsForDoneCheck.map((c) => [c.id, c.name]));
  const allEpicCardsForDone = d.stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
  const epicWorkComplete =
    allEpicCardsForDone.length > 0 &&
    allEpicCardsForDone.every((c) => isColumnDone(colNameByIdForEpic[c.column_id]));

  if (epicWorkComplete && epic.autonomous) {
    // If we created the umbrella branch for this run, notify the operator
    // that it's ready for a final PR to main.
    if (epic.pr_base_branch?.startsWith(AUTONOMOUS_BRANCH_PREFIX)) {
      console.log(
        `[Autonomous] 🎉 Epic "${epic.name}" complete — umbrella branch "${epic.pr_base_branch}" is ready. Open a PR from it to merge all changes into main.`,
      );
    }

    d.stmts.updateKanbanEpic.run(
      epic.name,
      epic.description,
      epic.color,
      0,
      epic.autonomous_interval,
      epic.autonomous_max_concurrent,
      epic.autonomous_max_iterations,
      epic.autonomous_model ?? null,
      epic.orchestration_budgets_json ?? null,
      // Keep the umbrella branch on the epic record so the operator can see
      // which branch to PR from. The next run will detect the
      // `feature/autonomous-` prefix and create a fresh one.
      epic.pr_base_branch ?? null,
      epic.id,
    );
    const clearedEpic = d.stmts.getKanbanEpic.get(epic.id) as KanbanEpicRow;
    scheduleAutonomousEpic(projectId, clearedEpic);
    d.broadcast({ type: 'kanban_update', projectId });
    console.log(`[Autonomous] Epic "${epic.name}" — all cards are Done; autonomous mode disabled`);
    return;
  }

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

  // ── Umbrella feature branch ─────────────────────────────────────────────
  // Create a shared feature branch for this autonomous run if one hasn't
  // been set by the operator (custom base) or was not yet created.
  // Condition: pr_base_branch is null  → definitely a fresh run
  //            pr_base_branch starts with our prefix → stale branch from a
  //              previous completed run; create a fresh one for this run.
  // If the operator set a custom value (no prefix match) we leave it alone.
  const needsUmbrella =
    !epic.pr_base_branch || epic.pr_base_branch.startsWith(AUTONOMOUS_BRANCH_PREFIX);

  if (needsUmbrella) {
    const umbrellaBranch = await createUmbrellaBranch(project, epic);
    if (umbrellaBranch) {
      // Persist to DB so every card dispatched in this (and future ticks of
      // this) run inherits the branch via `effectivePrBaseBranch()`.
      d.stmts.updateKanbanEpic.run(
        epic.name,
        epic.description,
        epic.color,
        epic.autonomous,
        epic.autonomous_interval,
        epic.autonomous_max_concurrent,
        epic.autonomous_max_iterations,
        epic.autonomous_model ?? null,
        epic.orchestration_budgets_json ?? null,
        umbrellaBranch,
        epic.id,
      );
      // Mutate the in-memory epic so cards dispatched in THIS tick also see it.
      epic.pr_base_branch = umbrellaBranch;
      d.broadcast({ type: 'kanban_update', projectId });
    }
  }
  // ───────────────────────────────────────────────────────────────────────

  // Label-based routing: every eligible card is dispatchable. The intake
  // ("ticketing") agent stamps labels at card-creation time; we route to
  // the first specialist whose id/role/name matches a label, falling back
  // to the project lead (which can implement directly or `<handoff>`).
  const dispatchable = eligible;

  const activeProcesses = d.getActiveProcesses();
  const agentSessionCounts = new Map<string, number>();
  for (const [sid] of activeProcesses) {
    const session = d.stmts.getSession.get(sid) as { agent_id: string } | undefined;
    if (session)
      agentSessionCounts.set(session.agent_id, (agentSessionCounts.get(session.agent_id) || 0) + 1);
  }

  // Reviewer/docs/intake are out-of-band roles — never autonomously assigned.
  // Leads are always assignable: they can implement directly or `<handoff>`
  // to a specialist, and they're the right safety net when a project's
  // `subAgents` list is stale or empty.
  const roleFiltered = project.agents.filter(
    (a) => a.role !== 'docs' && a.role !== 'intake' && a.role !== 'reviewer',
  );
  const leadAgent = project.agents.find((a) => a.role === 'lead');
  const allLeads = project.agents.filter((a) => a.role === 'lead');
  let assignableAgents: Agent[];
  if (leadAgent && leadAgent.subAgents?.length) {
    const resolvedSubAgents = leadAgent.subAgents
      .map((sa) => {
        const saId = typeof sa === 'string' ? sa : (sa as { id: string }).id;
        return project.agents.find((a) => a.id === saId) || d.findAgent(saId)?.agent;
      })
      .filter((a): a is Agent => !!a);
    // Union of resolved subAgents and all leads, deduped by id.
    const byId = new Map<string, Agent>();
    for (const a of [...resolvedSubAgents, ...allLeads]) byId.set(a.id, a);
    assignableAgents = Array.from(byId.values());
    // Stale/unresolved subAgent IDs and no leads in the project → fall back
    // to the role-filter so a misconfigured roster doesn't strand the loop.
    if (assignableAgents.length === 0) {
      assignableAgents = roleFiltered;
    }
  } else {
    assignableAgents = roleFiltered;
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
  // Per-agent cap = epic-wide cap. Any single agent may absorb up to the
  // epic's `autonomous_max_concurrent` cards in flight at once — there is no
  // implicit `ceil(max_concurrent / agentCount)` partition that previously
  // forced each agent to ~1 card when agentCount > max_concurrent. The
  // epic-wide ceiling (`slotsAvailable`, computed below from In Progress +
  // Review card counts) remains the only global gate on dispatch volume.
  const perAgentLimit = epic.autonomous_max_concurrent;

  interface AgentSlot {
    agent: Agent;
    active: number;
    slots: number;
  }

  const agentsWithSlots: AgentSlot[] = assignableAgents
    .map((a) => {
      const active = agentSessionCounts.get(a.id) || 0;
      return { agent: a, active, slots: Math.max(0, perAgentLimit - active) };
    })
    .filter((a) => a.slots > 0);
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
  const agentSlotsCopy = agentsWithSlots.map((a) => ({ ...a }));
  const webhookHandlerDeps = d.getWebhookHandlerDeps();

  // Routing pool for `pickAgentForCard`:
  //   - The project lead is treated as fallback-only; it never matches as a
  //     specialist. Even when the dispatcher's `assignableAgents` includes
  //     the lead (no-subAgents projects), we strip it from the routing
  //     pool here so a card labelled "lead" doesn't accidentally land on
  //     the lead via id/role-match.
  //   - The lead's slot count comes from `agentSlotsCopy` if it's already
  //     in the assignable pool, otherwise from a synthetic per-agent cap so
  //     the lead can absorb overflow on subAgents-scoped projects too. The
  //     synthetic cap mirrors `perAgentLimit` (= epic.autonomous_max_concurrent)
  //     so a fallback lead isn't artificially capped at one overflow card.
  const lead = pickLead(project);
  const slotsByAgentId = new Map<string, number>();
  for (const slot of agentSlotsCopy) {
    slotsByAgentId.set(slot.agent.id, slot.slots);
  }
  const routingPool = agentSlotsCopy.map((s) => s.agent).filter((a) => !lead || a.id !== lead.id);
  if (lead && !slotsByAgentId.has(lead.id)) {
    slotsByAgentId.set(lead.id, perAgentLimit);
  }

  while (assigned < slotsAvailable && assigned < dispatchable.length) {
    const card = dispatchable[assigned];

    const picked = pickAgentForCard({
      card,
      assignableAgents: routingPool,
      lead: lead ?? null,
      ctx: { slotsByAgentId },
    });
    if (!picked) break;

    const agent = picked;
    // Decrement bookkeeping. Pool members also decrement their per-agent
    // slot in `agentSlotsCopy` so the caps stay enforced across the loop;
    // an out-of-pool lead only decrements the synthetic slots map.
    const poolIdx = agentSlotsCopy.findIndex((s) => s.agent.id === agent.id);
    if (poolIdx >= 0) agentSlotsCopy[poolIdx].slots--;
    slotsByAgentId.set(agent.id, (slotsByAgentId.get(agent.id) ?? 1) - 1);

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
          card.assign_model,
          card.pr_base_branch ?? null,
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
      const cfg = d.getConfig();
      const engineValidModels = cfg.engineValidModels || {};
      const cardRaw = typeof card.assign_model === 'string' ? card.assign_model.trim() : '';
      let model: string;
      if (cardRaw) {
        const allowed = engineValidModels[engine] || [];
        model = allowed.includes(cardRaw)
          ? cardRaw
          : sessionModelForAutonomousDispatch(epic, agent, engineValidModels);
      } else {
        model = sessionModelForAutonomousDispatch(epic, agent, engineValidModels);
      }
      const projRow = d.findProject(projectId);
      const wt = defaultSessionUseWorktreeFlag(projRow);
      d.stmts.createSession.run(sessionId, agent.id, card.title, engine, model, wt, 0, 1);
      // Autonomous-dispatch sessions are created by the system (no
      // human caller in scope); attribute them to the org owner so the
      // single-tenant operator can see them in their session list.
      setSessionOwner(sessionId, getOrgOwnerUserId());
      {
        const row = d.stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (row) {
          d.broadcast({ type: 'session_created', agentId: agent.id, session: row });
        }
      }

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
        card.assign_model,
        card.pr_base_branch ?? null,
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

      // Scoped cross-hub secret injection: only cards that carry an opt-in
      // label (`cross-hub:dev` or `survey-tracker`) receive `DEV_HUB_API_KEY`
      // in their spawn environment. The fetch is best-effort — if Secrets
      // Manager is unreachable the session starts without the key and the
      // error is logged via the TOOL_ERROR pattern (see server/secrets.ts).
      const extraEnv: Record<string, string> = {};
      if (cardNeedsDevHubKey(card.labels)) {
        const devHubKey = await getDevHubApiKey();
        if (devHubKey) {
          extraEnv.DEV_HUB_API_KEY = devHubKey;
        }
      }

      d.handleChat(null, {
        type: 'chat',
        agentId: agent.id,
        sessionId,
        content: contextLines.join('\n'),
        hookSpecificOutput: { sessionTitle: card.title },
        ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
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

  const task = cron.schedule(
    '* * * * *',
    wrapCronTick(
      () =>
        runAutonomousLoop(projectId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Autonomous] Safety-net error for "${epic.name}":`, msg);
        }),
      `autonomous:${projectId}`,
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds('* * * * *'),
      name: `autonomous:${projectId}`,
    }),
  );
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

  reviewPollCron = cron.schedule(
    '*/3 * * * *',
    wrapCronTick(async () => {
      try {
        await reconcileKanbanWithGitHub();
        await pollForMissedReviews();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[ReviewPoll] Polling error:', msg);
      }
    }, 'review-poll'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds('*/3 * * * *'),
      name: 'review-poll',
    }),
  );
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
 * Scans cards in **Review** and **In Progress** (author work often lives there
 * after a `changes_requested` webhook moves the card). For each card with a
 * PR URL, compares GitHub `CHANGES_REQUESTED` review ids to
 * `lastDispatchedReviewId` (also updated when the webhook path dispatches and
 * the user message is actually persisted). New ids are pushed through
 * `dispatchReviewFeedback`.
 *
 * Exported for Vitest; production only schedules this via `startReviewPollingFallback`.
 */
export async function pollForMissedReviews(): Promise<void> {
  const d = getDeps();
  const projects = d.getProjects();
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

    const seenCardIds = new Set<string>();
    const cardsToScan: KanbanCardRow[] = [];
    for (const col of [reviewCol, inProgressCol].filter(Boolean) as Array<(typeof cols)[0]>) {
      for (const c of d.stmts.getKanbanCardsByColumn.all(col.id) as KanbanCardRow[]) {
        if (seenCardIds.has(c.id)) continue;
        seenCardIds.add(c.id);
        cardsToScan.push(c);
      }
    }

    for (const card of cardsToScan) {
      if (!card.pr_url) continue;

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

          const result = await dispatchReviewFeedback(
            webhookHandlerDeps,
            card,
            project,
            feedbackMessage,
          );
          if (result.userMessagePersisted) {
            const latestId = Math.max(...newReviews.map((r) => r.id));
            recordDispatchedChangesRequestedReview(card.id, latestId);
          }
        }
      } catch {
        // gh CLI not available or API error — skip silently
      }
    }
  }
}
