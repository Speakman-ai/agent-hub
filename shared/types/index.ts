export type {
  SessionState,
  SessionStateMeta,
  SessionStateSignals,
  SessionWire,
} from './session.js';
export type { ProjectWire } from './project.js';
export type { AgentWire } from './agent.js';
export type { MessageRole, MessageWire } from './message.js';

/** Standard API error body shape. */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  /** Stable, machine-readable error code (e.g. `no_active_org_membership`). */
  code?: string;
}
