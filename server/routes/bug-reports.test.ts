import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import createBugReportRoutes, {
  _resetRateLimit,
  buildBugReportPrompt,
  sanitizeReplayRef,
} from './bug-reports.js';
import type { RouteDeps, ChatMessage } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────

interface TestCtx {
  app: Express;
  handleChat: Mock<(ws: unknown, msg: ChatMessage) => Promise<void>>;
  createSession: Mock;
  insertBackgroundTask: Mock;
  uploadsDir: string;
}

function makeRouteDeps(overrides: Partial<RouteDeps> = {}): {
  deps: RouteDeps;
  handleChat: Mock<(ws: unknown, msg: ChatMessage) => Promise<void>>;
  createSession: Mock;
  insertBackgroundTask: Mock;
  uploadsDir: string;
} {
  const uploadsDir = path.join(
    os.tmpdir(),
    `agent-hub-bug-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path.join(uploadsDir, 'uploads'), { recursive: true });

  const createSession = vi.fn();
  const insertBackgroundTask = vi.fn();
  const handleChat = vi.fn(async () => {}) as Mock<
    (ws: unknown, msg: ChatMessage) => Promise<void>
  >;

  const deps = {
    stmts: {
      createSession: { run: createSession },
      insertBackgroundTask: { run: insertBackgroundTask },
    },
    findAgent: vi.fn((id: string) =>
      id === 'agent-hub-intake'
        ? {
            project: { id: 'agent-hub', name: 'Agent Hub', agents: [] },
            agent: {
              id: 'agent-hub-intake',
              name: 'Ticket Intake',
              engine: 'claude-code',
              role: 'intake',
            },
          }
        : null,
    ),
    handleChat,
    serverDir: uploadsDir,
    DEFAULT_MODEL: 'claude-sonnet-4-5',
    ...overrides,
  } as unknown as RouteDeps;

  return { deps, handleChat, createSession, insertBackgroundTask, uploadsDir };
}

function makeApp(deps: RouteDeps): Express {
  const app = express();
  app.use(createBugReportRoutes(deps));
  return app;
}

function setupCtx(overrides?: Partial<RouteDeps>): TestCtx {
  _resetRateLimit();
  const { deps, handleChat, createSession, insertBackgroundTask, uploadsDir } =
    makeRouteDeps(overrides);
  const app = makeApp(deps);
  return { app, handleChat, createSession, insertBackgroundTask, uploadsDir };
}

// A fake PNG file (minimal valid header bytes — we don't decode).
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

// ─── Tests ────────────────────────────────────────────────────────

describe('buildBugReportPrompt', () => {
  it('starts with "## Bug Report" header', () => {
    const out = buildBugReportPrompt({
      title: 'Crash',
      description: 'boom',
      severity: 'high',
    });
    expect(out.startsWith('## Bug Report')).toBe(true);
  });

  it('includes screenshot markdown when URL given', () => {
    const out = buildBugReportPrompt({
      title: 'x',
      description: 'y',
      severity: 'low',
      screenshotUrl: '/uploads/foo.png',
    });
    expect(out).toContain('![bug report screenshot](/uploads/foo.png)');
  });

  it('includes final instruction line about user-request epic', () => {
    const out = buildBugReportPrompt({
      title: 'x',
      description: 'y',
      severity: 'medium',
    });
    expect(out).toContain('user-request');
    expect(out).toContain('End the session after the card is created');
  });

  it('includes a Session Replay section when a replayRef is given', () => {
    const out = buildBugReportPrompt({
      title: 'x',
      description: 'y',
      severity: 'medium',
      replayRef: '/uploads/replay-abc123.json',
    });
    expect(out).toContain('### Session Replay');
    expect(out).toContain('/uploads/replay-abc123.json');
    expect(out).toMatch(/replayRef/);
  });

  it('omits the Session Replay section when no replayRef is given', () => {
    const out = buildBugReportPrompt({ title: 'x', description: 'y', severity: 'medium' });
    expect(out).not.toContain('### Session Replay');
  });

  it('instructs the intake agent NOT to pass session_id on the created card', () => {
    // Regression guard for the "Session active / Open Session" stuck state:
    // if the ephemeral intake session stamps its id on the bug-report card,
    // the UI permanently shows the card as assigned with no way to clear it
    // (see board PUT endpoint — session_id is nullable but must be explicitly
    // cleared, which requires an accessible Assignee dropdown the UI hides
    // when session_id is set).
    const out = buildBugReportPrompt({
      title: 'x',
      description: 'y',
      severity: 'medium',
    });
    expect(out).toMatch(/do not pass .*session_?id/i);
    // And the snake_case form the JSON API accepts
    expect(out).toContain('session_id');
  });
});

describe('sanitizeReplayRef', () => {
  it('accepts a valid replay upload ref', () => {
    expect(sanitizeReplayRef('/uploads/replay-abc-123.json')).toBe('/uploads/replay-abc-123.json');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeReplayRef('  /uploads/replay-x.json ')).toBe('/uploads/replay-x.json');
  });

  it('rejects refs that are not replay uploads', () => {
    expect(sanitizeReplayRef('/uploads/foo.png')).toBeNull();
    expect(sanitizeReplayRef('/uploads/other.json')).toBeNull();
    expect(sanitizeReplayRef('https://evil.example/replay-x.json')).toBeNull();
    expect(sanitizeReplayRef('/uploads/replay-x.txt')).toBeNull();
  });

  it('rejects traversal attempts', () => {
    expect(sanitizeReplayRef('/uploads/replay-../../etc/passwd.json')).toBeNull();
  });

  it('returns null for empty / nullish input', () => {
    expect(sanitizeReplayRef(undefined)).toBeNull();
    expect(sanitizeReplayRef(null)).toBeNull();
    expect(sanitizeReplayRef('')).toBeNull();
  });
});

describe('POST /api/bug-reports', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = setupCtx();
  });

  afterEach(() => {
    try {
      if (ctx && existsSync(ctx.uploadsDir)) {
        rmSync(ctx.uploadsDir, { recursive: true, force: true });
      }
    } catch {
      /* noop */
    }
  });

  it('returns 202 with sessionId on a valid submission', async () => {
    const res = await supertest(ctx.app)
      .post('/api/bug-reports')
      .field('title', 'Button does nothing')
      .field('description', 'Clicking Save does nothing')
      .field('severity', 'high')
      .field('clientType', 'web')
      .attach('screenshot', PNG_MAGIC, {
        filename: 'shot.png',
        contentType: 'image/png',
      })
      .expect(202);

    expect(res.body).toHaveProperty('sessionId');
    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.status).toBe('dispatched');

    expect(ctx.createSession).toHaveBeenCalledTimes(1);
    const sessionArgs = ctx.createSession.mock.calls[0]!;
    expect(sessionArgs[1]).toBe('agent-hub-intake');

    // CORS header on response
    expect(res.headers['access-control-allow-origin']).toBe('*');

    // handleChat is scheduled via setImmediate — wait for it.
    await new Promise((r) => setImmediate(r));
    expect(ctx.handleChat).toHaveBeenCalledTimes(1);
    const [, chatMsg] = ctx.handleChat.mock.calls[0]!;
    expect(chatMsg.agentId).toBe('agent-hub-intake');
    expect(chatMsg.content.startsWith('## Bug Report')).toBe(true);
    expect(chatMsg.content).toContain('Button does nothing');

    // Screenshot was saved into uploads dir
    const uploads = readdirSync(path.join(ctx.uploadsDir, 'uploads'));
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatch(/\.png$/);

    // Prompt that is actually sent must tell the intake agent not to stamp
    // its ephemeral session id on the resulting card.
    expect(chatMsg.content).toMatch(/do not pass .*session_?id/i);
  });

  it('threads a valid replayRef into the intake prompt', async () => {
    await supertest(ctx.app)
      .post('/api/bug-reports')
      .field('title', 'Replay attached')
      .field('severity', 'medium')
      .field('replayRef', '/uploads/replay-deadbeef.json')
      .expect(202);

    await new Promise((r) => setImmediate(r));
    const [, chatMsg] = ctx.handleChat.mock.calls[0]!;
    expect(chatMsg.content).toContain('### Session Replay');
    expect(chatMsg.content).toContain('/uploads/replay-deadbeef.json');
  });

  it('drops a non-replay (malicious) replayRef rather than echoing it', async () => {
    await supertest(ctx.app)
      .post('/api/bug-reports')
      .field('title', 'Bad ref')
      .field('severity', 'medium')
      .field('replayRef', 'https://evil.example/x.json')
      .expect(202);

    await new Promise((r) => setImmediate(r));
    const [, chatMsg] = ctx.handleChat.mock.calls[0]!;
    expect(chatMsg.content).not.toContain('### Session Replay');
    expect(chatMsg.content).not.toContain('evil.example');
  });

  it('returns 400 when title is missing', async () => {
    const res = await supertest(ctx.app)
      .post('/api/bug-reports')
      .field('description', 'No title here')
      .field('severity', 'low')
      .expect(400);

    expect(res.body.error).toMatch(/title/i);
    expect(ctx.handleChat).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid severity', async () => {
    const res = await supertest(ctx.app)
      .post('/api/bug-reports')
      .field('title', 'Something')
      .field('severity', 'catastrophic')
      .expect(400);

    expect(res.body.error).toMatch(/severity/i);
    expect(ctx.handleChat).not.toHaveBeenCalled();
  });

  it('rate-limits to 10 reports per IP per hour', async () => {
    for (let i = 0; i < 10; i++) {
      await supertest(ctx.app).post('/api/bug-reports').field('title', `Report ${i}`).expect(202);
    }

    const res = await supertest(ctx.app)
      .post('/api/bug-reports')
      .field('title', 'Report 11')
      .expect(429);

    expect(res.body.error).toMatch(/rate limit/i);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('handles OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await supertest(ctx.app).options('/api/bug-reports').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('rejects non-image screenshot content types', async () => {
    const res = await supertest(ctx.app)
      .post('/api/bug-reports')
      .field('title', 'Bad file')
      .attach('screenshot', Buffer.from('not an image'), {
        filename: 'x.txt',
        contentType: 'text/plain',
      })
      .expect(400);
    expect(res.body.error).toMatch(/image/i);
  });

  it('returns 500 when intake agent is not configured', async () => {
    const missingDeps = setupCtx({
      findAgent: vi.fn(() => null) as unknown as RouteDeps['findAgent'],
    });
    const res = await supertest(missingDeps.app)
      .post('/api/bug-reports')
      .field('title', 'Something')
      .expect(500);
    expect(res.body.error).toMatch(/intake agent/i);
  });
});
