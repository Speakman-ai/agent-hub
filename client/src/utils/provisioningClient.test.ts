import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provisionProject, subscribeProvisioningEvents } from './provisioningClient';

// Mock the shared connection module so the helper hits a known base URL
// without pulling in the whole auth wiring. `appendAuthToWsUrl` is
// overridden per-test (see `setAppendAuth` below) so suites can verify
// both the no-credential and credential-present paths.
let mockAppendAuth = (url: any) => url;
let mockRebase = (url: any) => url;
(vi as any).mock('./connection.js', () => ({
  getApiBase: () => 'http://localhost:3051/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test' }),
  appendAuthToWsUrl: (url: any) => mockAppendAuth(url),
  rebaseWsUrlToClientOrigin: (url: any) => mockRebase(url),
}));
function setAppendAuth(fn: any) {
  mockAppendAuth = fn;
}
afterEach(() => {
  mockAppendAuth = (url: any) => url;
  mockRebase = (url: any) => url;
});

describe('provisionProject', () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the payload and returns the job descriptor on 200', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobId: 'job-1', wsUrl: 'ws://x' }),
    });
    const result = await provisionProject({
      description: 'hi',
      appType: 'web-app',
      stack: 'react-vite-express-sqlite',
    });
    expect(result!).toEqual({ jobId: 'job-1', wsUrl: 'ws://x' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3051/api/projects/provision',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test',
        }),
      }),
    );
    const call = (globalThis.fetch as any).mock.calls[0][1];
    expect(JSON.parse(call.body)).toMatchObject({ description: 'hi', appType: 'web-app' });
  });

  it('throws an informative error when the server returns a JSON error body', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ error: 'owner missing' }),
    });
    await expect(provisionProject({})).rejects.toThrow(/422.*owner missing/);
  });

  it('throws a generic error when the server returns non-JSON', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(provisionProject({})).rejects.toThrow(/Provisioning failed: 500/);
  });
});

describe('subscribeProvisioningEvents', () => {
  let sockets: any[] = [];
  class FakeSocket {
    [key: string]: any;
    constructor(url: any) {
      this.url = url;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.closed = false;
      sockets.push(this);
    }
    close() {
      this.closed = true;
      // Intentionally do NOT fire onclose — caller initiated, and the
      // subscribe helper sets its closed flag first, guarding handlers.
    }
  }

  beforeEach(() => {
    sockets = [];
    (globalThis as any).WebSocket = FakeSocket;
  });
  afterEach(() => {
    delete (globalThis as any).WebSocket;
  });

  it('parses JSON frames and forwards them to onEvent', () => {
    const onEvent = vi.fn();
    subscribeProvisioningEvents('ws://x', { onEvent });
    const sock = sockets[0];
    sock.onmessage({ data: JSON.stringify({ type: 'phase', phase: 'validate', status: 'ok' }) });
    expect(onEvent!).toHaveBeenCalledWith({ type: 'phase', phase: 'validate', status: 'ok' });
  });

  it('forwards parse errors to onError and keeps the socket open', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribeProvisioningEvents('ws://x', { onEvent, onError });
    const sock = sockets[0];
    sock.onmessage({ data: '{not json' });
    expect(onError!).toHaveBeenCalled();
    expect(onEvent!).not.toHaveBeenCalled();
  });

  it('returns a close handle that tears down the socket and silences further events', () => {
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const handle = subscribeProvisioningEvents('ws://x', { onEvent, onClose });
    const sock = sockets[0];
    handle.close();
    expect(sock!.closed).toBe(true);
    // Subsequent messages after caller-initiated close are ignored.
    sock.onmessage({ data: JSON.stringify({ type: 'log', line: 'late' }) });
    expect(onEvent!).not.toHaveBeenCalled();
    // onClose fired by the server after we closed should also be swallowed.
    sock.onclose?.();
    expect(onClose!).not.toHaveBeenCalled();
  });

  it('fires onClose after the server closes the socket following a terminal done event', () => {
    const onClose = vi.fn();
    const onEvent = vi.fn();
    subscribeProvisioningEvents('ws://x', { onEvent, onClose });
    // Deliver terminal done, then server closes — this is the clean path.
    sockets[0].onmessage({ data: JSON.stringify({ type: 'done', seq: 0 }) });
    sockets[0].onclose();
    expect(onClose!).toHaveBeenCalledTimes(1);
  });

  it('handles WebSocket constructor failure by calling onError', () => {
    (globalThis as any).WebSocket = function () {
      throw new Error('ws unavailable');
    };
    const onError = vi.fn();
    const handle = subscribeProvisioningEvents('ws://x', { onEvent: vi.fn(), onError });
    expect(onError!).toHaveBeenCalled();
    // close() is still safe after construction failure
    expect(() => handle.close()).not.toThrow();
  });

  it('resumes from the last seq after an unexpected close', () => {
    const sockets: any[] = [];
    const factory = (url: any) => {
      const sock = {
        url,
        onmessage: null,
        onclose: null,
        onerror: null,
        closed: false,
        close: vi.fn(function (this: any) {
          this.closed = true;
        }),
      };
      sockets.push(sock);
      return sock;
    };
    const scheduled: any[] = [];
    const setTimeoutFn = (fn: any /*, ms */) => {
      scheduled.push(fn);
      return scheduled.length;
    };
    const clearTimeoutFn = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();

    subscribeProvisioningEvents('ws://job', {
      onEvent,
      onClose,
      watchdogMs: 60_000,
      reconnectBackoffMs: 0,
      maxReconnects: 1,
      webSocketFactory: factory,
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(sockets.length).toBe(1);
    // Deliver two events with seqs.
    sockets[0].onmessage({
      data: JSON.stringify({ type: 'phase', phase: 'validate', status: 'ok', seq: 0 }),
    });
    sockets[0].onmessage({
      data: JSON.stringify({ type: 'phase', phase: 'copy-template', status: 'ok', seq: 1 }),
    });
    expect(onEvent!).toHaveBeenCalledTimes(2);

    // Server drops the socket mid-stream — onclose fires WITHOUT a terminal done.
    sockets[0].onclose();
    // onClose MUST NOT have been called yet — the client should reconnect silently.
    expect(onClose!).not.toHaveBeenCalled();

    // Run the scheduled reconnect timer.
    expect(scheduled.length).toBeGreaterThan(0);
    // First scheduled callback is the watchdog; find the reconnect one
    // (scheduled after clearing the watchdog). We just run them all — the
    // watchdog's callback is a no-op because state.closed is false but
    // state.doneReceived is also false, so it'd synthesize a stall. To
    // avoid that, only run the most recently scheduled (the reconnect).
    const reconnectFn = scheduled[scheduled.length - 1];
    reconnectFn();

    // Second socket should have been opened with ?since=1.
    expect(sockets.length).toBe(2);
    expect(sockets[1].url).toBe('ws://job?since=1');

    // Resume stream delivers terminal done — the second socket should
    // fire onClose after the done event lands.
    sockets[1].onmessage({ data: JSON.stringify({ type: 'done', seq: 2 }) });
    sockets[1].onclose();
    expect(onEvent!).toHaveBeenCalledWith({ type: 'done', seq: 2 });
    expect(onClose!).toHaveBeenCalledTimes(1);
  });

  it('surfaces a STREAM_DROPPED failure when the second socket also drops', () => {
    const sockets: any[] = [];
    const factory = (url: any) => {
      const sock = {
        url,
        onmessage: null,
        onclose: null,
        onerror: null,
        closed: false,
        close: vi.fn(),
      };
      sockets.push(sock);
      return sock;
    };
    const scheduled: any[] = [];
    const setTimeoutFn = (fn: any) => {
      scheduled.push(fn);
      return scheduled.length;
    };
    const clearTimeoutFn = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();

    subscribeProvisioningEvents('ws://job', {
      onEvent,
      onClose,
      watchdogMs: 60_000,
      reconnectBackoffMs: 0,
      maxReconnects: 1,
      webSocketFactory: factory,
      setTimeoutFn,
      clearTimeoutFn,
    });

    // First socket: deliver one event then drop.
    sockets[0].onmessage({
      data: JSON.stringify({ type: 'phase', phase: 'validate', status: 'ok', seq: 0 }),
    });
    sockets[0].onclose();

    // Run the reconnect timer (last scheduled).
    scheduled[scheduled.length - 1]();
    expect(sockets.length).toBe(2);
    expect(sockets[1].url).toBe('ws://job?since=0');

    // Second socket drops without any event — reconnect budget exhausted.
    sockets[1].onclose();

    // Caller should have received a synthesized terminal done with
    // STREAM_DROPPED so their UI can render the failure card.
    const doneCall = (onEvent as any).mock.calls.find((c: any) => c[0]?.type === 'done');
    expect(doneCall!).toBeTruthy();
    expect(doneCall[0].error.code).toBe('STREAM_DROPPED');
    expect(onClose!).toHaveBeenCalledTimes(1);
  });

  it('watchdog fires a STREAM_STALLED failure when the stream goes silent', () => {
    const sockets: any[] = [];
    const factory = (url: any) => {
      const sock = {
        url,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: vi.fn(),
      };
      sockets.push(sock);
      return sock;
    };
    const scheduled: any[] = [];
    const setTimeoutFn = (fn: any, ms: any) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    };
    const clearTimeoutFn = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();

    subscribeProvisioningEvents('ws://job', {
      onEvent,
      onClose,
      watchdogMs: 1_000,
      reconnectBackoffMs: 0,
      maxReconnects: 1,
      webSocketFactory: factory,
      setTimeoutFn,
      clearTimeoutFn,
    });

    // No events arrive; run the watchdog timer (the very first scheduled
    // callback after connect is the watchdog).
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled[0].ms).toBe(1_000);
    scheduled[0].fn();

    const doneCall = (onEvent as any).mock.calls.find((c: any) => c[0]?.type === 'done');
    expect(doneCall!).toBeTruthy();
    expect(doneCall[0].error.code).toBe('STREAM_STALLED');
    expect(doneCall[0].error.message).toMatch(/1000ms/);
    expect(onClose!).toHaveBeenCalledTimes(1);
  });

  it('watchdog resets on each incoming event', () => {
    const sockets: any[] = [];
    const factory = (url: any) => {
      const sock = {
        url,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: vi.fn(),
      };
      sockets.push(sock);
      return sock;
    };
    // Track timers — we clear & re-arm on every event, so the scheduled
    // array grows monotonically and the clearTimeoutFn is called.
    const scheduled: any[] = [];
    let nextHandle = 1;
    const setTimeoutFn = (fn: any, ms: any) => {
      const id = nextHandle++;
      scheduled.push({ id, fn, ms });
      return id;
    };
    const clearTimeoutFn = vi.fn();

    subscribeProvisioningEvents('ws://job', {
      onEvent: vi.fn(),
      onClose: vi.fn(),
      watchdogMs: 1_000,
      reconnectBackoffMs: 0,
      webSocketFactory: factory,
      setTimeoutFn,
      clearTimeoutFn,
    });

    // Initial watchdog armed at connect.
    expect(scheduled.length).toBe(1);
    // Event arrives — watchdog should be cleared and re-armed.
    sockets[0].onmessage({ data: JSON.stringify({ type: 'log', line: 'hi', seq: 0 }) });
    expect(clearTimeoutFn!).toHaveBeenCalled();
    expect(scheduled.length).toBe(2);
  });

  it('terminal done clears the watchdog so it never fires post-completion', () => {
    const sockets: any[] = [];
    const factory = (url: any) => {
      const sock = {
        url,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: vi.fn(),
      };
      sockets.push(sock);
      return sock;
    };
    const scheduled: any[] = [];
    const setTimeoutFn = (fn: any, ms: any) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    };
    const clearTimeoutFn = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();

    subscribeProvisioningEvents('ws://job', {
      onEvent,
      onClose,
      watchdogMs: 1_000,
      webSocketFactory: factory,
      setTimeoutFn,
      clearTimeoutFn,
    });

    sockets[0].onmessage({ data: JSON.stringify({ type: 'done', seq: 0 }) });
    sockets[0].onclose();

    // Running the initial watchdog callback after done must NOT emit a
    // second synthesized terminal event.
    const firstWatchdog = scheduled[0].fn;
    (onEvent as any).mockClear();
    firstWatchdog();
    expect(onEvent!).not.toHaveBeenCalled();
  });

  // Regression: server-issued wsUrls (POST /api/projects/provision)
  // come back without an auth credential. The client must splice
  // ?token= / ?apiKey= in before
  // opening the socket — otherwise multi-user hubs close the upgrade
  // with 4401 and surface "Provisioning stream dropped and could not be
  // resumed." See `appendAuthToWsUrl` in connection.js.
  describe('auth token append', () => {
    it('routes the initial wsUrl through appendAuthToWsUrl', () => {
      setAppendAuth((url: any) => `${url}${url.includes('?') ? '&' : '?'}token=jwt-abc`);
      const sockets: any[] = [];
      const factory = (url: any) => {
        const sock = { url, onmessage: null, onclose: null, onerror: null, close: vi.fn() };
        sockets.push(sock);
        return sock;
      };
      subscribeProvisioningEvents('ws://job', {
        onEvent: vi.fn(),
        watchdogMs: 60_000,
        webSocketFactory: factory,
        setTimeoutFn: () => 1,
        clearTimeoutFn: vi.fn(),
      });
      expect(sockets[0].url).toBe('ws://job?token=jwt-abc');
    });

    // Regression: behind a reverse proxy / Docker port-map the server-issued
    // wsUrl carries the wrong host:port (Host header stripped to bare IP), so
    // the browser dials the wrong port and the socket fails before auth —
    // surfacing as "Provisioning stream dropped and could not be resumed".
    // The client MUST rebase the URL onto its own origin, then append auth.
    it('rebases the server wsUrl onto the client origin before appending auth', () => {
      // Simulate the docker bug: server minted ws://10.0.0.5 (no port); the
      // browser actually reached 10.0.0.5:8080. rebase rewrites the origin,
      // appendAuth then splices the credential onto the rebased URL.
      setAppendAuth((url: any) => `${url}${url.includes('?') ? '&' : '?'}token=jwt-abc`);
      mockRebase = (url: any) => url.replace('ws://10.0.0.5/', 'ws://10.0.0.5:8080/');
      const sockets: any[] = [];
      const factory = (url: any) => {
        const sock = { url, onmessage: null, onclose: null, onerror: null, close: vi.fn() };
        sockets.push(sock);
        return sock;
      };
      subscribeProvisioningEvents('ws://10.0.0.5/api/provisioning/job-9/events', {
        onEvent: vi.fn(),
        watchdogMs: 60_000,
        webSocketFactory: factory,
        setTimeoutFn: () => 1,
        clearTimeoutFn: vi.fn(),
      });
      expect(sockets[0].url).toBe('ws://10.0.0.5:8080/api/provisioning/job-9/events?token=jwt-abc');
    });

    it('leaves the wsUrl unchanged when no credential is available', () => {
      setAppendAuth((url: any) => url);
      const sockets: any[] = [];
      const factory = (url: any) => {
        const sock = { url, onmessage: null, onclose: null, onerror: null, close: vi.fn() };
        sockets.push(sock);
        return sock;
      };
      subscribeProvisioningEvents('ws://job', {
        onEvent: vi.fn(),
        watchdogMs: 60_000,
        webSocketFactory: factory,
        setTimeoutFn: () => 1,
        clearTimeoutFn: vi.fn(),
      });
      expect(sockets[0].url).toBe('ws://job');
    });

    it('re-appends auth on the reconnect URL alongside ?since=', () => {
      // appendAuthToWsUrl is called fresh on every connect, so a token
      // rotation between initial-connect and reconnect would still
      // produce a valid URL. The reconnect URL must contain BOTH the
      // auth credential and ?since=<lastSeq>.
      setAppendAuth((url: any) => `${url}${url.includes('?') ? '&' : '?'}token=jwt-xyz`);
      const sockets: any[] = [];
      const factory = (url: any) => {
        const sock = {
          url,
          onmessage: null,
          onclose: null,
          onerror: null,
          closed: false,
          close: vi.fn(function (this: any) {
            this.closed = true;
          }),
        };
        sockets.push(sock);
        return sock;
      };
      const scheduled: any[] = [];
      const setTimeoutFn = (fn: any) => {
        scheduled.push(fn);
        return scheduled.length;
      };
      subscribeProvisioningEvents('ws://job', {
        onEvent: vi.fn(),
        onClose: vi.fn(),
        watchdogMs: 60_000,
        reconnectBackoffMs: 0,
        maxReconnects: 1,
        webSocketFactory: factory,
        setTimeoutFn,
        clearTimeoutFn: vi.fn(),
      });
      expect(sockets[0].url).toBe('ws://job?token=jwt-xyz');
      sockets[0].onmessage({
        data: JSON.stringify({ type: 'phase', phase: 'validate', status: 'ok', seq: 4 }),
      });
      sockets[0].onclose();
      // Run the most recently scheduled callback (the reconnect).
      scheduled[scheduled.length - 1]();
      expect(sockets.length).toBe(2);
      // The reconnect URL must carry both the credential AND ?since=.
      expect(sockets[1].url).toContain('token=jwt-xyz');
      expect(sockets[1].url).toContain('since=4');
    });
  });
});
