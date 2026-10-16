/**
 * Fold `agenthub_preview` websocket frames into the per-session map the
 * mobile preview pane reads. Mirrors the web client's cases: a refresh
 * bumps the live preview, a stop marks it stopped, and a log line appends to
 * the tail. Everything else is a lifecycle event that replaces the stored one.
 *
 * Every lifecycle event gets a new `seq`. Log lines and refreshes keep it, so
 * "has the preview's state changed since X" is a seq comparison, never an
 * object-identity check (which log-only updates would defeat).
 */
let lastSeq = 0;
const nextSeq = () => ++lastSeq;

// An entry that carries refresh/log metadata but no lifecycle event yet.
const META_ONLY = 'preview_refresh';

/** Lifecycle generation of a stored entry; 0 when it carries no lifecycle event. */
export function previewLifecycleSeq(entry: any): number {
  if (!entry || entry.kind === META_ONLY) return 0;
  return typeof entry.seq === 'number' ? entry.seq : 0;
}

/**
 * Refreshes and log lines are metadata: they are always recorded, whatever
 * lifecycle event is cached, and never change its kind or seq. The cached
 * event may be stale (the pane can be showing a newer REST snapshot), so
 * whether a refresh applies is decided in resolvePreviewEvent against the
 * state that actually wins, not here.
 */
function withMeta(last: any, sid: string, meta: Record<string, unknown>) {
  return { ...(last ?? { kind: META_ONLY, sessionId: sid }), ...meta };
}

export function applyPreviewEvent(prev: Record<string, any>, data: any): Record<string, any> {
  const sid = data?.sessionId;
  if (!sid || typeof sid !== 'string') return prev;
  const last = prev[sid];
  if (data.kind === 'preview_refresh') {
    return {
      ...prev,
      [sid]: withMeta(last, sid, {
        refreshAt: data.refreshAt ?? Date.now(),
        refreshReason: data.reason ?? '',
      }),
    };
  }
  if (data.kind === 'preview_log') {
    if (!data.line) return prev;
    const logTail = [...(Array.isArray(last?.logTail) ? last.logTail : []), data.line].slice(-40);
    return { ...prev, [sid]: withMeta(last, sid, { logTail }) };
  }
  if (data.kind === 'preview_stopped') {
    // Kept as an explicit lifecycle event rather than deleted, so a hydrated
    // ready snapshot cannot outlive the stop.
    return { ...prev, [sid]: { kind: 'preview_stopped', sessionId: sid, seq: nextSeq() } };
  }
  const logTail = Array.isArray(data.logTail)
    ? data.logTail
    : Array.isArray(last?.logTail)
      ? last.logTail
      : [];
  return { ...prev, [sid]: { ...data, logTail, seq: nextSeq() } };
}

/**
 * A preview snapshot fetched over REST, with the lifecycle seq of the live
 * entry the pane held when the request was sent (0 when none).
 */
export interface PreviewHydration {
  event: any;
  seqAtRequest: number;
}

/**
 * The event a preview pane should render.
 *
 * The lifecycle state comes from whichever is newer: the REST snapshot beats
 * the live lifecycle event that was already cached when it was requested (a
 * broadcast may have been missed while the phone was in the background); a
 * lifecycle event received after the request beats the snapshot. Log lines
 * and refreshes never change that choice; they are laid over the winner (a
 * refresh only over a ready preview).
 */
export function resolvePreviewEvent(live: any, hydration: PreviewHydration | null): any {
  const liveSeq = previewLifecycleSeq(live);
  const snapshotWins = !!hydration && liveSeq === hydration.seqAtRequest;
  const base = snapshotWins ? (hydration!.event ?? null) : liveSeq ? live : null;
  if (!base || base === live || !live) return base;
  let resolved = base;
  if (Array.isArray(live.logTail) && live.logTail.length) {
    resolved = { ...resolved, logTail: live.logTail };
  }
  if (resolved.kind === 'preview' && live.refreshAt != null) {
    resolved = { ...resolved, refreshAt: live.refreshAt, refreshReason: live.refreshReason };
  }
  return resolved;
}

export type PreviewPaneStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'unavailable';

export function previewPaneStatus(event: any): PreviewPaneStatus {
  if (!event || typeof event !== 'object') return 'idle';
  if (event.kind === 'preview') return 'ready';
  if (event.kind === 'preview_starting') return 'starting';
  if (event.kind === 'preview_failed') return 'failed';
  if (event.kind === 'preview_unavailable') return 'unavailable';
  return 'idle';
}

/** Canonical URL from a ready preview event. Empty until the server is up. */
export function previewEventUrl(event: any): string {
  if (!event || event.kind !== 'preview') return '';
  const url = event.fullUrl || event.previewUrl || '';
  return typeof url === 'string' ? url : '';
}
