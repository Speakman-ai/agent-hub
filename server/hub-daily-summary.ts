/**
 * Hub Daily Summary — per-user report of today / yesterday. "Today" folds in
 * the current-state facts (running sessions, open cards, open todos).
 *
 * Persistence is the caller's `preferences_json.hubDailySummary`, keyed by
 * local YYYY-MM-DD in the timezone they send. A stored report whose `date`
 * is not today is treated as empty (the report clears every calendar day).
 * Generation is explicit (POST); GET never spawns a model.
 */
import os from 'os';
import { HUB_ASSISTANT_AGENT_ID, HUB_SESSION_MODE } from '../shared/utils/hub.js';
import {
  dailySummaryCardHref,
  dailySummaryProjectHref,
  dailySummarySessionHref,
  dailySummaryTodoHref,
  linkifyDailySummaryMarkdown,
  type DailySummaryLinkRef,
} from '../shared/utils/dailySummaryLinks.js';
import { getDb } from './db.js';
import { computeDayWindow } from './me-dashboard-google.js';
import { buildMyWork } from './me-dashboard.js';
import {
  getUserPreferencesRow,
  mergeUserPreferencesJson,
  type HubDailySummaryStored,
} from './user-preferences-store.js';
import { listTodos } from './user-todos-store.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from './engine-resolver.js';
import { runOneShotPromptWithFailover, type OneShotFailoverOutcome } from './one-shot-failover.js';
import { resolveSessionCliSpawnEnv } from './per-user-cli-spawn.js';
import { ensureHubProject, resolveHubEngineAndModel } from './hub-assistant.js';
import type { AppConfig, RouteDeps } from './types.js';
import type { VisibilityCaller } from './project-visibility.js';

const MAX_SESSIONS = 20;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 280;
const MAX_CARDS = 20;
const MAX_TODOS = 20;
const MAX_RUNNING = 15;
const GENERATE_TIMEOUT_MS = 90_000;

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

export interface DailySummaryFacts {
  date: string;
  yesterdayDate: string;
  timeZone: string;
  timeMin: string;
  timeMax: string;
  yesterdayTimeMin: string;
  yesterdayTimeMax: string;
  running: DailySummaryRunningFact[];
  openCards: DailySummaryCardFact[];
  openTodos: DailySummaryTodoFact[];
  todaySessions: DailySummarySessionFact[];
  yesterdaySessions: DailySummarySessionFact[];
  todayMessages: DailySummaryMessageFact[];
  yesterdayMessages: DailySummaryMessageFact[];
  todayCards: DailySummaryCardFact[];
  yesterdayCards: DailySummaryCardFact[];
  todayDoneTodos: DailySummaryTodoFact[];
  yesterdayDoneTodos: DailySummaryTodoFact[];
}

export interface DailySummaryGetPayload {
  date: string;
  timeZone: string;
  report: HubDailySummaryStored | null;
}

export interface GenerateDailySummaryInput {
  userId: string;
  timeZone?: string;
  deps: RouteDeps;
  caller: VisibilityCaller;
  now?: Date;
  cwd?: string;
  resolveEngine?: typeof resolveOneShotEngine;
  runFailover?: (
    input: Parameters<typeof runOneShotPromptWithFailover>[0],
    cfg: AppConfig,
  ) => Promise<OneShotFailoverOutcome>;
}

function previousDate(dateStr: string): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function parseDailySummaryTimeZone(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const tz = raw.trim();
  if (!tz) return undefined;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return undefined;
  }
}

export function isStoredSummaryForDate(
  stored: HubDailySummaryStored | undefined,
  date: string,
): boolean {
  return !!stored && stored.date === date && stored.markdown.trim().length > 0;
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
  const rows = getDb()
    .prepare(
      `SELECT at.session_id AS session_id, s.name AS session_name, s.agent_id AS agent_id,
              s.session_mode AS session_mode, s.owner_user_id AS owner_user_id,
              at.started_at AS started_at
       FROM active_tasks at
       JOIN sessions s ON s.id = at.session_id
       WHERE at.status = 'running'
         AND s.deleted_at IS NULL
       ORDER BY at.started_at ASC
       LIMIT ?`,
    )
    .all(MAX_RUNNING * 2) as RunningRow[];
  const mine: DailySummaryRunningFact[] = [];
  const others: DailySummaryRunningFact[] = [];
  for (const row of rows) {
    const fact: DailySummaryRunningFact = {
      sessionId: row.session_id,
      sessionName: row.session_name,
      agentId: row.agent_id,
      kind: sessionKind(row.agent_id, row.session_mode),
      mine: row.owner_user_id === userId,
      startedAt: row.started_at,
    };
    if (fact.mine) mine.push(fact);
    else others.push(fact);
  }
  return [...mine, ...others].slice(0, MAX_RUNNING);
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

export function collectDailySummaryFacts(input: {
  userId: string;
  caller: VisibilityCaller;
  deps: RouteDeps;
  timeZone?: string;
  now?: Date;
}): DailySummaryFacts {
  const { date, timeMin, timeMax } = computeDayWindow({
    now: input.now,
    timeZone: input.timeZone,
  });
  const yesterdayDate = previousDate(date);
  const yesterday = computeDayWindow({
    now: input.now,
    timeZone: input.timeZone,
    date: yesterdayDate,
  });

  const work = buildMyWork(input.deps, input.userId, input.caller);
  const cards = work.cards.map(toCardFact);
  const todos = listTodos(input.userId);

  return {
    date,
    yesterdayDate,
    timeZone: input.timeZone || 'UTC',
    timeMin,
    timeMax,
    yesterdayTimeMin: yesterday.timeMin,
    yesterdayTimeMax: yesterday.timeMax,
    running: queryRunning(input.userId),
    openCards: cards.filter((c) => !c.isDone).slice(0, MAX_CARDS),
    openTodos: todos
      .filter((t) => t.status === 'open')
      .slice(0, MAX_TODOS)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
    todaySessions: queryOwnedSessions(input.userId, timeMin, timeMax),
    yesterdaySessions: queryOwnedSessions(input.userId, yesterday.timeMin, yesterday.timeMax),
    todayMessages: queryUserMessages(input.userId, timeMin, timeMax),
    yesterdayMessages: queryUserMessages(input.userId, yesterday.timeMin, yesterday.timeMax),
    todayCards: cards.filter((c) => inWindow(c.updatedAt, timeMin, timeMax)).slice(0, MAX_CARDS),
    yesterdayCards: cards
      .filter((c) => inWindow(c.updatedAt, yesterday.timeMin, yesterday.timeMax))
      .slice(0, MAX_CARDS),
    todayDoneTodos: todos
      .filter((t) => t.status === 'done' && inWindow(t.updatedAt, timeMin, timeMax))
      .slice(0, MAX_TODOS)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
    yesterdayDoneTodos: todos
      .filter(
        (t) => t.status === 'done' && inWindow(t.updatedAt, yesterday.timeMin, yesterday.timeMax),
      )
      .slice(0, MAX_TODOS)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
  };
}

function mdLink(label: string, href: string): string {
  return `[${label.replace(/]/g, '\\]')}](${href})`;
}

export function dailySummaryRefsFromFacts(facts: DailySummaryFacts): DailySummaryLinkRef[] {
  const refs: DailySummaryLinkRef[] = [];
  for (const card of [...facts.openCards, ...facts.todayCards, ...facts.yesterdayCards]) {
    if (!card.projectId) continue;
    refs.push({ label: card.title, href: dailySummaryCardHref(card.projectId, card.id) });
    refs.push({ label: card.projectName, href: dailySummaryProjectHref(card.projectId) });
  }
  for (const session of [...facts.todaySessions, ...facts.yesterdaySessions]) {
    refs.push({ label: session.name, href: dailySummarySessionHref(session.id, session.agentId) });
  }
  for (const running of facts.running) {
    refs.push({
      label: running.sessionName,
      href: dailySummarySessionHref(running.sessionId, running.agentId),
    });
  }
  for (const message of [...facts.todayMessages, ...facts.yesterdayMessages]) {
    refs.push({
      label: message.sessionName,
      href: dailySummarySessionHref(message.sessionId),
    });
  }
  for (const todo of [...facts.openTodos, ...facts.todayDoneTodos, ...facts.yesterdayDoneTodos]) {
    refs.push({ label: todo.title, href: dailySummaryTodoHref() });
  }
  return refs;
}

function linesFor<T>(items: T[], format: (item: T) => string): string {
  if (items.length === 0) return '  (none)';
  return items.map((item) => `  - ${format(item)}`).join('\n');
}

export function formatFactsForPrompt(facts: DailySummaryFacts): string {
  return [
    `Local date: ${facts.date} (${facts.timeZone})`,
    `Yesterday: ${facts.yesterdayDate}`,
    '',
    'Each named ticket, session, todo, and project below already has a markdown link. Copy those links when you mention them.',
    '',
    'TODAY — running sessions:',
    linesFor(facts.running, (s) => {
      const name = mdLink(s.sessionName, dailySummarySessionHref(s.sessionId, s.agentId));
      return `${name} [${s.kind}${s.mine ? ', yours' : ', org'}] agent=${s.agentId} started=${s.startedAt}`;
    }),
    'TODAY — open cards assigned to you:',
    linesFor(facts.openCards, (c) => {
      const title = mdLink(c.title, dailySummaryCardHref(c.projectId, c.id));
      const project = mdLink(c.projectName, dailySummaryProjectHref(c.projectId));
      return `${title} (${project} / ${c.columnName})`;
    }),
    'TODAY — open todos:',
    linesFor(facts.openTodos, (t) => mdLink(t.title, dailySummaryTodoHref())),
    'TODAY — sessions you owned that updated:',
    linesFor(facts.todaySessions, (s) => {
      const name = mdLink(s.name, dailySummarySessionHref(s.id, s.agentId));
      return `${name} [${s.kind}] updated=${s.updatedAt}`;
    }),
    'TODAY — your chat messages:',
    linesFor(facts.todayMessages, (m) => {
      const name = mdLink(m.sessionName, dailySummarySessionHref(m.sessionId));
      return `${name} [${m.kind}]: ${m.content}`;
    }),
    'TODAY — assigned cards updated:',
    linesFor(facts.todayCards, (c) => {
      const title = mdLink(c.title, dailySummaryCardHref(c.projectId, c.id));
      const project = mdLink(c.projectName, dailySummaryProjectHref(c.projectId));
      return `${title} (${project} / ${c.columnName})`;
    }),
    'TODAY — todos marked done:',
    linesFor(facts.todayDoneTodos, (t) => mdLink(t.title, dailySummaryTodoHref())),
    '',
    'YESTERDAY — sessions you owned that updated:',
    linesFor(facts.yesterdaySessions, (s) => {
      const name = mdLink(s.name, dailySummarySessionHref(s.id, s.agentId));
      return `${name} [${s.kind}] updated=${s.updatedAt}`;
    }),
    'YESTERDAY — your chat messages:',
    linesFor(facts.yesterdayMessages, (m) => {
      const name = mdLink(m.sessionName, dailySummarySessionHref(m.sessionId));
      return `${name} [${m.kind}]: ${m.content}`;
    }),
    'YESTERDAY — assigned cards updated:',
    linesFor(facts.yesterdayCards, (c) => {
      const title = mdLink(c.title, dailySummaryCardHref(c.projectId, c.id));
      const project = mdLink(c.projectName, dailySummaryProjectHref(c.projectId));
      return `${title} (${project} / ${c.columnName})`;
    }),
    'YESTERDAY — todos marked done:',
    linesFor(facts.yesterdayDoneTodos, (t) => mdLink(t.title, dailySummaryTodoHref())),
  ].join('\n');
}

export function readDailySummary(userId: string, date: string): HubDailySummaryStored | null {
  // Pure read: return the stored report only when it is for the requested date,
  // otherwise null. Never mutate here — a GET must not drop a still-valid report
  // just because the caller's timezone (or an omitted `tz`, defaulting to UTC)
  // resolved a different local date. Two devices in different zones would
  // otherwise clobber each other's report on read. Persistence happens only on
  // POST via saveDailySummary.
  const stored = getUserPreferencesRow(userId).hubDailySummary;
  if (isStoredSummaryForDate(stored, date)) return stored ?? null;
  return null;
}

export function saveDailySummary(userId: string, report: HubDailySummaryStored): void {
  mergeUserPreferencesJson(userId, { hubDailySummary: report });
}

function hubWorkspaceCwd(): string {
  try {
    const cwd = ensureHubProject().cwd?.trim();
    if (cwd) return cwd;
  } catch {
    /* tests / missing project file */
  }
  return os.tmpdir();
}

const SYSTEM_PROMPT = [
  'You write a daily operating summary for this Agent Hub user.',
  'Use ONLY the facts provided. Do not invent work, tickets, or sessions.',
  'If a section has no facts, say so in one short sentence.',
  'Output markdown only — no preamble, no code fences around the whole reply.',
  'Use these two headings, in this order:',
  '## Today',
  '## Yesterday',
  'Today covers both what is happening right now (running sessions, open cards, open todos) and what happened earlier today.',
  'Be concise. Use bullet lists. Name projects, tickets, and sessions when given.',
  'When you mention a ticket, session, todo, or project, keep the markdown link from the facts (`[name](url)`). Do not drop the URL.',
  'Hub-kind sessions are the user talking to Hub, not project shipping work — label them as Hub chat.',
].join('\n');

export async function generateDailySummary(
  input: GenerateDailySummaryInput,
): Promise<HubDailySummaryStored> {
  const timeZone = parseDailySummaryTimeZone(input.timeZone);
  const facts = collectDailySummaryFacts({
    userId: input.userId,
    caller: input.caller,
    deps: input.deps,
    timeZone,
    now: input.now,
  });
  const resolveEngine = input.resolveEngine ?? resolveOneShotEngine;
  const runFailover = input.runFailover ?? runOneShotPromptWithFailover;
  const config = input.deps.config;
  const hubPick = resolveHubEngineAndModel(config, input.userId);
  const resolved = await resolveEngine(config, {
    userId: input.userId,
    agentId: HUB_ASSISTANT_AGENT_ID,
    preferred: hubPick.engine,
    preferredModel: hubPick.model,
  });
  const cwd = input.cwd ?? hubWorkspaceCwd();
  const outcome = await runFailover(
    {
      engine: resolved.engine,
      model: resolved.model,
      prompt: `Write the daily summary from these facts:\n\n${formatFactsForPrompt(facts)}`,
      systemPrompt: SYSTEM_PROMPT,
      cwd,
      timeoutMs: GENERATE_TIMEOUT_MS,
      userId: input.userId,
      agentId: HUB_ASSISTANT_AGENT_ID,
      buildEnv: (engine) =>
        resolveSessionCliSpawnEnv({
          cfg: config,
          ownerId: input.userId,
          credsOwnerId: input.userId,
          engine,
        }),
      scope: 'daily-summary',
      claudePermissionMode: 'bypassPermissions',
    },
    config,
  );
  const markdown = linkifyDailySummaryMarkdown(
    outcome.output.trim(),
    dailySummaryRefsFromFacts(facts),
  );
  if (!markdown || (outcome.detailed.code !== 0 && outcome.detailed.code !== null)) {
    throw new Error(outcome.detailed.stderr?.trim() || 'Daily summary generation failed');
  }
  const report: HubDailySummaryStored = {
    date: facts.date,
    timeZone: facts.timeZone,
    markdown,
    engine: outcome.engine,
    model: outcome.model,
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
  saveDailySummary(input.userId, report);
  return report;
}

export function getDailySummaryPayload(input: {
  userId: string;
  timeZone?: string;
  now?: Date;
}): DailySummaryGetPayload {
  const tz = parseDailySummaryTimeZone(input.timeZone);
  const { date } = computeDayWindow({ now: input.now, timeZone: tz });
  return {
    date,
    timeZone: tz || 'UTC',
    report: readDailySummary(input.userId, date),
  };
}

export { NoEnginesAvailableError };
