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
}
