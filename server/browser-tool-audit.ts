/**
 * Structured stdout audit trail for operator log aggregation (separate from
 * `session_events` UI telemetry persisted in chat.ts).
 */

export interface BrowserToolAuditEntry {
  chatSessionId: string;
  op: string;
  ok: boolean;
  hostExit: number;
  /** Short error or detail — never bulk page/extract payloads. */
  detail?: string;
  urlSnippet?: string;
}

/**
 * Normalize a navigation URL for audit logs: **`search` and `hash` are stripped**
 * so tokens and signed query params are not echoed to stdout.
 */
export function redactUrlForBrowserAudit(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    const base = `${u.origin}${u.pathname}`;
    return base.length > 220 ? `${base.slice(0, 219)}…` : base;
  } catch {
    const noFrag = t.split('#')[0] ?? '';
    const noQuery = noFrag.split('?')[0]?.trim();
    if (!noQuery) return undefined;
    return noQuery.length > 220 ? `${noQuery.slice(0, 219)}…` : noQuery;
  }
}

const MAX_AUDIT_DETAIL_BYTES = 512;

/**
 * Build a safe `detail` field for {@link logBrowserToolAudit}: URL-shaped
 * `hostDetail` / navigate input is redacted (no `?` / `#`) so tokens are not
 * echoed to stdout; non-URL strings are truncated only.
 */
export function sanitizeBrowserToolAuditDetail(params: {
  op: string;
  hostExit: number;
  hostDetail?: string;
  /** User-supplied navigate URL — preferred source on successful `navigate`. */
  navigateUrl?: string;
}): string | undefined {
  const { op, hostExit, hostDetail, navigateUrl } = params;

  if (op === 'navigate' && hostExit === 0) {
    const red = redactUrlForBrowserAudit(navigateUrl?.trim() || hostDetail?.trim());
    return red;
  }

  if ((op === 'back' || op === 'forward') && hostExit === 0) {
    const red = redactUrlForBrowserAudit(typeof hostDetail === 'string' ? hostDetail : undefined);
    return red;
  }

  if (typeof hostDetail !== 'string' || !hostDetail.trim()) return undefined;
  const trimmed = hostDetail.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const red = redactUrlForBrowserAudit(trimmed);
    if (red)
      return red.length > MAX_AUDIT_DETAIL_BYTES
        ? `${red.slice(0, MAX_AUDIT_DETAIL_BYTES - 1)}…`
        : red;
  }

  return hostDetail.slice(0, MAX_AUDIT_DETAIL_BYTES);
}

export function logBrowserToolAudit(entry: BrowserToolAuditEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'browser_tool',
    chatSessionId: entry.chatSessionId,
    op: entry.op,
    ok: entry.ok,
    hostExit: entry.hostExit,
    ...(entry.detail ? { detail: entry.detail.slice(0, MAX_AUDIT_DETAIL_BYTES) } : {}),
    ...(entry.urlSnippet ? { urlSnippet: entry.urlSnippet.slice(0, 220) } : {}),
  });
  console.log(`[browser-tool-audit] ${line}`);
}
