import { extractAskBlocks } from './extractAskBlocks.js';

const ANSWER_FENCE_RE = /```agenthub:ask:answer\s*\n([\s\S]*?)\n?```/g;
const ANSWER_XML_RE = /<agenthub:ask:answer>\s*([\s\S]*?)\s*<\/agenthub:ask:answer>/gi;

export interface ChatMessageLike {
  role?: string | null;
  content?: string | null;
}

function collectAnsweredAskIds(content: string): Set<string> {
  const out = new Set<string>();
  if (typeof content !== 'string' || !content.includes('agenthub:ask:answer')) {
    return out;
  }
  for (const re of [ANSWER_FENCE_RE, ANSWER_XML_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const body = match[1]?.trim();
      if (!body) continue;
      try {
        const parsed = JSON.parse(body) as { askId?: string };
        const askId = typeof parsed?.askId === 'string' ? parsed.askId : null;
        if (askId) out.add(askId);
      } catch {
        /* malformed */
      }
    }
  }
  return out;
}

export function findUnansweredAskIds(
  messages: ReadonlyArray<ChatMessageLike> | null | undefined,
): string[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  let latestAssistant: ChatMessageLike | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant') {
      latestAssistant = m;
      break;
    }
  }
  if (!latestAssistant || typeof latestAssistant.content !== 'string') return [];
  if (!latestAssistant.content.includes('agenthub:ask')) return [];

  const { asks } = extractAskBlocks(latestAssistant.content);
  if (!Array.isArray(asks) || asks.length === 0) return [];

  const answered = new Set<string>();
  for (const msg of messages) {
    if (msg?.role !== 'user') continue;
    for (const id of collectAnsweredAskIds(msg.content || '')) {
      answered.add(id);
    }
  }

  const out: string[] = [];
  for (const ask of asks) {
    const askId = ask && typeof ask.askId === 'string' ? ask.askId : null;
    if (!askId) continue;
    if (!answered.has(askId)) out.push(askId);
  }
  return out;
}
