/** JSON wire shape for session lifecycle state (persisted in sessions.state). */
export type SessionState =
  | 'waiting_for_user_input'
  | 'working'
  | 'running_tests'
  | 'reviewing'
  | 'pending_checks'
  | 'pending_push'
  | 'pushed'
  | 'merged';

export interface SessionStateMeta {
  label: string;
  short: string;
  icon: string;
  color: string;
  anim: 'spin' | 'pulse' | 'none';
}

export interface SessionStateSignals {
  finalizeStatus?: string | null;
  hasActiveTask?: boolean;
  merged?: boolean;
}

/** Minimal session fields returned by list/detail API routes. */
export interface SessionWire {
  id: string;
  agent_id: string;
  name: string;
  engine: string;
  model: string;
  state?: SessionState | string | null;
  changes_ready?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  owner_user_id?: string | null;
  session_mode?: string | null;
  linked_design_id?: string | null;
  worktree_branch?: string | null;
  use_worktree?: number;
  [key: string]: unknown;
}
