import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub ./config — api.js imports getApiBaseUrl + getAuthHeaders from it, and
// config.js in turn imports @react-native-async-storage/async-storage which
// doesn't resolve in a plain node test environment.
vi.mock('./config', () => ({
  getApiBaseUrl: () => 'https://example.test/api',
  getAuthHeaders: () => ({ 'X-API-Key': 'test-key' }),
}));

// Stub ./uploadFile — the binary uploader depends on expo-file-system
// which doesn't resolve in a plain node test environment. We only need to
// verify api.uploadFile forwards its argument through.
vi.mock('./uploadFile', () => ({
  uploadFile: vi.fn(async (ref) => ({ __mockedWith: ref })),
}));

// Import after mocks are registered.
const { api } = await import('./api.js');
const uploadFileMock = (await import('./uploadFile')).uploadFile;

// Mock global fetch. Each test can override `mockFetch` to shape the response.
let mockFetch;
beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  });
  globalThis.fetch = mockFetch;
});

/** Extract `[url, init]` from the last call to fetch. */
function lastCall() {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return mockFetch.mock.calls[0];
}

describe('api webhook helpers — URL + method + body parity with web client', () => {
  it('getWebhooks → GET /webhooks', async () => {
    await api.getWebhooks();
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks');
    expect(init?.method).toBeUndefined(); // default GET
  });

  it('getProjectWebhooks(projectId) → GET /webhooks/project/:projectId', async () => {
    await api.getProjectWebhooks('agent-hub');
    const [url] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/project/agent-hub');
  });

  it('createWebhook(data) → POST /webhooks with JSON body', async () => {
    const data = {
      projectId: 'agent-hub',
      repoUrl: 'https://github.com/acme/repo',
      events: { pull_request: true },
      enabled: true,
    };
    await api.createWebhook(data);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(data);
  });

  it('updateWebhook(id, data) → PUT /webhooks/:id with JSON body', async () => {
    const data = { enabled: false, authorAllowlist: ['mcsteen'] };
    await api.updateWebhook(42, data);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/42');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual(data);
  });

  it('deleteWebhook(id) → DELETE /webhooks/:id', async () => {
    await api.deleteWebhook(42);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/42');
    expect(init.method).toBe('DELETE');
  });

  it('getWebhookLogs(id) defaults limit=20', async () => {
    await api.getWebhookLogs(42);
    const [url] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/42/logs?limit=20');
  });

  it('getWebhookLogs(id, 5) passes an explicit limit', async () => {
    await api.getWebhookLogs(42, 5);
    const [url] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/42/logs?limit=5');
  });

  it('registerWebhook(id) → POST /webhooks/:id/register', async () => {
    await api.registerWebhook(42);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/42/register');
    expect(init.method).toBe('POST');
  });

  it('unregisterWebhook(id) → DELETE /webhooks/:id/register', async () => {
    await api.unregisterWebhook(42);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/42/register');
    expect(init.method).toBe('DELETE');
  });

  it('getWebhookRegistration(id) → GET /webhooks/:id/register', async () => {
    await api.getWebhookRegistration(42);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/webhooks/42/register');
    expect(init?.method).toBeUndefined();
  });
});

describe('api threads helpers — URL + method parity with web client', () => {
  it('getThreads(projectId) without filter → GET /projects/:id/threads', async () => {
    await api.getThreads('agent-hub');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/projects/agent-hub/threads');
    expect(init?.method).toBeUndefined();
  });

  it('getThreads(projectId, type) appends the type query', async () => {
    await api.getThreads('agent-hub', 'cron');
    const [url] = lastCall();
    expect(url).toBe('https://example.test/api/projects/agent-hub/threads?type=cron');
  });

  it('getThreads URL-encodes the type parameter', async () => {
    await api.getThreads('agent-hub', 'heart beat');
    const [url] = lastCall();
    expect(url).toBe(
      'https://example.test/api/projects/agent-hub/threads?type=heart%20beat',
    );
  });

  it('getThread(threadId) → GET /threads/:id', async () => {
    await api.getThread('thread-xyz');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/threads/thread-xyz');
    expect(init?.method).toBeUndefined();
  });

  it('getThreadEntries(threadId) → GET /threads/:id/entries', async () => {
    await api.getThreadEntries('thread-xyz');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/threads/thread-xyz/entries');
    expect(init?.method).toBeUndefined();
  });
});

describe('api webhook helpers — request headers + error handling', () => {
  it('attaches the API key and JSON content-type to every call', async () => {
    await api.getWebhooks();
    const [, init] = lastCall();
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-API-Key': 'test-key',
    });
  });

  it('throws when the server returns non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    await expect(api.getWebhooks()).rejects.toThrow(/API error: 500/);
  });
});

describe('api upload helpers', () => {
  it('uploadImage → POST /upload with JSON body', async () => {
    await api.uploadImage('data:image/png;base64,AAA', 'shot.png');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/upload');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      dataUrl: 'data:image/png;base64,AAA',
      filename: 'shot.png',
    });
  });

  it('uploadFile delegates to the binary uploader (fileRef pass-through)', async () => {
    uploadFileMock.mockClear();
    const fileRef = { uri: 'file:///tmp/a.mp4', name: 'a.mp4', type: 'video/mp4' };
    const result = await api.uploadFile(fileRef);
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock).toHaveBeenCalledWith(fileRef);
    expect(result).toEqual({ __mockedWith: fileRef });
    // Crucially, uploadFile must NOT round-trip through fetchJSON — the
    // binary uploader handles its own request against /api/upload/file.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
