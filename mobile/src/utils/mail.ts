/**
 * Pure formatting helpers for rendering Gmail message rows on the dashboard.
 * Shared shape mirrored in `client/src/utils/mail.ts` — keep the two in sync.
 */

/**
 * A recent-mail row from `GET /api/me/dashboard` (`google.mail.messages[]`).
 * Mirrors the server's `DashboardMailMessage` / the web `DashboardMailMessageWire`
 * so the mobile pane catches shape drift instead of leaning on `any`.
 */
export interface DashboardMailMessage {
  id: string | null;
  threadId: string | null;
  from: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
  internalDate: string | null;
  unread: boolean;
}

/**
 * The human sender name from an RFC 2822 `From` header.
 * `"Jane Doe" <jane@x.com>` → `Jane Doe`; a bare address → the address;
 * empty / null → `Unknown sender`.
 */
export function mailSenderName(from: string | null | undefined): string {
  const raw = (from ?? '').trim();
  if (!raw) return 'Unknown sender';
  const named = raw.match(/^(.*?)<[^>]*>\s*$/);
  if (named) {
    const name = named[1].trim().replace(/^"(.*)"$/, '$1').trim();
    if (name) return name;
    const addr = raw.match(/<([^>]*)>/);
    return addr?.[1].trim() || raw;
  }
  return raw.replace(/^"(.*)"$/, '$1').trim() || 'Unknown sender';
}

/**
 * A compact received-time label for a message row. Prefers Gmail's
 * `internalDate` (epoch-ms string); falls back to the `Date` header. Same-day
 * messages show a time (`9:41 AM`), older ones a short date (`Jul 12`), and
 * anything from a prior year includes the year (`Jul 12, 2025`).
 */
export function formatMailDate(
  internalDate: string | null | undefined,
  dateHeader: string | null | undefined,
  now = new Date(),
): string {
  let ms: number | null = null;
  if (internalDate && /^\d+$/.test(internalDate)) {
    ms = Number(internalDate);
  } else if (dateHeader) {
    const parsed = Date.parse(dateHeader);
    if (!Number.isNaN(parsed)) ms = parsed;
  }
  if (ms === null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
