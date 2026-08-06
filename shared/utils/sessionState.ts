import type { SessionState, SessionStateMeta, SessionStateSignals } from '../types/session.js';

export type { SessionState, SessionStateMeta, SessionStateSignals };

export const SESSION_STATES: readonly SessionState[] = [
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

export function resolveSessionState(signals: SessionStateSignals): SessionState {
  const fromFinalize = finalizeStatusToState(signals?.finalizeStatus);
  const pushStage = fromFinalize != null && PUSH_STAGE_STATES.includes(fromFinalize);
  if (fromFinalize && !pushStage) return fromFinalize;
  if (signals?.hasActiveTask) return 'working';
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
