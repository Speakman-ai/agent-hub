import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

// Minimal stand-in for the browser WebSocket. The real one cannot be driven
// deterministically under fake timers, so we expose hooks to simulate the
// server side: `simulateOpen`, `simulateMessage`, and a `close()` that mirrors
// the browser's "fire onclose" behaviour.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  sent: any[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // ── test drivers ────────────────────────────────────────────────
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(obj: any) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  get pings() {
    return this.sent.filter((m) => m?.type === 'ping');
  }
}

const PING_INTERVAL = 30000;

describe('useWebSocket pong-liveness watchdog', () => {
  let originalWs: any;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWs = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWs;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function latestSocket() {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  it('keeps a healthy socket open when pongs arrive', () => {
    const { result } = renderHook(() => useWebSocket(vi.fn()));
    const ws = latestSocket();

    act(() => ws.simulateOpen());
    expect(result.current.connected).toBe(true);

    // First ping tick: a ping is sent and we are now awaiting a pong.
    act(() => vi.advanceTimersByTime(PING_INTERVAL));
    expect(ws.pings).toHaveLength(1);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    // Server answers the keepalive.
    act(() => ws.simulateMessage({ type: 'pong' }));

    // Next tick: watchdog is satisfied, sends another ping, socket stays open.
    act(() => vi.advanceTimersByTime(PING_INTERVAL));
    expect(ws.pings).toHaveLength(2);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(result.current.connected).toBe(true);
  });

  it('force-closes a half-open socket when a ping goes unanswered (the bug)', () => {
    const { result } = renderHook(() => useWebSocket(vi.fn()));
    const ws = latestSocket();

    act(() => ws.simulateOpen());
    expect(result.current.connected).toBe(true);

    // Tick 1: ping sent, no pong comes back (link is silently dead).
    act(() => vi.advanceTimersByTime(PING_INTERVAL));
    expect(ws.pings).toHaveLength(1);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    // Tick 2: previous ping still unanswered → watchdog force-closes so the
    // reconnect/self-heal chain can run. Before the fix the socket stayed OPEN
    // and `connected` was stuck true forever.
    act(() => vi.advanceTimersByTime(PING_INTERVAL));
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(result.current.connected).toBe(false);
  });

  it('treats any inbound frame (not only pong) as proof of life', () => {
    renderHook(() => useWebSocket(vi.fn()));
    const ws = latestSocket();
    act(() => ws.simulateOpen());

    act(() => vi.advanceTimersByTime(PING_INTERVAL));
    expect(ws.pings).toHaveLength(1);

    // Ordinary application traffic arrives instead of a pong.
    act(() => ws.simulateMessage({ type: 'finalize_run_step_state', run_id: 'r1' }));

    // Watchdog cleared → next tick sends a fresh ping and does NOT close.
    act(() => vi.advanceTimersByTime(PING_INTERVAL));
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(ws.pings).toHaveLength(2);
  });

  it('reconnects after a half-open close, enabling the connected false→true transition', () => {
    const { result } = renderHook(() => useWebSocket(vi.fn()));
    const ws = latestSocket();
    act(() => ws.simulateOpen());

    // Drive the half-open detection to completion.
    act(() => vi.advanceTimersByTime(PING_INTERVAL)); // ping, no pong
    act(() => vi.advanceTimersByTime(PING_INTERVAL)); // watchdog closes
    expect(result.current.connected).toBe(false);

    // Backoff reconnect timer (RECONNECT_DELAY = 2000ms) opens a fresh socket.
    act(() => vi.advanceTimersByTime(2000));
    const ws2 = latestSocket();
    expect(ws2).not.toBe(ws);

    act(() => ws2.simulateOpen());
    // The false→true edge is exactly what useWsReconnectBroadcast keys on to
    // emit `agenthub:ws_reconnected`, which makes useFinalizeRun refetch.
    expect(result.current.connected).toBe(true);
  });
});
