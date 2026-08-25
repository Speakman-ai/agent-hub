import { useRef, useCallback, useEffect, useState } from 'react';
import { getWsUrl } from '../utils/config';
import { pingTickAction } from '../utils/websocketLiveness';
const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;
const PING_INTERVAL = 30000;
export function useWebSocket(onMessage: any) {
  const wsRef = useRef<any>(null);
  const reconnectDelay = useRef(RECONNECT_DELAY);
  const reconnectTimer = useRef<any>(null);
  const pingTimer = useRef<any>(null);
  // Pong-liveness watchdog — set true when a ping is sent, cleared on any
  // inbound frame. If still true at the next ping tick the link is half-open
  // (TCP silently dropped on sleep / network switch with no close reaching
  // the app, so `readyState` is stuck OPEN and `onclose` never fires). Force
  // a close so the reconnect path runs; otherwise streamed state (e.g. the
  // finalize checks block) goes stale forever. Mirrors the web client.
  const awaitingPongRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const url = getWsUrl();
    if (!url) {
      // No server configured yet — don't attempt connection
      setConnected(false);
      setReconnecting(false);
      return;
    }
    setReconnecting(true);
    const ws = new WebSocket(url);
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
        const action = pingTickAction(ws.readyState === WebSocket.OPEN, awaitingPongRef.current);
        if (action === 'noop') return;
        if (action === 'close') {
          // Previous ping unanswered — connection is dead but unnoticed.
          // Force-close so onclose fires and the reconnect path runs.
          console.warn('WebSocket pong timeout — forcing reconnect');
          ws.close();
          return;
        }
        awaitingPongRef.current = true;
        ws.send(JSON.stringify({ type: 'ping' }));
      }, PING_INTERVAL);
    };
    ws.onmessage = (event: any) => {
      // Any inbound frame proves the link is alive — clear the watchdog.
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
  const reconnect = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    clearInterval(pingTimer.current);
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent auto-reconnect
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
    reconnectDelay.current = RECONNECT_DELAY;
    connect();
  }, [connect]);
  // Don't auto-connect on mount — wait for AppContext to load config
  // from AsyncStorage and call reconnect() explicitly. This prevents
  // the race condition where WS connects before auth is available.
  useEffect(() => {
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(pingTimer.current);
      wsRef.current?.close();
    };
  }, []);
  /**
   * Send a JSON frame over the socket.
   *
   * Explicit boolean contract (relied on by callers like DesignViewScreen to
   * decide whether to commit optimistic UI): returns `true` only when the
   * socket is OPEN and the frame was written; returns `false` when the socket
   * is connecting/closed so the caller can avoid clearing the composer or
   * flipping `processing` for a message that never left the device.
   *
   * @param {unknown} data
   * @returns {boolean} whether the frame was actually written
   */
  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);
  return { send, connected, reconnecting, reconnect };
}
