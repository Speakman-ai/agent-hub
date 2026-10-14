/**
 * Google Chat as a trigger's optional second destination. After a trigger's
 * Agent Hub message commits, `chat-trigger-router.ts` hands the same
 * occurrence here, and it is posted to the trigger's Google Chat space through
 * the trigger creator's own Google connection (the same token the
 * `/api/google/chat/*` proxy uses). It is fire-and-forget: a missing
 * connection, a missing scope or a Google error is logged and never reaches
 * the Agent Hub post.
 */

import config from './config.js';
import { getActiveAccessToken, getGoogleConnectionStatus } from './google-connections-store.js';
import { hasChatMessagesCreateScope } from './google-scopes.js';
import {
  dailySummaryCardHref,
  dailySummarySessionHref,
} from '../shared/utils/dailySummaryLinks.js';
import type { ChatTriggerCard } from '../shared/utils/chatTriggers.js';

const CHAT_API = 'https://chat.googleapis.com/v1';
const SEND_TIMEOUT_MS = 15_000;

export interface GoogleChatTriggerSend {
  /** The trigger creator: their Google account sends the message. */
  userId: string;
  spaceId: string;
  card: ChatTriggerCard;
  /** Agent Hub message id; makes the Google create idempotent. */
  messageId: string;
}

export interface GoogleChatTriggerDeps {
  fetchImpl?: typeof fetch;
  resolveToken?: (userId: string) => Promise<string | null>;
  canSend?: (userId: string) => boolean;
  publicUrl?: string | null;
}

/** `<…>` is Google Chat link syntax; a title containing it must not become one. */
function plain(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›');
}

function refHref(card: ChatTriggerCard, ref: ChatTriggerCard['refs'][number]): string | null {
  if (ref.kind === 'card') return dailySummaryCardHref(card.projectId, ref.targetId);
  if (ref.kind === 'session') return dailySummarySessionHref(ref.targetId);
  return null;
}

/**
 * Plain-text Google Chat message for a trigger card: bold title with status,
 * the detail line, then one line per reference (linked when the Hub has a
 * public URL to link to).
 */
export function buildGoogleChatTriggerText(
  card: ChatTriggerCard,
  publicUrl: string | null = null,
): string {
  const base = publicUrl?.replace(/\/+$/, '') || null;
  const status = card.statusLabel ? ` (${plain(card.statusLabel)})` : '';
  const lines = [`*${plain(card.title)}*${status}`];
  if (card.detail) lines.push(plain(card.detail));
  for (const ref of card.refs) {
    const href = refHref(card, ref);
    const label = plain(ref.label);
    lines.push(base && href ? `• <${base}${href}|${label.replace(/\|/g, '/')}>` : `• ${label}`);
  }
  lines.push(`_${plain(card.projectId)} · Agent Hub_`);
  return lines.join('\n');
}

async function defaultResolveToken(userId: string): Promise<string | null> {
  return getActiveAccessToken(userId, config.googleOAuth ?? null);
}

function defaultCanSend(userId: string): boolean {
  if (!config.googleOAuth?.clientId || !config.googleOAuth?.clientSecret) return false;
  const status = getGoogleConnectionStatus(userId);
  return status.connected && hasChatMessagesCreateScope(status.grantedScopes);
}

/**
 * Posts one trigger occurrence to Google Chat. Throws with a short reason on
 * any failure; the router catches and logs it.
 */
export async function sendTriggerToGoogleChat(
  send: GoogleChatTriggerSend,
  deps: GoogleChatTriggerDeps = {},
): Promise<void> {
  const canSend = deps.canSend ?? defaultCanSend;
  if (!canSend(send.userId)) {
    throw new Error('creator has no Google Chat send access (connect Google or grant Chat)');
  }
  const token = await (deps.resolveToken ?? defaultResolveToken)(send.userId);
  if (!token) throw new Error('creator must reconnect Google');
  const text = buildGoogleChatTriggerText(
    send.card,
    deps.publicUrl === undefined ? (config.publicUrl ?? null) : deps.publicUrl,
  );
  const url =
    `${CHAT_API}/spaces/${encodeURIComponent(send.spaceId)}/messages` +
    `?requestId=${encodeURIComponent(`agent-hub-trigger-${send.messageId}`)}`;
  const res = await (deps.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    let reason = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      reason = body?.error?.message ?? '';
    } catch {
      // Body is not JSON; the status is enough.
    }
    throw new Error(`Google Chat returned ${res.status}${reason ? `: ${reason}` : ''}`);
  }
}
