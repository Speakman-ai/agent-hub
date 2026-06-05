export type SessionState =
  | 'waiting_for_user_input'
  | 'working'
  | 'running_tests'
  | 'reviewing'
  | 'pending_checks'
  | 'pending_push'
  | 'pushed'
  | 'merged';

export const SESSION_STATES: readonly SessionState[];
export const DEFAULT_SESSION_STATE: SessionState;

export function isSessionState(v: unknown): v is SessionState;

export function finalizeStatusToState(
  finalizeStatus: string | null | undefined,
): SessionState | null;

export interface SessionStateSignals {
  finalizeStatus?: string | null;
  hasActiveTask?: boolean;
  merged?: boolean;
}

export function resolveSessionState(signals: SessionStateSignals): SessionState;

export interface SessionStateMeta {
  label: string;
  short: string;
  icon: string;
  color: string;
  anim: 'spin' | 'pulse' | 'none';
}

export const SESSION_STATE_META: Record<SessionState, SessionStateMeta>;

export function sessionStateMeta(state: string | null | undefined): SessionStateMeta;
