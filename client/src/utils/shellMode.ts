import { deriveSessionState } from './deriveSessionState';

/**
 * System agents that have their own jobs and never host a chat: the docs
 * agent, reviewer, skill builder, QA, and the Hub assistant (pinned separately).
 */
const SIMPLE_CHAT_HIDDEN_ROLES = new Set([
  'reviewer',
  'docs',
  'hub-assistant',
  'skill-builder',
  'qa',
]);

export function isSimpleChatAgent(agent: { role?: string | null } | null | undefined): boolean {
  const role = (agent?.role ?? '').trim().toLowerCase();
  return !SIMPLE_CHAT_HIDDEN_ROLES.has(role);
}

/** Persisted shell: the full Hub, or the messaging-style simple view. */
export const SHELL_MODE_KEY = 'agenthub.shellMode';
/** Saved simple-sidebar order. The Server Agent is not in this list. */
export const SIMPLE_ROSTER_ORDER_KEY = 'agenthub.simpleRosterOrder';
/** Saved organization order for the simple chat list. */
export const SIMPLE_ORG_ORDER_KEY = 'agenthub.simpleOrgOrder';
/** Saved project order inside each organization. */
export const SIMPLE_PROJECT_ORDER_KEY = 'agenthub.simpleProjectOrder';

export type ShellMode = 'hub' | 'simple';

export type SimpleContactStatus = 'working' | 'needs-you' | 'idle';

export type SimpleAgent = {
  id: string;
  name?: string | null;
  color?: string | null;
  avatar?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  role?: string | null;
  active?: boolean | null;
};

export type SimpleSession = {
  id: string;
  name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  session_mode?: string | null;
  sidebar_parent_id?: string | null;
  cron_id?: unknown;
};

/** Key for the chat this simple view last opened with an agent. */
export const SIMPLE_SESSION_KEY_PREFIX = 'agenthub.simpleSession:';
/** Where Full Hub returns to: the session open when the simple view was entered. */
export const PRE_SIMPLE_TARGET_KEY = 'agenthub.preSimpleTarget';

export type PreSimpleTarget = { agentId: string; sessionId: string };

export function simpleSessionKey(agentId: string): string {
  return `${SIMPLE_SESSION_KEY_PREFIX}${agentId}`;
}

/** A simple-view chat: consult, not a SideBar fork and not a cron run. */
export function isSimpleConsultSession(
  session: Pick<SimpleSession, 'session_mode' | 'sidebar_parent_id' | 'cron_id'> | null | undefined,
): boolean {
  if (!session || session.session_mode !== 'consult') return false;
  if (session.sidebar_parent_id) return false;
  if (session.cron_id) return false;
  return true;
}

/**
 * The simple shell only shows consult chats. A known session that is not one
 * (a build, a SideBar fork, a cron run) must open in the full Hub instead, or
 * the user would send build turns with the build controls hidden. An unknown
 * row is left alone: it is usually a target whose list has not loaded yet.
 */
export function simpleShellMustLeaveFor(
  session: Pick<SimpleSession, 'session_mode' | 'sidebar_parent_id' | 'cron_id'> | null | undefined,
): boolean {
  if (!session) return false;
  return !isSimpleConsultSession(session);
}

/**
 * Record where Full Hub should return when the user enters the simple view
 * from the full Hub. One target for the whole shell, not per agent: the
 * Server Agent and every roster chat change the active agent, so a key on
 * the agent active at exit would miss. A consult or Hub thread is the simple
 * view itself, so entering from one clears any older target.
 */
export function rememberPreSimpleTarget(
  agentId: string | null | undefined,
  sessionId: string | null | undefined,
  sessionMode: string | null | undefined,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = defaultStorage(),
): void {
  try {
    if (!agentId || !sessionId || sessionMode === 'consult' || sessionMode === 'hub') {
      storage?.removeItem(PRE_SIMPLE_TARGET_KEY);
      return;
    }
    storage?.setItem(PRE_SIMPLE_TARGET_KEY, JSON.stringify({ agentId, sessionId }));
  } catch {
    // Best-effort.
  }
}

/** Read and clear the session Full Hub should restore. */
export function takePreSimpleTarget(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null = defaultStorage(),
): PreSimpleTarget | null {
  try {
    const raw = storage?.getItem(PRE_SIMPLE_TARGET_KEY) ?? null;
    if (!raw) return null;
    storage?.removeItem(PRE_SIMPLE_TARGET_KEY);
    const parsed = JSON.parse(raw);
    if (typeof parsed?.agentId !== 'string' || typeof parsed?.sessionId !== 'string') return null;
    return { agentId: parsed.agentId, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

export type SimpleContact = {
  agentId: string;
  name: string;
  projectId: string;
  projectName: string;
  color: string;
  avatar: string | null;
  preview: string;
  status: SimpleContactStatus;
  sessionId: string | null;
  updatedAt: string;
};

export function readShellMode(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): ShellMode {
  try {
    return storage?.getItem(SHELL_MODE_KEY) === 'simple' ? 'simple' : 'hub';
  } catch {
    return 'hub';
  }
}

export function writeShellMode(
  mode: ShellMode,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(SHELL_MODE_KEY, mode);
  } catch {
    // Preference is best-effort; the in-memory toggle still works.
  }
}

export function readSimpleRosterOrder(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): string[] {
  try {
    const raw = storage?.getItem(SIMPLE_ROSTER_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === 'string' && id.trim() !== '');
  } catch {
    return [];
  }
}

export function writeSimpleRosterOrder(
  ids: readonly string[],
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(SIMPLE_ROSTER_ORDER_KEY, JSON.stringify(ids));
  } catch {
    // Order is best-effort; the in-memory list still works.
  }
}

export function readSimpleOrgOrder(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): string[] {
  return readIdList(storage, SIMPLE_ORG_ORDER_KEY);
}

export function writeSimpleOrgOrder(
  ids: readonly string[],
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  writeIdList(storage, SIMPLE_ORG_ORDER_KEY, ids);
}

export function readSimpleProjectOrder(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): Record<string, string[]> {
  try {
    const raw = storage?.getItem(SIMPLE_PROJECT_ORDER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [orgId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      out[orgId] = value.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSimpleProjectOrder(
  order: Readonly<Record<string, readonly string[]>>,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(SIMPLE_PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Order is best-effort; the in-memory list still works.
  }
}

function readIdList(storage: Pick<Storage, 'getItem'> | null, key: string): string[] {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === 'string' && id.trim() !== '');
  } catch {
    return [];
  }
}

function writeIdList(
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(key, JSON.stringify(ids));
  } catch {
    // Order is best-effort; the in-memory list still works.
  }
}

/**
 * Keep a saved order, drop agents that are gone, and append agents that are
 * new. An empty current list leaves the saved order alone so a loading
 * sidebar does not wipe it.
 */
export function reconcileSimpleRosterOrder(
  saved: readonly string[],
  currentIds: readonly string[],
): string[] {
  if (currentIds.length === 0) return [...saved];
  const current = new Set(currentIds);
  const kept = saved.filter((id) => current.has(id));
  const keptSet = new Set(kept);
  return [...kept, ...currentIds.filter((id) => !keptSet.has(id))];
}

/** Place `sourceId` in the slot `targetId` occupies. Null when nothing moves. */
export function moveSimpleContact(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
): string[] | null {
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, sourceId);
  return next.every((id, index) => id === ids[index]) ? null : next;
}

export function orderSimpleContacts(
  contacts: readonly SimpleContact[],
  savedIds: readonly string[],
): SimpleContact[] {
  if (savedIds.length === 0) return [...contacts];
  const byId = new Map(contacts.map((contact) => [contact.agentId, contact]));
  const ordered: SimpleContact[] = [];
  const seen = new Set<string>();
  for (const id of savedIds) {
    const contact = byId.get(id);
    if (!contact || seen.has(id)) continue;
    ordered.push(contact);
    seen.add(id);
  }
  for (const contact of contacts) {
    if (!seen.has(contact.agentId)) ordered.push(contact);
  }
  return ordered;
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Newest session by `updated_at`, then `created_at`. Equal stamps keep input order. */
export function pickNewestSession<T extends SimpleSession>(
  sessions: readonly T[] | null | undefined,
): T | null {
  if (!sessions?.length) return null;
  return [...sessions].sort((a, b) => {
    const at = a.updated_at || a.created_at || '';
    const bt = b.updated_at || b.created_at || '';
    if (at === bt) return 0;
    return at < bt ? 1 : -1;
  })[0];
}

/**
 * The thread this contact should open: the live session when this agent is
 * already selected, otherwise the id Hub stored for them, otherwise the newest.
 */
export function preferredSimpleSession<T extends SimpleSession>(
  sessions: readonly T[] | null | undefined,
  preferredId: string | null | undefined,
): T | null {
  if (preferredId) {
    const remembered = sessions?.find((session) => session.id === preferredId);
    if (remembered) return remembered;
  }
  return pickNewestSession(sessions);
}

export function sessionsForSimpleAgent(
  agentId: string,
  loadedSessionsAgentId: string | null | undefined,
  activeSessions: readonly SimpleSession[] | null | undefined,
  cached: Readonly<Record<string, readonly SimpleSession[] | undefined>>,
): readonly SimpleSession[] {
  if (loadedSessionsAgentId && agentId === loadedSessionsAgentId) return activeSessions ?? [];
  return cached[agentId] ?? [];
}

export type SimpleStatusSignals = {
  activeTaskSessionIds?: Readonly<Record<string, unknown>>;
  finalizeStatusBySession?: Readonly<Record<string, string | null | undefined>>;
  needsInputBySession?: Readonly<Record<string, unknown>>;
};

/**
 * The sidebar's red exclamation: session state `needs_input` (a question,
 * password, approval, sign-in, or disputed review). A cleared needs-input
 * entry is not that state.
 */
export function sessionShowsNeedsYou(
  session: SimpleSession,
  signals: SimpleStatusSignals = {},
): boolean {
  return (
    deriveSessionState(session, {
      activeTaskSessionIds: signals.activeTaskSessionIds ?? {},
      finalizeStatusBySession: signals.finalizeStatusBySession ?? {},
      needsInputBySession: signals.needsInputBySession ?? {},
    }) === 'needs_input'
  );
}

export function simpleContactStatus(
  sessions: readonly SimpleSession[],
  signals: SimpleStatusSignals = {},
): SimpleContactStatus {
  if (sessions.some((session) => sessionShowsNeedsYou(session, signals))) return 'needs-you';
  const activeTasks = signals.activeTaskSessionIds ?? {};
  if (sessions.some((session) => isSimpleConsultSession(session) && activeTasks[session.id])) {
    return 'working';
  }
  return 'idle';
}

export function simpleContactPreview(
  status: SimpleContactStatus,
  session: SimpleSession | null,
  projectName: string,
): string {
  if (status === 'needs-you') return 'Needs you';
  if (status === 'working') return 'Working…';
  const name = session?.name?.trim();
  if (name && projectName) return `${projectName} · ${name}`;
  return name || projectName || 'No conversation yet';
}

export function buildSimpleContacts(input: {
  agents: readonly SimpleAgent[];
  loadedSessionsAgentId?: string | null;
  activeSessions?: readonly SimpleSession[] | null;
  sessionsByAgentId?: Readonly<Record<string, readonly SimpleSession[] | undefined>>;
  activeTaskSessionIds?: Readonly<Record<string, unknown>>;
  finalizeStatusBySession?: Readonly<Record<string, string | null | undefined>>;
  needsInputBySession?: Readonly<Record<string, unknown>>;
  /** `activeSessionId:<agentId>` values, plus the live open session. */
  rememberedSessionIds?: Readonly<Record<string, string | null | undefined>>;
  activeAgentId?: string | null;
  activeSessionId?: string | null;
}): SimpleContact[] {
  const cached = input.sessionsByAgentId ?? {};
  const signals: SimpleStatusSignals = {
    activeTaskSessionIds: input.activeTaskSessionIds ?? {},
    finalizeStatusBySession: input.finalizeStatusBySession ?? {},
    needsInputBySession: input.needsInputBySession ?? {},
  };
  const contacts: SimpleContact[] = [];

  for (const agent of input.agents) {
    if (!agent?.id || agent.active === false || !isSimpleChatAgent(agent)) continue;
    const sessions = sessionsForSimpleAgent(
      agent.id,
      input.loadedSessionsAgentId,
      input.activeSessions,
      cached,
    );
    const consults = sessions.filter(isSimpleConsultSession);
    const preferredId =
      input.activeAgentId === agent.id && input.activeSessionId
        ? input.activeSessionId
        : input.rememberedSessionIds?.[agent.id];
    const session = preferredSimpleSession(consults, preferredId);
    const projectName = agent.projectName?.trim() || '';
    const status = simpleContactStatus(sessions, signals);
    contacts.push({
      agentId: agent.id,
      name: agent.name?.trim() || 'Agent',
      projectId: agent.projectId?.trim() || agent.id,
      projectName,
      color: agent.color || '#6b7280',
      avatar: agent.avatar ?? null,
      preview: simpleContactPreview(status, session, projectName),
      status,
      sessionId: session?.id ?? null,
      updatedAt: session?.updated_at || session?.created_at || '',
    });
  }

  return contacts;
}

export function filterSimpleContacts(
  contacts: readonly SimpleContact[],
  query: string,
): SimpleContact[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...contacts];
  return contacts.filter((contact) => {
    const haystack =
      `${contact.name} ${contact.projectName} ${contact.preview}`.toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
