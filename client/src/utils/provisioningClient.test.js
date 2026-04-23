import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provisionProject, subscribeProvisioningEvents } from './provisioningClient.js';

// Mock the shared connection module so the helper hits a known base URL
// without pulling in the whole auth wiring.
vi.mock('./connection.js', () => ({
  getApiBase: () => 'http://localhost:3051/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test' }),
}));

describe('provisionProject', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the payload and returns the job descriptor on 200', async () => {
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobId: 'job-1', wsUrl: 'ws://x' }),
    });
    const result = await provisionProject({
      description: 'hi',
      appType: 'web-app',
      stack: 'react-vite-express-sqlite',
    });
    expect(result).toEqual({ jobId: 'job-1', wsUrl: 'ws://x' });
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
    const call = globalThis.fetch.mock.calls[0][1];
    expect(JSON.parse(call.body)).toMatchObject({ description: 'hi', appType: 'web-app' });
  });

  it('throws an informative error when the server returns a JSON error body', async () => {
    globalThis.fetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ error: 'owner missing' }),
    });
    await expect(provisionProject({})).rejects.toThrow(/422.*owner missing/);
  });

  it('throws a generic error when the server returns non-JSON', async () => {
    globalThis.fetch.mockResolvedValueOnce({
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
  let sockets;
  class FakeSocket {
    constructor(url) {
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
    globalThis.WebSocket = FakeSocket;
  });
  afterEach(() => {
    delete globalThis.WebSocket;
  });

  it('parses JSON frames and forwards them to onEvent', () => {
    const onEvent = vi.fn();
    subscribeProvisioningEvents('ws://x', { onEvent });
    const sock = sockets[0];
    sock.onmessage({ data: JSON.stringify({ type: 'phase', phase: 'validate', status: 'ok' }) });
    expect(onEvent).toHaveBeenCalledWith({ type: 'phase', phase: 'validate', status: 'ok' });
  });

  it('forwards parse errors to onError and keeps the socket open', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribeProvisioningEvents('ws://x', { onEvent, onError });
    const sock = sockets[0];
    sock.onmessage({ data: '{not json' });
    expect(onError).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('returns a close handle that tears down the socket and silences further events', () => {
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const handle = subscribeProvisioningEvents('ws://x', { onEvent, onClose });
    const sock = sockets[0];
    handle.close();
    expect(sock.closed).toBe(true);
    // Subsequent messages after caller-initiated close are ignored.
    sock.onmessage({ data: JSON.stringify({ type: 'log', line: 'late' }) });
    expect(onEvent).not.toHaveBeenCalled();
    // onClose fired by the server after we closed should also be swallowed.
    sock.onclose?.();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onClose when the server closes the socket', () => {
    const onClose = vi.fn();
    subscribeProvisioningEvents('ws://x', { onEvent: vi.fn(), onClose });
    sockets[0].onclose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handles WebSocket constructor failure by calling onError', () => {
    globalThis.WebSocket = function () {
      throw new Error('ws unavailable');
    };
    const onError = vi.fn();
    const handle = subscribeProvisioningEvents('ws://x', { onEvent: vi.fn(), onError });
    expect(onError).toHaveBeenCalled();
    // close() is still safe after construction failure
    expect(() => handle.close()).not.toThrow();
  });
});
