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

// Stub ./auth — it pulls in @react-native-async-storage/async-storage which
// can't resolve in a plain node test environment. The tests below don't
// exercise the 401 JWT-clear path, so no-op helpers are sufficient.
vi.mock('./auth', () => ({
  getToken: () => null,
  clearToken: vi.fn(async () => {}),
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

describe('api worktree helpers — URL + method + body parity with web client', () => {
  it('setSessionWorktree(id, true) → PUT /sessions/:id/worktree with {enabled}', async () => {
    await api.setSessionWorktree('sess-1', true);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/sessions/sess-1/worktree');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
  });

  it('setSessionWorktree(id, false) passes enabled:false', async () => {
    await api.setSessionWorktree('sess-2', false);
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  it('createSession(agentId, name) omits use_worktree by default', async () => {
    await api.createSession('agent-1', 'My session');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/agents/agent-1/sessions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'My session' });
  });

  it('createSession with options.use_worktree forwards the flag', async () => {
    await api.createSession('agent-1', 'My session', { use_worktree: false });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({ name: 'My session', use_worktree: false });
  });

  it('setSessionAskMode(id, true) → PUT /sessions/:id/ask-mode with {enabled}', async () => {
    await api.setSessionAskMode('sess-4', true);
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/sessions/sess-4/ask-mode');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
  });

  it('setSessionAskMode(id, false) passes enabled:false', async () => {
    await api.setSessionAskMode('sess-5', false);
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  it('createSession omits ask_mode when not provided', async () => {
    await api.createSession('agent-1', 'My session');
    const [, init] = lastCall();
    const body = JSON.parse(init.body);
    expect(body).toEqual({ name: 'My session' });
    expect(body).not.toHaveProperty('ask_mode');
  });

  it('createSession({ askMode: true }) forwards ask_mode:true', async () => {
    await api.createSession('agent-1', 'My session', { askMode: true });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      name: 'My session',
      ask_mode: true,
    });
  });

  it('createSession({ askMode: false }) forwards ask_mode:false (explicit opt-out)', async () => {
    await api.createSession('agent-1', 'My session', { askMode: false });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      name: 'My session',
      ask_mode: false,
    });
  });

  it('createSession coerces truthy askMode values to boolean true', async () => {
    await api.createSession('agent-1', 'My session', { askMode: 1 });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      name: 'My session',
      ask_mode: true,
    });
  });

  it('createSession can combine askMode with use_worktree', async () => {
    await api.createSession('agent-1', 'My session', {
      use_worktree: false,
      askMode: true,
    });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      name: 'My session',
      use_worktree: false,
      ask_mode: true,
    });
  });

  it('createPrFromSession(id) defaults autoMerge=false and omits title', async () => {
    await api.createPrFromSession('sess-3');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/sessions/sess-3/create-pr');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.autoMerge).toBe(false);
    expect(body.title).toBeUndefined();
  });

  it('createPrFromSession(id, { autoMerge, title }) forwards both fields', async () => {
    await api.createPrFromSession('sess-3', { autoMerge: true, title: 'Fix bug' });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({ autoMerge: true, title: 'Fix bug' });
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
    await expect(api.getWebhooks()).rejects.toThrow(/500: boom/);
  });
});

describe('api session summarization — URL + method parity with web client', () => {
  it('summarizeSession(id) → POST /sessions/:id/summarize with no body', async () => {
    await api.summarizeSession('sess-99');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/sessions/sess-99/summarize');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('summarizeSession attaches the API key header', async () => {
    await api.summarizeSession('sess-99');
    const [, init] = lastCall();
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-API-Key': 'test-key',
    });
  });

  it('summarizeSession returns the parsed JSON body from the server', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'Key decisions: …' }),
    });
    const result = await api.summarizeSession('sess-99');
    expect(result).toEqual({ summary: 'Key decisions: …' });
  });

  it('summarizeSession surfaces server errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    await expect(api.summarizeSession('sess-99')).rejects.toThrow(/500: boom/);
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

describe('fetchJSON error body parsing — cycle/duplicate 409s surface in message', () => {
  it('includes body.error in thrown message for non-ok responses', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'cycle' }),
    });
    globalThis.fetch = mockFetch;

    await expect(api.getAgents()).rejects.toThrow('409: cycle');
  });

  it('includes body.error "duplicate" in thrown message', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'duplicate' }),
    });
    globalThis.fetch = mockFetch;

    await expect(api.getAgents()).rejects.toThrow('409: duplicate');
  });

  it('falls back to generic message when body is not JSON', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json'); },
    });
    globalThis.fetch = mockFetch;

    await expect(api.getAgents()).rejects.toThrow('API error: 500');
  });
});
