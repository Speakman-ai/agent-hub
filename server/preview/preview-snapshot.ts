/**
 * preview-snapshot — build `agenthub_preview` snapshot events for a WS
 * client that just (re)connected.
 *
 * Why this exists: the chat handler in `preview-block.ts` is the only
 * code path that broadcasts `agenthub_preview` events today (apart from
 * the per-line `preview_log` fan-out and the new `notifyStatus` hook
 * that lives on the compose runtime). The block handler stays alive
 * only for the duration of the chat turn that triggered the preview;
 * once it exits, no further broadcasts happen for that preview.
 *
 * That works as long as a client is connected for the whole boot. If
 * the browser tab sleeps, the laptop closes its lid, or the WS drops
 * for any reason and reconnects later, the client has missed every
 * `preview_starting` rebroadcast plus the final `preview` / `preview_failed`
 * terminal event — and the chat handler has long since returned, so no
 * further events will ever fire for that group. The pane sits frozen
 * on whatever `preview_starting` snapshot it last received.
 *
 * The fix is two-pronged:
 *
 *   1. The compose runtime now fires a `notifyStatus` callback when the
 *      background health-check flips a row to `ready` or `failed`. The
 *      WS broadcaster in `server/index.ts` translates that into the
 *      corresponding `agenthub_preview` event, so any client connected
 *      at the moment of the transition sees it — even if the original
 *      chat handler has exited.
 *
 *   2. On WS connect (this file), we walk every active compose group
 *      (`status IN ('starting','ready','failed')`) and emit a snapshot
 *      event so the reconnecting client can rebuild its preview pane
 *      state from scratch. Combined with #1, a reconnecting client
 *      always converges on the truth — either via the snapshot (state
 *      already terminal) or via the snapshot + subsequent broadcast
 *      (state still `starting`).
 *
 * The functions here are intentionally pure: no WebSocket access, no
 * filesystem access, no globals. The caller (websocket.ts) does the
 * broadcast-filter check + ws.send, so this module stays trivially
 * unit-testable with an in-memory compose runtime stub.
 */

import type { ComposePreviewRow } from './preview-compose-runtime.js';

/**
 * The compose-runtime surface that the snapshot builder needs. Narrowed
 * from `PreviewComposeRuntime` so tests can pass a stub without standing
 * up a real runtime.
 */
export interface PreviewSnapshotRuntime {
  listActive(): ComposePreviewRow[];
  /**
   * Returns the in-memory boot-log tail for `groupId`, or `[]` if the
   * group is unknown to the runtime (e.g. ghost row from a prior
   * process). Calling this on the production runtime hits the docker
   * daemon for a fresh `docker compose logs --tail` read; that's
   * acceptable on connect (one-shot) but would not be inside a hot
   * loop.
   */
  getLogTail(groupId: string): string[];
}

/**
 * The subset of `PreviewBroadcastEvent` that the snapshot builder
 * emits. We don't import the full discriminated union from
 * `preview-block.ts` to avoid pulling its heavier transitive deps into
 * the WS connect path — the wire shape we care about is small and
 * stable.
 */
export type PreviewSnapshotEvent = {
  type: 'agenthub_preview';
  /**
   * `kind: 'preview_starting'` — boot in flight; the pane should show
   * the spinner + log tail. `kind: 'preview'` — entry service is
   * healthy; the pane should swap to the iframe. `kind: 'preview_failed'`
   * — boot failed; the pane should render the error + final log tail.
   *
   * We do NOT emit a `preview_unavailable` snapshot — that kind is
   * gated on `project.prEnv?.preview?.enabled`, which the client can
   * resolve from `/api/projects` on its own; sending it as a fake
   * "snapshot" would lie about preview state for sessions that simply
   * never started one.
   */
  kind: 'preview_starting' | 'preview' | 'preview_failed';
  sessionId: string;
  previewId: string;
  /**
   * `target` and `route` are populated by the chat handler when an
   * agent emits a `<agenthub:preview>` block; on a cold WS connect we
   * don't have that context, so we use generic defaults the pane can
   * still render against.
   */
  target: 'client';
  route: '/';
  agentReason: '';
  previewUrl?: string;
  fullUrl?: string;
  port?: number;
  screenshotPath: null;
  logTail: string[];
  error?: string;
};

/**
 * Build the full set of snapshot events for the WS connect handshake.
 * The caller is responsible for filtering each event through
 * `shouldDeliverBroadcast` before sending — we don't take a visibility
 * stamp here so the helper stays pure and trivially testable.
 *
 * Ordering matches `listActive` (started_at ASC) so a multi-session
 * replay is deterministic.
 */
export function buildPreviewSnapshotEvents(
  runtime: PreviewSnapshotRuntime,
): PreviewSnapshotEvent[] {
  const events: PreviewSnapshotEvent[] = [];
  for (const row of runtime.listActive()) {
    const snap = previewSnapshotEventFromRow(row, runtime.getLogTail(row.id));
    if (snap) events.push(snap);
  }
  return events;
}

/**
 * Translate a single compose row + its log tail into a snapshot event.
 * Exposed so the WS connect handler can reuse it inside a per-row try
 * block (one row's `getLogTail` failing shouldn't take out the whole
 * snapshot).
 *
 * Returns `null` for statuses we don't snapshot (defense against
 * future ComposeStatus enum growth — we'd rather emit nothing than a
 * mis-typed event).
 */
export function previewSnapshotEventFromRow(
  row: ComposePreviewRow,
  logTail: string[],
): PreviewSnapshotEvent | null {
  // `fullUrl` mirrors the chat-handler convention: the snapshot is the
  // canonical URL the iframe should load on success. Without a `route`
  // we can't know whether the agent wanted `/some/sub/path`; rendering
  // the root is the conservative default and matches what
  // `derivePaneState` falls back to (route='/').
  if (row.status === 'starting') {
    return {
      type: 'agenthub_preview',
      kind: 'preview_starting',
      sessionId: row.session_id,
      previewId: row.id,
      target: 'client',
      route: '/',
      agentReason: '',
      previewUrl: row.url,
      port: row.port,
      screenshotPath: null,
      logTail,
    };
  }
  if (row.status === 'ready') {
    return {
      type: 'agenthub_preview',
      kind: 'preview',
      sessionId: row.session_id,
      previewId: row.id,
      target: 'client',
      route: '/',
      agentReason: '',
      previewUrl: row.url,
      fullUrl: row.url,
      port: row.port,
      screenshotPath: null,
      logTail,
    };
  }
  if (row.status === 'failed') {
    return {
      type: 'agenthub_preview',
      kind: 'preview_failed',
      sessionId: row.session_id,
      previewId: row.id,
      target: 'client',
      route: '/',
      agentReason: '',
      screenshotPath: null,
      logTail,
      error: 'preview boot failed',
    };
  }
  return null;
}
