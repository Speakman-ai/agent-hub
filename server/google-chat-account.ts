/**
 * The one Google account a user's Google Chat runs as.
 *
 * Calendar, Gmail, Sheets and Drive work across every linked account, but
 * Chat stays single-account: one Workspace Events subscription per user, one
 * sender identity for replies, drafts and project chat triggers. The binding
 * is stored explicitly (`google_chat_accounts`, keyed by Google identity) so
 * it survives default-account switches:
 *
 *  - No binding yet: the first verified Workspace account that holds a Chat
 *    scope is bound (the default account wins when it qualifies), so existing
 *    single-account users carry on without a choice.
 *  - Bound account removed: Chat is unavailable until the same Google account
 *    is relinked or the user picks another. It never moves to a different
 *    account on its own.
 *  - Switching (`setChatAccount`): only to a verified Workspace account. The
 *    caller tears down the old account's push state (see
 *    `routes/google-chat-account.ts`).
 *
 * Every write of the binding goes through `rebind`, which discards held agent
 * replies written as another identity in the same transaction. Drafts also
 * record their identity, and approval refuses to send one with a token for a
 * different account (`claimChatDraftForSend`), so no ordering of a switch and
 * an approval can post a reply under the wrong name.
 *
 * Every Chat path resolves its account here: the `/api/google/chat/*`
 * proxies, push subscriptions, agent reply drafts, and chat triggers.
 */
import { getOrgsDb } from './orgs.js';
import {
  getActiveAccessToken,
  getGoogleConnection,
  listGoogleConnections,
  type GoogleConnectionRow,
  type GoogleConnectionStatus,
} from './google-connections-store.js';
import type { GoogleOAuthCredentials } from './google-oauth.js';
import { hasChatMessagesReadScope, hasChatMessagesCreateScope } from './google-scopes.js';
import { discardPendingChatDrafts, type GoogleChatDraft } from './google-chat-drafts-store.js';

const CONSUMER_DOMAIN_RE = /@(gmail|googlemail)\.com$/i;

/**
 * Google Chat serves Google Workspace accounts only. Only the userinfo `hd`
 * claim proves Workspace membership (an email domain does not: personal
 * Google accounts can use any address). Every OAuth callback records `hd` or
 * its confirmed absence; an account linked before that has `hostedDomain`
 * null and is not eligible until it is reconnected.
 */
export function isWorkspaceAccount(conn: Pick<GoogleConnectionRow, 'hostedDomain'>): boolean {
  return !!conn.hostedDomain;
}

/**
 * Continuity for accounts linked before `hd` was recorded: such a default
 * account that already holds Chat scopes is how Chat ran for that user, so the
 * first-use binding keeps it. Never offered for selection. Google's Chat API
 * itself refuses personal accounts, so this cannot open Chat to one.
 */
function isLegacyChatAccount(conn: GoogleConnectionRow): boolean {
  return (
    conn.hostedDomain === null &&
    conn.isDefault &&
    !CONSUMER_DOMAIN_RE.test(conn.googleEmail) &&
    hasAnyChatScope(conn.grantedScopes)
  );
}

function hasAnyChatScope(scopes: string[]): boolean {
  return hasChatMessagesReadScope(scopes) || hasChatMessagesCreateScope(scopes);
}

interface BindingRow {
  google_sub: string;
  google_email: string;
}

function readBinding(userId: string): BindingRow | undefined {
  return getOrgsDb()
    .prepare('SELECT google_sub, google_email FROM google_chat_accounts WHERE user_id = ?')
    .get(userId) as BindingRow | undefined;
}

/**
 * The only writer of the binding. In one transaction it points Chat at
 * `conn` and discards pending drafts written as any other identity, so the
 * new identity never becomes visible while an old reply is still approvable.
 * Returns the discarded drafts for the caller to announce.
 */
function rebind(userId: string, conn: GoogleConnectionRow): GoogleChatDraft[] {
  const db = getOrgsDb();
  return db.transaction((): GoogleChatDraft[] => {
    writeBinding(userId, conn);
    return discardPendingChatDrafts(userId, conn.googleSub);
  })();
}

function writeBinding(userId: string, conn: GoogleConnectionRow): void {
  getOrgsDb()
    .prepare(
      `INSERT INTO google_chat_accounts (user_id, google_sub, google_email, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         google_sub = excluded.google_sub,
         google_email = excluded.google_email,
         updated_at = excluded.updated_at`,
    )
    .run(userId, conn.googleSub, conn.googleEmail);
}

export interface ChatAccountBinding {
  /** Linked account Chat runs as; null when the bound account is not linked. */
  account: GoogleConnectionRow | null;
  /** Email of the bound Google account, linked or not; null when never bound. */
  boundEmail: string | null;
}

/**
 * The user's Chat binding, binding a qualifying account on first use. Never
 * throws for a user without Google.
 */
export function getChatAccountBinding(userId: string): ChatAccountBinding {
  const binding = readBinding(userId);
  const accounts = listGoogleConnections(userId);
  if (binding) {
    const account = accounts.find((a) => a.googleSub === binding.google_sub) ?? null;
    return { account, boundEmail: account?.googleEmail ?? binding.google_email };
  }
  const candidates = accounts.filter(
    (a) => isWorkspaceAccount(a) && hasAnyChatScope(a.grantedScopes),
  );
  // Before the binding existed Chat ran as the default account, so a default
  // that can run Chat (verified, or the legacy case) keeps it ahead of any
  // other account, including one whose consent just arrived.
  const pick =
    accounts.find(
      (a) =>
        a.isDefault &&
        ((isWorkspaceAccount(a) && hasAnyChatScope(a.grantedScopes)) || isLegacyChatAccount(a)),
    ) ?? candidates[0];
  if (!pick) return { account: null, boundEmail: null };
  rebind(userId, pick);
  return { account: pick, boundEmail: pick.googleEmail };
}

export interface ChatAccountSummary {
  /** Linked account id; null when the bound account is no longer linked. */
  accountId: string | null;
  email: string | null;
  /** Scopes granted to that account (empty when it is not linked). */
  grantedScopes: string[];
  /**
   * True once Chat is bound. False means the account is only the suggestion
   * for enabling Chat: the default when it is a Workspace account, else the
   * first Workspace account. Consenting Chat on it binds it.
   */
  bound: boolean;
}

/**
 * What clients need to drive Chat consent: the Chat account's scopes (not the
 * default account's) and which account an "Enable Chat" consent should target.
 * Null when no linked account could ever run Chat.
 */
export function getChatAccountSummary(userId: string): ChatAccountSummary | null {
  const { account, boundEmail } = getChatAccountBinding(userId);
  if (account) {
    return {
      accountId: account.accountId,
      email: account.googleEmail,
      grantedScopes: account.grantedScopes,
      bound: true,
    };
  }
  if (boundEmail) return { accountId: null, email: boundEmail, grantedScopes: [], bound: true };
  const workspace = listGoogleConnections(userId).filter((a) => isWorkspaceAccount(a));
  const pick = workspace.find((a) => a.isDefault) ?? workspace[0];
  return pick
    ? {
        accountId: pick.accountId,
        email: pick.googleEmail,
        grantedScopes: pick.grantedScopes,
        bound: false,
      }
    : null;
}

/** The linked account Chat runs as, or null. */
export function getChatAccount(userId: string): GoogleConnectionRow | null {
  return getChatAccountBinding(userId).account;
}

/**
 * Connection status for the Chat account, shaped like the store's status.
 * With no usable Chat account but other accounts linked, it reports a
 * connection with no granted scopes, so callers answer "Chat access not
 * granted" (which the clients turn into an enable prompt) rather than
 * "not connected".
 */
export function getChatConnectionStatus(userId: string): GoogleConnectionStatus {
  const account = getChatAccount(userId);
  if (account) {
    return {
      connected: true,
      accountId: account.accountId,
      email: account.googleEmail,
      grantedScopes: account.grantedScopes,
      connectedAt: account.connectedAt,
      tokenExpiresAt: account.tokenExpiresAt,
    };
  }
  const anyLinked = listGoogleConnections(userId).length > 0;
  return {
    connected: anyLinked,
    accountId: null,
    email: null,
    grantedScopes: [],
    connectedAt: null,
    tokenExpiresAt: null,
  };
}

/** Fresh access token for the Chat account, or null when there is none. */
export async function getChatAccessToken(
  userId: string,
  credentials: GoogleOAuthCredentials | null,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<string | null> {
  const account = getChatAccount(userId);
  if (!account) return null;
  return getActiveAccessToken(userId, credentials, {
    ...opts,
    account: { accountId: account.accountId },
  });
}

/**
 * Token plus the identity it belongs to, read from one binding lookup. Draft
 * approval passes `sub` to the claim, which refuses a draft written as
 * anyone else.
 */
export async function getChatAccessIdentity(
  userId: string,
  credentials: GoogleOAuthCredentials | null,
): Promise<{ token: string; sub: string } | null> {
  const account = getChatAccount(userId);
  if (!account) return null;
  const token = await getActiveAccessToken(userId, credentials, {
    account: { accountId: account.accountId },
  });
  return token ? { token, sub: account.googleSub } : null;
}

/** Google `sub` of the Chat account (`users/{sub}` in the Chat API), or null. */
export function getChatAccountSub(userId: string): string | null {
  return getChatAccount(userId)?.googleSub ?? null;
}

export type SetChatAccountResult =
  | {
      ok: true;
      changed: boolean;
      previous: GoogleConnectionRow | null;
      account: GoogleConnectionRow;
      /** Held replies written as another identity, discarded with the switch. */
      discarded: GoogleChatDraft[];
    }
  | { ok: false; code: 'google_account_not_found' | 'google_chat_workspace_required' };

/**
 * Bind Chat to one of the user's linked accounts. Only Workspace accounts
 * qualify. `previous` is the linked account Chat ran as before, for teardown.
 */
export function setChatAccount(userId: string, accountId: string): SetChatAccountResult {
  const target = getGoogleConnection(userId, { accountId });
  if (!target) return { ok: false, code: 'google_account_not_found' };
  if (!isWorkspaceAccount(target)) return { ok: false, code: 'google_chat_workspace_required' };
  const before = readBinding(userId);
  const previous = before
    ? (listGoogleConnections(userId).find((a) => a.googleSub === before.google_sub) ?? null)
    : null;
  const changed = before?.google_sub !== target.googleSub;
  const discarded = changed ? rebind(userId, target) : [];
  return { ok: true, changed, previous, account: target, discarded };
}

/**
 * After an OAuth consent that granted Chat scopes to `accountId`: bind it when
 * the user has no usable Chat account. An existing, still-linked binding is
 * left alone; switching is always explicit.
 */
export function bindChatAccountIfUnbound(
  userId: string,
  accountId: string,
): { bound: boolean; discarded: GoogleChatDraft[] } {
  const none = { bound: false, discarded: [] };
  const conn = getGoogleConnection(userId, { accountId });
  if (!conn || !isWorkspaceAccount(conn) || !hasAnyChatScope(conn.grantedScopes)) return none;
  // Resolve the effective binding first. With no row yet this binds the
  // account Chat already ran as (the default), which then stays; `bound`
  // reports whether that first binding landed on this account.
  const hadBinding = !!readBinding(userId);
  const effective = getChatAccountBinding(userId).account;
  if (effective) {
    return { bound: !hadBinding && effective.googleSub === conn.googleSub, discarded: [] };
  }
  return { bound: true, discarded: rebind(userId, conn) };
}
