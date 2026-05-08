/**
 * Host browser_steps from `browser_tool_activity` session events — shared web / mobile parity.
 */

/**
 * @param {{ seq?: number, event?: object }[]|undefined|null} timelineEntries
 */
export function deriveStreamingBrowserHint(timelineEntries) {
  /** @type {Map<string, string>} */
  const open = new Map();
  for (const row of timelineEntries || []) {
    const ev = row?.event;
    if (!ev || ev.type !== 'browser_tool_activity') continue;
    if (ev.phase === 'started') open.set(ev.actionId, ev.label || 'Browser…');
    if (ev.phase === 'ended') open.delete(ev.actionId);
  }
  if (open.size === 0) return null;
  return [...open.values()].pop();
}

/**
 * @param {{ seq?: number, event?: object }[]|undefined|null} timelineEntries
 */
export function mergeBrowserTimelineRows(timelineEntries) {
  /** @type {Map<string, object>} */
  const map = new Map();
  const order = [];
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
  return order.map((i) => map.get(i)).filter(Boolean);
}
