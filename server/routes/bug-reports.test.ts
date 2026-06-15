import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import os from 'os';

// Stub the investigation trigger so creating a bug ticket here never spawns a
// CLI (the real fire-and-forget path would shell out to an engine). We still
// assert it is wired correctly below. Mocked at the module the shared intake
// helper imports from, so both the support-ticket route and this endpoint see
// the stub.
const triggerInvestigation = vi.fn();
vi.mock('../support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: (...args: unknown[]) => triggerInvestigation(...args),
}));

import createBugReportRoutes, {
  _resetRateLimit,
  buildBugReportTicketBody,
  sanitizeReplayRef,
} from './bug-reports.js';
import { getStmts } from '../db.js';
import { getSupportTicket, listSupportTickets } from '../support-tickets-store.js';
import type { RouteDeps } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────

const INTAKE_PROJECT = { id: 'agent-hub', name: 'Agent Hub', cwd: '/tmp', color: '#000' };

function makeApp(opts: { projectExists?: boolean } = {}): {
  app: Express;
  broadcast: ReturnType<typeof vi.fn>;
} {
  const broadcast = vi.fn();
  const deps = {
    stmts: getStmts(),
    broadcast,
    findProject: vi.fn((id: string) =>
      opts.projectExists === false ? null : id === INTAKE_PROJECT.id ? INTAKE_PROJECT : null,
    ),
    config: {},
    serverDir: os.tmpdir(),
  } as unknown as RouteDeps;

  const app = express();
  app.use(createBugReportRoutes(deps));
  return { app, broadcast };
}

// ─── Unit: buildBugReportTicketBody ───────────────────────────────

describe('buildBugReportTicketBody', () => {
  it('uses the description as the lead paragraph', () => {
    const out = buildBugReportTicketBody({ title: 'Crash', description: 'boom', severity: 'high' });
    expect(out.startsWith('boom')).toBe(true);
  });

  it('falls back to a placeholder when no description is given', () => {
    const out = buildBugReportTicketBody({ title: 'x', description: '', severity: 'low' });
    expect(out).toContain('_(no description provided)_');
  });

  it('includes a Reporter Context section with source metadata', () => {
    const out = buildBugReportTicketBody({
      title: 'x',
      description: 'y',
      severity: 'medium',
      sourceUrl: 'https://hub.example/app',
      userAgent: 'Mozilla/5.0',
      clientType: 'web',
      currentAgentId: 'agent-hub-dev',
    });
    expect(out).toContain('### Reporter Context');
    expect(out).toContain('https://hub.example/app');
    expect(out).toContain('Mozilla/5.0');
    expect(out).toContain('web');
    expect(out).toContain('agent-hub-dev');
  });

  it('includes a Session Replay line when a replayRef is given', () => {
    const out = buildBugReportTicketBody({
      title: 'x',
      description: 'y',
      severity: 'medium',
      replayRef: '/uploads/replay-abc123.json',
    });
    expect(out).toContain('Session Replay');
    expect(out).toContain('/uploads/replay-abc123.json');
  });

  it('omits the Session Replay line when no replayRef is given', () => {
    const out = buildBugReportTicketBody({ title: 'x', description: 'y', severity: 'medium' });
    expect(out).not.toContain('Session Replay');
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

// ─── Integration: POST /api/bug-reports ───────────────────────────

describe('POST /api/bug-reports', () => {
  let app: Express;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetRateLimit();
    triggerInvestigation.mockClear();
    ({ app, broadcast } = makeApp());
  });

  it('creates a bug support ticket in the agent-hub queue and returns 201', async () => {
    const res = await supertest(app)
      .post('/api/bug-reports')
      .field('title', 'Button does nothing')
      .field('description', 'Clicking Save does nothing')
      .field('severity', 'high')
      .field('clientType', 'web')
      .expect(201);

    expect(typeof res.body.ticketId).toBe('string');
    expect(res.body.status).toBe('received');
    // No more session-spawn contract — the old response shape is gone.
    expect(res.body).not.toHaveProperty('sessionId');

    // CORS header still present (cross-origin intake surface).
    expect(res.headers['access-control-allow-origin']).toBe('*');

    const ticket = getSupportTicket(res.body.ticketId);
    expect(ticket).not.toBeNull();
    expect(ticket!.project_id).toBe('agent-hub');
    expect(ticket!.type).toBe('bug');
    expect(ticket!.severity).toBe('high');
    expect(ticket!.status).toBe('new');
    expect(ticket!.subject).toBe('Button does nothing');
    expect(ticket!.body).toContain('Clicking Save does nothing');
    expect(ticket!.body).toContain('### Reporter Context');
    expect(ticket!.reporter).toBe('bug-report (web)');

    // Created event broadcast + AI investigation fired for the bug ticket.
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'support_ticket_created' }),
    );
    expect(triggerInvestigation).toHaveBeenCalledTimes(1);
    expect(triggerInvestigation.mock.calls[0]![0]).toBe(res.body.ticketId);
  });

  it('persists a valid, attributable replayRef on the ticket', async () => {
    // Seed an unattributed replay row so the intake guard can claim it for the
    // agent-hub project and keep the ref.
    const replayId = `bugreplay-${Date.now()}`;
    getStmts().insertSessionReplay.run(
      replayId,
      null, // project_id (unattributed)
      0,
      0,
      0,
      0,
      'local',
      `replays/${replayId}.bin`,
      null,
      null,
      null,
      null,
      null,
    );
    const ref = `/uploads/replay-${replayId}.json`;

    const res = await supertest(app)
      .post('/api/bug-reports')
      .field('title', 'Replay attached')
      .field('severity', 'medium')
      .field('replayRef', ref)
      .expect(201);

    const ticket = getSupportTicket(res.body.ticketId);
    expect(ticket!.replay_ref).toBe(ref);
    // The accepted ref is also surfaced in the operator-visible body.
    expect(ticket!.body).toContain(ref);

    // The body is finalized BEFORE the support_ticket_created broadcast and the
    // investigation fire, so consumers never see a stale (replay-free) body.
    const created = broadcast.mock.calls
      .map((c) => c[0] as { type: string; ticket?: { replay_ref: string | null; body: string } })
      .find((e) => e.type === 'support_ticket_created');
    expect(created?.ticket?.replay_ref).toBe(ref);
    expect(created?.ticket?.body).toContain(ref);

    // The investigation is triggered after finalization, so the ticket it reads
    // back by id already carries the accepted ref.
    expect(triggerInvestigation).toHaveBeenCalledTimes(1);
    const investigatedId = triggerInvestigation.mock.calls[0]![0] as string;
    expect(getSupportTicket(investigatedId)!.body).toContain(ref);
  });

  it('drops a well-formed but unattributable replayRef (no matching capture)', async () => {
    const ghostRef = '/uploads/replay-does-not-exist.json';
    const res = await supertest(app)
      .post('/api/bug-reports')
      .field('title', 'Ghost replay')
      .field('severity', 'medium')
      .field('replayRef', ghostRef)
      .expect(201);

    const ticket = getSupportTicket(res.body.ticketId);
    expect(ticket!.replay_ref).toBeNull();
    // Regression: a rejected ref must NOT linger in the body (it would
    // otherwise reach operators and the AI investigation prompt). The body is
    // rebuilt from the persisted (cleared) replay_ref, not the raw input.
    expect(ticket!.body).not.toContain(ghostRef);
    expect(ticket!.body).not.toContain('Session Replay');
  });

  it('drops a malicious (non-replay) replayRef before it reaches the ticket', async () => {
    const res = await supertest(app)
      .post('/api/bug-reports')
      .field('title', 'Bad ref')
      .field('severity', 'medium')
      .field('replayRef', 'https://evil.example/x.json')
      .expect(201);

    const ticket = getSupportTicket(res.body.ticketId);
    expect(ticket!.replay_ref).toBeNull();
    expect(ticket!.body).not.toContain('evil.example');
  });

  it('tolerates (and ignores) a legacy screenshot part', async () => {
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const before = listSupportTickets('agent-hub').length;
    await supertest(app)
      .post('/api/bug-reports')
      .field('title', 'Has screenshot')
      .field('severity', 'low')
      .attach('screenshot', PNG_MAGIC, { filename: 'shot.png', contentType: 'image/png' })
      .expect(201);
    // Ticket still lands; the screenshot is simply not referenced anywhere.
    expect(listSupportTickets('agent-hub').length).toBe(before + 1);
  });

  it('returns 400 when title is missing', async () => {
    const res = await supertest(app)
      .post('/api/bug-reports')
      .field('description', 'No title here')
      .field('severity', 'low')
      .expect(400);
    expect(res.body.error).toMatch(/title/i);
    expect(triggerInvestigation).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid severity', async () => {
    const res = await supertest(app)
      .post('/api/bug-reports')
      .field('title', 'Something')
      .field('severity', 'catastrophic')
      .expect(400);
    expect(res.body.error).toMatch(/severity/i);
  });

  it('rate-limits to 10 reports per IP per hour', async () => {
    for (let i = 0; i < 10; i++) {
      await supertest(app).post('/api/bug-reports').field('title', `Report ${i}`).expect(201);
    }
    const res = await supertest(app)
      .post('/api/bug-reports')
      .field('title', 'Report 11')
      .expect(429);
    expect(res.body.error).toMatch(/rate limit/i);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('handles OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await supertest(app).options('/api/bug-reports').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('returns 500 when the intake project is not configured', async () => {
    _resetRateLimit();
    const { app: noProjectApp } = makeApp({ projectExists: false });
    const res = await supertest(noProjectApp)
      .post('/api/bug-reports')
      .field('title', 'Something')
      .expect(500);
    expect(res.body.error).toMatch(/intake project/i);
  });
});
