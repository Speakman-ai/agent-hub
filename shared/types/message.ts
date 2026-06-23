export type MessageRole = 'user' | 'assistant' | 'system';

/** Chat message as returned by session message routes. */
export interface MessageWire {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  [key: string]: unknown;
}
