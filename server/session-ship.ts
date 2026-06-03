import { v4 as uuidv4 } from 'uuid';
import type { ChildProcess } from 'child_process';
import type {
  Agent,
  AgentLookup,
  BroadcastFn,
  MessageRow,
  Project,
  SessionRow,
  Stmts,
} from './types.js';
import { loadSkillByName } from './skill-invoke.js';
import { resolveWorkspaceSkillsDir } from './project-paths.js';
import { getProjectMode } from './project-mode.js';
import { isResolvePrSessionTitle } from './session-title-pr.js';
import {
  FINALIZE_AUTOMATION_ASSIGNED_DEFAULT,
  type FinalizeAutomationLevel,
} from './finalize/automation.js';
import { worktreeHasFinalizeCi } from './finalize/worktree-has-ci.js';

export const SHIP_SKILL_ID = 'create-ticket-and-pr';

export type SessionShipSource = 'manual' | 'auto_session_end';

/** Shown in chat as a system callout; not sent to the CLI as a user turn. */
export const SHIP_SYSTEM_MESSAGE = 'Create ticket & PR';
export const SHIP_AUTO_SYSTEM_MESSAGE = 'Shipping automatically';

/** Instruction passed to the model on the ship turn (skill body is in pending context). */
export const SHIP_CLI_PROMPT =
  'The operator requested Create ticket & PR. Follow the loaded skill: create or reuse a kanban card, commit, push, and open a pull request with summary and test plan.';

/** Card-assignment / autonomous session end — agent must rebase before push. */
export const SHIP_AUTO_CLI_PROMPT =
  'This session ended with publishable work (card assignment or autonomous dispatch). Follow the loaded create-ticket-and-pr skill now: fetch origin, rebase onto the project base branch and resolve conflicts, run checks, commit if needed, then push and open or update the PR. Never push before integrating remote changes — rebase first. Move the linked kanban card to Review when done.';

const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;
const SHIP_PR_POLL_MS = 2_000;
const SHIP_PR_POLL_TIMEOUT_MS = 120_000;

export function buildShipRequestedMetadata(source: SessionShipSource = 'manual'): string {
  return JSON.stringify({
    kind: 'ship_requested',
    skillId: SHIP_SKILL_ID,
    ...(source === 'auto_session_end' ? { auto: true } : {}),
  });
}

export function parseShipRequestedMetadata(metadataString: string | null | undefined): {
  kind: 'ship_requested';
  skillId: string;
  auto?: boolean;
} | null {
  if (metadataString == null) return null;
  let parsed: unknown;
  try {
    parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.kind !== 'ship_requested') return null;
  return {
    kind: 'ship_requested',
    skillId: typeof row.skillId === 'string' ? row.skillId : SHIP_SKILL_ID,
    ...(row.auto === true ? { auto: true } : {}),
  };
}

export interface TriggerSessionShipArgs {
  sessionId: string;
  session: SessionRow;
  project: Project;
  agent: Agent;
  stmts: Stmts;
  broadcast: BroadcastFn;
  activeProcesses: Map<string, ChildProcess>;
  source?: SessionShipSource;
  handleChat: (
    ws: null,
    msg: {
      type: 'chat';
      agentId: string;
      sessionId: string;
      content: string;
      _skipUserMessagePersist?: boolean;
    },
  ) => Promise<void>;
}

export type TriggerSessionShipResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code?: string };

/** Prevents duplicate POST /ship or double auto-ship before handleChat registers activeProcesses. */
const sessionsWithShipInFlight = new Set<string>();

/** Test-only reset for in-flight ship guard. */
export function resetShipInFlightForTests(): void {
  sessionsWithShipInFlight.clear();
}

/** Clear persisted changes_ready and notify clients once a PR exists (skill or server path). */
export function clearChangesReadyAndNotifyPrCreated(args: {
  sessionId: string;
  agentId: string;
  stmts: Pick<Stmts, 'clearSessionChangesReady'>;
  broadcast: BroadcastFn;
  prUrl: string;
  cardTitle?: string | null;
}): void {
  try {
    args.stmts.clearSessionChangesReady.run(args.sessionId);
  } catch (err) {
    console.warn(
      `[session-ship] clearSessionChangesReady failed for ${args.sessionId}:`,
      (err as Error).message,
    );
  }
  args.broadcast({
    type: 'auto_pr_created',
    sessionId: args.sessionId,
    agentId: args.agentId,
    prUrl: args.prUrl,
    cardTitle: args.cardTitle ?? undefined,
  });
}

interface ShipPrDetectionResult {
  prUrl: string;
  cardTitle?: string | null;
}

function parsePrUrlFromMetadata(metadataString: string | null | undefined): string | null {
  if (!metadataString) return null;
  try {
    const parsed = JSON.parse(metadataString) as Record<string, unknown>;
    if (
      parsed.kind === 'pr_created' &&
      typeof parsed.prUrl === 'string' &&
      parsed.prUrl.length > 0
    ) {
      return parsed.prUrl;
    }
  } catch {
    return null;
  }
  return null;
}

function detectSessionPrUrl(stmts: Stmts, sessionId: string): ShipPrDetectionResult | null {
  const card = stmts.getKanbanCardBySession.get(sessionId) as
    | { pr_url?: string | null; title?: string | null }
    | undefined;
  if (typeof card?.pr_url === 'string' && card.pr_url.length > 0) {
    return { prUrl: card.pr_url, cardTitle: card.title ?? null };
  }

  const messages = stmts.getMessages.all(sessionId) as MessageRow[];
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    const fromMetadata = parsePrUrlFromMetadata(message.metadata);
    if (fromMetadata) return { prUrl: fromMetadata };
    const fromContent = message.content.match(GITHUB_PR_URL_RE)?.[0];
    if (fromContent) return { prUrl: fromContent };
  }
  return null;
}

async function pollForSessionPrUrl(args: {
  stmts: Stmts;
  sessionId: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ShipPrDetectionResult | null> {
  const timeoutMs = args.timeoutMs ?? SHIP_PR_POLL_TIMEOUT_MS;
  const intervalMs = args.intervalMs ?? SHIP_PR_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const detected = detectSessionPrUrl(args.stmts, args.sessionId);
    if (detected) return detected;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export function triggerSessionShip(args: TriggerSessionShipArgs): TriggerSessionShipResult {
  const {
    sessionId,
    session,
    project,
    agent,
    stmts,
    broadcast,
    activeProcesses,
    handleChat,
    source = 'manual',
  } = args;
  const isAuto = source === 'auto_session_end';
  const systemMessage = isAuto ? SHIP_AUTO_SYSTEM_MESSAGE : SHIP_SYSTEM_MESSAGE;
  const cliPrompt = isAuto ? SHIP_AUTO_CLI_PROMPT : SHIP_CLI_PROMPT;
  const skillReason = isAuto ? 'auto-session-end' : 'create-ticket-pr-button';

  if (getProjectMode(project) === 'workflow') {
    return {
      ok: false,
      status: 403,
      error: 'Session PR creation is disabled while this project is in workflow mode',
      code: 'workflow_mode',
    };
  }

  if (activeProcesses.has(sessionId) || sessionsWithShipInFlight.has(sessionId)) {
    return {
      ok: false,
      status: 409,
      error: sessionsWithShipInFlight.has(sessionId)
        ? 'Create ticket & PR is already in progress for this session'
        : 'Session is still streaming — wait for the agent to finish before creating a PR',
      code: sessionsWithShipInFlight.has(sessionId) ? 'ship_in_progress' : 'session_streaming',
    };
  }

  if (isResolvePrSessionTitle(session.name)) {
    return {
      ok: false,
      status: 409,
      error:
        'This session is a Resolve PR session — push fixes to the existing PR rather than opening a new one.',
      code: 'resolve_pr_session',
    };
  }

  if (!session.worktree_path) {
    return {
      ok: false,
      status: 400,
      error: 'Session has no worktree — nothing to commit',
      code: 'no_worktree',
    };
  }

  if (worktreeHasFinalizeCi(session.worktree_path)) {
    return {
      ok: false,
      status: 409,
      error:
        'This project uses Finalize Code Changes (.agent-hub/ci.yaml). Use **Finalize Code Changes** on the session instead of Create ticket & PR.',
      code: 'finalize_configured',
    };
  }

  const skillsDir = resolveWorkspaceSkillsDir(project, agent);
  const injection = loadSkillByName({
    name: SHIP_SKILL_ID,
    reason: skillReason,
    paths: { skillsDir },
    sessionId,
    stmts,
    broadcast,
  });
  if (!injection.trim() || injection.includes('## Skill Load Error')) {
    return {
      ok: false,
      status: 404,
      error: `Skill "${SHIP_SKILL_ID}" is not available for this project`,
      code: 'skill_not_found',
    };
  }

  stmts.updateSessionPendingSkillContext.run(injection, sessionId);

  const msgId = uuidv4();
  const metadata = buildShipRequestedMetadata(source);
  try {
    stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      systemMessage,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
    stmts.touchSession.run(sessionId);
    const inserted =
      (stmts.getMessageById.get(msgId) as MessageRow | undefined) ??
      ({
        id: msgId,
        session_id: sessionId,
        role: 'system',
        content: systemMessage,
        engine: null,
        model: null,
        attachments: null,
        metadata,
        created_at: new Date().toISOString(),
      } satisfies MessageRow);
    broadcast({ type: 'message', message: inserted });
  } catch (err) {
    console.error('[session-ship] Failed to persist system message:', (err as Error).message);
  }

  sessionsWithShipInFlight.add(sessionId);

  void handleChat(null, {
    type: 'chat',
    agentId: session.agent_id,
    sessionId,
    content: cliPrompt,
    _skipUserMessagePersist: true,
  })
    .then(() => {
      void pollForSessionPrUrl({ stmts, sessionId }).then((detected) => {
        if (!detected) return;
        clearChangesReadyAndNotifyPrCreated({
          sessionId,
          agentId: session.agent_id,
          stmts,
          broadcast,
          prUrl: detected.prUrl,
          cardTitle: detected.cardTitle ?? null,
        });
      });
    })
    .catch((err: Error) => {
      console.error(`[session-ship] handleChat failed for session ${sessionId}:`, err.message);
      const errorText = `Failed to start ship workflow: ${err.message}`;
      broadcast({
        type: 'error',
        sessionId,
        message: errorText,
      });
      try {
        const msgId = uuidv4();
        const metadata = JSON.stringify({
          kind: 'pr_failed',
          code: 'pr_failed',
          error: err.message,
          agentName: agent.name,
        });
        const content = `Auto-PR failed (pr_failed): ${errorText}`;
        stmts.addMessage.run(
          msgId,
          sessionId,
          'system',
          content,
          null,
          null,
          null,
          metadata,
          null,
          null,
          null,
        );
        const inserted =
          (stmts.getMessageById.get(msgId) as MessageRow | undefined) ??
          ({
            id: msgId,
            session_id: sessionId,
            role: 'system',
            content,
            engine: null,
            model: null,
            attachments: null,
            metadata,
            created_at: new Date().toISOString(),
          } satisfies MessageRow);
        broadcast({ type: 'message', message: inserted });
        broadcast({
          type: 'auto_pr_failed',
          sessionId,
          agentId: session.agent_id,
          code: 'pr_failed',
          error: err.message,
        });
      } catch (persistErr: unknown) {
        const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
        console.warn(`[session-ship] Failed to persist pr_failed marker: ${msg}`);
      }
    })
    .finally(() => {
      sessionsWithShipInFlight.delete(sessionId);
    });

  return { ok: true };
}

export function markSessionAutoShipOnComplete(stmts: Stmts, sessionId: string): void {
  try {
    stmts.updateSessionAutoShipOnComplete.run(1, sessionId);
  } catch (err) {
    console.warn(
      `[session-ship] updateSessionAutoShipOnComplete failed for ${sessionId}:`,
      (err as Error).message,
    );
  }
}

export function markSessionFinalizeAutomation(
  stmts: Stmts,
  sessionId: string,
  level: FinalizeAutomationLevel = FINALIZE_AUTOMATION_ASSIGNED_DEFAULT,
): void {
  try {
    stmts.updateSessionFinalizeAutomation.run(level, sessionId);
  } catch (err) {
    console.warn(
      `[session-ship] updateSessionFinalizeAutomation failed for ${sessionId}:`,
      (err as Error).message,
    );
  }
}

/** One-shot guard: clear after auto-ship is triggered so turn-end does not loop. */
export function clearSessionAutoShipOnComplete(stmts: Stmts, sessionId: string): void {
  try {
    stmts.updateSessionAutoShipOnComplete.run(0, sessionId);
  } catch (err) {
    console.warn(
      `[session-ship] clearSessionAutoShipOnComplete failed for ${sessionId}:`,
      (err as Error).message,
    );
  }
}

/** Card-assignment / autonomous sessions auto-ship at session end; ad-hoc sessions wait for the button. */
export function shouldAutoShipSessionAtEnd(
  session: SessionRow | undefined,
  card: { dispatched_by_autonomous?: number | null } | undefined,
): boolean {
  if (session && Number(session.auto_ship_on_complete) === 1) return true;
  if (card && Number(card.dispatched_by_autonomous) === 1) return true;
  return false;
}
