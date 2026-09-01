export type MessageRole = 'user' | 'assistant' | 'system';

/** Chat message as returned by session message routes. */
export interface MessageWire {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  /** Raw JSON metadata column (parse with the relevant helper, e.g. `parseWikiRagIndicator`). */
  metadata?: string | null;
  engine?: string | null;
  model?: string | null;
  [key: string]: unknown;
}
