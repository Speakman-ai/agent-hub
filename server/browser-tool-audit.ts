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

export function logBrowserToolAudit(entry: BrowserToolAuditEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'browser_tool',
    chatSessionId: entry.chatSessionId,
    op: entry.op,
    ok: entry.ok,
    hostExit: entry.hostExit,
    ...(entry.detail ? { detail: entry.detail.slice(0, 512) } : {}),
    ...(entry.urlSnippet ? { urlSnippet: entry.urlSnippet.slice(0, 220) } : {}),
  });
  console.log(`[browser-tool-audit] ${line}`);
}
