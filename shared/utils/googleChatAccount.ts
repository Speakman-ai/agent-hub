/**
 * Shared helpers for the Google Chat account picker on web and mobile. The
 * server binds each user's Chat to one linked Workspace account
 * (`GET/PUT /api/google/chat/account`).
 */

export interface GoogleChatAccountCandidate {
  accountId: string;
  email: string;
  isDefault: boolean;
  /** Google Chat only serves Workspace accounts. */
  workspace: boolean;
  hasChatScope: boolean;
}

export interface GoogleChatAccountState {
  account: { accountId: string; email: string } | null;
  /** The account Chat is set to, even when it is no longer linked. */
  boundEmail: string | null;
  candidates: GoogleChatAccountCandidate[];
}

/**
 * Accounts Chat can move to: verified Workspace accounts, current one first.
 * The current account is always listed so the picker shows it, even when it
 * was bound before Workspace membership was recorded.
 */
export function chatAccountChoices(state: GoogleChatAccountState): GoogleChatAccountCandidate[] {
  const current = state.account?.accountId;
  const eligible = state.candidates.filter((c) => c.workspace || c.accountId === current);
  return [
    ...eligible.filter((c) => c.accountId === current),
    ...eligible.filter((c) => c.accountId !== current),
  ];
}

/** Why Chat is not usable right now, or null when it is (or was never set up). */
export function chatAccountNotice(state: GoogleChatAccountState): string | null {
  if (state.account) {
    const current = state.candidates.find((c) => c.accountId === state.account?.accountId);
    return current && !current.hasChatScope
      ? `Chat access has not been granted for ${state.account.email} yet. Enable it from the Chat page.`
      : null;
  }
  if (state.boundEmail) {
    return `Google Chat was set to ${state.boundEmail}, which is no longer linked. Relink it, or pick another account.`;
  }
  return null;
}

/** `chatAccount` as `/api/auth/google/status` reports it. */
export interface GoogleStatusChatAccount {
  accountId: string | null;
  email: string | null;
  grantedScopes: string[];
  bound: boolean;
}

/**
 * The status as Chat sees it: Chat runs as its own account, so its consent
 * checks read that account's scopes rather than the default account's. A
 * status without `chatAccount` (older servers) is returned unchanged.
 */
export function chatScopedStatus<
  T extends {
    email?: string | null;
    grantedScopes?: string[];
    chatAccount?: GoogleStatusChatAccount | null;
  },
>(status: T | null | undefined): T | null | undefined {
  if (!status || status.chatAccount === undefined) return status;
  const chat = status.chatAccount;
  return { ...status, email: chat?.email ?? null, grantedScopes: chat?.grantedScopes ?? [] };
}

/** Account an "Enable Chat" consent should target; undefined means the default. */
export function chatConsentAccountId(
  status:
    | { grantedScopes?: string[]; chatAccount?: GoogleStatusChatAccount | null }
    | null
    | undefined,
): string | undefined {
  return status?.chatAccount?.accountId ?? undefined;
}
