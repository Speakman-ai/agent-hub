import { WebSocketServer, WebSocket as WsClient } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import { authenticateWsDetailed } from './auth.js';
import { stmts } from './db.js';
import {
  userOwnsSession,
  getSessionOwner,
  isReviewerSession,
  isSharedCronSession,
  setWsAuthUserId,
  getWsAuthUserId,
  setWsAuthVisibility,
  getWsAuthVisibility,
  type AuthStampedWs,
  type WsVisibilityStamp,
} from './session-ownership.js';
import { handleBroadcastForPush } from './push.js';
import { resolveProjectIdFromEvent } from './event-project-resolver.js';
import { shouldDeliverBroadcast } from './broadcast-filter.js';
import { buildBackgroundShellSnapshot } from './background-shells/background-shell-snapshot.js';
import type { WebSocketDeps, BroadcastFn, MessageQueueRow } from './types.js';
import { buildActiveTasksSnapshotLenient } from './active-tasks.js';
import { buildAwaitingInputSnapshotLenient } from './awaiting-input.js';
import { buildPreviewSnapshotEvents } from './preview/preview-snapshot.js';
import { buildFinalizeSnapshotEvents } from './finalize/finalize-snapshot.js';
import { subscribeToJob, isJobFinished } from './provisioning/orchestrator.js';

function isSharedReadableSession(sessionId: string): boolean {
  return isReviewerSession(sessionId) || isSharedCronSession(sessionId);
}
import { parsePreviewProxySessionId } from './preview/preview-proxy.js';
import { parseTerminalWebSocketSessionId } from './terminal/terminal-websocket.js';
import { parseBrowserScreencastWebSocketSessionId } from './browser-screencast-websocket.js';
import { canViewProject } from './project-visibility.js';
import {
  queryLogRecordsSince,
  queryLogTailSeed,
  type LogRecordRow,
  type LogTailSeed,
} from './logs/logs-db.js';
import { MAX_QUERY_LIMIT } from './logs/logs-schema.js';
import { serializeLogRecord } from './logs/log-record-api.js';
import { subscribeLogTail } from './logs/log-tail.js';
import { incLogMetric } from './logs/log-metrics.js';

/** Per-client cap: a slow subscriber can never grow an unbounded JS queue. */
export const MAX_LOG_TAIL_BUFFER_RECORDS = 1_000;
/** Stop calling ws.send when the underlying socket is already backpressured. */
export const MAX_LOG_TAIL_SOCKET_BUFFERED_BYTES = 1_000_000;
const LOG_TAIL_SEND_BATCH = 100;

interface LogTailSubscription {
  projectId: string;
  records: LogRecordRow[];
  scheduled: boolean;
  /** Live records queue here until every reconnect-backfill page is sent. */
  backfillInProgress: boolean;
  /**
   * Optional lower bound (nanoseconds) on the initial backfill window. Bounds
   * the seed to recent records so the Live view does not replay the entire
   * retained history oldest-first. Undefined = full history (client picked
   * "All time").
   */
  sinceUnixNano?: number;
}

/**
 * Match `/api/provisioning/<jobId>/events` and return the jobId. Returns
 * null if the URL is not a provisioning subscription — callers fall
 * through to the normal agent-chat connection handler.
 */
export function parseProvisioningPath(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  // Strip query string; we don't consult it here.
  const pathOnly = rawUrl.split('?')[0] ?? '';
  const m = pathOnly.match(/^\/api\/provisioning\/([^/]+)\/events\/?$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Parse the `?since=<seq>` query parameter from a provisioning WS URL.
 * Returns the non-negative integer seq, or `null` if absent/invalid.
 * Callers use this to resume a dropped stream without re-processing
 * already-received events. Malformed / negative / non-integer values
 * are treated as absent rather than errors — the server just replays
 * the whole buffer, which is a safe degradation.
 */
export function parseProvisioningSince(rawUrl: string | undefined): number | null {
  if (!rawUrl) return null;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex < 0) return null;
  const query = rawUrl.slice(qIndex + 1);
  let since: string | null = null;
  for (const part of query.split('&')) {
    const [k, v] = part.split('=', 2);
    if (k === 'since') {
      since = v ?? '';
      break;
    }
  }
  if (since == null || since === '') return null;
  try {
    const decoded = decodeURIComponent(since);
    if (decoded === '') return null;
    const n = Number(decoded);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
  } catch {
    return null;
  }
}

export default function createWebSocket(
  server: Server,
  deps: WebSocketDeps,
): { wss: WebSocketServer; broadcast: BroadcastFn } {
  // Route upgrades explicitly instead of letting `ws` claim every path on the
  // HTTP server. The terminal channel and preview HMR proxy have their own
  // upgrade handlers; a `{server}` WebSocketServer would also call
  // `handleUpgrade` for those sockets, causing the classic "handleUpgrade was
  // called more than once" crash after the dedicated handler accepted them.
  const wss = new WebSocketServer({ noServer: true });
  const handleChatUpgrade = (
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void => {
    if (
      parsePreviewProxySessionId(request.url) ||
      parseTerminalWebSocketSessionId(request.url) ||
      parseBrowserScreencastWebSocketSessionId(request.url)
    ) {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
  server.on('upgrade', handleChatUpgrade);
  wss.on('close', () => server.off('upgrade', handleChatUpgrade));

  const {
    getProjects,
    handleChat,
    handleCancel,
    handleDequeue,
    handleEditQueueItem,
    handleDesignChat,
    handleDesignCancel,
    getPreviewSnapshotRuntime,
    getBackgroundShellSnapshotRuntime,
    subscribeLogTail: subscribeCommittedLogs = subscribeLogTail,
  } = deps;

  // The writer invokes this only after its SQLite transaction commits. One
  // listener fans records to the matching project subscriptions, each with an
  // independent bounded queue so one stalled browser cannot affect another.
  const tailSubscriptions = new WeakMap<WsClient, LogTailSubscription>();
  const unsubscribeLogTail = subscribeCommittedLogs((records) => {
    for (const client of wss.clients) {
      const sub = tailSubscriptions.get(client as WsClient);
      if (!sub || client.readyState !== WsClient.OPEN) continue;
      // Bound the live push by the subscription's window as well as its
      // project. A newly-committed row is NOT necessarily inside the window: a
      // source flushing a backlog commits rows whose event times are hours old,
      // and pushing those into a "Last hour" view drops ancient records at the
      // top of a bounded tail. The seed and "Load older" both honour the
      // window, so the live path has to as well or the view is only bounded
      // until the next delayed batch lands.
      const matching = records.filter(
        (record) =>
          record.project_id === sub.projectId &&
          (sub.sinceUnixNano == null || record.time_unix_nano >= sub.sinceUnixNano),
      );
      if (matching.length === 0) continue;
      sub.records.push(...matching);
      if (sub.records.length > MAX_LOG_TAIL_BUFFER_RECORDS) {
        const overflow = sub.records.length - MAX_LOG_TAIL_BUFFER_RECORDS;
        // Do not advance the cursor past rows we could not deliver. Closing
        // preserves the client's last durable cursor, so its reconnect
        // backfill can recover this whole batch without a permanent gap.
        requireLogTailRecovery(
          client as WsClient,
          sub,
          overflow,
          'Log tail queue overflow; reconnect to recover',
        );
        continue;
      }
      // A live cursor must never overtake an incomplete older backfill. Queue
      // it until `streamLogTailBackfill` reaches nextCursor=null.
      if (!sub.backfillInProgress) scheduleLogTailFlush(client as WsClient, sub);
    }
  });

  function scheduleLogTailFlush(ws: WsClient, sub: LogTailSubscription): void {
    if (sub.scheduled) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      flushLogTail(ws, sub);
    });
  }

  function flushLogTail(ws: WsClient, sub: LogTailSubscription): void {
    if (tailSubscriptions.get(ws) !== sub || ws.readyState !== WsClient.OPEN) return;
    if (sub.backfillInProgress) return;
    if (sub.records.length === 0) return;
    if (ws.bufferedAmount > MAX_LOG_TAIL_SOCKET_BUFFERED_BYTES) {
      // A successful `send` is no longer possible within our memory bound.
      // Closing with 1013 tells the client to reconnect; its durable cursor
      // then replays every committed row through the backfill query. Merely
      // clearing this queue would leave a quiet, permanent gap if the burst
      // ended before a later frame could report `dropped`.
      requireLogTailRecovery(
        ws,
        sub,
        sub.records.length,
        'Log tail backpressure; reconnect to recover',
      );
      return;
    }
    const records = sub.records.splice(0, LOG_TAIL_SEND_BATCH);
    try {
      ws.send(
        JSON.stringify({
          type: 'logs_tail',
          projectId: sub.projectId,
          records: records.map(serializeLogRecord),
          cursor: records[records.length - 1]!.id,
          dropped: 0,
        }),
      );
    } catch {
      requireLogTailRecovery(
        ws,
        sub,
        records.length + sub.records.length,
        'Log tail send failed; reconnect to recover',
      );
      return;
    }
    if (sub.records.length > 0) scheduleLogTailFlush(ws, sub);
  }

  /**
   * Announce a bounded-tail loss when the transport can still accept a tiny
   * control frame, then force the standard reconnect/backfill recovery path.
   * The control frame deliberately has no replacement cursor: clients must
   * keep their last received durable cursor instead of skipping the loss.
   */
  function requireLogTailRecovery(
    ws: WsClient,
    sub: LogTailSubscription,
    dropped: number,
    reason: string,
  ): void {
    tailSubscriptions.delete(ws);
    // One forced-recovery event = one WebSocket drop for the health gauge
    // (decision LOG-SCOPE). Counted regardless of whether the closing control
    // frame reaches the peer — the subscriber is dropped either way.
    incLogMetric('wsDrops');
    if (ws.readyState !== WsClient.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          type: 'logs_tail_recovery_required',
          projectId: sub.projectId,
          dropped,
        }),
      );
    } catch {
      // Still close below: the client reconnects with its pre-loss cursor.
    }
    try {
      ws.close(1013, reason);
    } catch {
      // Peer already disconnected; no retained queue remains.
    }
  }

  /** Release the queued live records once backfill/seed has been dispatched. */
  function finishLogTailBackfill(ws: WsClient, sub: LogTailSubscription): void {
    if (tailSubscriptions.get(ws) !== sub) return;
    sub.backfillInProgress = false;
    if (sub.records.length > 0) scheduleLogTailFlush(ws, sub);
  }

  /**
   * Seed a *fresh* subscribe from the newest end of the window in a single
   * frame, instead of draining the window oldest-first.
   *
   * Draining forward from a cursor is correct for a reconnect (the client is
   * missing a contiguous range, so every committed row must arrive) but wrong
   * for a first subscribe: on a busy project it streams the entire retention
   * window into the browser oldest-first, so the Live view sits on hours-old
   * records until the whole replay finishes. The tail is what the user asked
   * for, so send the tail; `Load older` pages backwards on demand.
   *
   * This is **lossy by construction**: it drops everything older than the
   * newest `MAX_QUERY_LIMIT` in the window and reports `nextCursor: null`. It
   * therefore runs only when the subscriber explicitly asked for a seed
   * (`seed: true`), never when the server merely observes `cursor === 0`; see
   * the `logs_subscribe` handler.
   */
  function seedLogTail(ws: WsClient, sub: LogTailSubscription, cursor: number): void {
    let seed: LogTailSeed;
    try {
      seed = queryLogTailSeed(sub.projectId, MAX_QUERY_LIMIT, sub.sinceUnixNano);
    } catch {
      requireLogTailRecovery(
        ws,
        sub,
        sub.records.length,
        'Log tail seed failed; reconnect to recover',
      );
      return;
    }
    // `seed.cursor` is the project's max committed ingest id at seed time, NOT
    // the max id among the rows we are sending. The event-time cutoff excludes
    // rows that can hold much higher ids (a delayed batch ingested late with old
    // event times sits entirely above the seed page), so reporting the page's
    // max would leave the client resubscribing below them and the next
    // reconnect would drain `id > cursor` and splice those already-known,
    // old-event-time rows into the live tail as if they were new. Everything
    // already ingested has been considered; excluded rows come back through the
    // event-time "Load older" path, which is the only path that positions them
    // correctly anyway. `Math.max` keeps the advance monotonic against the
    // cursor the client sent.
    const seedCursor = Math.max(cursor, seed.cursor);
    try {
      ws.send(
        JSON.stringify({
          type: 'logs_tail_backfill',
          projectId: sub.projectId,
          records: seed.records.map(serializeLogRecord),
          cursor: seedCursor,
          nextCursor: null,
        }),
      );
    } catch {
      requireLogTailRecovery(
        ws,
        sub,
        sub.records.length,
        'Log tail seed send failed; reconnect to recover',
      );
      return;
    }
    finishLogTailBackfill(ws, sub);
  }

  /**
   * Drain every bounded `id > cursor` page before releasing queued live
   * records. Yielding between pages keeps the event loop responsive; records
   * that arrive while yielded remain bounded in `sub.records` and can never
   * advance the live cursor ahead of the undispatched middle pages.
   */
  async function streamLogTailBackfill(
    ws: WsClient,
    sub: LogTailSubscription,
    initialCursor: number,
    seedRequested: boolean,
  ): Promise<void> {
    if (tailSubscriptions.get(ws) !== sub || ws.readyState !== WsClient.OPEN) return;
    if (seedRequested) {
      seedLogTail(ws, sub, initialCursor);
      return;
    }
    let cursor = initialCursor;
    while (tailSubscriptions.get(ws) === sub && ws.readyState === WsClient.OPEN) {
      if (ws.bufferedAmount > MAX_LOG_TAIL_SOCKET_BUFFERED_BYTES) {
        requireLogTailRecovery(
          ws,
          sub,
          sub.records.length,
          'Log tail backfill backpressure; reconnect to recover',
        );
        return;
      }
      let page: ReturnType<typeof queryLogRecordsSince>;
      try {
        page = queryLogRecordsSince(sub.projectId, cursor, MAX_QUERY_LIMIT, sub.sinceUnixNano);
      } catch {
        requireLogTailRecovery(
          ws,
          sub,
          sub.records.length,
          'Log tail backfill failed; reconnect to recover',
        );
        return;
      }
      try {
        ws.send(
          JSON.stringify({
            type: 'logs_tail_backfill',
            projectId: sub.projectId,
            records: page.records.map(serializeLogRecord),
            cursor: page.records.length > 0 ? page.records[page.records.length - 1]!.id : cursor,
            nextCursor: page.nextCursor,
          }),
        );
      } catch {
        requireLogTailRecovery(
          ws,
          sub,
          sub.records.length,
          'Log tail backfill send failed; reconnect to recover',
        );
        return;
      }
      if (page.nextCursor == null) {
        finishLogTailBackfill(ws, sub);
        return;
      }
      cursor = page.nextCursor;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Per-broadcast: resolve the event's projectId (if any) and look it up
  // in the in-memory project list. Both lookups are cheap (resolver hits
  // a single SQLite prepared statement; findProject is an array find);
  // doing them once per broadcast and reusing across all recipients
  // amortises the cost across the fan-out.
  const findProjectLocal = (projectId: string) =>
    getProjects().find((p) => p.id === projectId) ?? null;

  function broadcast(data: Record<string, unknown>): void {
    const msg = JSON.stringify(data);
    if (data.suppressWebSocket !== true) {
      wss.clients.forEach((client: WsClient) => {
        if (client.readyState !== WsClient.OPEN) return;
        const stamp = getWsAuthVisibility(client as AuthStampedWs);
        if (
          !shouldDeliverBroadcast(data, stamp, {
            resolveProjectId: resolveProjectIdFromEvent,
            findProject: findProjectLocal,
            getSessionOwner,
            isSharedReadableSession,
          })
        ) {
          return;
        }
        client.send(msg);
      });
    }
    // Fan out relevant broadcasts to mobile clients via Expo push. Fire-and-
    // forget: push dispatch must never block the WebSocket hot path.
    //
    // Push recipients are filtered inside `handleBroadcastForPush`:
    // private-project events go only to tokens whose user can view the
    // project (`filterTokensForBroadcastVisibility`), and session-scoped
    // events go only to the session owner's devices
    // (`filterTokensForSessionOwner`); unowned sessions keep the shared
    // fan-out.
    void handleBroadcastForPush(data).catch((err: unknown) => {
      console.error('[push] broadcast handler failed:', (err as Error).message);
    });
  }

  wss.on('connection', (ws: WsClient, request: IncomingMessage) => {
    const wsAuth = authenticateWsDetailed(request);
    if (!wsAuth.ok) {
      ws.close(4401, 'Unauthorized — invalid or missing API key');
      return;
    }
    // Stamp the resolved user id on the ws so per-session ownership
    // checks below (and createSession in chat.ts) can attribute new
    // sessions to the caller. Local-bundled mode and apiKey paths don't
    // populate `userId`; those are resolved to the org owner downstream.
    setWsAuthUserId(ws as AuthStampedWs, wsAuth.userId);

    // Also stamp the visibility snapshot used by `broadcast()` to skip
    // events on private projects the caller cannot view. localBypass
    // captures every path where there's no per-user privacy boundary
    // to enforce:
    //   - apiKey / `viaApiKey`: legacy break-glass, treated as Owner.
    //   - no `userId`: bundled-local (`subject: 'local'`) and the
    //     no-auth-configured branch — both return `ok: true` with no
    //     uid; without one we can't filter, so we deliver everything
    //     (consistent with how those callers see every project in REST).
    const stamp: WsVisibilityStamp = {
      userId: wsAuth.userId ?? null,
      role: wsAuth.role,
      localBypass: Boolean(wsAuth.viaApiKey) || !wsAuth.userId,
    };
    setWsAuthVisibility(ws as AuthStampedWs, stamp);

    // Provisioning subscription — a dedicated URL hands this connection
    // off to the orchestrator's event stream rather than the normal
    // agent-chat pipeline. Every buffered event replays, then live
    // events stream in; the socket is closed automatically once the
    // orchestrator emits `done`.
    const provisioningJobId = parseProvisioningPath(request.url);
    if (provisioningJobId) {
      const since = parseProvisioningSince(request.url);
      handleProvisioningSubscription(ws, provisioningJobId, since);
      return;
    }

    console.log('Client connected');

    try {
      ws.send(
        JSON.stringify({
          type: 'active-tasks-snapshot',
          tasks: buildActiveTasksSnapshotLenient(stmts!),
        }),
      );
    } catch {
      /* send failure — client may have disconnected */
    }

    // Sessions currently blocked on an unanswered `agenthub:ask` picker. The
    // sidebar uses this to flag "needs user input" before the first live
    // `awaiting_input` event arrives. Per-session events flow over the normal
    // broadcast path after this initial snapshot.
    try {
      ws.send(
        JSON.stringify({
          type: 'awaiting-input-snapshot',
          items: buildAwaitingInputSnapshotLenient(stmts!),
        }),
      );
    } catch {
      /* send failure — client may have disconnected */
    }

    try {
      const queuedSessions = stmts!.getAllQueuedSessions.all() as Array<{ session_id: string }>;
      for (const { session_id } of queuedSessions) {
        ws.send(
          JSON.stringify({
            type: 'queue_updated',
            sessionId: session_id,
            queue: stmts!.getQueuedMessages.all(session_id) as MessageQueueRow[],
          }),
        );
      }
    } catch {}

    // Preview snapshot: replay the current `agenthub_preview` state for every
    // active compose group the caller is allowed to see. Without this, a
    // client that reconnected after a tab-sleep / laptop-suspend would sit
    // frozen on whatever `preview_starting` event it last received before
    // disconnect — the chat handler's broadcast loop has long since exited,
    // and the per-row terminal flip on the runtime is invisible by default.
    // Each event is filtered through `shouldDeliverBroadcast` so a user
    // doesn't receive snapshots for sessions on projects they can't see.
    try {
      const runtime = getPreviewSnapshotRuntime?.();
      if (runtime) {
        const snapshots = buildPreviewSnapshotEvents(runtime);
        for (const event of snapshots) {
          // Treat the snapshot exactly like a fan-out broadcast: skip
          // recipients whose visibility stamp says they can't see the
          // project this event belongs to.
          if (
            !shouldDeliverBroadcast(event as unknown as Record<string, unknown>, stamp, {
              resolveProjectId: resolveProjectIdFromEvent,
              findProject: findProjectLocal,
              getSessionOwner,
              isSharedReadableSession,
            })
          ) {
            continue;
          }
          ws.send(JSON.stringify(event));
        }
      }
    } catch (err) {
      // Snapshot is best-effort — a DB hiccup or a misbehaving runtime
      // method must never break the rest of the connect handshake.
      console.error(
        '[ws] preview snapshot failed (lenient skip):',
        err instanceof Error ? err.message : err,
      );
    }

    // Background-shell snapshot: the current running shells, grouped by
    // session, so a reconnecting client rebuilds its watch-loop indicator from
    // the server's truth. The live `background_shell_update` events that would
    // have told it fired while the socket was down, and a shell can run for
    // hours — long enough for a laptop suspend to lose every one of them.
    // Sent as a single replace-the-world payload rather than per-shell events
    // so a client also *clears* sessions whose shells finished while it was
    // away. Filtering (project visibility AND session ownership) lives in
    // `buildBackgroundShellSnapshot`.
    try {
      const shellRuntime = getBackgroundShellSnapshotRuntime?.();
      if (shellRuntime) {
        const snapshot = buildBackgroundShellSnapshot(shellRuntime, stamp, {
          resolveProjectId: resolveProjectIdFromEvent,
          findProject: findProjectLocal,
          getSessionOwner,
        });
        ws.send(JSON.stringify(snapshot));
      }
    } catch (err) {
      // Best-effort — never break the connect handshake over an indicator.
      console.error(
        '[ws] background-shell snapshot failed (lenient skip):',
        err instanceof Error ? err.message : err,
      );
    }

    // Finalize snapshot: replay one `finalize_run_phase_changed` per
    // non-terminal finalize run so a reconnecting client converges its
    // checks block / button to the server's truth. `useFinalizeRun` mirrors
    // run state purely from streamed `finalize_run_*` events; every event that
    // fired while the socket was down (tab sleep, Wi-Fi switch, NAT rebind,
    // or the mount→first-connect gap) was otherwise lost with no server-side
    // recovery — the recurring "tests are running but the UI doesn't say they
    // are" report. Prior fixes were client-side reconnect heuristics; this is
    // the unconditional server counterpart. The client's `onPhaseChanged`
    // turns each event into a full REST refetch (run + steps + phases). Each
    // event is filtered through `shouldDeliverBroadcast` so a user never
    // receives a snapshot for a session on a project they can't see.
    try {
      const finalizeEvents = buildFinalizeSnapshotEvents(stmts);
      for (const event of finalizeEvents) {
        if (
          !shouldDeliverBroadcast(event as unknown as Record<string, unknown>, stamp, {
            resolveProjectId: resolveProjectIdFromEvent,
            findProject: findProjectLocal,
            getSessionOwner,
            isSharedReadableSession,
          })
        ) {
          continue;
        }
        ws.send(JSON.stringify(event));
      }
    } catch (err) {
      // Best-effort — a DB hiccup must never break the connect handshake.
      console.error(
        '[ws] finalize snapshot failed (lenient skip):',
        err instanceof Error ? err.message : err,
      );
    }

    // Per-session ownership gate. Returns true if the caller may act on
    // `sessionId`. Sessions that don't yet exist (orphan auto-create
    // path used by `chat`) are permitted — they get stamped with the
    // caller's user id at create time.
    // The global `x-api-key` break-glass (and local-bundled / no-auth
    // handshakes) authenticate with no per-user id — they're stamped with
    // `localBypass` instead. Forward that as `authViaApiKey` so the
    // ownership gate treats them as full-privilege Owners, matching REST.
    const ownerReq = {
      authUserId: getWsAuthUserId(ws as AuthStampedWs),
      authViaApiKey: Boolean(getWsAuthVisibility(ws as AuthStampedWs)?.localBypass),
    };
    const mayActOnSession = (sessionId: string): boolean => {
      try {
        const row = stmts!.getSession.get(sessionId) as { id?: string } | undefined;
        if (!row) return true;
      } catch {
        return true;
      }
      return userOwnsSession(ownerReq, sessionId);
    };

    ws.on('message', (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      const { type } = msg;
      if (type === 'chat' && typeof msg.agentId === 'string' && typeof msg.sessionId === 'string') {
        if (!mayActOnSession(msg.sessionId)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
          return;
        }
        // Strip `extraEnv` so clients cannot inject arbitrary env vars into
        // the spawned CLI process (e.g. overriding GH_TOKEN, ANTHROPIC_API_KEY,
        // AGENT_HUB_URL, LD_PRELOAD).  Only the autonomous-dispatch in-process
        // call site (server/autonomous.ts) — which never goes through WebSocket
        // — is a legitimate producer of extraEnv.
        const { extraEnv: _drop, ...safeMsg } = msg;
        void handleChat(ws, safeMsg as unknown as import('./types.js').ChatMessage).catch(
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[chat] handleChat rejected: ${message}`);
            try {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  sessionId: typeof safeMsg.sessionId === 'string' ? safeMsg.sessionId : undefined,
                  error: message,
                }),
              );
            } catch {
              /* socket already gone */
            }
          },
        );
      } else if (type === 'cancel' && typeof msg.sessionId === 'string') {
        if (!mayActOnSession(msg.sessionId)) return;
        handleCancel(msg.sessionId);
      } else if (
        type === 'design_chat' &&
        typeof msg.designId === 'string' &&
        typeof msg.content === 'string'
      ) {
        handleDesignChat(ws, msg as unknown as import('./types.js').DesignChatMessage);
      } else if (type === 'design_cancel' && typeof msg.designId === 'string') {
        handleDesignCancel(msg.designId);
      } else if (
        type === 'dequeue' &&
        typeof msg.sessionId === 'string' &&
        typeof msg.messageId === 'string'
      ) {
        if (!mayActOnSession(msg.sessionId)) return;
        handleDequeue(msg.sessionId, msg.messageId);
      } else if (
        type === 'edit_queue_item' &&
        typeof msg.sessionId === 'string' &&
        typeof msg.messageId === 'string' &&
        typeof msg.content === 'string'
      ) {
        if (!mayActOnSession(msg.sessionId)) return;
        handleEditQueueItem(msg.sessionId, msg.messageId, msg.content);
      } else if (type === 'logs_subscribe') {
        const projectId = typeof msg.projectId === 'string' ? msg.projectId : '';
        const cursor = typeof msg.cursor === 'number' ? msg.cursor : 0;
        // Optional recent-window lower bound (ns). A malformed value is ignored
        // rather than rejected — the subscription still succeeds, unbounded.
        // Nanosecond epochs (~1.76e18) exceed MAX_SAFE_INTEGER, so this is a
        // finite/positive check, not `isSafeInteger`; ~256ns double coarseness
        // is irrelevant for a window boundary and matches how the REST query
        // and ingest already treat these timestamps.
        const sinceUnixNano =
          typeof msg.sinceUnixNano === 'number' &&
          Number.isFinite(msg.sinceUnixNano) &&
          msg.sinceUnixNano > 0
            ? msg.sinceUnixNano
            : undefined;
        // Explicit fresh-subscribe signal. Whether a subscriber already holds
        // tail state is something only that subscriber knows, so it must be
        // *stated* rather than inferred from `cursor === 0`: 0 is also the
        // legitimate resume cursor for a client that has not yet durably
        // accepted a row, and seeding one of those would silently drop every
        // retained record older than the newest MAX_QUERY_LIMIT (the seed
        // reports `nextCursor: null`, so the client never pages back for them).
        // Absent, non-boolean, or false → forward drain, the lossless default,
        // which is also what every pre-`seed` client gets.
        //
        // A `seed: true` paired with a non-zero cursor is self-contradictory:
        // the caller claims to be fresh while naming rows it has already seen.
        // Resolve it toward the lossless branch rather than honouring the seed.
        const seedRequested = msg.seed === true && cursor === 0;
        if (
          projectId.length === 0 ||
          projectId.length > 200 ||
          !Number.isSafeInteger(cursor) ||
          cursor < 0
        ) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid log subscription' }));
          return;
        }
        const project = findProjectLocal(projectId);
        const subscriptionCaller = getWsAuthVisibility(ws as AuthStampedWs);
        if (
          !project ||
          !subscriptionCaller ||
          !canViewProject(project, {
            userId: subscriptionCaller.userId,
            role: subscriptionCaller.role,
            localBypass: Boolean(subscriptionCaller.localBypass),
          })
        ) {
          // Do not disclose whether a hidden project exists.
          ws.send(JSON.stringify({ type: 'error', error: 'Project not found' }));
          return;
        }
        const sub: LogTailSubscription = {
          projectId,
          records: [],
          scheduled: false,
          backfillInProgress: true,
          sinceUnixNano,
        };
        // Install before reading the backfill: concurrent commits can produce a
        // duplicate (the client dedupes by id), but never an unrecoverable gap.
        tailSubscriptions.set(ws, sub);
        void streamLogTailBackfill(ws, sub, cursor, seedRequested);
      } else if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => {
      tailSubscriptions.delete(ws);
      console.log('Client disconnected');
    });
  });

  // `wss` is normally process-lifetime. Standalone test servers close it,
  // however, and must release their listener so records do not fan into dead
  // server instances.
  wss.on('close', unsubscribeLogTail);

  return { wss, broadcast };
}

/**
 * Attach a freshly-opened WebSocket to a provisioning job. Replays every
 * buffered event, then streams live events. Closes the socket on the
 * terminal `done` event (or on error if the job id is unknown).
 *
 * `since` (optional): the last seq id the client already received; only
 * events with `seq > since` are replayed. Used by the client's reconnect
 * path so a dropped stream can resume without re-processing.
 */
function handleProvisioningSubscription(
  ws: WsClient,
  jobId: string,
  since: number | null = null,
): void {
  const send = (data: Record<string, unknown>): void => {
    if (ws.readyState !== WsClient.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* caller disconnected */
    }
  };

  const unsubscribe = subscribeToJob(
    jobId,
    (ev) => {
      send(ev as unknown as Record<string, unknown>);
      if (ev.type === 'done') {
        try {
          ws.close(1000, 'Job complete');
        } catch {
          /* ignore */
        }
      }
    },
    since != null ? { since } : {},
  );

  if (!unsubscribe) {
    send({ type: 'done', error: { code: 404, message: `Unknown job ${jobId}` } });
    try {
      ws.close(4404, 'Unknown provisioning job');
    } catch {
      /* ignore */
    }
    return;
  }

  // Edge case: if the job already finished before we subscribed (tight
  // race between POST and WS open), `subscribeToJob` replays the
  // terminal done and we still need to close the socket.
  if (isJobFinished(jobId)) {
    try {
      ws.close(1000, 'Job already complete');
    } catch {
      /* ignore */
    }
    return;
  }

  ws.on('close', () => {
    unsubscribe();
  });
  ws.on('error', () => {
    unsubscribe();
  });
}
