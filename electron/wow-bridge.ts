/**
 * WoW bridge: the desktop half of the AgentHub WoW addon.
 *
 * Addons have no network or file access, so both directions go through files:
 *
 * - Out of the game: the addon queues `{ id, agent | sessionId, prompt }`
 *   entries in its SavedVariables file, which the game writes on /reload and
 *   logout. Each entry starts a new session, or replies to `sessionId`.
 * - Into the game: the bridge rewrites `Interface/AddOns/AgentHub/Data.lua`
 *   with the user's recent sessions. The game reads addon files on every
 *   /reload and never writes them, so nothing clobbers the snapshot.
 *
 * Nothing to configure: install folders are auto-detected
 * (`AGENT_HUB_WOW_DIR` overrides), and the bridge stays idle unless the addon
 * is installed. Handled ids are remembered on disk so a request never runs
 * twice, including across app restarts.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { luaList, parseSavedVariables, type LuaTable } from './lua-saved-variables.js';

export const SAVED_VARIABLES_FILE = 'AgentHub.lua';
export const SAVED_VARIABLES_GLOBAL = 'AgentHubDB';
export const ADDON_FOLDER = 'AgentHub';
export const DATA_FILE = 'Data.lua';
/** Sessions in the in-game list, and messages kept per session. */
export const SNAPSHOT_SESSIONS = 20;
export const SNAPSHOT_MESSAGES = 4;
const SNAPSHOT_MAX_CHARS = 600;
/** Acknowledged ids published to the addon; well above its 20-entry queue. */
const HANDLED_ACK_LIMIT = 200;
/** Requests older than this are ignored rather than launched late. */
export const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROMPT_CHARS = 4000;
/**
 * How long a processed id is remembered. Requests older than
 * MAX_REQUEST_AGE_MS never run, so twice that (headroom for a skewed game
 * clock) covers every id that could still be in some account's queue.
 */
const PROCESSED_RETENTION_MS = 2 * MAX_REQUEST_AGE_MS;

export interface WowLaunchRequest {
  id: string;
  agent: string | null;
  /** Set when replying to an existing session instead of starting one. */
  sessionId: string | null;
  /**
   * For replies: the Hub and account (`hubBinding`) of the snapshot the
   * session was picked from. The reply only ever goes there.
   */
  binding?: string | null;
  prompt: string;
  /** Unix seconds, as the addon's `time()` returns. */
  createdAt: number | null;
}

export interface AgentSummary {
  id: string;
  name?: string;
}

export interface HubTarget {
  baseUrl: string;
  headers: Record<string, string>;
}

export type LaunchOutcome =
  | { kind: 'launched'; request: WowLaunchRequest; title: string; sessionId: string | null }
  | { kind: 'rejected'; request: WowLaunchRequest; reason: string }
  | { kind: 'retry'; request: WowLaunchRequest; reason: string };

/** Candidate WoW install roots for this machine. */
export function wowInstallRoots(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homeDir: string,
): string[] {
  const override = env.AGENT_HUB_WOW_DIR?.trim();
  if (override) return [override];
  if (platform === 'darwin') {
    return [
      '/Applications/World of Warcraft',
      path.join(homeDir, 'Applications', 'World of Warcraft'),
    ];
  }
  if (platform === 'win32') {
    const roots: string[] = [];
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)']) {
      if (base) roots.push(path.win32.join(base, 'World of Warcraft'));
    }
    return [...new Set(roots)];
  }
  return [];
}

interface DirFs {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
}

const realDirFs: DirFs = {
  existsSync,
  readdirSync: (p) => readdirSync(p),
};

function listDir(fs: DirFs, dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** `<root>/_<flavor>_/` folders: `_retail_`, `_classic_`, WoW Forever's, ... */
function flavorDirs(roots: string[], fs: DirFs): string[] {
  const out: string[] = [];
  for (const root of roots) {
    for (const flavor of listDir(fs, root)) {
      if (/^_[^/\\]+_$/.test(flavor)) out.push(path.join(root, flavor));
    }
  }
  return out;
}

function addonDirIn(flavorDir: string): string {
  return path.join(flavorDir, 'Interface', 'AddOns', ADDON_FOLDER);
}

/** Installed copies of the addon, one per game flavor. */
export function findAddonDirs(roots: string[], fs: DirFs = realDirFs): string[] {
  return flavorDirs(roots, fs)
    .map(addonDirIn)
    .filter((dir) => fs.existsSync(dir));
}

/**
 * Whether the addon is still installed in the flavor a SavedVariables file
 * belongs to (`<flavor>/WTF/Account/<account>/SavedVariables/AgentHub.lua`).
 * The game keeps SavedVariables after an addon is removed; a leftover queue
 * must not launch anything.
 */
export function addonInstalledFor(savedVariablesFile: string, fs: DirFs = realDirFs): boolean {
  return fs.existsSync(addonDirIn(path.resolve(savedVariablesFile, '..', '..', '..', '..', '..')));
}

/**
 * Every `<root>/_<flavor>_/WTF/Account/<account>/SavedVariables/AgentHub.lua`
 * in a flavor where the addon is installed. Flavor folders (`_retail_`,
 * `_classic_`, WoW Forever's) aren't hardcoded: any `_name_` directory counts.
 */
export function findSavedVariablesFiles(roots: string[], fs: DirFs = realDirFs): string[] {
  const out: string[] = [];
  for (const flavor of flavorDirs(roots, fs)) {
    if (!fs.existsSync(addonDirIn(flavor))) continue;
    const accounts = path.join(flavor, 'WTF', 'Account');
    for (const account of listDir(fs, accounts)) {
      const file = path.join(accounts, account, 'SavedVariables', SAVED_VARIABLES_FILE);
      if (fs.existsSync(file)) out.push(file);
    }
  }
  return out;
}

/** Queue entries from the addon's SavedVariables source. Malformed entries are dropped. */
export function extractRequests(source: string): WowLaunchRequest[] {
  const db = parseSavedVariables(source)[SAVED_VARIABLES_GLOBAL];
  if (!db || typeof db !== 'object') return [];
  const out: WowLaunchRequest[] = [];
  for (const entry of luaList(db.queue)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as LuaTable;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : '';
    if (!id || !prompt) continue;
    const agent = typeof e.agent === 'string' && e.agent.trim() ? e.agent.trim() : null;
    const sessionId =
      typeof e.sessionId === 'string' && e.sessionId.trim() ? e.sessionId.trim() : null;
    const createdAt = typeof e.createdAt === 'number' ? e.createdAt : null;
    const binding = typeof e.binding === 'string' && e.binding ? e.binding : null;
    out.push({
      id,
      agent,
      sessionId,
      binding,
      prompt: prompt.slice(0, MAX_PROMPT_CHARS),
      createdAt,
    });
  }
  return out;
}

/**
 * Match what the player typed against the agent list: exact id, then exact
 * name, then a unique partial match on id or name. Ambiguity is an error
 * rather than a guess, since the session would start on the wrong agent.
 */
export function resolveAgent(
  query: string | null,
  agents: AgentSummary[],
): { agent: AgentSummary } | { error: string } {
  if (!query) {
    return { error: 'No agent picked. In game: /ah agent <name>, or start with @<agent>.' };
  }
  // Spaces, dashes and underscores are interchangeable: `@agent-hub-qa` and
  // `/ah agent Agent Hub QA` both name the same agent.
  const norm = (s: string | undefined) =>
    (s ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '-');
  const q = norm(query);
  const tiers: Array<(a: AgentSummary) => boolean> = [
    (a) => norm(a.id) === q,
    (a) => norm(a.name) === q,
    (a) => norm(a.id).includes(q) || norm(a.name).includes(q),
  ];
  for (const match of tiers) {
    const hits = agents.filter(match);
    if (hits.length === 1) return { agent: hits[0] };
    if (hits.length > 1) {
      const ids = hits
        .slice(0, 5)
        .map((a) => a.id)
        .join(', ');
      return { error: `"${query}" matches ${hits.length} agents (${ids}). Use the full id.` };
    }
  }
  return { error: `No agent matches "${query}".` };
}

export function isStale(request: WowLaunchRequest, now: number): boolean {
  return request.createdAt !== null && now - request.createdAt * 1000 > MAX_REQUEST_AGE_MS;
}

/**
 * Bridge state, persisted as JSON:
 * - `processed`: ids launched or permanently rejected; never sent again.
 * - `attempts`: id -> the Hub and account it was first sent to (see
 *   `hubBinding`). Written before the first POST, so after a lost response or
 *   a crash the retry goes to the same place, where the Idempotency-Key
 *   matches. Cleared once the id is processed.
 */
export interface BridgeStore {
  has(id: string): boolean;
  add(id: string): void;
  attemptFor(id: string): string | null;
  bindAttempt(id: string, binding: string): void;
}

export function createProcessedStore(
  filePath: string,
  write: (file: string, contents: string) => void = writeAtomic,
  clock: () => number = Date.now,
) {
  type Processed = { id: string; at: number };
  type State = { processed: Processed[]; attempts: Record<string, string> };
  let state: State | null = null;
  const load = () => {
    if (state) return state;
    let parsed: { processed?: unknown; attempts?: unknown } | null = null;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {}
    const attempts: Record<string, string> = Object.create(null);
    if (parsed?.attempts && typeof parsed.attempts === 'object') {
      for (const [id, binding] of Object.entries(parsed.attempts as Record<string, unknown>)) {
        if (typeof binding === 'string') attempts[id] = binding;
      }
    }
    const processed: Processed[] = [];
    for (const x of Array.isArray(parsed?.processed) ? parsed.processed : []) {
      if (x && typeof x.id === 'string' && typeof x.at === 'number') {
        processed.push({ id: x.id, at: x.at });
      }
    }
    state = { processed, attempts };
    return state;
  };
  // Memory changes only after the write succeeds: a binding the disk doesn't
  // have must never look recorded, or the next attempt would POST without it.
  const commit = (next: State) => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    write(filePath, JSON.stringify(next, null, 2) + '\n');
    state = next;
  };
  return {
    has: (id: string) => load().processed.some((p) => p.id === id),
    /** Most recent ids first. */
    recent: (limit: number) =>
      load()
        .processed.slice(-limit)
        .reverse()
        .map((p) => p.id),
    add(id: string) {
      const st = load();
      const now = clock();
      const attempts: Record<string, string> = Object.assign(Object.create(null), st.attempts);
      delete attempts[id];
      // Pruned by age only: an id is forgotten once no queue can still run it.
      const kept = st.processed.filter((p) => p.id !== id && now - p.at < PROCESSED_RETENTION_MS);
      commit({ processed: [...kept, { id, at: now }], attempts });
    },
    attemptFor: (id: string) => load().attempts[id] ?? null,
    bindAttempt(id: string, binding: string) {
      const st = load();
      const attempts: Record<string, string> = Object.assign(Object.create(null), st.attempts);
      attempts[id] = binding;
      commit({ processed: st.processed, attempts });
    },
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function sessionTitle(prompt: string): string {
  return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const msg = body?.message ?? body?.error;
    if (typeof msg === 'string' && msg) return msg;
  } catch {}
  return `HTTP ${res.status}`;
}

/** Status codes worth retrying later (sign-in, rate limit, server trouble). */
function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

/** Stable per request, so every retry of it carries the same key. */
export function idempotencyKeyFor(request: WowLaunchRequest): string {
  return `wow-${request.id}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 200);
}

async function readAgents(
  target: HubTarget,
  fetchImpl: FetchLike,
): Promise<{ agents: AgentSummary[] } | { retry: string }> {
  try {
    const res = await fetchImpl(`${target.baseUrl}/api/agents`, {
      headers: { Accept: 'application/json', ...target.headers },
    });
    if (!res.ok) {
      return {
        retry:
          res.status === 401 ? 'Sign in to Agent Hub in the desktop app.' : await errorText(res),
      };
    }
    const body = (await res.json()) as unknown;
    return {
      agents: Array.isArray(body)
        ? body.filter((a): a is AgentSummary => !!a && typeof a.id === 'string')
        : [],
    };
  } catch (err) {
    return { retry: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Record an id as done. If that can't be saved, the request stays bound and is
 * retried against the same Hub and account, which replays it by key.
 */
function markProcessed(store: BridgeStore, id: string) {
  try {
    store.add(id);
  } catch {}
}

/**
 * Where a request's Idempotency-Key is valid: the Hub (base URL) plus the
 * account the Hub scopes keys to, which is the signed-in user id or, for
 * callers without one, `shared`. Mirrors `idempotencyScope` on the server.
 */
export function hubBinding(baseUrl: string, userId: string | null): string {
  // Scheme and host are case-insensitive (URL lowercases them); the path is
  // not, and /Hub and /hub can be different Hubs behind one proxy.
  let base = baseUrl.trim();
  try {
    const u = new URL(base);
    base = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {}
  return `${base.replace(/\/+$/, '')}|${userId ?? 'shared'}`;
}

async function readBinding(
  target: HubTarget,
  fetchImpl: FetchLike,
): Promise<{ binding: string } | { retry: string }> {
  try {
    const res = await fetchImpl(`${target.baseUrl}/api/auth/me`, {
      headers: { Accept: 'application/json', ...target.headers },
    });
    if (!res.ok) {
      return {
        retry:
          res.status === 401 ? 'Sign in to Agent Hub in the desktop app.' : await errorText(res),
      };
    }
    const body = (await res.json()) as { user?: { id?: unknown } | null };
    const id = typeof body?.user?.id === 'string' ? body.user.id : null;
    return { binding: hubBinding(target.baseUrl, id) };
  } catch (err) {
    return { retry: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run every not-yet-handled request: replies go to their session, the rest
 * start a new one. Agents are only fetched when a new session is needed.
 */
export async function launchPending(params: {
  requests: WowLaunchRequest[];
  target: HubTarget | null;
  store: BridgeStore;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<LaunchOutcome[]> {
  const { requests, target, store } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const now = params.now ?? Date.now();
  const fresh: WowLaunchRequest[] = [];
  for (const r of requests) {
    if (store.has(r.id)) continue;
    if (isStale(r, now)) markProcessed(store, r.id);
    else fresh.push(r);
  }
  if (fresh.length === 0) return [];

  if (!target) {
    return fresh.map((request) => ({
      kind: 'retry' as const,
      request,
      reason: 'Agent Hub is not connected.',
    }));
  }

  const where = await readBinding(target, fetchImpl);
  if ('retry' in where) {
    return fresh.map((request) => ({ kind: 'retry' as const, request, reason: where.retry }));
  }
  let agents: AgentSummary[] | null = null;
  let agentsRetry: string | null = null;
  const outcomes: LaunchOutcome[] = [];
  for (const request of fresh) {
    // Once sent somewhere, a request is only ever retried there: another Hub
    // or account has no record of its key and would run it a second time. A
    // reply is bound from the start to the Hub and account its session came
    // from; elsewhere that session id means nothing.
    const attempted = store.attemptFor(request.id);
    const boundTo = attempted ?? request.binding ?? null;
    if (boundTo && boundTo !== where.binding) {
      outcomes.push({
        kind: 'retry',
        request,
        reason: `Waiting for ${boundTo.split('|')[0]} and the account it was first sent from.`,
      });
      continue;
    }
    let url: string;
    let body: Record<string, unknown>;
    let title: string;
    if (request.sessionId) {
      url = `${target.baseUrl}/api/me/sessions/${encodeURIComponent(request.sessionId)}/reply`;
      body = { content: request.prompt };
      title = 'Reply sent';
    } else {
      if (!agents && !agentsRetry) {
        const read = await readAgents(target, fetchImpl);
        if ('retry' in read) agentsRetry = read.retry;
        else agents = read.agents;
      }
      if (agentsRetry || !agents) {
        outcomes.push({ kind: 'retry', request, reason: agentsRetry ?? 'No agent list.' });
        continue;
      }
      const resolved = resolveAgent(request.agent, agents);
      if ('error' in resolved) {
        markProcessed(store, request.id);
        outcomes.push({ kind: 'rejected', request, reason: resolved.error });
        continue;
      }
      url = `${target.baseUrl}/api/agents/${encodeURIComponent(resolved.agent.id)}/sessions`;
      body = {
        name: sessionTitle(request.prompt),
        autoTitle: true,
        seedMessage: request.prompt,
        autoStart: true,
      };
      title = `Started ${resolved.agent.name || resolved.agent.id}`;
    }
    if (!attempted) {
      try {
        store.bindAttempt(request.id, where.binding);
      } catch (err) {
        // Not durable, so not sent: a lost response could otherwise be
        // retried against another Hub or account after a restart.
        outcomes.push({
          kind: 'retry',
          request,
          reason: `Could not save bridge state: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The Hub replays the original result for a repeated key, so a
          // retry after a lost response (or a crash before store.add) can't
          // start a second session or send the reply twice.
          'Idempotency-Key': idempotencyKeyFor(request),
          ...target.headers,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const reason = await errorText(res);
        if (isRetryableStatus(res.status)) {
          outcomes.push({ kind: 'retry', request, reason });
        } else {
          markProcessed(store, request.id);
          outcomes.push({ kind: 'rejected', request, reason });
        }
        continue;
      }
      const json = (await res.json().catch(() => null)) as {
        id?: unknown;
        sessionId?: unknown;
      } | null;
      const sessionId = json?.sessionId ?? json?.id;
      markProcessed(store, request.id);
      outcomes.push({
        kind: 'launched',
        request,
        title,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
      });
    } catch (err) {
      outcomes.push({
        kind: 'retry',
        request,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

export interface RecentSession {
  id: string;
  name: string;
  agentName: string;
  projectName: string;
  state: string;
  updatedAt: string;
  lastReply: string | null;
  messages: Array<{ role: string; content: string; createdAt: string }>;
}

/** The caller's recent sessions from the Hub, or null when it can't be reached. */
export async function fetchRecentSessions(
  target: HubTarget,
  fetchImpl: FetchLike = fetch,
): Promise<RecentSession[] | null> {
  const query = `limit=${SNAPSHOT_SESSIONS}&messages=${SNAPSHOT_MESSAGES}&maxChars=${SNAPSHOT_MAX_CHARS}`;
  try {
    const res = await fetchImpl(`${target.baseUrl}/api/me/sessions/recent?${query}`, {
      headers: { Accept: 'application/json', ...target.headers },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sessions?: unknown };
    return Array.isArray(body?.sessions) ? (body.sessions as RecentSession[]) : null;
  } catch {
    return null;
  }
}

/** A Lua string literal. Control characters become `\ddd` so the file stays one line per value. */
export function luaString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (code < 32 || code === 127) out += `\\${String(code).padStart(3, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) or ISO to unix seconds; 0 when unparseable. */
export function toUnixSeconds(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const iso = /[TZ+]/.test(timestamp.slice(10)) ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Source of the addon's `Data.lua`: a single `AgentHubData` literal.
 * `handled` acknowledges request ids the bridge is done with, so the addon
 * can drop them from its queue; it keeps everything else.
 */
export function renderDataLua(
  sessions: RecentSession[],
  sessionsAt: number,
  handled: string[] = [],
  binding: string | null = null,
): string {
  const str = (v: unknown) => luaString(typeof v === 'string' ? v : '');
  const lines = [
    '-- Written by the Agent Hub desktop app. Replaced every few seconds; edits are lost.',
    'AgentHubData = {',
    `  updatedAt = ${Math.floor(sessionsAt / 1000)},`,
    // Which Hub and account these sessions belong to; replies carry it.
    ...(binding ? [`  binding = ${str(binding)},`] : []),
    `  handled = { ${handled.map((id) => `${str(id)}, `).join('')}},`,
    '  sessions = {',
  ];
  for (const s of sessions) {
    lines.push('    {');
    lines.push(`      id = ${str(s.id)},`);
    lines.push(`      name = ${str(s.name)},`);
    lines.push(`      agent = ${str(s.agentName)},`);
    lines.push(`      project = ${str(s.projectName)},`);
    lines.push(`      state = ${str(s.state)},`);
    lines.push(`      updatedAt = ${toUnixSeconds(s.updatedAt)},`);
    lines.push(`      lastReply = ${str(s.lastReply ?? '')},`);
    lines.push('      messages = {');
    for (const m of Array.isArray(s.messages) ? s.messages : []) {
      lines.push(
        `        { role = ${str(m.role)}, content = ${str(m.content)}, at = ${toUnixSeconds(m.createdAt)} },`,
      );
    }
    lines.push('      },');
    lines.push('    },');
  }
  lines.push('  },', '}', '');
  return lines.join('\n');
}

/** Replace a file without a reader ever seeing it half-written. */
function writeAtomic(file: string, contents: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

export interface SessionSnapshot {
  sessions: RecentSession[];
  at: number;
  binding: string | null;
}

const EMPTY_SNAPSHOT: SessionSnapshot = { sessions: [], at: 0, binding: null };

/**
 * What the game should show. A cached list is reused only for the same Hub
 * and account; when the current one is unknown (Hub down, signed out) or
 * different, nothing is shown rather than someone else's sessions.
 */
export function chooseSnapshot(
  cached: SessionSnapshot | null,
  current: { binding: string | null; sessions: RecentSession[] | null },
  now: number,
): SessionSnapshot {
  if (current.binding && current.sessions) {
    return { sessions: current.sessions, at: now, binding: current.binding };
  }
  if (cached && current.binding && cached.binding === current.binding) return cached;
  return EMPTY_SNAPSHOT;
}

export interface WowBridgeOptions {
  roots: string[];
  statePath: string;
  getTarget: () => HubTarget | null;
  notify: (title: string, body: string, type: 'success' | 'error') => void;
  log?: (msg: string) => void;
  pollMs?: number;
  rescanMs?: number;
  snapshotMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Poll the SavedVariables files and keep the in-game snapshot fresh. A changed
 * file is processed on the next poll; every rescan re-reads all files so
 * retryable failures (signed out, Hub down) go through once the cause clears.
 */
export function startWowBridge(opts: WowBridgeOptions): { stop(): void } {
  const log = opts.log ?? (() => {});
  const store = createProcessedStore(opts.statePath);
  const mtimes = new Map<string, number>();
  const retryNotified = new Set<string>();
  let files: string[] = [];
  let addonDirs: string[] = [];
  let busy = false;
  let lastScan = 0;
  let lastSnapshot = 0;

  let lastSnapshotData: SessionSnapshot | null = null;

  const writeSnapshot = async () => {
    if (addonDirs.length === 0) return;
    const target = opts.getTarget();
    let binding: string | null = null;
    let sessions: RecentSession[] | null = null;
    if (target) {
      const where = await readBinding(target, opts.fetchImpl ?? fetch);
      if ('binding' in where) {
        binding = where.binding;
        sessions = await fetchRecentSessions(target, opts.fetchImpl ?? fetch);
      }
    }
    const snapshot = chooseSnapshot(lastSnapshotData, { binding, sessions }, Date.now());
    if (snapshot.binding) lastSnapshotData = snapshot;
    // Acknowledgements go out even when there is no session list to show.
    const source = renderDataLua(
      snapshot.sessions,
      snapshot.at,
      store.recent(HANDLED_ACK_LIMIT),
      snapshot.binding,
    );
    for (const dir of addonDirs) {
      try {
        writeAtomic(path.join(dir, DATA_FILE), source);
      } catch (err) {
        log(`[wow-bridge] could not write ${dir}: ${(err as Error).message}`);
      }
    }
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const rescan = now - lastScan >= (opts.rescanMs ?? 60_000);
      if (rescan) {
        files = findSavedVariablesFiles(opts.roots);
        addonDirs = findAddonDirs(opts.roots);
        lastScan = now;
      }
      let handled = false;
      for (const file of files) {
        let mtime: number;
        let size: number;
        try {
          const st = statSync(file);
          mtime = st.mtimeMs;
          size = st.size;
        } catch {
          continue;
        }
        if (!rescan && mtimes.get(file) === mtime) continue;
        // Removed since the last rescan: leave its queue alone.
        if (!addonInstalledFor(file)) continue;
        mtimes.set(file, mtime);
        if (size > MAX_FILE_BYTES) continue;
        let requests: WowLaunchRequest[];
        try {
          requests = extractRequests(readFileSync(file, 'utf-8'));
        } catch (err) {
          log(`[wow-bridge] could not parse ${file}: ${(err as Error).message}`);
          continue;
        }
        const outcomes = await launchPending({
          requests,
          target: opts.getTarget(),
          store,
          fetchImpl: opts.fetchImpl,
        });
        for (const o of outcomes) {
          if (o.kind === 'launched') {
            handled = true;
            retryNotified.delete(o.request.id);
            opts.notify(o.title, o.request.prompt, 'success');
          } else if (o.kind === 'rejected') {
            opts.notify('WoW request not sent', o.reason, 'error');
          } else if (!retryNotified.has(o.request.id)) {
            retryNotified.add(o.request.id);
            opts.notify('WoW request waiting', `${o.reason} Will retry.`, 'error');
          }
          log(`[wow-bridge] ${o.kind} ${o.request.id}`);
        }
      }
      if (handled || now - lastSnapshot >= (opts.snapshotMs ?? 20_000)) {
        lastSnapshot = now;
        await writeSnapshot();
      }
    } catch (err) {
      log(`[wow-bridge] ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.pollMs ?? 3000);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}
