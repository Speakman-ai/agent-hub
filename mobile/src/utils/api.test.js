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

describe('api session helpers — URL + method + body parity with web client', () => {
  it('createSession(agentId, name) omits use_worktree (worktree-only mode)', async () => {
    await api.createSession('agent-1', 'My session');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/agents/agent-1/sessions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'My session' });
  });

  it('createSession ignores legacy options.use_worktree (no longer forwarded)', async () => {
    await api.createSession('agent-1', 'My session', { use_worktree: false });
    const [, init] = lastCall();
    const body = JSON.parse(init.body);
    expect(body).toEqual({ name: 'My session' });
    expect(body).not.toHaveProperty('use_worktree');
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

  it('setSessionOrchestration(id, body) → PUT /sessions/:id/orchestration', async () => {
    await api.setSessionOrchestration('sess-o', { phase: 'verifying', meta: { pr: 1 } });
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/sessions/sess-o/orchestration');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ phase: 'verifying', meta: { pr: 1 } });
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

  it('createSession ignores use_worktree even when combined with askMode', async () => {
    await api.createSession('agent-1', 'My session', {
      use_worktree: false,
      askMode: true,
    });
    const [, init] = lastCall();
    const body = JSON.parse(init.body);
    expect(body).toEqual({ name: 'My session', ask_mode: true });
    expect(body).not.toHaveProperty('use_worktree');
  });

});

describe('api updateProject — PATCH parity with web client', () => {
  it('updateProject(projectId, body) → PATCH /projects/:id', async () => {
    await api.updateProject('p1', { mode: 'workflow' });
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/projects/p1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ mode: 'workflow' });
  });
});

describe('api plugin key helpers', () => {
  it('setGeminiApiKey saves through the host Gemini auth endpoint', async () => {
    await api.setGeminiApiKey('AIza-test');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/config/gemini-auth/api-key');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ apiKey: 'AIza-test' });
  });

  it('logoutGemini clears the host Gemini auth endpoint', async () => {
    await api.logoutGemini();
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/config/gemini-auth');
    expect(init.method).toBe('DELETE');
  });
});

describe('api fetchJSON — request headers + error handling', () => {
  it('attaches the API key and JSON content-type to every call', async () => {
    await api.getThreads('agent-hub');
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
    await expect(api.getThreads('agent-hub')).rejects.toThrow(/500: boom/);
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

describe('api soft-delete recovery — parity with web client', () => {
  it('getArchivedSessions(agentId) → GET /agents/:id/archived-sessions', async () => {
    await api.getArchivedSessions('agent-42');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/agents/agent-42/archived-sessions');
    // fetchJSON default is GET (no method set)
    expect(init.method).toBeUndefined();
  });

  it('restoreSession(id) → POST /sessions/:id/restore with no body', async () => {
    await api.restoreSession('sess-1');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/sessions/sess-1/restore');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('restoreSession returns the restored SessionRow', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'sess-1', deleted_at: null, name: 'Restored' }),
    });
    const result = await api.restoreSession('sess-1');
    expect(result).toEqual({ id: 'sess-1', deleted_at: null, name: 'Restored' });
  });

  it('restoreSession surfaces 404 when already purged', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not archived' }),
    });
    await expect(api.restoreSession('sess-ghost')).rejects.toThrow(/404: not archived/);
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

describe('api.assignCard — engine/model opts parity with web client', () => {
  it('POSTs only { agentId } when no opts are given', async () => {
    await api.assignCard('p1', 'card-1', 'agent-a');
    const [url, init] = lastCall();
    expect(url).toBe('https://example.test/api/projects/p1/board/cards/card-1/assign');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ agentId: 'agent-a' });
  });

  it('forwards model only when set and non-blank', async () => {
    await api.assignCard('p1', 'card-1', 'agent-a', {
      model: 'claude-opus-4-8',
    });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      agentId: 'agent-a',
      model: 'claude-opus-4-8',
    });
  });

  it('forwards engine only when set and non-blank', async () => {
    await api.assignCard('p1', 'card-1', 'agent-a', { engine: 'codex-cli' });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      agentId: 'agent-a',
      engine: 'codex-cli',
    });
  });

  it('forwards both engine and model when both are set', async () => {
    await api.assignCard('p1', 'card-1', 'agent-a', {
      engine: 'codex-cli',
      model: 'gpt-5-codex',
    });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      agentId: 'agent-a',
      engine: 'codex-cli',
      model: 'gpt-5-codex',
    });
  });

  it('trims engine/model whitespace before posting', async () => {
    await api.assignCard('p1', 'card-1', 'agent-a', {
      engine: '  codex-cli  ',
      model: '  gpt-5-codex  ',
    });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({
      agentId: 'agent-a',
      engine: 'codex-cli',
      model: 'gpt-5-codex',
    });
  });

  it('drops blank/whitespace-only engine and model', async () => {
    await api.assignCard('p1', 'card-1', 'agent-a', {
      engine: '   ',
      model: '',
    });
    const [, init] = lastCall();
    expect(JSON.parse(init.body)).toEqual({ agentId: 'agent-a' });
  });
});

describe('api.startFinalizeWizard — Finalize setup parity with web client', () => {
  it('POSTs /projects/:projectId/finalize/setup-wizard with empty body', async () => {
    await api.startFinalizeWizard('agent-hub');
    const [url, init] = lastCall();
    expect(url).toBe(
      'https://example.test/api/projects/agent-hub/finalize/setup-wizard',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
  });

  it('returns the parsed response payload (sessionId / agentId / target)', async () => {
    const payload = {
      sessionId: 'sess-1',
      agentId: 'agent-a',
      target: { sessionId: 'sess-target', branch: 'feat/ci', worktreePath: '/wt' },
      session: { id: 'sess-1' },
      draft: { proposedCiYaml: 'version: 1' },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });
    const res = await api.startFinalizeWizard('agent-hub');
    expect(res).toEqual(payload);
  });
});

describe('api.getHealth — drawer footer / mount-effect contract', () => {
  // DrawerContent mounts a useEffect that calls `api.getHealth()` to populate
  // the footer's server version/git hash. Guard the contract that effect relies
  // on: `getHealth` must be a callable method on the `api` named export and must
  // issue a plain GET /health. (A missing method or wrong export would surface
  // as a runtime error only when the drawer mounts, which the node suite can't
  // render — so we pin it here.)
  it('is a function on the api named export', () => {
    expect(typeof api.getHealth).toBe('function');
  });

  it('getHealth() → GET /health and returns the parsed payload', async () => {
    const payload = { version: '2.11.0', gitHash: 'abc1234' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });
    const res = await api.getHealth();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://example.test/api/health');
    expect(init?.method).toBeUndefined(); // GET
    expect(res).toEqual(payload);
  });
});
