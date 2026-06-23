import { useRef, useCallback, useEffect, useState } from 'react';
import { getWsUrl } from '../utils/connection';

const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;
const PING_INTERVAL = 30000;

export function useWebSocket(onMessage: any) {
  const wsRef = useRef<any>(null);
  const reconnectDelay = useRef(RECONNECT_DELAY);
  const reconnectTimer = useRef<any>(null);
  const pingTimer = useRef<any>(null);
  // Pong-liveness watchdog. Set true when a ping is sent and cleared on any
  // inbound frame (a pong, or any other server message — both prove the link
  // is alive). If it is still true at the next ping tick, the previous ping
  // went unanswered: the socket is half-open (TCP silently dropped on sleep /
  // Wi-Fi switch / NAT rebind / idle proxy kill, with no FIN/RST reaching the
  // browser, so `readyState` is stuck OPEN and `onclose` never fires). Without
  // this, `connected` stays true forever, no reconnect happens, the
  // `agenthub:ws_reconnected` self-heal never fires, and every finalize step
  // event during the dead window is lost — the "tests don't show" report.
  const awaitingPongRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setReconnecting(true);
    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
      setReconnecting(false);
      reconnectDelay.current = RECONNECT_DELAY;

      // Start ping interval for keepalive + half-open detection.
      awaitingPongRef.current = false;
      clearInterval(pingTimer.current);
      pingTimer.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (awaitingPongRef.current) {
          // The previous ping was never answered (no pong, no other frame) —
          // the connection is dead but the browser hasn't noticed. Force-close
          // so `onclose` fires, which flips `connected` false→true on the next
          // successful open and drives the `agenthub:ws_reconnected` refetch.
          console.warn('WebSocket pong timeout — forcing reconnect');
          ws.close();
          return;
        }
        awaitingPongRef.current = true;
        ws.send(JSON.stringify({ type: 'ping' }));
      }, PING_INTERVAL);
    };

    ws.onmessage = (event: any) => {
      // Any inbound frame proves the link is alive — clear the pong watchdog
      // before doing anything else (a pong is the explicit ack, but ordinary
      // traffic counts too, so a busy socket is never falsely reaped).
      awaitingPongRef.current = false;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong') return; // keepalive response
        onMessageRef.current?.(data);
      } catch (e: any) {
        console.error('Failed to parse WS message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);
      wsRef.current = null;
      awaitingPongRef.current = false;
      clearInterval(pingTimer.current);

      // Reconnect with exponential backoff
      setReconnecting(true);
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, MAX_RECONNECT_DELAY);
        connect();
      }, reconnectDelay.current);
    };

    ws.onerror = (err: any) => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(pingTimer.current);
      const ws = wsRef.current;
      if (ws) {
        // Neutralize handlers so a phantom socket from StrictMode's
        // mount→cleanup→mount cycle can't fire onmessage/onclose after we're gone.
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  return { send, connected, reconnecting, wsRef };
}
