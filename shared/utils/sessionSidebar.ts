/**
 * SideBar: one side conversation per session, backed by a hidden Consult-mode
 * child session on the server. Web and mobile route every WS event for a
 * SideBar session to the SideBar panel instead of the main chat, so SideBar
 * turns never stream into the main transcript or raise "session finished"
 * toasts. The server tags those events with `sidebarParentId`.
 */

export const SIDEBAR_WS_EVENT = 'agenthub:sidebar-ws';

export interface SidebarMessage {
  id: string;
  role: string;
  content: string;
  /** Local optimistic user message not yet echoed by the server. */
  pending?: boolean;
  /** Our question that a server snapshot proved never arrived. Retryable. */
  failed?: boolean;
}

/** Session id a WS payload is about (`message` events carry it on the row). */
export function wsEventSessionId(data: any): string | null {
  if (typeof data?.sessionId === 'string' && data.sessionId) return data.sessionId;
  const sid = data?.message?.session_id;
  return typeof sid === 'string' && sid ? sid : null;
}

/** True when App.tsx should hand this event to the SideBar and skip the main chat. */
export function isSidebarWsEvent(data: any, sidebarIds: ReadonlySet<string>): boolean {
  if (data?.type === 'sidebar_opened' || data?.type === 'sidebar_closed') return true;
  // The server tags every event about a SideBar session, so routing works even
  // before (or without) the panel registering the id, e.g. after a reload.
  if (typeof data?.sidebarParentId === 'string' && data.sidebarParentId) return true;
  const sid = wsEventSessionId(data);
  return sid !== null && sidebarIds.has(sid);
}

/** Upsert into a conversation, recording which of our questions it confirmed. */
function upsertInto(conv: SidebarConversation, msg: SidebarMessage): SidebarConversation {
  const before = conv.messages;
  const messages = upsertMessage(before, msg);
  if (messages === before) return conv;
  const gone = before.filter(
    (m) => (m.pending || m.failed) && !messages.some((x) => x.id === m.id),
  );
  return gone.length
    ? { ...conv, messages, confirmed: [...conv.confirmed, ...gone.map((m) => m.id)] }
    : { ...conv, messages };
}

function upsertMessage(messages: SidebarMessage[], msg: SidebarMessage): SidebarMessage[] {
  if (messages.some((m) => m.id === msg.id)) return messages;
  if (msg.role === 'user') {
    // Replace our local copy of the same question (still pending, or marked
    // undelivered before a late echo) instead of doubling it.
    const idx = messages.findIndex((m) => (m.pending || m.failed) && m.content === msg.content);
    if (idx !== -1) {
      const next = messages.slice();
      next[idx] = msg;
      return next;
    }
  }
  return [...messages, msg];
}

function toSidebarMessage(raw: any): SidebarMessage | null {
  if (!raw || typeof raw.id !== 'string') return null;
  return { id: raw.id, role: String(raw.role ?? ''), content: String(raw.content ?? '') };
}

/** Plain Enter sends; Shift+Enter and IME candidate confirmation do not. */
export function isSidebarSubmitKey(e: {
  key: string;
  shiftKey?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return false;
  return true;
}

/*
 * Panel state machine shared by the web pane and the mobile sheet.
 *
 * Every piece of state is scoped to what it is about, and every input names
 * its target, so a result about one thing can never land on another:
 *
 * - Conversation state (messages, streaming, running turn, history load,
 *   errors) lives in `conv`, which belongs to exactly one SideBar id (or to
 *   the draft before one exists). Replacing the SideBar replaces `conv`.
 * - Which SideBar is current changes only through two server facts, applied
 *   monotonically: `opened(id, seq)` and `closed(ids)`. An id once closed is
 *   never adopted again; an open older (lower per-parent `sidebar_seq`) than
 *   one already seen is ignored. Each replacement bumps `lifecycleVersion`.
 * - A lookup applies only if `lifecycleVersion` is unchanged since it started
 *   (otherwise newer facts already decided). A history load or failure
 *   applies only to the `conv` with the same id and request token.
 * - An operation carries its own `opId`. Settling it touches the op, the
 *   facts its response names, and the question it created, never the
 *   current SideBar's turn state.
 * - `busy` is derived: a turn the server says is running (`turnRunning`,
 *   set only by turn events and the lookup's `running` snapshot when no
 *   newer turn event was seen) or a question of ours awaiting its echo.
 * - No event about this parent's SideBars is ever dropped for arriving
 *   "early": what the panel considers current can lag the server (a lookup
 *   in flight, a replacement not adopted yet), so chat events for any other
 *   not-closed SideBar are held and replayed whenever it is adopted.
 * - Each of our questions has one lifecycle in the `questions` ledger:
 *   pending -> delivered (terminal) | undelivered -> (Retry) pending, or
 *   discarded (terminal) when this tab starts over. Confirmation comes only
 *   from the server (echo or history); every failure path checks the ledger
 *   and can only demote a question that is still pending.
 * - A question's text is never discarded. Any failed send (first try or a
 *   retry, over WS or via an open) marks that same message undelivered in
 *   place; Retry re-sends it in place. Unsent questions also survive the
 *   SideBar being replaced from elsewhere (they move over, undelivered).
 * - Optimistic state always settles. A loaded history is authoritative for
 *   our own questions too: each pending question is either matched to its
 *   persisted row or marked undelivered (text kept, retryable). Nothing local
 *   waits on an echo that a snapshot already proved will not come.
 */

export type SidebarPhase = 'loading' | 'ready' | 'load_error';
export type SidebarOp = 'open' | 'fresh' | 'discard';
type HistoryState = 'none' | 'loading' | 'loaded' | 'failed';

export interface SidebarConversation {
  /** SideBar this conversation belongs to; null is the draft before one exists. */
  id: string | null;
  messages: SidebarMessage[];
  streamingContent: string;
  turnRunning: boolean;
  /** Local id of our question awaiting its echo or turn start. */
  pendingQuestionId: string | null;
  /** Our questions this conversation confirmed delivered (flushed to the ledger). */
  confirmed: string[];
  /** A turn event arrived since the current lookup started. */
  turnEventSeen: boolean;
  error: string | null;
  history: HistoryState;
  historyToken: number;
  historyError: string | null;
}

/**
 * Lifecycle of one of our questions. `delivered` and `discarded` are terminal:
 * nothing moves a question out of them, so a late failure can never resurrect
 * a question the server already confirmed.
 */
export type SidebarQuestionStatus = 'pending' | 'delivered' | 'undelivered' | 'discarded';

export interface SidebarQuestion {
  content: string;
  status: SidebarQuestionStatus;
}

export interface SidebarPendingOp {
  opId: number;
  op: SidebarOp;
  /** The question an `open` carries (its text lives in the ledger). */
  questionId: string | null;
  /** `lifecycleVersion` when the op started: which conversation it targets. */
  targetVersion: number;
}

export interface SidebarPanelState {
  parentSessionId: string;
  conv: SidebarConversation;
  loadToken: number;
  lookup: 'loading' | 'done' | 'failed';
  lookupError: string | null;
  lookupVersion: number;
  lifecycleVersion: number;
  pendingOp: SidebarPendingOp | null;
  /** Panel-level notice from an operation (not tied to a conversation). */
  notice: string | null;
  /**
   * Chat events for this parent about a SideBar that is not the current
   * conversation (yet). Replayed when that SideBar is adopted, by any path;
   * dropped when it is closed.
   */
  buffered: any[];
  closedIds: string[];
  maxSeq: number;
  maxSeqId: string | null;
  /** Ledger of our questions by local id; outlives conversation swaps. */
  questions: Record<string, SidebarQuestion>;
}

export type SidebarAction =
  | { type: 'load_start'; token: number; parentSessionId: string }
  | {
      type: 'load_result';
      token: number;
      sidebarId: string | null;
      seq?: number | null;
      running: boolean;
    }
  | { type: 'history'; token: number; sidebarId: string; messages: any[] }
  | { type: 'history_failed'; token: number; sidebarId: string; error: string }
  | { type: 'load_failed'; token: number; error: string }
  | { type: 'ws'; data: any }
  | { type: 'ask_local'; questionId: string; content: string }
  | { type: 'ask_failed'; questionId: string; error: string }
  /** Re-send an undelivered question in place (same message, back to pending). */
  | { type: 'question_retry'; questionId: string }
  | {
      type: 'op_start';
      opId: number;
      op: SidebarOp;
      questionId?: string | null;
    }
  | {
      type: 'op_opened';
      opId: number;
      sidebarId: string;
      seq?: number | null;
      closedIds?: string[];
    }
  | { type: 'op_discarded'; opId: number; closedIds?: string[] }
  | { type: 'op_failed'; opId: number; error: string };

/** What the UI renders. */
export interface SidebarView {
  sidebarId: string | null;
  messages: SidebarMessage[];
  streamingContent: string;
  busy: boolean;
  error: string | null;
  phase: SidebarPhase;
  loadError: string | null;
  pendingOp: SidebarOp | null;
}

const MAX_BUFFERED_EVENTS = 500;
const MAX_CLOSED_IDS = 200;

export const SIDEBAR_REPLACED_ERROR =
  'The SideBar was replaced in another window before your question ran. Ask again.';

function emptyConversation(id: string | null, history: HistoryState = 'none'): SidebarConversation {
  return {
    id,
    messages: [],
    streamingContent: '',
    turnRunning: false,
    pendingQuestionId: null,
    confirmed: [],
    turnEventSeen: false,
    error: null,
    history,
    historyToken: 0,
    historyError: null,
  };
}

export function initialSidebarPanelState(parentSessionId: string): SidebarPanelState {
  return {
    parentSessionId,
    conv: emptyConversation(null),
    loadToken: 0,
    lookup: 'loading',
    lookupError: null,
    lookupVersion: 0,
    lifecycleVersion: 0,
    pendingOp: null,
    notice: null,
    buffered: [],
    closedIds: [],
    maxSeq: 0,
    maxSeqId: null,
    questions: {},
  };
}

export function sidebarView(state: SidebarPanelState): SidebarView {
  const { conv } = state;
  const phase: SidebarPhase =
    state.lookup === 'failed' || conv.history === 'failed'
      ? 'load_error'
      : state.lookup === 'loading' || conv.history === 'loading'
        ? 'loading'
        : 'ready';
  return {
    sidebarId: conv.id,
    messages: conv.messages,
    streamingContent: conv.streamingContent,
    busy: conv.turnRunning || conv.pendingQuestionId !== null,
    error: state.notice ?? conv.error,
    phase,
    loadError: state.lookup === 'failed' ? state.lookupError : conv.historyError,
    pendingOp: state.pendingOp?.op ?? null,
  };
}

/** Whether the user may ask a question right now. */
export function canAskSidebar(state: SidebarPanelState): boolean {
  const view = sidebarView(state);
  return view.phase === 'ready' && state.pendingOp === null && !view.busy;
}

const seqOf = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

function isStaleOpen(state: SidebarPanelState, id: string, seq: number | null): boolean {
  if (state.closedIds.includes(id)) return true;
  if (state.conv.id === id || state.maxSeqId === id) return false;
  return seq !== null && seq <= state.maxSeq;
}

function withSeq(state: SidebarPanelState, id: string, seq: number | null): SidebarPanelState {
  return seq !== null && seq > state.maxSeq ? { ...state, maxSeq: seq, maxSeqId: id } : state;
}

/**
 * The only way the current conversation changes. Replays any chat events held
 * for the newly current SideBar, so they land on top of whatever snapshot
 * seeded it (e.g. a `done` that beat the lookup response clears `running`).
 *
 * Our own unsent questions (pending or undelivered) are not lost with the old
 * conversation: they move over, marked undelivered, unless this tab is the one
 * starting over (its own New or Discard).
 */
function replaceConversation(
  state: SidebarPanelState,
  conv: SidebarConversation,
): SidebarPanelState {
  let next = conv;
  let questions = state.questions;
  const startingOver = state.pendingOp?.op === 'fresh' || state.pendingOp?.op === 'discard';
  const present = new Set(conv.messages.map((m) => m.id));
  const left = state.conv.messages.filter((m) => (m.pending || m.failed) && !present.has(m.id));
  if (startingOver) {
    questions = setStatuses(
      questions,
      left.map((m) => m.id),
      'discarded',
    );
  } else {
    const unsent = left.filter((m) => {
      const status = questions[m.id]?.status;
      return status === 'pending' || status === 'undelivered';
    });
    if (unsent.length) {
      next = {
        ...next,
        messages: [
          ...next.messages,
          ...unsent.map((m) => ({ ...m, pending: false, failed: true })),
        ],
      };
    }
  }
  let buffered = state.buffered;
  if (conv.id) {
    const mine = buffered.filter((ev) => wsEventSessionId(ev) === conv.id);
    if (mine.length) {
      buffered = buffered.filter((ev) => wsEventSessionId(ev) !== conv.id);
      for (const ev of mine) next = applyChatEvent(next, ev);
    }
  }
  return {
    ...state,
    conv: next,
    buffered,
    questions,
    lifecycleVersion: state.lifecycleVersion + 1,
  };
}

function setStatuses(
  questions: Record<string, SidebarQuestion>,
  ids: readonly string[],
  status: SidebarQuestionStatus,
): Record<string, SidebarQuestion> {
  let next = questions;
  for (const id of ids) {
    const q = next[id];
    if (!q || q.status === status) continue;
    next = { ...next, [id]: { ...q, status } };
  }
  return next;
}

/** Fact: the server archived these SideBars. */
function applyClosed(state: SidebarPanelState, ids: readonly string[]): SidebarPanelState {
  const fresh = ids.filter((id) => typeof id === 'string' && id && !state.closedIds.includes(id));
  if (fresh.length === 0) return state;
  const next = {
    ...state,
    closedIds: [...state.closedIds, ...fresh].slice(-MAX_CLOSED_IDS),
    buffered: state.buffered.filter((ev) => !fresh.includes(wsEventSessionId(ev) ?? '')),
  };
  if (next.conv.id && fresh.includes(next.conv.id)) {
    return replaceConversation(next, emptyConversation(null));
  }
  return next;
}

/**
 * Fact: the server created this SideBar. A brand-new SideBar has no history to
 * load. The draft (our first question) moves into it only when `carryDraft`.
 */
function applyOpened(
  state: SidebarPanelState,
  id: string,
  seq: number | null,
  carryDraft: boolean,
): { state: SidebarPanelState; adopted: boolean } {
  if (isStaleOpen(state, id, seq)) return { state, adopted: false };
  if (state.conv.id === id) return { state: withSeq(state, id, seq), adopted: true };
  const draft = state.conv.id === null && carryDraft ? state.conv : null;
  const conv: SidebarConversation = draft
    ? { ...draft, id, history: 'none' }
    : emptyConversation(id);
  return { state: replaceConversation(withSeq(state, id, seq), conv), adopted: true };
}

/**
 * Our question did not get through: keep it, marked undelivered, so the user
 * can retry it. Only a question still `pending` in the ledger can be demoted;
 * one already delivered (or discarded) is left alone, never resurrected. When
 * its message is not in this conversation (the draft it lived in was
 * replaced), it is re-added from the ledger's text.
 */
function markUndelivered(state: SidebarPanelState, questionId: string): SidebarPanelState {
  const q = state.questions[questionId];
  if (!q || q.status !== 'pending') return state;
  const conv = state.conv;
  const pendingQuestionId = conv.pendingQuestionId === questionId ? null : conv.pendingQuestionId;
  const messages = conv.messages.some((m) => m.id === questionId)
    ? conv.messages.map((m) => (m.id === questionId ? { ...m, pending: false, failed: true } : m))
    : [
        ...conv.messages,
        { id: questionId, role: 'user', content: q.content, pending: false, failed: true },
      ];
  return {
    ...state,
    questions: { ...state.questions, [questionId]: { ...q, status: 'undelivered' } },
    conv: { ...conv, pendingQuestionId, messages },
  };
}

/**
 * Fold what the conversation learned into the ledger, once per action:
 * server-confirmed questions become `delivered`; a pending question whose
 * message history proved missing (now marked failed) becomes `undelivered`.
 * Terminal entries no operation still refers to are pruned.
 */
function syncLedger(state: SidebarPanelState): SidebarPanelState {
  const conv = state.conv;
  let questions = setStatuses(state.questions, conv.confirmed, 'delivered');
  const failedPending = conv.messages
    .filter((m) => m.failed && questions[m.id]?.status === 'pending')
    .map((m) => m.id);
  questions = setStatuses(questions, failedPending, 'undelivered');
  const keep = state.pendingOp?.questionId ?? null;
  let pruned = false;
  const kept: Record<string, SidebarQuestion> = {};
  for (const [id, q] of Object.entries(questions)) {
    if ((q.status === 'delivered' || q.status === 'discarded') && id !== keep) {
      pruned = true;
      continue;
    }
    kept[id] = q;
  }
  if (!pruned && questions === state.questions && conv.confirmed.length === 0) return state;
  return {
    ...state,
    questions: pruned ? kept : questions,
    conv: conv.confirmed.length ? { ...conv, confirmed: [] } : conv,
  };
}

/** Chat events for the current conversation. Only these set `turnRunning`. */
function applyChatEvent(conv: SidebarConversation, data: any): SidebarConversation {
  switch (data.type) {
    case 'thinking':
      return {
        ...conv,
        turnRunning: true,
        turnEventSeen: true,
        pendingQuestionId: null,
        error: null,
      };
    case 'stream':
      return {
        ...conv,
        turnRunning: true,
        turnEventSeen: true,
        pendingQuestionId: null,
        streamingContent: typeof data.content === 'string' ? data.content : conv.streamingContent,
      };
    case 'message':
    case 'message_added': {
      const msg = toSidebarMessage(data.message);
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system')) {
        return conv;
      }
      const next = upsertInto(conv, msg);
      const echoed =
        conv.pendingQuestionId !== null &&
        !next.messages.some((m) => m.id === conv.pendingQuestionId);
      return echoed ? { ...next, pendingQuestionId: null } : next;
    }
    case 'done': {
      const msg = toSidebarMessage(data.message);
      return {
        ...(msg ? upsertInto(conv, msg) : conv),
        turnRunning: false,
        turnEventSeen: true,
        pendingQuestionId: null,
        streamingContent: '',
      };
    }
    case 'error':
      return {
        ...conv,
        turnRunning: false,
        turnEventSeen: true,
        pendingQuestionId: null,
        streamingContent: '',
        error: typeof data.error === 'string' ? data.error : 'The SideBar turn failed.',
      };
    default:
      return conv;
  }
}

/**
 * History wins for anything it contains. A live message survives only if the
 * snapshot lacks it. Our pending questions settle here: one whose text matches
 * a persisted user row we had not seen yet was delivered (its WS echo was
 * missed) and folds into that row; one with no match never reached the server
 * and is marked undelivered so the user can retry it.
 */
function mergeHistory(conv: SidebarConversation, history: any[]): SidebarConversation {
  const fromHistory: SidebarMessage[] = [];
  for (const raw of history) {
    const msg = toSidebarMessage(raw);
    if (msg && (msg.role === 'user' || msg.role === 'assistant')) fromHistory.push(msg);
  }
  const historyIds = new Set(fromHistory.map((m) => m.id));
  const isLocal = (m: SidebarMessage) => m.pending || m.failed;
  const liveIds = new Set(conv.messages.filter((m) => !isLocal(m)).map((m) => m.id));
  const unseenUserRows = fromHistory.filter((m) => m.role === 'user' && !liveIds.has(m.id));
  let merged = fromHistory;
  let pendingQuestionId = conv.pendingQuestionId;
  const confirmed = [...conv.confirmed];
  for (const m of conv.messages) {
    if (historyIds.has(m.id)) continue;
    if (isLocal(m)) {
      // Pending or marked undelivered: the persisted row decides.
      const match = unseenUserRows.findIndex((h) => h.content === m.content);
      if (match !== -1) {
        unseenUserRows.splice(match, 1);
        if (pendingQuestionId === m.id) pendingQuestionId = null;
        confirmed.push(m.id);
        continue;
      }
      merged = [...merged, { ...m, pending: false, failed: true }];
      if (pendingQuestionId === m.id) pendingQuestionId = null;
      continue;
    }
    merged = upsertMessage(merged, m);
  }
  return { ...conv, messages: merged, pendingQuestionId, confirmed };
}

function applyWs(state: SidebarPanelState, data: any): SidebarPanelState {
  if (!data || typeof data !== 'object') return state;
  if (data.type === 'sidebar_opened') {
    const id = data.session?.id;
    if (data.parentSessionId !== state.parentSessionId || typeof id !== 'string') return state;
    // While our own open is in flight this is probably it, so the draft
    // question moves along; if it is not, the POST response says so.
    return applyOpened(state, id, seqOf(data.session?.sidebar_seq), state.pendingOp?.op === 'open')
      .state;
  }
  if (data.type === 'sidebar_closed') {
    if (data.sidebarParentId !== state.parentSessionId && data.sessionId !== state.conv.id) {
      return state;
    }
    return applyClosed(state, [data.sessionId]);
  }
  const sid = wsEventSessionId(data);
  if (!sid) return state;
  if (sid !== state.conv.id) {
    // About a SideBar of this parent we have not adopted (yet): hold it.
    if (data.sidebarParentId !== state.parentSessionId || state.closedIds.includes(sid)) {
      return state;
    }
    return { ...state, buffered: [...state.buffered, data].slice(-MAX_BUFFERED_EVENTS) };
  }
  const conv = applyChatEvent(state.conv, data);
  return conv === state.conv ? state : { ...state, conv };
}

export function sidebarPanelReducer(
  state: SidebarPanelState,
  action: SidebarAction,
): SidebarPanelState {
  const next = reduce(state, action);
  return next === state ? state : syncLedger(next);
}

function reduce(state: SidebarPanelState, action: SidebarAction): SidebarPanelState {
  switch (action.type) {
    case 'load_start': {
      if (action.parentSessionId !== state.parentSessionId) {
        return { ...initialSidebarPanelState(action.parentSessionId), loadToken: action.token };
      }
      // Same parent (first load, retry, or reconnect resync): keep what is on
      // screen and everything known; the lookup reconciles against it.
      return {
        ...state,
        loadToken: action.token,
        lookup: 'loading',
        lookupError: null,
        lookupVersion: state.lifecycleVersion,
        conv: { ...state.conv, turnEventSeen: false },
      };
    }
    case 'load_result': {
      if (action.token !== state.loadToken || state.lookup !== 'loading') return state;
      // A lifecycle fact arrived since the lookup started: it is newer.
      if (state.lifecycleVersion !== state.lookupVersion) {
        return { ...state, lookup: 'done' };
      }
      const seq = seqOf(action.seq);
      const id =
        action.sidebarId && !isStaleOpen(state, action.sidebarId, seq) ? action.sidebarId : null;
      const done: SidebarPanelState = { ...state, lookup: 'done' };
      if (!id) {
        // As of the lookup (issued after anything we knew), nothing is live.
        return state.conv.id ? applyClosed(done, [state.conv.id]) : done;
      }
      if (id === state.conv.id) {
        const conv = state.conv;
        const turnRunning = conv.turnEventSeen ? conv.turnRunning : action.running;
        return {
          ...done,
          conv: {
            ...conv,
            turnRunning,
            streamingContent: turnRunning ? conv.streamingContent : '',
            history: 'loading',
            historyToken: action.token,
            historyError: null,
          },
        };
      }
      // A SideBar we had not seen: its history loads; a draft question carries
      // over and is reconciled against that history.
      const carried = state.conv.id === null ? state.conv.messages : [];
      return replaceConversation(withSeq(done, id, seq), {
        ...emptyConversation(id, 'loading'),
        messages: carried,
        pendingQuestionId: state.conv.id === null ? state.conv.pendingQuestionId : null,
        turnRunning: action.running,
        historyToken: action.token,
      });
    }
    case 'history': {
      const conv = state.conv;
      if (conv.id !== action.sidebarId || conv.historyToken !== action.token) return state;
      if (conv.history !== 'loading') return state;
      return { ...state, conv: { ...mergeHistory(conv, action.messages), history: 'loaded' } };
    }
    case 'history_failed': {
      const conv = state.conv;
      if (conv.id !== action.sidebarId || conv.historyToken !== action.token) return state;
      if (conv.history !== 'loading') return state;
      return { ...state, conv: { ...conv, history: 'failed', historyError: action.error } };
    }
    case 'load_failed':
      if (action.token !== state.loadToken || state.lookup !== 'loading') return state;
      if (state.lifecycleVersion !== state.lookupVersion) return { ...state, lookup: 'done' };
      return { ...state, lookup: 'failed', lookupError: action.error };
    case 'ws':
      return applyWs(state, action.data);
    case 'ask_local':
      return {
        ...state,
        notice: null,
        questions: {
          ...state.questions,
          [action.questionId]: { content: action.content, status: 'pending' },
        },
        conv: {
          ...state.conv,
          error: null,
          pendingQuestionId: action.questionId,
          messages: [
            ...state.conv.messages,
            { id: action.questionId, role: 'user', content: action.content, pending: true },
          ],
        },
      };
    case 'ask_failed':
      return { ...markUndelivered(state, action.questionId), notice: action.error };
    case 'question_retry': {
      const conv = state.conv;
      const q = state.questions[action.questionId];
      if (q?.status !== 'undelivered') return state;
      if (!conv.messages.some((m) => m.id === action.questionId && m.failed)) return state;
      return {
        ...state,
        notice: null,
        questions: { ...state.questions, [action.questionId]: { ...q, status: 'pending' } },
        conv: {
          ...conv,
          error: null,
          pendingQuestionId: action.questionId,
          messages: conv.messages.map((m) =>
            m.id === action.questionId ? { ...m, pending: true, failed: false } : m,
          ),
        },
      };
    }
    case 'op_start':
      if (state.pendingOp) return state;
      return {
        ...state,
        notice: null,
        pendingOp: {
          opId: action.opId,
          op: action.op,
          questionId: action.questionId ?? null,
          targetVersion: state.lifecycleVersion,
        },
      };
    case 'op_opened': {
      const op = state.pendingOp;
      if (!op || op.opId !== action.opId || op.op === 'discard') return state;
      const afterClose = applyClosed(state, action.closedIds ?? []);
      const { state: opened, adopted } = applyOpened(
        afterClose,
        action.sidebarId,
        seqOf(action.seq),
        op.op === 'open',
      );
      const settled: SidebarPanelState = { ...opened, pendingOp: null };
      if (adopted || !op.questionId) return settled;
      // Our new SideBar was already superseded. Unless the server confirmed
      // the question, it never ran there: keep it, undelivered, on the
      // current SideBar for a retry. That SideBar's turn state is untouched.
      const demoted = markUndelivered(settled, op.questionId);
      return demoted === settled ? settled : { ...demoted, notice: SIDEBAR_REPLACED_ERROR };
    }
    case 'op_discarded': {
      const op = state.pendingOp;
      if (!op || op.opId !== action.opId || op.op !== 'discard') return state;
      // Was the conversation the user discarded still current when the
      // response landed? (Our own close event may already have cleared it,
      // or another window may have opened a newer one: leave that alone.)
      const stillTargeted = state.lifecycleVersion === op.targetVersion;
      // Only what the server actually archived goes; a newer SideBar stays.
      const closed = applyClosed(state, action.closedIds ?? []);
      // Nothing server-side covered it (e.g. a draft whose first open
      // failed): discarding means dropping the local conversation too. Its
      // questions become `discarded` (replaceConversation, op is discard).
      const cleared =
        stillTargeted && closed.lifecycleVersion === state.lifecycleVersion
          ? replaceConversation(closed, emptyConversation(null))
          : closed;
      return { ...cleared, pendingOp: null, notice: null };
    }
    case 'op_failed': {
      const op = state.pendingOp;
      if (!op || op.opId !== action.opId) return state;
      if (!op.questionId) return { ...state, pendingOp: null, notice: action.error };
      // The HTTP response can be lost after the server already acted: if the
      // question was confirmed over WS, the open worked and nothing failed.
      const demoted = markUndelivered(state, op.questionId);
      return demoted === state
        ? { ...state, pendingOp: null }
        : { ...demoted, pendingOp: null, notice: action.error };
    }
    default:
      return state;
  }
}
