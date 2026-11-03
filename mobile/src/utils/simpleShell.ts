import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isNeedsInputKind,
  liveNeedsInputKind,
  resolveSessionState,
  DEFAULT_SESSION_STATE,
} from '@shared/utils/sessionState';

/**
 * Roles that stay off the simple contact list. The Server Agent is pinned
 * separately and is not one of these rows.
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

export const SHELL_MODE_KEY = 'agenthub.shellMode';
export const SIMPLE_ROSTER_ORDER_KEY = 'agenthub.simpleRosterOrder';
export const SIMPLE_ORG_ORDER_KEY = 'agenthub.simpleOrgOrder';
export const SIMPLE_PROJECT_ORDER_KEY = 'agenthub.simpleProjectOrder';

export type ShellMode = 'hub' | 'simple';
export type SimpleContactStatus = 'working' | 'needs-you' | 'idle';

export type SimpleAgent = {
  id: string;
  name?: string | null;
  color?: string | null;
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
  state?: string | null;
  finalize_status?: string | null;
  needs_input?: unknown;
  needs_input_at?: unknown;
};

export type SimpleContact = {
  agentId: string;
  name: string;
  projectId: string;
  projectName: string;
  color: string;
  preview: string;
  status: SimpleContactStatus;
  sessionId: string | null;
  updatedAt: string;
};

export type SimpleStatusSignals = {
  activeTaskSessionIds?: Readonly<Record<string, unknown>>;
  finalizeStatusBySession?: Readonly<Record<string, string | null | undefined>>;
  needsInputBySession?: Parameters<typeof liveNeedsInputKind>[1];
};

export const SIMPLE_SESSION_KEY_PREFIX = 'agenthub.simpleSession:';
/** Where Full Hub returns to: the session open when the simple view was entered. */
export const PRE_SIMPLE_TARGET_KEY = 'agenthub.preSimpleTarget';

export type PreSimpleTarget = { agentId: string; sessionId: string };

export function simpleSessionKey(agentId: string): string {
  return `${SIMPLE_SESSION_KEY_PREFIX}${agentId}`;
}

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
 * must open in the full app, or build turns would go out with the build
 * controls hidden. An unknown row is usually a target still loading.
 */
export function simpleShellMustLeaveFor(
  session: Pick<SimpleSession, 'session_mode' | 'sidebar_parent_id' | 'cron_id'> | null | undefined,
): boolean {
  if (!session) return false;
  return !isSimpleConsultSession(session);
}

export async function readShellMode(): Promise<ShellMode> {
  try {
    const value = await AsyncStorage.getItem(SHELL_MODE_KEY);
    return value === 'simple' ? 'simple' : 'hub';
  } catch {
    return 'hub';
  }
}

export async function writeShellMode(mode: ShellMode): Promise<void> {
  try {
    await AsyncStorage.setItem(SHELL_MODE_KEY, mode);
  } catch {
    // The route still changes when storage is unavailable.
  }
}

export async function readSimpleRosterOrder(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(SIMPLE_ROSTER_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function writeSimpleRosterOrder(ids: readonly string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SIMPLE_ROSTER_ORDER_KEY, JSON.stringify(ids));
  } catch {
    // Order still applies for this visit.
  }
}

export async function readSimpleOrgOrder(): Promise<string[]> {
  return readIdList(SIMPLE_ORG_ORDER_KEY);
}

export async function writeSimpleOrgOrder(ids: readonly string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SIMPLE_ORG_ORDER_KEY, JSON.stringify(ids));
  } catch {
    // Order still applies for this visit.
  }
}

export async function readSimpleProjectOrder(): Promise<Record<string, string[]>> {
  try {
    const raw = await AsyncStorage.getItem(SIMPLE_PROJECT_ORDER_KEY);
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

export async function writeSimpleProjectOrder(
  order: Readonly<Record<string, readonly string[]>>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(SIMPLE_PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Order still applies for this visit.
  }
}

async function readIdList(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function readSimpleSessionId(agentId: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(simpleSessionKey(agentId));
  } catch {
    return null;
  }
}

export async function writeSimpleSessionId(agentId: string, sessionId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(simpleSessionKey(agentId), sessionId);
  } catch {
    // The chat is already open.
  }
}

/**
 * Record where Full Hub should return when the user enters the simple view
 * from the full app. One target for the whole shell, not per agent: the
 * Server Agent and every chat change the active agent, so a key on the agent
 * active at exit would miss. Entering from a consult or Hub thread clears it.
 */
export async function rememberPreSimpleTarget(
  agentId: string | null | undefined,
  sessionId: string | null | undefined,
  sessionMode: string | null | undefined,
): Promise<void> {
  try {
    if (!agentId || !sessionId || sessionMode === 'consult' || sessionMode === 'hub') {
      await AsyncStorage.removeItem(PRE_SIMPLE_TARGET_KEY);
      return;
    }
    await AsyncStorage.setItem(PRE_SIMPLE_TARGET_KEY, JSON.stringify({ agentId, sessionId }));
  } catch {
    // Full Hub still opens; it just keeps the current thread.
  }
}

/** Read and clear the session Full Hub should restore. */
export async function takePreSimpleTarget(): Promise<PreSimpleTarget | null> {
  try {
    const raw = await AsyncStorage.getItem(PRE_SIMPLE_TARGET_KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(PRE_SIMPLE_TARGET_KEY);
    const parsed = JSON.parse(raw);
    if (typeof parsed?.agentId !== 'string' || typeof parsed?.sessionId !== 'string') return null;
    return { agentId: parsed.agentId, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

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

function deriveSimpleSessionState(session: SimpleSession, signals: SimpleStatusSignals): string {
  const activeTaskSessionIds = signals.activeTaskSessionIds ?? {};
  const finalizeStatusBySession = signals.finalizeStatusBySession ?? {};
  const hasActiveTask = !!activeTaskSessionIds[session.id];
  const liveFinalize = finalizeStatusBySession[session.id];
  const finalizeStatus = liveFinalize ?? session.finalize_status ?? null;
  const merged = session.state === 'merged';
  const kind = liveNeedsInputKind(session, signals.needsInputBySession);
  const needsInput = isNeedsInputKind(kind) ? kind : null;
  const derived = resolveSessionState({ finalizeStatus, hasActiveTask, merged, needsInput });
  if (
    derived === DEFAULT_SESSION_STATE &&
    !hasActiveTask &&
    liveFinalize == null &&
    session.state &&
    session.state !== DEFAULT_SESSION_STATE &&
    session.state !== 'needs_input'
  ) {
    return session.state;
  }
  return derived;
}

export function sessionShowsNeedsYou(
  session: SimpleSession,
  signals: SimpleStatusSignals = {},
): boolean {
  return deriveSimpleSessionState(session, signals) === 'needs_input';
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
  sessionsByAgentId?: Readonly<Record<string, readonly SimpleSession[] | undefined>>;
  activeTaskSessionIds?: Readonly<Record<string, unknown>>;
  finalizeStatusBySession?: Readonly<Record<string, string | null | undefined>>;
  needsInputBySession?: SimpleStatusSignals['needsInputBySession'];
  rememberedSessionIds?: Readonly<Record<string, string | null | undefined>>;
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
    const sessions = cached[agent.id] ?? [];
    const consults = sessions.filter(isSimpleConsultSession);
    const session = preferredSimpleSession(consults, input.rememberedSessionIds?.[agent.id]);
    const projectName = agent.projectName?.trim() || '';
    const status = simpleContactStatus(sessions, signals);
    contacts.push({
      agentId: agent.id,
      name: agent.name?.trim() || 'Agent',
      projectId: agent.projectId?.trim() || agent.id,
      projectName,
      color: agent.color || '#6b7280',
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
