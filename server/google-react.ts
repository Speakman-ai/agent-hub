/**
 * Host-mediated `google` ReAct read action — inline calendar / gmail / sheets / chat
 * context for a session, scoped to the SESSION OWNER's linked Google account.
 *
 * This is the read-only sibling of the `google` skill wrappers. The wrappers
 * shell out to the `/api/google/*` proxy; this helper runs in-process during a
 * chat turn where the host already knows the owner (`session.owner_user_id`),
 * so it resolves the owner's access token directly via the connections store
 * and calls googleapis. It NEVER returns a token and performs reads only —
 * writes stay behind the wrappers / proxy where intent is explicit.
 */
import { google } from 'googleapis';
import { getActiveAccessToken, getGoogleConnectionStatus } from './google-connections-store.js';
import type { GoogleOAuthCredentials } from './google-oauth.js';
import {
  hasCalendarReadScope,
  hasChatMessagesReadScope,
  hasGmailReadScope,
  hasSheetsReadScope,
} from './google-scopes.js';
import { isRfc3339, shiftRfc3339 } from '../shared/utils/rfc3339.js';

export const GOOGLE_REACT_SURFACES = ['calendar', 'gmail', 'sheets', 'chat'] as const;
export type GoogleReactSurface = (typeof GOOGLE_REACT_SURFACES)[number];

export function isGoogleReactSurface(value: string): value is GoogleReactSurface {
  return (GOOGLE_REACT_SURFACES as readonly string[]).includes(value);
}

export interface GoogleReactAction {
  surface: GoogleReactSurface;
  from?: string;
  to?: string;
  q?: string;
  max?: number;
  threadId?: string;
  spreadsheetId?: string;
  range?: string;
  calendarId?: string;
  /** chat — `spaces/AAAA` or the bare space id. */
  spaceId?: string;
}

export interface GoogleReactContext {
  ownerUserId: string | null | undefined;
  oauthConfig: GoogleOAuthCredentials | null;
}

export interface GoogleReactResult {
  /** Context to inject into the next turn (empty when nothing useful came back). */
  markdown: string;
  /** A user-facing error/misconfiguration note (mutually informative with markdown). */
  errorMarkdown?: string;
  /**
   * True only for a genuine host/tool failure (an unexpected googleapis throw)
   * that should mark the ReAct host step as failed. Expected, user-recoverable
   * states — not linked, OAuth not configured, reconnect required, or missing
   * required args (`from`/`to`, `spreadsheetId`/`range`) — leave this falsy:
   * their `errorMarkdown` is a NORMAL observation injected for the next turn so
   * the assistant can relay it, NOT a tool error.
   */
  failed?: boolean;
}

const NOT_LINKED = (detail: string): GoogleReactResult => ({
  markdown: '',
  errorMarkdown:
    `## Google not available\n${detail}\n\n` +
    'The session owner can link or repair the connection under **Settings → Account → Google**.',
});

const SURFACE_LABEL: Record<GoogleReactSurface, string> = {
  calendar: 'Google Calendar',
  gmail: 'Gmail',
  sheets: 'Google Sheets',
  chat: 'Google Chat',
};

/**
 * Recoverable "the owner is connected but hasn't granted this surface" note.
 * Like NOT_LINKED it leaves `failed` falsy — with incremental consent this is a
 * normal, user-fixable state, not a host/tool error.
 */
const SCOPE_REQUIRED = (surface: GoogleReactSurface): GoogleReactResult => ({
  markdown: '',
  errorMarkdown:
    `## ${SURFACE_LABEL[surface]} not enabled\n` +
    `The session owner is connected but has not granted ${SURFACE_LABEL[surface]} access.\n\n` +
    'Enable it under **Settings → Account → Google** (incremental consent).',
});

const READ_SCOPE_GATE: Record<GoogleReactSurface, (scopes: string[]) => boolean> = {
  calendar: hasCalendarReadScope,
  gmail: hasGmailReadScope,
  sheets: hasSheetsReadScope,
  chat: hasChatMessagesReadScope,
};

/**
 * Detect a Google "insufficient permission / scope" failure so a
 * connected-but-under-scoped call that still reaches googleapis (e.g. a scope
 * revoked mid-session, or a scope our list doesn't yet enumerate) is treated as
 * recoverable rather than a host error. Mirrors the proxy's 403 handling.
 */
function isInsufficientScopeError(err: unknown): boolean {
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
  const status = Number(e?.code ?? e?.status);
  if (status !== 403) {
    // Some googleapis errors only carry the reason, not a numeric 403.
    const msg = String(e?.message ?? '').toLowerCase();
    if (!msg.includes('insufficient') && !msg.includes('scope')) return false;
  }
  const reasons = (e?.errors ?? []).map((x) => String(x?.reason ?? '').toLowerCase());
  const msg = String(e?.message ?? '').toLowerCase();
  return (
    reasons.some((r) => r.includes('insufficientpermissions') || r.includes('insufficientscope')) ||
    msg.includes('insufficient authentication scopes') ||
    msg.includes('insufficient permission') ||
    msg.includes('request had insufficient authentication scopes') ||
    (status === 403 && msg.includes('scope'))
  );
}

function authClient(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

function truncate(value: string | null | undefined, max = 140): string {
  const s = (value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function runGoogleReadAction(
  action: GoogleReactAction,
  ctx: GoogleReactContext,
): Promise<GoogleReactResult> {
  const ownerId = ctx.ownerUserId?.trim();
  if (!ownerId) {
    return NOT_LINKED('No Hub user owns this session, so no Google connection can be resolved.');
  }
  if (!ctx.oauthConfig?.clientId || !ctx.oauthConfig?.clientSecret) {
    return NOT_LINKED('Google OAuth is not configured on this Hub.');
  }

  const status = getGoogleConnectionStatus(ownerId);
  if (!status.connected) {
    return NOT_LINKED('The session owner has not linked a Google account.');
  }

  // Incremental consent: connected does NOT imply this surface's scope was
  // granted. Gate per-surface up front (mirrors the proxy routes) so a missing
  // scope is a recoverable observation, not a googleapis throw marked failed.
  const readGate = READ_SCOPE_GATE[action.surface];
  if (readGate && !readGate(status.grantedScopes)) {
    return SCOPE_REQUIRED(action.surface);
  }

  let token: string | null;
  try {
    token = await getActiveAccessToken(ownerId, ctx.oauthConfig);
  } catch {
    return NOT_LINKED('Could not resolve a Google access token (refresh failed).');
  }
  if (!token) {
    return NOT_LINKED('The session owner must reconnect their Google account.');
  }

  try {
    switch (action.surface) {
      case 'calendar':
        return await readCalendar(action, token);
      case 'gmail':
        return await readGmail(action, token);
      case 'sheets':
        return await readSheets(action, token);
      case 'chat':
        return await readChat(action, token);
      default:
        return {
          markdown: '',
          errorMarkdown: `## Google read error\nUnknown surface "${String(action.surface)}".`,
          failed: true,
        };
    }
  } catch (err: unknown) {
    // A late insufficient-scope failure (scope revoked mid-session, or one our
    // grant list doesn't enumerate) is recoverable, not a host error.
    if (isInsufficientScopeError(err)) {
      return SCOPE_REQUIRED(action.surface);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      markdown: '',
      errorMarkdown: `## Google read error\nThe ${action.surface} read failed: ${truncate(msg, 200)}`,
      failed: true,
    };
  }
}

async function readCalendar(action: GoogleReactAction, token: string): Promise<GoogleReactResult> {
  if (!action.from || !action.to) {
    return {
      markdown: '',
      errorMarkdown:
        '## Google calendar read error\nProvide `from` and `to` RFC3339 timestamps, e.g. ' +
        '`{"tool":"google","surface":"calendar","from":"2026-06-30T00:00:00Z","to":"2026-07-01T00:00:00Z"}`.',
    };
  }
  const calendar = google.calendar({ version: 'v3', auth: authClient(token) });
  const result = await calendar.events.list({
    calendarId: action.calendarId?.trim() || 'primary',
    timeMin: action.from,
    timeMax: action.to,
    q: action.q,
    maxResults: clampMax(action.max, 25, 50),
    singleEvents: true,
    orderBy: 'startTime',
  });
  const items = result.data.items ?? [];
  if (items.length === 0) {
    return { markdown: `## Google Calendar\nNo events between ${action.from} and ${action.to}.` };
  }
  const lines = items.map((e) => {
    const when = e.start?.dateTime ?? e.start?.date ?? '(no start)';
    const who = e.attendees?.length ? ` · ${e.attendees.length} attendee(s)` : '';
    return `- **${when}** — ${truncate(e.summary) || '(no title)'}${who}`;
  });
  return {
    markdown: `## Google Calendar (${action.from} → ${action.to})\n${lines.join('\n')}`,
  };
}

async function readGmail(action: GoogleReactAction, token: string): Promise<GoogleReactResult> {
  const gmail = google.gmail({ version: 'v1', auth: authClient(token) });

  if (action.threadId?.trim()) {
    const result = await gmail.users.threads.get({
      userId: 'me',
      id: action.threadId.trim(),
      format: 'metadata',
    });
    const messages = result.data.messages ?? [];
    const lines = messages.map((m) => {
      const headers = m.payload?.headers ?? [];
      const h = (name: string) =>
        headers.find((x) => (x.name ?? '').toLowerCase() === name)?.value ?? '';
      return `- **${truncate(h('from'), 60)}** — ${truncate(h('subject')) || '(no subject)'}`;
    });
    return {
      markdown:
        `## Gmail thread ${action.threadId.trim()}\n` +
        (lines.length ? lines.join('\n') : 'No messages in this thread.'),
    };
  }

  const result = await gmail.users.threads.list({
    userId: 'me',
    q: action.q,
    maxResults: clampMax(action.max, 15, 50),
  });
  const threads = result.data.threads ?? [];
  if (threads.length === 0) {
    return { markdown: `## Gmail\nNo threads${action.q ? ` for query \`${action.q}\`` : ''}.` };
  }
  const lines = threads.map((t) => `- \`${t.id}\` — ${truncate(t.snippet) || '(no snippet)'}`);
  return {
    markdown: `## Gmail threads${action.q ? ` (\`${action.q}\`)` : ''}\n${lines.join('\n')}`,
  };
}

async function readSheets(action: GoogleReactAction, token: string): Promise<GoogleReactResult> {
  const spreadsheetId = action.spreadsheetId?.trim();
  if (!spreadsheetId || !action.range?.trim()) {
    return {
      markdown: '',
      errorMarkdown:
        '## Google sheets read error\nProvide `spreadsheetId` and `range`, e.g. ' +
        '`{"tool":"google","surface":"sheets","spreadsheetId":"…","range":"Sheet1!A1:C10"}`.',
    };
  }
  const sheets = google.sheets({ version: 'v4', auth: authClient(token) });
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: action.range.trim(),
  });
  const rows = (result.data.values ?? []) as unknown[][];
  if (rows.length === 0) {
    return { markdown: `## Google Sheet ${spreadsheetId} — ${action.range}\n(no values in range)` };
  }
  const rendered = rows
    .slice(0, 50)
    .map((row) => row.map((cell) => String(cell ?? '')).join(' | '))
    .join('\n');
  const more = rows.length > 50 ? `\n… ${rows.length - 50} more row(s) truncated.` : '';
  return {
    markdown: `## Google Sheet ${spreadsheetId} — ${action.range}\n\`\`\`\n${rendered}\n\`\`\`${more}`,
  };
}

// Same alphabets as the proxy: keeps `/` or `..` out of the resource name.
const CHAT_SPACE_RE = /^(?:spaces\/)?([A-Za-z0-9_-]{1,128})$/;
const CHAT_THREAD_RE = /^(?:spaces\/([A-Za-z0-9_-]{1,128})\/threads\/)?([A-Za-z0-9_.-]{1,256})$/;

const CHAT_USAGE =
  '`{"tool":"google","surface":"chat","spaceId":"spaces/AAAA","max":20}` ' +
  '(optional `threadId`, and `from` as an RFC 3339 lower bound). ' +
  'List spaces with `google-chat.sh spaces`.';

async function readChat(action: GoogleReactAction, token: string): Promise<GoogleReactResult> {
  const spaceId = CHAT_SPACE_RE.exec(action.spaceId?.trim() ?? '')?.[1];
  if (!spaceId) {
    return {
      markdown: '',
      errorMarkdown: `## Google Chat read error\nProvide a valid \`spaceId\`, e.g. ${CHAT_USAGE}`,
    };
  }
  const filters: string[] = [];
  const thread = action.threadId?.trim();
  if (thread) {
    const m = CHAT_THREAD_RE.exec(thread);
    if (!m || (m[1] && m[1] !== spaceId)) {
      return {
        markdown: '',
        errorMarkdown:
          '## Google Chat read error\n`threadId` must be a thread id or ' +
          '`spaces/{space}/threads/{thread}` in the requested space.',
      };
    }
    filters.push(`thread.name = spaces/${spaceId}/threads/${m[2]}`);
  }
  if (action.from) {
    if (!isRfc3339(action.from)) {
      return {
        markdown: '',
        errorMarkdown:
          '## Google Chat read error\n`from` must be an RFC 3339 timestamp with a zone, ' +
          'e.g. `2026-10-08T10:00:00Z`.',
      };
    }
    // Chat only supports strict `>`; widen by 1ns so `from` is inclusive.
    filters.push(`createTime > "${shiftRfc3339(action.from, -1n)}"`);
  }

  const chat = google.chat({ version: 'v1', auth: authClient(token) });
  const result = await chat.spaces.messages.list({
    parent: `spaces/${spaceId}`,
    pageSize: clampMax(action.max, 20, 50),
    orderBy: 'createTime desc',
    ...(filters.length ? { filter: filters.join(' AND ') } : {}),
  });
  // Fetched newest-first so `max` keeps the most recent; render oldest-first.
  const messages = [...(result.data.messages ?? [])].reverse();
  const heading = `## Google Chat spaces/${spaceId}${thread ? ` (thread ${thread})` : ''}`;
  if (messages.length === 0) {
    return { markdown: `${heading}\nNo messages${action.from ? ` since ${action.from}` : ''}.` };
  }
  const lines = messages.map((m) => {
    const senderId = m.sender?.name?.split('/').pop();
    const who =
      m.sender?.displayName?.trim() ||
      (m.sender?.type === 'BOT' ? 'App' : senderId ? `User ${senderId}` : 'Unknown sender');
    const body = truncate(m.text ?? m.fallbackText, 300) || '(no text)';
    const attachments = m.attachment?.length ? ` [${m.attachment.length} attachment(s)]` : '';
    return `- **${m.createTime ?? '(no time)'}** ${truncate(who, 60)}: ${body}${attachments}`;
  });
  return { markdown: `${heading}\n${lines.join('\n')}` };
}

function clampMax(value: number | undefined, fallback: number, hardMax: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), hardMax);
}
