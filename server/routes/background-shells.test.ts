/**
 * Integration tests for the session background-shells routes.
 *
 * The runtime itself is faked (its own unit test covers process lifecycle);
 * here we pin route behaviour: ownership 404s, validation, the 503 when the
 * runtime is absent, and correct delegation to the runtime.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { BackgroundShellRow } from '../background-shells/background-shell-runtime.js';

const TEST_CWD = process.cwd();

// Toggle ownership per-test.
let ownsSession = true;
vi.mock('../session-ownership.js', () => ({
  userOwnsSession: () => ownsSession,
  getSessionOwner: () => null,
}));

const { default: createBackgroundShellRoutes } = await import('./background-shells.js');

function row(over: Partial<BackgroundShellRow> = {}): BackgroundShellRow {
  return {
    id: 'shell-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    command: 'npm run build',
    label: null,
    cwd: '/wt/sess-1',
    pid: 4242,
    pid_start_time: null,
    status: 'running',
    exit_code: null,
    log_path: '/data/background-shells/shell-1.log',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...over,
  };
}

interface FakeRuntime {
  list: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  getLogTail: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function buildApp(
  opts: {
    runtime?: FakeRuntime | null;
    session?: unknown;
    project?: { id: string; cwd?: string } | null;
  } = {},
) {
  const session =
    opts.session === undefined
      ? { id: 'sess-1', agent_id: 'agent-1', worktree_path: TEST_CWD }
      : opts.session;
  const deps = {
    stmts: { getSession: { get: () => session } },
    findAgent: () =>
      opts.project === null ? null : { project: opts.project ?? { id: 'proj-1', cwd: TEST_CWD } },
    getBackgroundShellRuntime: () => (opts.runtime === undefined ? runtime : opts.runtime),
  } as unknown as Parameters<typeof createBackgroundShellRoutes>[0];

  const app = express();
  app.use(express.json());
  app.use(createBackgroundShellRoutes(deps));
  return app;
}

let runtime: FakeRuntime;
beforeEach(() => {
  ownsSession = true;
  runtime = {
    list: vi.fn(() => [row()]),
    start: vi.fn((input) => row({ command: input.command, label: input.label, cwd: input.cwd })),
    getById: vi.fn(() => row()),
    getLogTail: vi.fn(() => ['line-1', 'line-2']),
    stop: vi.fn(async () => row({ status: 'stopped' })),
  };
});

describe('GET /api/sessions/:sessionId/background-shells', () => {
  it('lists shells for an owned session', async () => {
    const res = await supertest(buildApp()).get('/api/sessions/sess-1/background-shells');
    expect(res.status).toBe(200);
    expect(res.body.shells).toHaveLength(1);
    expect(runtime.list).toHaveBeenCalledWith('sess-1');
  });

  it('404s when the caller does not own the session', async () => {
    ownsSession = false;
    const res = await supertest(buildApp()).get('/api/sessions/sess-1/background-shells');
    expect(res.status).toBe(404);
  });

  it('503s when the runtime is unavailable', async () => {
    const res = await supertest(buildApp({ runtime: null })).get(
      '/api/sessions/sess-1/background-shells',
    );
    expect(res.status).toBe(503);
  });
});

describe('POST /api/sessions/:sessionId/background-shells', () => {
  it('starts a shell in the session worktree', async () => {
    const res = await supertest(buildApp())
      .post('/api/sessions/sess-1/background-shells')
      .send({ command: 'sleep 100', label: 'sleeper' });
    expect(res.status).toBe(201);
    expect(res.body.shell.command).toBe('sleep 100');
    expect(runtime.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', command: 'sleep 100', cwd: TEST_CWD }),
    );
  });

  it('falls back to project cwd when the session has no worktree', async () => {
    const app = buildApp({
      session: { id: 'sess-1', agent_id: 'agent-1', worktree_path: null },
      project: { id: 'proj-1', cwd: TEST_CWD },
    });
    const res = await supertest(app)
      .post('/api/sessions/sess-1/background-shells')
      .send({ command: 'ls' });
    expect(res.status).toBe(201);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ cwd: TEST_CWD }));
  });

  it('400s on a missing command', async () => {
    const res = await supertest(buildApp())
      .post('/api/sessions/sess-1/background-shells')
      .send({ label: 'x' });
    expect(res.status).toBe(400);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('400s on a whitespace-only command', async () => {
    const res = await supertest(buildApp())
      .post('/api/sessions/sess-1/background-shells')
      .send({ command: '   ' });
    expect(res.status).toBe(400);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('passes the command through verbatim (does not trim meaningful whitespace)', async () => {
    const res = await supertest(buildApp())
      .post('/api/sessions/sess-1/background-shells')
      .send({ command: '  printf "%s" " x " ' });
    expect(res.status).toBe(201);
    expect(runtime.start).toHaveBeenCalledWith(
      expect.objectContaining({ command: '  printf "%s" " x " ' }),
    );
  });

  it('400s when there is no worktree or project directory', async () => {
    const app = buildApp({
      session: { id: 'sess-1', agent_id: 'agent-1', worktree_path: null },
      project: { id: 'proj-1' },
    });
    const res = await supertest(app)
      .post('/api/sessions/sess-1/background-shells')
      .send({ command: 'ls' });
    expect(res.status).toBe(400);
  });

  it('400s when the resolved directory has vanished', async () => {
    const app = buildApp({
      session: {
        id: 'sess-1',
        agent_id: 'agent-1',
        worktree_path: '/definitely/not-an-agent-hub-directory',
      },
    });
    const res = await supertest(app)
      .post('/api/sessions/sess-1/background-shells')
      .send({ command: 'ls' });
    expect(res.status).toBe(400);
    expect(runtime.start).not.toHaveBeenCalled();
  });
});

describe('GET .../:shellId and /logs', () => {
  it('returns one shell', async () => {
    const res = await supertest(buildApp()).get('/api/sessions/sess-1/background-shells/shell-1');
    expect(res.status).toBe(200);
    expect(res.body.shell.id).toBe('shell-1');
  });

  it('404s for a shell that belongs to a different session', async () => {
    runtime.getById = vi.fn(() => row({ session_id: 'other' }));
    const res = await supertest(buildApp()).get('/api/sessions/sess-1/background-shells/shell-1');
    expect(res.status).toBe(404);
  });

  it('returns the log tail with a limit', async () => {
    const res = await supertest(buildApp()).get(
      '/api/sessions/sess-1/background-shells/shell-1/logs?limit=50',
    );
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual(['line-1', 'line-2']);
    expect(runtime.getLogTail).toHaveBeenCalledWith('shell-1', 50);
  });
});

describe('POST .../:shellId/stop', () => {
  it('stops a shell and returns the terminal row', async () => {
    const res = await supertest(buildApp()).post(
      '/api/sessions/sess-1/background-shells/shell-1/stop',
    );
    expect(res.status).toBe(200);
    expect(res.body.shell.status).toBe('stopped');
    expect(runtime.stop).toHaveBeenCalledWith('shell-1');
  });

  it('404s when the shell is unknown', async () => {
    runtime.getById = vi.fn(() => null);
    const res = await supertest(buildApp()).post(
      '/api/sessions/sess-1/background-shells/shell-1/stop',
    );
    expect(res.status).toBe(404);
    expect(runtime.stop).not.toHaveBeenCalled();
  });
});
