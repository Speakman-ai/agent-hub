/**
 * Tagged items in a session chat turn.
 *
 * The session composer inserts the same `@[label](kind:id)` tokens Hub Chat
 * uses, so a user can point the agent at a card, PR, support ticket or another
 * session. The token alone gives the agent a bare id. This module resolves each
 * token as the sender and appends a short block with what it names (title,
 * status, project), so the agent can act on it without a lookup first.
 *
 * Refs the sender cannot see, or that name nothing, are left out: the block
 * never tells the agent more than the sender could open.
 */

import { buildRefViewer, resolveRef, type RefLookups, type RefViewer } from './hub-chat-refs.js';
import { locateChatMarkdownCode } from './hub-chat-markdown.js';
import { parseHubChatRefTokens } from '../shared/utils/hubChatRefTokens.js';
import type { ResolvedRef } from './hub-chat-refs.js';

/** Upper bound on items listed, so a pasted wall of tokens cannot bloat the turn. */
export const SESSION_REF_CONTEXT_LIMIT = 20;

function quote(text: string | null): string {
  if (!text) return '';
  const one = text.replace(/\s+/g, ' ').trim();
  return one ? ` "${one.length > 160 ? `${one.slice(0, 159)}…` : one}"` : '';
}

function describe(ref: ResolvedRef): string {
  const parts: string[] = [];
  switch (ref.kind) {
    case 'card':
      parts.push(`Card ${ref.label ?? ref.targetId}${quote(ref.title)}`);
      parts.push(`id ${ref.targetId}`);
      if (ref.projectId) parts.push(`project ${ref.projectId}`);
      if (ref.status) parts.push(`column ${ref.status}`);
      break;
    case 'pr':
      parts.push(`Pull request ${ref.label ?? ref.targetId}${quote(ref.title)}`);
      if (ref.projectId) parts.push(`project ${ref.projectId}`);
      if (ref.number != null) parts.push(`number ${ref.number}`);
      if (ref.status) parts.push(`status ${ref.status}`);
      break;
    case 'ticket':
      parts.push(`Support ticket${quote(ref.title ?? ref.label)}`);
      parts.push(`id ${ref.targetId}`);
      if (ref.projectId) parts.push(`project ${ref.projectId}`);
      if (ref.status) parts.push(`status ${ref.status}`);
      break;
    case 'session':
      parts.push(`Session${quote(ref.label)}`);
      parts.push(`id ${ref.targetId}`);
      if (ref.title) parts.push(`agent ${ref.title}`);
      if (ref.projectId) parts.push(`project ${ref.projectId}`);
      if (ref.status) parts.push(`state ${ref.status}`);
      break;
    case 'agent':
      parts.push(`Agent ${ref.label ?? ref.targetId}`);
      parts.push(`id ${ref.targetId}`);
      if (ref.projectId) parts.push(`project ${ref.projectId}`);
      break;
    case 'user':
      parts.push(`Person @${ref.label ?? ref.targetId}`);
      parts.push(`user id ${ref.targetId}`);
      break;
  }
  return `- ${parts.join(' · ')}`;
}

/**
 * The context block for the refs in `content`, resolved as `viewer`. Returns
 * '' when the message carries no visible refs.
 */
export function buildSessionRefContext(
  lookups: RefLookups,
  viewer: RefViewer,
  content: string,
): string {
  if (!content.includes('@[')) return '';
  const tokens = parseHubChatRefTokens(content, locateChatMarkdownCode);
  if (tokens.length === 0) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of tokens) {
    const key = `${t.kind}:${t.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = resolveRef(lookups, viewer, t.kind, t.targetId);
    if (!resolved.visible) continue;
    lines.push(describe(resolved));
    if (lines.length >= SESSION_REF_CONTEXT_LIMIT) break;
  }
  if (lines.length === 0) return '';
  return [
    '<tagged-items>',
    'The user tagged these Agent Hub items in this message (shown inline as @[label](kind:id)):',
    ...lines,
    'Use the agent-hub skill wrappers (board.sh, ah-api.sh) to read more about any of them.',
    '</tagged-items>',
  ].join('\n');
}

/**
 * Appends the tagged-items block to the turn the CLI sees. The stored message
 * keeps its tokens unchanged so every client renders them as chips. Never
 * throws: a resolve failure just sends the turn without the block.
 */
export function appendSessionRefContext(args: {
  cliContent: string;
  content: string;
  senderUserId: string | null;
  orgId: () => string;
  localBypass: boolean;
  lookups: RefLookups;
}): string {
  const { cliContent, content, senderUserId, lookups } = args;
  if (!senderUserId || !content.includes('@[')) return cliContent;
  try {
    const viewer = buildRefViewer(senderUserId, args.orgId(), args.localBypass);
    const block = buildSessionRefContext(lookups, viewer, content);
    return block ? `${cliContent}\n\n${block}` : cliContent;
  } catch (err) {
    console.warn('[session-chat-refs] could not resolve tagged items:', (err as Error).message);
    return cliContent;
  }
}
