import { useEffect, useRef } from 'react';

/**
 * Fan out a `agenthub:ws_reconnected` window event whenever the WebSocket
 * transitions into the connected state *after a disconnected window was
 * observed* — i.e. the first successful connection when the app mounted with
 * the socket down, and every subsequent reconnect after a drop.
 *
 * Why this exists: the server replays connect snapshots for some streams
 * (active-tasks / awaiting-input / preview) but not for everything. State
 * that is only patched by streamed events — most notably the finalize run
 * mirrored by `useFinalizeRun` — goes stale if events fire while the socket
 * is down, because the server does not buffer/replay them on connect.
 * Consumers listen for this event and reconcile against the server (refetch),
 * so a transient WS drop can't strand the UI on stale state ("tests are
 * either not showing or not running sometimes").
 *
 * Why we reconcile on the FIRST successful connection too (not just later
 * reconnects): `useWebSocket` always starts `connected === false` and opens
 * the socket asynchronously, so in the real app the first connection is a
 * genuine `false -> true` transition. A consumer's mount-time fetch (e.g.
 * `useFinalizeRun`'s initial REST load) runs *before* that first socket open,
 * so any event that fires in the `[mount, first-connect]` gap is missed with
 * no snapshot to recover it. Firing on that first connection closes the gap;
 * the cost is one extra reconcile fetch shortly after mount, which is cheap
 * and idempotent. (Earlier this hook suppressed the first connection to avoid
 * that fetch — a false economy that left the gap open. See review of PR for
 * card b65f2cc5.)
 *
 * The ONLY case that does not fire is the degenerate one where the component
 * mounts with the socket already open (`connected === true` on the first
 * observation) and never drops — there was no disconnected window, so the
 * consumer's mount fetch already reflects current truth.
 *
 * @param connected current socket-open flag (from `useWebSocket`)
 * @param dispatch  injectable emitter (defaults to window dispatch) — for tests
 */
export function useWsReconnectBroadcast(
  connected: boolean,
  dispatch: () => void = () => window.dispatchEvent(new CustomEvent('agenthub:ws_reconnected')),
): void {
  // True once we have observed the socket in a disconnected state. Set on any
  // `connected === false` observation (including the initial mount value) and
  // cleared after a reconcile fires, so each disconnect → reconnect cycle
  // triggers exactly one reconciliation.
  const sawDisconnectedRef = useRef(false);
  useEffect(() => {
    if (!connected) {
      sawDisconnectedRef.current = true;
      return;
    }
    if (sawDisconnectedRef.current) {
      sawDisconnectedRef.current = false;
      dispatch();
    }
    // `dispatch` is a stable default (or a test-provided fn); excluding it
    // keeps the effect keyed purely on the connection transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
}
