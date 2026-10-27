/**
 * Multi-account helpers for the Google Calendar, Gmail, and dashboard surfaces
 * on web and mobile.
 *
 * A Hub user can link several Google accounts. `/api/auth/google/status` lists
 * them under `accounts` (default first) and every `/api/google/*` proxy takes an
 * `account` query parameter. These helpers normalize that list, fan reads out
 * across accounts, tag each item with the account it came from, and pick the
 * account a write (new event, reply) should go to.
 */
import { sortCalendarEvents, type CalendarEventLike } from './calendarEvents';

export interface LinkedGoogleAccount {
  /** Linked account id. Empty only for a status payload that predates `accounts`. */
  accountId: string;
  email: string;
  isDefault: boolean;
  grantedScopes: string[];
}

export interface GoogleStatusWithAccounts {
  connected?: boolean;
  email?: string | null;
  grantedScopes?: string[];
  defaultAccountId?: string | null;
  accounts?: Array<Partial<LinkedGoogleAccount> | null> | null;
}

/**
 * The caller's linked accounts, default first. Falls back to a single account
 * built from the top-level status fields when the payload has no `accounts`.
 */
export function linkedGoogleAccounts(
  status: GoogleStatusWithAccounts | null | undefined,
): LinkedGoogleAccount[] {
  const raw = Array.isArray(status?.accounts) ? status.accounts : [];
  const accounts: LinkedGoogleAccount[] = [];
  for (const a of raw) {
    if (!a || typeof a.accountId !== 'string' || !a.accountId) continue;
    accounts.push({
      accountId: a.accountId,
      email: typeof a.email === 'string' ? a.email : '',
      isDefault: !!a.isDefault || a.accountId === status?.defaultAccountId,
      grantedScopes: Array.isArray(a.grantedScopes) ? a.grantedScopes : [],
    });
  }
  if (accounts.length) {
    // Stable: keeps the server's order among non-default accounts.
    return [...accounts.filter((a) => a.isDefault), ...accounts.filter((a) => !a.isDefault)];
  }
  if (!status?.connected) return [];
  return [
    {
      accountId: status.defaultAccountId ?? '',
      email: status.email ?? '',
      isDefault: true,
      grantedScopes: status.grantedScopes ?? [],
    },
  ];
}

/** The default account, else the first one. */
export function defaultGoogleAccount(
  accounts: LinkedGoogleAccount[],
): LinkedGoogleAccount | undefined {
  return accounts.find((a) => a.isDefault) ?? accounts[0];
}

/** Value for the proxies' `account` query parameter; undefined means the default. */
export function googleAccountParam(
  account: Pick<LinkedGoogleAccount, 'accountId'> | null | undefined,
): string | undefined {
  return account?.accountId || undefined;
}

/** Distinct per-account colors (hex, usable from CSS and React Native). */
export const GOOGLE_ACCOUNT_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
] as const;

const UNKNOWN_ACCOUNT_COLOR = '#6b7280';

/** Color for an account, by its position in the linked list. */
export function googleAccountColor(
  accounts: Pick<LinkedGoogleAccount, 'accountId'>[],
  accountId: string | null | undefined,
): string {
  const index = accounts.findIndex((a) => a.accountId === (accountId ?? ''));
  if (index < 0) return UNKNOWN_ACCOUNT_COLOR;
  return GOOGLE_ACCOUNT_COLORS[index % GOOGLE_ACCOUNT_COLORS.length];
}

export interface GoogleAccountTag {
  accountId: string;
  accountEmail: string;
}

export type AccountTagged<T> = T & GoogleAccountTag;

export function tagWithAccount<T extends object>(
  items: T[],
  account: Pick<LinkedGoogleAccount, 'accountId' | 'email'>,
): AccountTagged<T>[] {
  return items.map((item) => ({
    ...item,
    accountId: account.accountId,
    accountEmail: account.email,
  }));
}

export interface GoogleAccountFetchFailure {
  account: LinkedGoogleAccount;
  error: string;
}

/**
 * Run `fetcher` for every account in parallel and tag what comes back. One
 * account failing (revoked token, missing scope) never hides the others; it is
 * reported in `failures`. Items keep account order.
 */
export async function fetchAcrossGoogleAccounts<T extends object>(
  accounts: LinkedGoogleAccount[],
  fetcher: (account: LinkedGoogleAccount) => Promise<T[]>,
): Promise<{ items: AccountTagged<T>[]; failures: GoogleAccountFetchFailure[] }> {
  const settled = await Promise.allSettled(accounts.map((a) => fetcher(a)));
  const items: AccountTagged<T>[] = [];
  const failures: GoogleAccountFetchFailure[] = [];
  settled.forEach((result, i) => {
    const account = accounts[i];
    if (result.status === 'fulfilled') {
      items.push(...tagWithAccount(result.value ?? [], account));
    } else {
      const reason = result.reason as { message?: unknown } | undefined;
      const message = typeof reason?.message === 'string' ? reason.message : String(reason);
      failures.push({ account, error: message || 'Request failed' });
    }
  });
  return { items, failures };
}

/** Events from several accounts on one timeline, ordered by start. */
export function mergeAccountEvents<T extends CalendarEventLike>(
  items: AccountTagged<T>[],
): AccountTagged<T>[] {
  return sortCalendarEvents(items);
}

/** Drop items from accounts the user switched off. */
export function withoutHiddenAccounts<T extends Partial<GoogleAccountTag>>(
  items: T[],
  hiddenAccountIds: readonly string[],
): T[] {
  if (!hiddenAccountIds.length) return items;
  const hidden = new Set(hiddenAccountIds);
  return items.filter((item) => !hidden.has(item.accountId ?? ''));
}

/**
 * The hidden list that actually applies. Toggles only render with two or more
 * accounts, so with one (or none) nothing may stay hidden, otherwise a stored
 * choice could hide the only account with no control to bring it back. Ids of
 * accounts that are no longer linked are dropped too.
 */
export function effectiveHiddenAccounts(
  hiddenAccountIds: readonly string[],
  accounts: Pick<LinkedGoogleAccount, 'accountId'>[],
): string[] {
  if (accounts.length < 2) return [];
  const linked = new Set(accounts.map((a) => a.accountId));
  return hiddenAccountIds.filter((id) => linked.has(id));
}

/** Flip one account's visibility in a hidden-id list. */
export function toggleHiddenAccount(hiddenAccountIds: readonly string[], accountId: string) {
  return hiddenAccountIds.includes(accountId)
    ? hiddenAccountIds.filter((id) => id !== accountId)
    : [...hiddenAccountIds, accountId];
}

/** Storage key for the calendar's hidden-account list. */
export const CALENDAR_HIDDEN_ACCOUNTS_KEY = 'agent-hub.calendar.hiddenAccounts';

/** Parse a stored hidden-account list, tolerating junk. */
export function parseHiddenAccounts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Selection value for the Gmail "All inboxes" view. */
export const ALL_INBOXES = '__all_inboxes__';

/**
 * Which inbox the Gmail surface shows. Keeps a valid selection; otherwise falls
 * back to the default account when it can read mail, then the first account
 * that can. "All inboxes" is only offered with two or more readable accounts.
 */
export function resolveInboxSelection(
  selection: string | null | undefined,
  accounts: LinkedGoogleAccount[],
  canRead: (account: LinkedGoogleAccount) => boolean,
): string | null {
  const readable = accounts.filter(canRead);
  if (selection === ALL_INBOXES && readable.length > 1) return ALL_INBOXES;
  if (selection && readable.some((a) => a.accountId === selection)) return selection;
  const def = defaultGoogleAccount(accounts);
  if (def && canRead(def)) return def.accountId;
  return readable[0]?.accountId ?? def?.accountId ?? null;
}

/** The accounts to read for an inbox selection. */
export function inboxAccounts(
  selection: string | null,
  accounts: LinkedGoogleAccount[],
  canRead: (account: LinkedGoogleAccount) => boolean,
): LinkedGoogleAccount[] {
  if (selection === ALL_INBOXES) return accounts.filter(canRead);
  const match = accounts.find((a) => a.accountId === selection);
  return match ? [match] : [];
}

/** The linked account that owns a tagged item, if it is still linked. */
export function accountForItem(
  item: Partial<GoogleAccountTag> | null | undefined,
  accounts: LinkedGoogleAccount[],
): LinkedGoogleAccount | undefined {
  if (!item) return undefined;
  return accounts.find((a) => a.accountId === (item.accountId ?? ''));
}

/** The bare address from a header like `Jane Doe <jane@example.com>`. */
export function emailAddressOf(header: string | null | undefined): string | null {
  if (!header) return null;
  const angled = header.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angled) return angled[1];
  const bare = header.match(/[^\s<>,;"]+@[^\s<>,;"]+/);
  return bare ? bare[0] : null;
}

/**
 * Split an address-list header into mailboxes. Commas inside a quoted display
 * name (`"Doe, Jane" <jane@x.com>`) or inside angle brackets don't separate.
 */
export function splitMailboxes(header: string | null | undefined): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  const raw = header ?? '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted && ch === '\\' && i + 1 < raw.length) {
      current += ch + raw[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>' && angle > 0) angle--;
    if (ch === ',' && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export interface GmailReplySource {
  from?: string | null;
  to?: string | null;
  /** `Reply-To` header; when present on incoming mail, replies go here instead of From. */
  replyTo?: string | null;
  subject?: string | null;
  messageIdHeader?: string | null;
}

/**
 * POST body for replying in a thread. Replies to the last message's Reply-To
 * addresses, else its sender; if that message was the account's own sent
 * mail, replies to its first recipient instead. Threading headers keep the reply in the thread.
 */
export function buildGmailReplyBody(opts: {
  threadId: string;
  messages: GmailReplySource[];
  accountEmail: string | null | undefined;
  text: string;
}): {
  to: string[];
  subject: string;
  text: string;
  threadId: string;
  inReplyTo?: string;
  references?: string;
} | null {
  const last = opts.messages[opts.messages.length - 1];
  if (!last) return null;
  const self = (opts.accountEmail || '').toLowerCase();
  const sender = emailAddressOf(last.from);
  let recipients: string[];
  if (sender && sender.toLowerCase() === self) {
    // Our own sent message: continue the conversation with its first recipient.
    const first = emailAddressOf(splitMailboxes(last.to)[0]);
    recipients = first ? [first] : [];
  } else {
    // Incoming mail: Reply-To names where replies belong (RFC 5322 3.6.2),
    // e.g. a notifications@ sender asking replies to go to a person.
    const replyTo = splitMailboxes(last.replyTo)
      .map((m) => emailAddressOf(m))
      .filter((a): a is string => !!a);
    recipients = replyTo.length ? replyTo : sender ? [sender] : [];
  }
  if (!recipients.length) return null;
  const baseSubject = opts.messages.find((m) => m.subject)?.subject?.trim() || '';
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`.trim();
  const messageId = last.messageIdHeader?.trim();
  return {
    to: recipients,
    subject,
    text: opts.text,
    threadId: opts.threadId,
    ...(messageId ? { inReplyTo: messageId, references: messageId } : {}),
  };
}
