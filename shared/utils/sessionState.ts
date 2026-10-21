import type {
  NeedsInputKind,
  SessionState,
  SessionStateMeta,
  SessionStateSignals,
} from '../types/session.js';

export type { NeedsInputKind, SessionState, SessionStateMeta, SessionStateSignals };

export const SESSION_STATES: readonly SessionState[] = [
  'needs_input',
  'waiting_for_user_input',
  'working',
  'running_tests',
  'reviewing',
  'pending_checks',
  'pending_push',
  'pushed',
  'merged',
];

export const DEFAULT_SESSION_STATE: SessionState = 'waiting_for_user_input';

export function isSessionState(v: unknown): v is SessionState {
  return typeof v === 'string' && (SESSION_STATES as readonly string[]).includes(v);
}

export function finalizeStatusToState(
  finalizeStatus: string | null | undefined,
): SessionState | null {
  if (!finalizeStatus) return null;
  switch (finalizeStatus) {
    case 'pushed':
      return 'pushed';
    case 'disputed':
      return 'needs_input';
    case 'pushing':
    case 'ready_to_push':
      return 'pending_push';
    case 'running':
      return 'running_tests';
    case 'reviewing':
      return 'reviewing';
    case 'queued':
    case 'rebasing':
    case 'dispatching':
      return 'pending_checks';
    default:
      if (finalizeStatus.endsWith('_passed')) return 'pending_checks';
      return null;
  }
}

/**
 * States that describe the push step itself. `merged` strictly implies the
 * branch was pushed, so neither may override it: a session whose PR merged and
 * which then re-finalized (review feedback, a follow-up turn) parks its newest
 * run at `ready_to_push`, and reporting that would regress the session to
 * "Pending push" beside a "Merged" PR pill. Live activity states still win, so
 * a re-finalize in flight is visible while it runs.
 */
const PUSH_STAGE_STATES: readonly SessionState[] = ['pending_push', 'pushed'];

/**
 * Finalize states that wait on a human (a disputed review). A turn the human
 * starts in reply shows as `working` while it runs, so live activity wins.
 */
const PARKED_STATES: readonly SessionState[] = ['needs_input'];

export function resolveSessionState(signals: SessionStateSignals): SessionState {
  // A session stopped on the human (question, password, approval, sign-in,
  // disputed review) shows that above everything else: approvals and sign-ins
  // pause a live turn, which would otherwise read as `working`.
  if (signals?.needsInput) return 'needs_input';
  const fromFinalize = finalizeStatusToState(signals?.finalizeStatus);
  const pushStage = fromFinalize != null && PUSH_STAGE_STATES.includes(fromFinalize);
  const parked = fromFinalize != null && PARKED_STATES.includes(fromFinalize);
  if (fromFinalize && !pushStage && !parked) return fromFinalize;
  if (signals?.hasActiveTask) return 'working';
  if (parked) return fromFinalize;
  if (signals?.merged) return 'merged';
  if (fromFinalize) return fromFinalize;
  return DEFAULT_SESSION_STATE;
}

export const SESSION_STATE_META: Record<SessionState, SessionStateMeta> = {
  waiting_for_user_input: {
    label: 'Waiting for user input',
    short: 'Waiting',
    icon: 'MessageCircleQuestion',
    color: 'amber',
    anim: 'none',
  },
  needs_input: {
    label: 'Needs your input',
    short: 'Needs you',
    icon: 'CircleAlert',
    color: 'rose',
    anim: 'none',
  },
  working: {
    label: 'Working',
    short: 'Working',
    icon: 'Loader2',
    color: 'indigo',
    anim: 'spin',
  },
  running_tests: {
    label: 'Running tests',
    short: 'Tests',
    icon: 'FlaskConical',
    color: 'violet',
    anim: 'pulse',
  },
  reviewing: {
    label: 'Reviewing',
    short: 'Reviewing',
    icon: 'ScanEye',
    color: 'sky',
    anim: 'pulse',
  },
  pending_checks: {
    label: 'Pending checks',
    short: 'Checks',
    icon: 'Clock',
    color: 'slate',
    anim: 'none',
  },
  pending_push: {
    label: 'Pending push',
    short: 'Push',
    icon: 'ArrowUpCircle',
    color: 'amber',
    anim: 'none',
  },
  pushed: {
    label: 'Pushed',
    short: 'Pushed',
    icon: 'CloudUpload',
    color: 'teal',
    anim: 'none',
  },
  merged: {
    label: 'Merged',
    short: 'Merged',
    icon: 'GitMerge',
    color: 'emerald',
    anim: 'none',
  },
};

const NEEDS_INPUT_LABELS: Record<NeedsInputKind, string> = {
  question: 'Needs your input: answer a question',
  credential: 'Needs your input: enter a password or secret',
  approval: 'Needs your input: approve an action',
  sign_in: 'Needs your input: sign in to a site',
  review_disputed: 'Needs your input: decide a disputed review',
};

/** Specific label for a `needs_input` session, or the generic one. */
export function needsInputLabel(kind: string | null | undefined): string {
  return (
    (kind && NEEDS_INPUT_LABELS[kind as NeedsInputKind]) || SESSION_STATE_META.needs_input.label
  );
}

export function isNeedsInputKind(v: unknown): v is NeedsInputKind {
  return typeof v === 'string' && v in NEEDS_INPUT_LABELS;
}

export function sessionStateMeta(state: string | null | undefined): SessionStateMeta {
  if (state && isSessionState(state)) return SESSION_STATE_META[state];
  return SESSION_STATE_META[DEFAULT_SESSION_STATE];
}

export function groupSessionsByState<T extends { state?: string | null }>(
  sessions?: T[] | null,
): Array<{ state: SessionState; meta: SessionStateMeta; sessions: T[] }> {
  const list = Array.isArray(sessions) ? sessions : [];
  const buckets = new Map<SessionState, T[]>();
  for (const s of list) {
    const state = isSessionState(s?.state) ? s.state : DEFAULT_SESSION_STATE;
    const bucket = buckets.get(state);
    if (bucket) bucket.push(s);
    else buckets.set(state, [s]);
  }
  return SESSION_STATES.filter((state) => buckets.has(state)).map((state) => ({
    state,
    meta: SESSION_STATE_META[state],
    sessions: buckets.get(state)!,
  }));
}

export type SessionsViewMode = 'list' | 'board';

export function isSessionsViewMode(v: unknown): v is SessionsViewMode {
  return v === 'list' || v === 'board';
}

/**
 * Kanban columns for the dashboard's board view. Unlike
 * {@link groupSessionsByState}, every in-flight state gets a column even when
 * empty, so the board layout stays stable as sessions move between states.
 * `needs_input`, `pushed` and `merged` only appear when a session is actually
 * in them: blocked sessions are rare, and a pushed session normally resolves to `merged` or
 * back to an active state, so always-empty columns are noise. Renderers collapse empty columns.
 */
const BOARD_COLUMNS_SHOWN_ONLY_WHEN_POPULATED: readonly SessionState[] = [
  'needs_input',
  'pushed',
  'merged',
];

export function buildSessionBoardColumns<T extends { state?: string | null }>(
  sessions?: T[] | null,
): Array<{ state: SessionState; meta: SessionStateMeta; sessions: T[] }> {
  const groups = new Map(groupSessionsByState(sessions).map((g) => [g.state, g.sessions]));
  return SESSION_STATES.filter(
    (state) => !BOARD_COLUMNS_SHOWN_ONLY_WHEN_POPULATED.includes(state) || groups.has(state),
  ).map((state) => ({
    state,
    meta: SESSION_STATE_META[state],
    sessions: groups.get(state) ?? [],
  }));
}

/**
 * One live needs-input entry: the reason (null = explicitly cleared) and the
 * server ms it was computed at. The timestamp decides between a live event and
 * a session payload, which can arrive in either order.
 */
export interface NeedsInputEntry {
  kind: string | null;
  at: number;
}

/** Live needs-input map, keyed by session id. */
export type NeedsInputMap = Record<string, NeedsInputEntry>;

function stamp(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Apply one `session_needs_input` event, ignoring one older than what is held. */
export function applyNeedsInputEvent(
  prev: NeedsInputMap,
  data: { sessionId?: unknown; needsInput?: unknown; at?: unknown } | null | undefined,
): NeedsInputMap {
  const sid = typeof data?.sessionId === 'string' ? data.sessionId : null;
  if (!sid) return prev;
  const entry = {
    kind: isNeedsInputKind(data?.needsInput) ? data.needsInput : null,
    at: stamp(data?.at),
  };
  const held = prev[sid];
  if (held && (held.at > entry.at || (held.at === entry.at && held.kind === entry.kind))) {
    return prev;
  }
  return { ...prev, [sid]: entry };
}

/**
 * Replace the live map with the server's connect-time snapshot. The snapshot
 * is authoritative for every session it lists, so entries from before a
 * disconnect never outlive a reconnect.
 */
export function applyNeedsInputSnapshot(items: unknown): NeedsInputMap {
  const out: NeedsInputMap = {};
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const sid = item && typeof item.sessionId === 'string' ? item.sessionId : null;
    if (!sid) continue;
    out[sid] = {
      kind: isNeedsInputKind(item.needsInput) ? item.needsInput : null,
      at: stamp(item.at),
    };
  }
  return out;
}

/**
 * A fetched session payload carries `needs_input_at`, the server time its
 * `needs_input` was computed. Record that value and time in the map when it is
 * newer than what is held, so a delayed event computed before the payload is
 * rejected by {@link applyNeedsInputEvent}; keep a held entry the server
 * produced after the payload (an event that landed while the fetch was in
 * flight). Returns `prev` unchanged when nothing applies.
 */
export function reseedNeedsInputFromSessions(
  prev: NeedsInputMap,
  sessions:
    | ReadonlyArray<{ id?: unknown; needs_input?: unknown; needs_input_at?: unknown }>
    | null
    | undefined,
): NeedsInputMap {
  if (!Array.isArray(sessions) || sessions.length === 0) return prev;
  let next: NeedsInputMap | null = null;
  for (const s of sessions) {
    const sid = typeof s?.id === 'string' ? s.id : null;
    if (!sid || typeof s.needs_input_at !== 'number') continue;
    const held = prev[sid];
    if (held && held.at >= s.needs_input_at) continue;
    next ??= { ...prev };
    next[sid] = {
      kind: isNeedsInputKind(s.needs_input) ? s.needs_input : null,
      at: s.needs_input_at,
    };
  }
  return next ?? prev;
}

/**
 * What a session is waiting on the human for: whichever of the live entry and
 * the session payload the server computed last. A payload without a timestamp
 * only applies when no live entry is held.
 */
export function liveNeedsInputKind(
  session: { id?: unknown; needs_input?: unknown; needs_input_at?: unknown } | null | undefined,
  map: NeedsInputMap | null | undefined,
): string | null {
  if (!session || typeof session.id !== 'string') return null;
  const fromPayload = isNeedsInputKind(session.needs_input) ? session.needs_input : null;
  const held = map?.[session.id];
  if (!held) return fromPayload;
  const payloadAt = typeof session.needs_input_at === 'number' ? session.needs_input_at : -1;
  return payloadAt > held.at ? fromPayload : held.kind;
}
