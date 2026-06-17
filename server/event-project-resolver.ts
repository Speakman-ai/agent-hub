/**
 * Resolve a WebSocket broadcast payload to a project id.
 *
 * The WS broadcast in `websocket.ts` fans every event out to every
 * connected client. Without filtering, a user can receive events about
 * a private project they do not own (e.g. an Electron banner fires off
 * a `done` event for a private project belonging to someone else).
 *
 * This module provides a pure-ish helper that inspects a broadcast
 * payload and returns the projectId the event is "about", so the
 * broadcast filter can call `canViewProject` per recipient before
 * sending. Resolution is best-effort:
 *
 *   1. Explicit `projectId` on the payload — most domain events already
 *      include it (kanban_update, workflow_run, capture_*, thread_*).
 *   2. `sessionId` → `sessions.agent_id` → `agents.project_id` via the
 *      project model.
 *   3. `cardId` → `kanban_cards.board_id` → `kanban_boards.project_id`.
 *   4. `agentId` → `agents.project_id` (direct).
 *
 * Returns `null` when nothing maps. Callers SHOULD treat `null` as
 * "unresolvable, fan out globally" so the filter never silently swallows
 * events whose project model we don't know about yet (e.g. ad-hoc system
 * messages). A more aggressive deny-on-unresolved policy would block
 * legitimate broadcasts and is the wrong default — visibility is the
 * narrow exception, not the rule.
 *
 * All db lookups are wrapped in try/catch so a missing/dropped table
 * (test harness, mid-boot) collapses to `null` instead of throwing into
 * the broadcast hot path.
 */

import { stmts, getDb } from './db.js';
import { findAgent } from './project-model.js';

/**
 * Minimal shape of a broadcast payload. We only ever read string fields
 * so the filter is robust to unknown event types.
 */
export interface BroadcastEvent {
  type?: string;
  projectId?: unknown;
  sessionId?: unknown;
  cardId?: unknown;
  agentId?: unknown;
  // Other fields are intentionally untyped — the resolver only consumes
  // the ids above.
  [key: string]: unknown;
}

/**
 * Dependency surface so tests can swap out the db / project-model calls
 * without instantiating the full server. Production callers pass
 * `undefined` and the resolver falls back to the singleton `stmts` /
 * `findAgent` imports.
 */
export interface EventProjectResolverDeps {
  /** Returns the `agent_id` for a session row, or null. */
  getSessionAgentId?: (sessionId: string) => string | null;
  /** Returns the `board_id` for a card row, or null. */
  getCardBoardId?: (cardId: string) => string | null;
  /** Returns the `project_id` for a board row, or null. */
  getBoardProjectId?: (boardId: string) => string | null;
  /** Returns the `project_id` for an agent id, or null. */
  getAgentProjectId?: (agentId: string) => string | null;
}

function safeString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function defaultGetSessionAgentId(sessionId: string): string | null {
  try {
    if (!stmts) return null;
    const row = stmts.getSession.get(sessionId) as { agent_id?: string } | undefined;
    return row?.agent_id ?? null;
  } catch {
    return null;
  }
}

function defaultGetCardBoardId(cardId: string): string | null {
  try {
    if (!stmts) return null;
    const row = stmts.getKanbanCard.get(cardId) as { board_id?: string } | undefined;
    return row?.board_id ?? null;
  } catch {
    return null;
  }
}

function defaultGetBoardProjectId(boardId: string): string | null {
  // No dedicated prepared statement — boards are tiny and looked up
  // rarely enough that an ad-hoc prepare on the singleton db is fine.
  // Growing `stmts` for a single privacy-filter use case is overkill.
  try {
    const db = getDb();
    const row = db.prepare('SELECT project_id FROM kanban_boards WHERE id = ?').get(boardId) as
      | { project_id?: string }
      | undefined;
    return row?.project_id ?? null;
  } catch {
    return null;
  }
}

function defaultGetAgentProjectId(agentId: string): string | null {
  try {
    const lookup = findAgent(agentId);
    return lookup?.project.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Inspect a broadcast payload and return the projectId it is "about",
 * or `null` if we cannot resolve one. See module header for the policy.
 */
export function resolveProjectIdFromEvent(
  data: BroadcastEvent | null | undefined,
  deps?: EventProjectResolverDeps,
): string | null {
  if (!data || typeof data !== 'object') return null;

  // 1. Explicit projectId — fast path.
  const explicit = safeString(data.projectId);
  if (explicit) return explicit;

  const getSessionAgentId = deps?.getSessionAgentId ?? defaultGetSessionAgentId;
  const getCardBoardId = deps?.getCardBoardId ?? defaultGetCardBoardId;
  const getBoardProjectId = deps?.getBoardProjectId ?? defaultGetBoardProjectId;
  const getAgentProjectId = deps?.getAgentProjectId ?? defaultGetAgentProjectId;

  // 2. sessionId / session_id -> agent -> project.
  const sessionId = safeString(data.sessionId) ?? safeString(data.session_id);
  if (sessionId) {
    const agentId = getSessionAgentId(sessionId);
    if (agentId) {
      const projectId = getAgentProjectId(agentId);
      if (projectId) return projectId;
    }
  }

  // 3. cardId -> board -> project. Used by `card_moved`, `dispatch_failure`,
  //    `webhook_pr_merged`, etc. when the upstream payload didn't include
  //    a projectId itself.
  const cardId = safeString(data.cardId);
  if (cardId) {
    const boardId = getCardBoardId(cardId);
    if (boardId) {
      const projectId = getBoardProjectId(boardId);
      if (projectId) return projectId;
    }
  }

  // 4. agentId -> project. Last-resort direct hop for events whose only
  //    identifier is an agent.
  const agentId = safeString(data.agentId);
  if (agentId) {
    const projectId = getAgentProjectId(agentId);
    if (projectId) return projectId;
  }

  return null;
}
