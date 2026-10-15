/**
 * Fact collection for `my_work` chat digests: the user's current state
 * (running sessions, open cards, open todos) plus what they did in a window.
 */
import os from 'os';
import { HUB_ASSISTANT_AGENT_ID, HUB_SESSION_MODE } from '../shared/utils/hub.js';
import { getDb } from './db.js';
import { buildMyWork } from './me-dashboard.js';
import { listTodos } from './user-todos-store.js';
import { ensureHubProject } from './hub-assistant.js';
import type { Project } from './types.js';
import type { VisibilityCaller } from './project-visibility.js';

const MAX_SESSIONS = 20;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 280;
const MAX_CARDS = 20;
const MAX_TODOS = 20;
const MAX_RUNNING = 15;

export interface DailySummarySessionFact {
  id: string;
  name: string;
  agentId: string;
  sessionMode: string;
  kind: 'hub' | 'project';
  updatedAt: string;
}

export interface DailySummaryMessageFact {
  sessionId: string;
  sessionName: string;
  kind: 'hub' | 'project';
  content: string;
  createdAt: string;
}

export interface DailySummaryCardFact {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  columnName: string;
  isDone: boolean;
  updatedAt: string;
}

export interface DailySummaryTodoFact {
  id: string;
  title: string;
  status: 'open' | 'done';
  updatedAt: string;
}

export interface DailySummaryRunningFact {
  sessionId: string;
  sessionName: string;
  agentId: string;
  kind: 'hub' | 'project';
  mine: boolean;
  startedAt: string;
}

function sessionKind(agentId: string, sessionMode: string): 'hub' | 'project' {
  return agentId === HUB_ASSISTANT_AGENT_ID || sessionMode === HUB_SESSION_MODE ? 'hub' : 'project';
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function inWindow(raw: string, timeMin: string, timeMax: string): boolean {
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const t = Date.parse(normalized);
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  return !Number.isNaN(t) && t >= min && t < max;
}

interface SessionRow {
  id: string;
  name: string;
  agent_id: string;
  session_mode: string;
  updated_at: string;
}

interface MessageRow {
  session_id: string;
  session_name: string;
  agent_id: string;
  session_mode: string;
  content: string;
  created_at: string;
}

interface RunningRow {
  session_id: string;
  session_name: string;
  agent_id: string;
  session_mode: string;
  owner_user_id: string | null;
  started_at: string;
}

function toSessionFact(row: SessionRow): DailySummarySessionFact {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    sessionMode: row.session_mode,
    kind: sessionKind(row.agent_id, row.session_mode),
    updatedAt: row.updated_at,
  };
}

function queryOwnedSessions(
  userId: string,
  timeMin: string,
  timeMax: string,
): DailySummarySessionFact[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, agent_id, session_mode, updated_at
       FROM sessions
       WHERE owner_user_id = ?
         AND deleted_at IS NULL
         AND datetime(updated_at) >= datetime(?)
         AND datetime(updated_at) < datetime(?)
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(userId, timeMin, timeMax, MAX_SESSIONS) as SessionRow[];
  return rows.map(toSessionFact);
}

function queryUserMessages(
  userId: string,
  timeMin: string,
  timeMax: string,
): DailySummaryMessageFact[] {
  const rows = getDb()
    .prepare(
      `SELECT m.session_id AS session_id, s.name AS session_name, s.agent_id AS agent_id,
              s.session_mode AS session_mode, m.content AS content, m.created_at AS created_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE s.owner_user_id = ?
         AND s.deleted_at IS NULL
         AND m.role = 'user'
         AND datetime(m.created_at) >= datetime(?)
         AND datetime(m.created_at) < datetime(?)
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(userId, timeMin, timeMax, MAX_MESSAGES) as MessageRow[];
  return rows.map((row) => ({
    sessionId: row.session_id,
    sessionName: row.session_name,
    kind: sessionKind(row.agent_id, row.session_mode),
    content: truncate(row.content, MAX_MESSAGE_CHARS),
    createdAt: row.created_at,
  }));
}

function queryRunning(userId: string): DailySummaryRunningFact[] {
  // Only the caller's own running sessions. The daily summary is a personal
  // "my work" report — other users' in-flight sessions must never leak in.
  const rows = getDb()
    .prepare(
      `SELECT at.session_id AS session_id, s.name AS session_name, s.agent_id AS agent_id,
              s.session_mode AS session_mode, s.owner_user_id AS owner_user_id,
              at.started_at AS started_at
       FROM active_tasks at
       JOIN sessions s ON s.id = at.session_id
       WHERE at.status = 'running'
         AND s.deleted_at IS NULL
         AND s.owner_user_id = ?
       ORDER BY at.started_at ASC
       LIMIT ?`,
    )
    .all(userId, MAX_RUNNING) as RunningRow[];
  return rows.map((row) => ({
    sessionId: row.session_id,
    sessionName: row.session_name,
    agentId: row.agent_id,
    kind: sessionKind(row.agent_id, row.session_mode),
    mine: true,
    startedAt: row.started_at,
  }));
}

function toCardFact(card: {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  columnName: string;
  isDone: boolean;
  updatedAt: string;
}): DailySummaryCardFact {
  return {
    id: card.id,
    title: card.title,
    projectId: card.projectId,
    projectName: card.projectName,
    columnName: card.columnName,
    isDone: card.isDone,
    updatedAt: card.updatedAt,
  };
}

export interface MyWorkWindowFacts {
  running: DailySummaryRunningFact[];
  openCards: DailySummaryCardFact[];
  openTodos: DailySummaryTodoFact[];
  sessions: DailySummarySessionFact[];
  messages: DailySummaryMessageFact[];
  cards: DailySummaryCardFact[];
  doneTodos: DailySummaryTodoFact[];
}

/**
 * The daily summary's facts over an arbitrary window instead of today and
 * yesterday: the current state (running sessions, open cards, open todos)
 * plus what the user did in `[timeMin, timeMax)`. Feeds `my_work` digests.
 */
export function collectMyWorkWindowFacts(input: {
  userId: string;
  caller: VisibilityCaller;
  getProjects: () => Project[];
  timeMin: string;
  timeMax: string;
}): MyWorkWindowFacts {
  const { userId, timeMin, timeMax } = input;
  const work = buildMyWork({ getProjects: input.getProjects }, userId, input.caller);
  const cards = work.cards.map(toCardFact);
  const todos = listTodos(userId);
  const todoFact = (t: (typeof todos)[number]): DailySummaryTodoFact => ({
    id: t.id,
    title: t.title,
    status: t.status,
    updatedAt: t.updatedAt,
  });
  return {
    running: queryRunning(userId),
    openCards: cards.filter((c) => !c.isDone).slice(0, MAX_CARDS),
    openTodos: todos
      .filter((t) => t.status === 'open')
      .slice(0, MAX_TODOS)
      .map(todoFact),
    sessions: queryOwnedSessions(userId, timeMin, timeMax),
    messages: queryUserMessages(userId, timeMin, timeMax),
    cards: cards.filter((c) => inWindow(c.updatedAt, timeMin, timeMax)).slice(0, MAX_CARDS),
    doneTodos: todos
      .filter((t) => t.status === 'done' && inWindow(t.updatedAt, timeMin, timeMax))
      .slice(0, MAX_TODOS)
      .map(todoFact),
  };
}

export function hubWorkspaceCwd(): string {
  try {
    const cwd = ensureHubProject().cwd?.trim();
    if (cwd) return cwd;
  } catch {
    /* tests / missing project file */
  }
  return os.tmpdir();
}
