import { useRef, useCallback, useEffect, useState } from 'react';

const WS_URL = `ws://${window.location.hostname}:3051`;
const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;
const PING_INTERVAL = 30000;

export function useWebSocket(onMessage) {
  const wsRef = useRef(null);
  const reconnectDelay = useRef(RECONNECT_DELAY);
  const reconnectTimer = useRef(null);
  const pingTimer = useRef(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setReconnecting(true);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
      setReconnecting(false);
      reconnectDelay.current = RECONNECT_DELAY;

      // Start ping interval for keepalive
      clearInterval(pingTimer.current);
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong') return; // keepalive response
        onMessageRef.current?.(data);
      } catch (e) {
        console.error('Failed to parse WS message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);
      wsRef.current = null;
      clearInterval(pingTimer.current);

      // Reconnect with exponential backoff
      setReconnecting(true);
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(
          reconnectDelay.current * 1.5,
          MAX_RECONNECT_DELAY
        );
        connect();
      }, reconnectDelay.current);
    };

    ws.onerror = (err) => {
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

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  return { send, connected, reconnecting };
}
