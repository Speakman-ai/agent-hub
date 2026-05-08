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
