import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateBoard } from './routes/board.js';
import { notifyDispatchFailure, dispatchReviewFeedback } from './routes/webhooks.js';
import { createEscalation } from './routes/escalations.js';
import { defaultModelForEngine } from './config.js';
import { loadBoardBlockers, hasUnresolvedBlockers } from './kanban-blockers.js';
import { pickTriageAgent, buildTriagePromptContext } from './triage.js';
import type {
  Stmts,
  Project,
  Agent,
  KanbanEpicRow,
  KanbanCardRow,
  AppConfig,
  BroadcastFn,
  ChatMessage,
  SessionRow,
} from './types.js';
import { defaultSessionUseWorktreeFlag } from './project-mode.js';

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
 * Cap the number of concurrent triage sessions per project. Triage is cheap
 * (one back-and-forth that emits a JSON block) but we still don't want a
 * freshly-enabled epic with 50 cards to spawn 50 intake sessions at once.
 *
 * Enforcement lives in `runTriageBatchForProject`: each tick counts the
 * currently-locked triage cards (via `getInFlightTriageCards`, intersected
 * with the live process set) and only spawns up to
 * `TRIAGE_MAX_CONCURRENT - inFlight` new sessions. The cap therefore
 * applies project-wide across ticks, not just within a single tick.
 */
const TRIAGE_MAX_CONCURRENT = 3;
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
    // Even when nothing is dispatchable, we still want to opportunistically
    // pull untriaged cards through triage so the next pass has triaged work
    // ready to go.
    runTriageBatchForProject(projectId, epic).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Triage] Batch error for "${epic.name}":`, msg);
    });
    return;
  }

  // Triage gate: only cards with `triaged_at != null` are dispatchable. The
  // remainder are routed to the project's intake/lead for triage. We only
  // enforce the gate when the project actually has a triage-capable agent —
  // otherwise older projects (no intake, no lead) would silently halt.
  const triageAgent = pickTriageAgent(project);
  let dispatchable: KanbanCardRow[];
  let untriaged: KanbanCardRow[] = [];
  if (triageAgent) {
    dispatchable = [];
    for (const c of eligible) {
      if (c.triaged_at && Number(c.triaged_at) > 0) {
        dispatchable.push(c);
      } else {
        untriaged.push(c);
      }
    }
    if (untriaged.length > 0) {
      console.log(
        `[Triage] ${untriaged.length} untriaged card(s) for epic "${epic.name}" — routing to ${triageAgent.name} (\`${triageAgent.id}\`)`,
      );
      runTriageBatchForProject(projectId, epic).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Triage] Batch error for "${epic.name}":`, msg);
      });
    }
  } else {
    // No intake or lead agent — skip gating entirely so existing flows keep
    // working. Operators add an intake agent to opt into triage routing.
    dispatchable = eligible;
  }

  if (dispatchable.length === 0) {
    console.log(
      `[Autonomous] No dispatchable cards for epic "${epic.name}" — ${untriaged.length} awaiting triage`,
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

  while (assigned < slotsAvailable && assigned < dispatchable.length) {
    const card = dispatchable[assigned];

    // Assignee preference — when triage tagged the card with a
    // `suggested_assignee` and that agent has an open slot, route to that
    // agent. Falls back to round-robin when the suggested agent is missing,
    // out of slots, or not in the assignable pool.
    let pickedIdx = -1;
    if (card.suggested_assignee) {
      pickedIdx = agentSlotsCopy.findIndex(
        (s) => s.agent.id === card.suggested_assignee && s.slots > 0,
      );
    }
    if (pickedIdx < 0) {
      for (let tries = 0; tries < agentSlotsCopy.length; tries++) {
        const idx = (agentIdx + tries) % agentSlotsCopy.length;
        if (agentSlotsCopy[idx].slots > 0) {
          pickedIdx = idx;
          break;
        }
      }
    }
    if (pickedIdx < 0) break;

    const agent = agentSlotsCopy[pickedIdx].agent;
    agentSlotsCopy[pickedIdx].slots--;
    // Round-robin cursor only advances when WE didn't honor an explicit
    // assignee — that way the next un-routed card still rotates fairly.
    if (!card.suggested_assignee || agent.id !== card.suggested_assignee) {
      agentIdx = (pickedIdx + 1) % agentSlotsCopy.length;
    }

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

// ─── Triage Batch ──────────────────────────────────────────────────────────
//
// Pulls untriaged eligible cards in this epic and spawns intake sessions
// (capped at TRIAGE_MAX_CONCURRENT in flight per project). The triage agent
// emits an <agenthub:triage> block at end of turn; chat.ts post-stream
// applies the block via applyTriageResult, which stamps `triaged_at` and
// hands the card back to the dispatcher for the next pass.
//
// Best-effort: failures rollback card state but do NOT throw.
export async function runTriageBatchForProject(
  projectId: string,
  epic: KanbanEpicRow,
): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const triageAgent = pickTriageAgent(project);
  if (!triageAgent) return; // Project has no intake or lead — triage disabled.

  const untriaged = d.stmts.getUntriagedAutonomousCards.all(
    epic.id,
    epic.autonomous_max_iterations,
  ) as KanbanCardRow[];
  if (untriaged.length === 0) return;

  // In-flight triage sessions are cards locked to a still-running triage
  // session: assignee = triage agent name, session_id non-null, triaged_at
  // null. The dedicated `getInFlightTriageCards` query is required because
  // `getUntriagedAutonomousCards` filters on `assignee IS NULL` and so
  // EXCLUDES every card that has already been locked — querying it for
  // in-flight triage rows would always return zero. We then cross-reference
  // session_id against activeProcesses to ignore stale locks left behind by
  // crashed sessions; survivors count toward the project-wide cap.
  const activeProcesses = d.getActiveProcesses();
  const lockedRows = d.stmts.getInFlightTriageCards.all(epic.id, triageAgent.name) as Array<{
    id: string;
    session_id: string | null;
  }>;
  let inFlight = 0;
  for (const row of lockedRows) {
    if (row.session_id && activeProcesses.has(row.session_id)) {
      inFlight++;
    }
  }
  const slotsAvailable = Math.max(0, TRIAGE_MAX_CONCURRENT - inFlight);
  if (slotsAvailable === 0) {
    console.log(
      `[Triage] Cap reached (${inFlight}/${TRIAGE_MAX_CONCURRENT}) for project "${project.name}" — waiting`,
    );
    return;
  }

  // Specialists offered to the intake agent: anyone other than docs/intake/
  // reviewer roles. The intake agent picks one of these as the assignee.
  const specialists = (project.agents || []).filter(
    (a) => a.role !== 'docs' && a.role !== 'intake' && a.role !== 'reviewer',
  );

  let spawned = 0;
  for (const card of untriaged) {
    if (spawned >= slotsAvailable) break;

    // Defense in depth: every row from `getUntriagedAutonomousCards` already
    // has assignee IS NULL and session_id IS NULL, so this branch should
    // never fire. We still guard against it in case the query semantics
    // change in the future or the row is mutated between SELECT and here.
    if (
      card.session_id &&
      activeProcesses.has(card.session_id) &&
      card.assignee === triageAgent.name
    ) {
      continue;
    }

    try {
      const sessionId = crypto.randomUUID();
      const engine = triageAgent.engine || 'claude-code';
      // Triage runs at the agent's default model — per-card / per-epic
      // model overrides only apply to the specialist that picks the card up
      // after triage, not to triage itself.
      const model = triageAgent.model || defaultModelForEngine(engine);
      const projRow = d.findProject(projectId);
      const wt = defaultSessionUseWorktreeFlag(projRow);

      d.stmts.createSession.run(
        sessionId,
        triageAgent.id,
        `Triage: ${card.title}`,
        engine,
        model,
        wt,
        0,
        1,
      );
      const row = d.stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (row) d.broadcast({ type: 'session_created', agentId: triageAgent.id, session: row });

      // Lock the card to the triage session: assignee = intake agent name,
      // session_id = triage session. setCardTriage clears both when triage
      // applies, so the dispatcher can pick the card up cleanly afterward.
      d.stmts.updateKanbanCard.run(
        card.title,
        card.description,
        card.priority,
        triageAgent.name,
        card.labels,
        sessionId,
        card.github_issue_url,
        card.pr_url,
        card.epic_id,
        card.assign_model,
        card.id,
      );

      const seedPrompt = buildTriagePromptContext({ card, specialists });
      d.handleChat(null, {
        type: 'chat',
        agentId: triageAgent.id,
        sessionId,
        content: seedPrompt,
        hookSpecificOutput: { sessionTitle: `Triage: ${card.title}` },
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Triage] handleChat failed for card "${card.title}":`, msg);
        // Best-effort rollback: clear the lock so the next pass retries.
        try {
          d.stmts.updateKanbanCard.run(
            card.title,
            card.description,
            card.priority,
            null,
            card.labels,
            null,
            card.github_issue_url,
            card.pr_url,
            card.epic_id,
            card.assign_model,
            card.id,
          );
        } catch {
          /* best-effort */
        }
      });

      d.broadcast({
        type: 'kanban_update',
        projectId,
      });
      spawned++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Triage] Failed to spawn for card "${card.title}":`, msg);
    }
  }

  if (spawned > 0) {
    console.log(
      `[Triage] Spawned ${spawned} session(s) for epic "${epic.name}" (cap ${TRIAGE_MAX_CONCURRENT}, in-flight ${inFlight})`,
    );
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

  // One-shot triage pass: when autonomous mode is FIRST enabled (or
  // re-enabled after being off), run triage across every untriaged eligible
  // card in this epic before dispatch starts. Dispatch will also run, but
  // it will skip untriaged cards on this first pass and pick them up on
  // subsequent ticks once the intake agent has emitted triage blocks.
  runTriageBatchForProject(projectId, epic).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Triage] Initial batch error for "${epic.name}":`, msg);
  });

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
