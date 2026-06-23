export interface BrowserToolActivityEvent {
  type?: string;
  phase?: string;
  actionId?: string;
  label?: string;
  op?: string;
  startedAtMs?: number;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
  extractPreview?: string;
  hasScreenshot?: boolean;
  targetSummary?: string;
  error?: string;
}

export interface BrowserTimelineEntry {
  seq?: number;
  event?: BrowserToolActivityEvent;
}

export interface BrowserTimelineRow {
  actionId: string;
  phase: string;
  op?: string;
  startedLabel?: string;
  startedAtMs?: number;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
  extractPreview?: string;
  hasScreenshot?: boolean;
  targetSummary?: string;
  error?: string;
}

export function deriveStreamingBrowserHint(
  timelineEntries: BrowserTimelineEntry[] | null | undefined,
): string | null {
  const open = new Map<string, string>();
  for (const row of timelineEntries || []) {
    const ev = row?.event;
    if (!ev || ev.type !== 'browser_tool_activity') continue;
    if (ev.phase === 'started') open.set(ev.actionId || '', ev.label || 'Browser…');
    if (ev.phase === 'ended') open.delete(ev.actionId || '');
  }
  if (open.size === 0) return null;
  return [...open.values()].pop() ?? null;
}

export function mergeBrowserTimelineRows(
  timelineEntries: BrowserTimelineEntry[] | null | undefined,
): BrowserTimelineRow[] {
  const map = new Map<string, BrowserTimelineRow>();
  const order: string[] = [];
  for (const row of timelineEntries || []) {
    const ev = row?.event;
    if (!ev || ev.type !== 'browser_tool_activity') continue;
    const id = ev.actionId;
    if (!id) continue;
    let cur = map.get(id);
    if (!cur) {
      cur = { actionId: id, phase: 'pending' };
      map.set(id, cur);
      order.push(id);
    }
    cur.op = ev.op ?? cur.op;
    if (ev.phase === 'started') {
      cur.phase = 'running';
      cur.startedLabel = ev.label || cur.startedLabel;
      cur.startedAtMs = ev.startedAtMs ?? cur.startedAtMs;
    }
    if (ev.phase === 'ended') {
      cur.phase = 'done';
      cur.ok = ev.ok;
      cur.summary = ev.summary;
      cur.durationMs = ev.durationMs;
      cur.extractPreview = ev.extractPreview;
      cur.hasScreenshot = ev.hasScreenshot;
      cur.targetSummary = ev.targetSummary;
      cur.error = ev.error;
    }
  }
  return order.map((i) => map.get(i)).filter((r): r is BrowserTimelineRow => Boolean(r));
}
