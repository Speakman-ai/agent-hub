/** Organization portfolio (linked project overview) and dispatched work, shared by web and mobile. */
import {
  rosterAgents,
  type OrganizationAgent,
  type OrganizationAgentApi,
  type OrganizationChat,
} from './organization-agents';

export interface OrganizationContextSource {
  serverId: string;
  organizationId: string;
  projectId: string;
  projectName: string;
  record: string;
}
export interface PortfolioProject {
  id: string;
  name: string;
  source: OrganizationContextSource;
  timestamp: string | null;
  agents: { id: string; name: string; role: string | null }[];
  agentCount: number;
  agentsTruncated: boolean;
  board: {
    columns: { name: string; count: number }[];
    openCards: number;
    totalCards: number;
    epics: number;
    phases: number;
  };
  wiki: { pages: number; updatedAt: string | null };
  sessions: { own: number; updatedAt: string | null };
}
export interface PortfolioOverview {
  serverId: string;
  organizationId: string;
  retrievedAt: string;
  offset: number;
  nextOffset: number | null;
  projects: PortfolioProject[];
}
export type OrganizationDispatchStatus =
  | 'queued'
  | 'starting'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'revoked'
  | 'expired';
export interface OrganizationDispatch {
  requestId: string;
  status: OrganizationDispatchStatus;
  code: string | null;
  message: string | null;
  serverId: string;
  organizationId: string;
  organizationAgentId: string;
  initiatingSessionId: string;
  projectId: string;
  agentId: string;
  name: string;
  sessionId: string | null;
  ref: string | null;
  sessionState: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  replayed?: boolean;
}
export interface DispatchInput {
  projectId: string;
  agentId: string;
  prompt: string;
}

/** Overview page size requested by the API client. */
export const PORTFOLIO_PAGE_SIZE = 20;

type Request = (path: string, options?: { method?: string; body?: string }) => Promise<any>;
export function createOrganizationPortfolioApi(request: Request) {
  const base = (id: string) => `/organizations/${encodeURIComponent(id)}`;
  return {
    overview: (id: string, offset = 0): Promise<PortfolioOverview> =>
      request(`${base(id)}/context?offset=${offset}&limit=${PORTFOLIO_PAGE_SIZE}`),
    dispatches: (
      id: string,
    ): Promise<{ dispatches: OrganizationDispatch[]; nextOffset: number | null }> =>
      request(`${base(id)}/dispatches?limit=50`),
    dispatch: (
      id: string,
      sessionId: string,
      body: DispatchInput & { idempotencyKey: string },
    ): Promise<OrganizationDispatch> =>
      request(`${base(id)}/sessions/${encodeURIComponent(sessionId)}/dispatches`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  };
}
export type OrganizationPortfolioApi = ReturnType<typeof createOrganizationPortfolioApi>;

export type DispatchDisplayState = 'pending' | 'running' | 'completed' | 'failed';
const RUNNING_SESSION_STATES = new Set(['working', 'running_tests', 'reviewing', 'pending_checks']);

/** The four states users see. A started session counts as running until its turn settles. */
export function dispatchDisplayState(dispatch: OrganizationDispatch): DispatchDisplayState {
  switch (dispatch.status) {
    case 'queued':
    case 'starting':
      return 'pending';
    case 'accepted':
      return !dispatch.sessionState || RUNNING_SESSION_STATES.has(dispatch.sessionState)
        ? 'running'
        : 'completed';
    default:
      return 'failed';
  }
}
export const DISPATCH_STATE_LABELS: Record<DispatchDisplayState, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};
export function dispatchDetail(dispatch: OrganizationDispatch): string {
  if (dispatch.status === 'queued') return 'Waiting for the target agent to finish earlier work.';
  if (dispatchDisplayState(dispatch) !== 'failed') return '';
  return dispatch.message || 'The target session could not start.';
}

/** Agents a member can dispatch from: active, with the dispatch tool, scoped to some project. */
export function dispatchSourceAgents(agents: OrganizationAgent[]): OrganizationAgent[] {
  return rosterAgents(agents).filter(
    (a) => a.organizationScope.enabled && a.organizationScope.tools.includes('dispatch'),
  );
}
/** Projects the source agent may dispatch into, in portfolio order. */
export function dispatchTargetProjects(
  projects: PortfolioProject[],
  source: OrganizationAgent | null | undefined,
): PortfolioProject[] {
  if (!source) return [];
  const allowed = source.effectiveProjectIds;
  return allowed ? projects.filter((p) => allowed.includes(p.id)) : projects;
}

/** The dispatch form's fields. Held by the controller so a reload or remount keeps them. */
export interface DispatchDraft {
  sourceId: string;
  projectId: string;
  agentId: string;
  prompt: string;
}
const emptyDraft: DispatchDraft = { sourceId: '', projectId: '', agentId: '', prompt: '' };

export interface OrganizationPortfolioState {
  organizationId: string | null;
  projects: PortfolioProject[];
  nextOffset: number | null;
  retrievedAt: string | null;
  agents: OrganizationAgent[];
  chats: OrganizationChat[];
  dispatches: OrganizationDispatch[];
  busy: boolean;
  ready: boolean;
  error: string;
  // Operation state: owned by the dispatch attempt and the user, never touched by reads.
  dispatching: boolean;
  dispatchError: string;
  draft: DispatchDraft;
}
type ServerState = Omit<OrganizationPortfolioState, 'dispatching' | 'dispatchError' | 'draft'>;
/** Server-derived state only. Reads and revocation reset this, never the operation state. */
const emptyServer = (organizationId: string | null): ServerState => ({
  organizationId,
  projects: [],
  nextOffset: null,
  retrievedAt: null,
  agents: [],
  chats: [],
  dispatches: [],
  busy: false,
  ready: false,
  error: '',
});
const empty = (organizationId: string | null = null): OrganizationPortfolioState => ({
  ...emptyServer(organizationId),
  dispatching: false,
  dispatchError: '',
  draft: emptyDraft,
});
const staleState = empty();

function newKey(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `ui-${random}`;
}
const statusOf = (error: unknown) =>
  typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : null;
function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

type Snapshot = Pick<
  OrganizationPortfolioState,
  'projects' | 'nextOffset' | 'retrievedAt' | 'dispatches' | 'agents' | 'chats'
>;

/**
 * Scoped to one Server connection + account + organization, like the agents controller: every
 * async result is applied only if the scope and the view's lifetime still hold, so a reply that
 * lands after a Server or organization switch is dropped.
 *
 * Server data has exactly one writer, `read`: every read (initial load, poll, "load more", the
 * follow-up to a dispatch) fetches projects, agents, chats and dispatches together under a new
 * generation, and a result is applied only if no newer read started after it was requested. So an
 * older response can never reintroduce data a newer authorization snapshot removed, and each list
 * is taken verbatim from the server, which already filters it by current access. Paging is just a
 * larger snapshot. Only reads take generations, and a read that supersedes a loading read takes
 * over its loading state, so the newest read always settles `busy`/`ready`.
 *
 * A dispatch is one pending operation per user intent (source agent, project, agent, task). Its
 * initiating chat and idempotency key are fixed on the first attempt and reused by every retry
 * until the server accepts it, independent of refreshed chat history. So a double tap, a lost
 * response or a retry while a refresh is pending returns the same request, never a second one.
 */
export class OrganizationPortfolioController {
  state: OrganizationPortfolioState;
  private generation = 0;
  private lifetime = 0;
  private listeners = new Set<() => void>();
  private pending: { intent: string; key: string; chatId: string | null } | null = null;
  // The one dispatch attempt in flight. Only that attempt may release it.
  private attempt: object | null = null;
  // Reads started and not yet settled (applied, dropped or failed).
  private reads = 0;
  // Accepted requests not yet seen in an applied snapshot. Ids only, never shown.
  private accepted = new Set<string>();
  constructor(
    private api: OrganizationPortfolioApi,
    private agentsApi: OrganizationAgentApi,
    private getScope: () => string,
    readonly organizationId: string,
    private scope = getScope(),
  ) {
    this.state = empty(organizationId);
  }
  snapshot = () => (this.getScope() === this.scope ? this.state : staleState);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  cancel = () => {
    this.lifetime++;
  };
  private publish(patch: Partial<OrganizationPortfolioState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private alive(): () => boolean {
    const lifetime = this.lifetime;
    return () => this.lifetime === lifetime && this.scope === this.getScope();
  }
  /** Claim the newest generation; the returned check fails once anything newer starts. */
  private claim(): () => boolean {
    const alive = this.alive();
    const generation = ++this.generation;
    return () => alive() && generation === this.generation;
  }
  /** Access lost: drop everything the caller can no longer read. */
  private revoked(error: unknown) {
    this.accepted.clear();
    this.publish({
      ...emptyServer(this.organizationId),
      ready: true,
      error: message(error, 'This organization is no longer available.'),
    });
  }
  /** Every overview page needed to show at least `count` projects, plus the other lists. */
  private async fetchSnapshot(count: number): Promise<Snapshot> {
    const pages = async () => {
      let page = await this.api.overview(this.organizationId);
      const projects = [...page.projects];
      while (page.nextOffset !== null && projects.length < count) {
        page = await this.api.overview(this.organizationId, page.nextOffset);
        projects.push(...page.projects.filter((p) => !projects.some((q) => q.id === p.id)));
      }
      return { projects, nextOffset: page.nextOffset, retrievedAt: page.retrievedAt };
    };
    const [overview, dispatches, agents, chats] = await Promise.all([
      pages(),
      this.api.dispatches(this.organizationId),
      this.agentsApi.list(this.organizationId),
      this.agentsApi.chats(this.organizationId),
    ]);
    return {
      ...overview,
      dispatches: dispatches.dispatches,
      agents: agents.agents,
      chats: chats.sessions,
    };
  }
  /** The single writer of server data. `reset` hides current data while it loads; a read that
   * starts while another is loading inherits that, since the older one can no longer settle it. */
  private async read(count: number, reset: boolean) {
    if (!this.alive()()) return;
    const current = this.claim();
    this.reads++;
    reset = reset || this.state.busy || !this.state.ready;
    if (reset) this.publish({ ...emptyServer(this.organizationId), busy: true });
    try {
      const snapshot = await this.fetchSnapshot(count);
      if (!current()) return;
      // Every applied snapshot was requested after any acceptance it supersedes.
      this.accepted.clear();
      this.publish({ ...snapshot, busy: false, ready: true, error: '' });
    } catch (error) {
      if (!current()) return;
      if (statusOf(error) === 404 || statusOf(error) === 403) this.revoked(error);
      else if (reset)
        this.publish({
          busy: false,
          error: message(error, 'Could not load the organization portfolio. Retry.'),
        });
      // A failed poll keeps the last authorized snapshot; the next poll retries.
    } finally {
      this.reads--;
    }
  }
  /** First page, never showing the previous organization's or permission level's data. */
  load() {
    return this.read(PORTFOLIO_PAGE_SIZE, true);
  }
  /** Quiet re-read of everything shown, keeping the pages the user expanded. */
  refresh() {
    if (!this.state.ready || this.state.busy) return Promise.resolve();
    return this.read(Math.max(this.state.projects.length, PORTFOLIO_PAGE_SIZE), false);
  }
  /**
   * Timer tick. Unlike an explicit refresh it never supersedes a read still running: with reads
   * slower than the interval, every tick would otherwise drop the one before and nothing would
   * ever be applied. The running read is newer than the previous tick anyway.
   */
  poll() {
    if (this.reads > 0) return Promise.resolve();
    return this.refresh();
  }
  /** One more overview page, fetched as part of a whole new snapshot. */
  loadMore() {
    if (!this.state.ready || this.state.busy || this.state.nextOffset === null)
      return Promise.resolve();
    return this.read(this.state.projects.length + PORTFOLIO_PAGE_SIZE, false);
  }
  /** Follow-up read after a dispatch: always runs, inheriting a pending load if there is one. */
  private reread() {
    return this.read(Math.max(this.state.projects.length, PORTFOLIO_PAGE_SIZE), false);
  }
  hasLiveDispatches(): boolean {
    return (
      this.accepted.size > 0 ||
      this.state.dispatches.some((d) => {
        const state = dispatchDisplayState(d);
        return state === 'pending' || state === 'running';
      })
    );
  }
  /** The pending operation for this intent, or a new one (a changed intent is a new request). */
  private pendingFor(intent: string) {
    if (this.pending?.intent !== intent) this.pending = { intent, key: newKey(), chatId: null };
    return this.pending;
  }
  /** Edit the dispatch form. Lives here so a reload (which remounts the form) keeps it. */
  setDraft(patch: Partial<DispatchDraft>) {
    this.publish({ draft: { ...this.state.draft, ...patch } });
  }
  /**
   * Dispatch from the caller's most recent chat with `sourceAgentId`, starting one if none
   * exists. Returns the server's view of the request, or null. Only one attempt runs at a time;
   * it holds the lock across reloads and only it releases it. On acceptance the task is cleared
   * from the draft (if the user has not edited it meanwhile), so the same text is not sent again
   * under a fresh key. The organization chat itself is never blocked by the outcome.
   */
  async dispatch(sourceAgentId: string, input: DispatchInput) {
    const alive = this.alive();
    if (this.attempt || this.state.busy || !this.state.ready || !alive()) return null;
    const prompt = input.prompt.trim();
    if (!prompt || !input.projectId || !input.agentId) return null;
    const attempt = {};
    this.attempt = attempt;
    this.publish({ dispatching: true, dispatchError: '' });
    try {
      const body = { projectId: input.projectId, agentId: input.agentId, prompt };
      const op = this.pendingFor(JSON.stringify([sourceAgentId, body]));
      if (!op.chatId)
        op.chatId =
          this.state.chats.find((c) => c.agentId === sourceAgentId && c.agentAvailable)?.id ?? null;
      if (!op.chatId) {
        const started = await this.agentsApi.startChat(this.organizationId, sourceAgentId);
        if (!alive()) return null;
        const chatId = started.session?.id;
        if (typeof chatId !== 'string' || !chatId) throw new Error('Could not start a chat');
        op.chatId = chatId;
      }
      const view = await this.api.dispatch(this.organizationId, op.chatId, {
        ...body,
        idempotencyKey: op.key,
      });
      if (!alive()) return null;
      if (this.pending === op) this.pending = null;
      const draft = this.state.draft;
      const sameTask =
        draft.prompt.trim() === prompt &&
        draft.projectId === input.projectId &&
        draft.agentId === input.agentId &&
        (!draft.sourceId || draft.sourceId === sourceAgentId);
      // Server data is written only by authorized snapshot reads, never from this response:
      // access may have been revoked while it was in flight. A new read supersedes every read
      // still running (so none can hide this request) and takes over a pending load. Until a
      // snapshot lands, the accepted id (not its data) keeps polling fast.
      this.accepted.add(view.requestId);
      void this.reread();
      if (sameTask) this.publish({ draft: { ...draft, prompt: '' } });
      return view;
    } catch (error) {
      if (!alive()) return null;
      // The chat itself is gone (archived agent, lost access): nothing was recorded under it,
      // so the next attempt may use another chat.
      if ((error as { code?: unknown })?.code === 'session_not_found' && this.pending)
        this.pending.chatId = null;
      this.publish({
        dispatchError: message(error, 'Dispatch failed. Retry; a retry never starts it twice.'),
      });
      // Refused requests are recorded server-side; show them in the list.
      void this.reread();
      return null;
    } finally {
      // Released only by its own attempt, however it ended (including a dropped result).
      if (this.attempt === attempt) {
        this.attempt = null;
        this.publish({ dispatching: false });
      }
    }
  }
}
