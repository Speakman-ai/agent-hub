import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type supertest from 'supertest';
import express from 'express';
import { readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRequest, createAgent, createProject } from '../test/helpers.js';
import type { AuthenticatedRequest } from '../auth.js';
import { getStmts } from '../db.js';
import type { RouteDeps } from '../types.js';
import { createDeployment } from '../deploy/deployment-store.js';
import {
  enqueueReleaseNotificationOutbox,
  markReleaseNotificationOutboxError,
} from '../release-notification-outbox.js';
import createSupportTicketRoutes, { serializeSupportTicket } from './support-tickets.js';
import createBoardRoutes from './board.js';

const routeMocks = vi.hoisted(() => ({
  resolveOwnerUserId: vi.fn(() => null as string | null),
  resolveOneShotEngine: vi.fn(
    async (
      _config: unknown,
      input: { userId: string | null; preferred?: string; preferredModel?: string | null },
    ) => {
      if (!input.userId) throw new Error('No acting user for selected engine');
      return { engine: input.preferred, model: input.preferredModel || 'resolved-default' };
    },
  ),
}));

vi.mock('../session-ownership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-ownership.js')>();
  return { ...actual, resolveOwnerUserId: routeMocks.resolveOwnerUserId };
});

vi.mock('../engine-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine-resolver.js')>();
  return { ...actual, resolveOneShotEngine: routeMocks.resolveOneShotEngine };
});

// Screenshot files land in the server's real /uploads dir (serverDir = server/).
const UPLOADS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
function screenshotFiles(): string[] {
  try {
    return readdirSync(UPLOADS_DIR).filter((f) => f.startsWith('support-screenshot-'));
  } catch {
    return [];
  }
}

// Successful create/patch paths persist screenshots into the real uploads dir.
// Snapshot what's there before the suite and remove anything new afterward so
// the worktree isn't littered and later tests aren't polluted.
let baselineScreenshots: Set<string>;

// Stub the investigation trigger so creating a bug ticket in these tests never
// spawns a CLI (the real fire-and-forget path would shell out to an engine).
// We still assert it is wired correctly below.
const triggerInvestigation = vi.fn();
vi.mock('../support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: (...args: unknown[]) => triggerInvestigation(...args),
}));

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
  baselineScreenshots = new Set(screenshotFiles());
}, 60_000);

afterAll(() => {
  for (const f of screenshotFiles()) {
    if (!baselineScreenshots.has(f)) {
      rmSync(path.join(UPLOADS_DIR, f), { force: true });
    }
  }
});

async function newProjectId(): Promise<string> {
  const project = await createProject();
  return project.id as string;
}

describe('support-tickets routes', () => {
  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/support-tickets').expect(404);
    await request
      .post('/api/projects/does-not-exist/support-tickets')
      .send({ body: 'x' })
      .expect(404);
  });

  it('creates, lists (severity-ordered), filters, patches, and deletes', async () => {
    const projectId = await newProjectId();

    // Empty queue to start.
    const empty = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(empty.body).toEqual([]);

    // Create in scrambled severity order.
    for (const severity of ['low', 'critical', 'medium', 'high']) {
      await request
        .post(`/api/projects/${projectId}/support-tickets`)
        .send({ body: `a ${severity} ticket`, severity, type: 'bug' })
        .expect(201);
    }

    const list = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(list.body.map((t: { severity: string }) => t.severity)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);

    const critical = list.body.find((t: { severity: string }) => t.severity === 'critical');
    expect(critical.status).toBe('new');

    // Patch: move to investigating + attach AI investigation.
    const patched = await request
      .patch(`/api/projects/${projectId}/support-tickets/${critical.id}`)
      .send({ status: 'investigating', aiSummary: 'looking into it' })
      .expect(200);
    expect(patched.body.status).toBe('investigating');
    expect(patched.body.ai_summary).toBe('looking into it');
    expect(patched.body.ai_investigated_at).not.toBeNull();

    // Status filter.
    const investigating = await request
      .get(`/api/projects/${projectId}/support-tickets?status=investigating`)
      .expect(200);
    expect(investigating.body).toHaveLength(1);
    expect(investigating.body[0].id).toBe(critical.id);

    // Single fetch.
    await request.get(`/api/projects/${projectId}/support-tickets/${critical.id}`).expect(200);

    // Delete.
    await request.delete(`/api/projects/${projectId}/support-tickets/${critical.id}`).expect(200);
    await request.get(`/api/projects/${projectId}/support-tickets/${critical.id}`).expect(404);
  });

  it('stores reporter_email and returns it in full for privileged local callers', async () => {
    const projectId = await newProjectId();

    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({
        body: 'notify me when this ships',
        reporter: 'Alice',
        reporter_email: 'Alice@Example.COM',
      })
      .expect(201);

    expect(created.body.reporter).toBe('Alice');
    expect(created.body.reporter_email).toBe('alice@example.com');
    expect(created.body.reporter_email_masked).toBe(false);

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${created.body.id}`)
      .expect(200);
    expect(detail.body.reporter_email).toBe('alice@example.com');
    expect(detail.body.release_notifications).toEqual([]);
  });

  it('includes safe release notification history on support ticket detail', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'customer bug', reporter_email: 'alice@example.com' })
      .expect(201);
    const deployment = createDeployment({ projectId, environment: 'production', ref: 'abc' });
    const notification = enqueueReleaseNotificationOutbox({
      projectId,
      deploymentId: deployment.id,
      supportTicketId: created.body.id,
      notificationType: 'ticket_release',
      idempotencyKey: `support-ticket-history-key:${created.body.id}`,
      recipientEmail: 'alice@example.com',
      subject: 'Ticket shipped',
      bodyText: 'Your ticket shipped.',
    });
    markReleaseNotificationOutboxError(notification.id, 'smtp secret detail');

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${created.body.id}`)
      .expect(200);

    const list = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(list.body.find((row: { id: string }) => row.id === created.body.id)).not.toHaveProperty(
      'release_notifications',
    );
    expect(detail.body.release_notifications).toEqual([
      expect.objectContaining({
        id: notification.id,
        deployment_id: deployment.id,
        notification_type: 'ticket_release',
        recipient_type: 'reporter',
        status: 'error',
        error_summary: 'Email delivery failed.',
        can_retry: true,
      }),
    ]);
    expect(JSON.stringify(detail.body.release_notifications)).not.toContain('smtp secret detail');
  });

  it('rejects invalid reporter_email values', async () => {
    const projectId = await newProjectId();

    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'x', reporter_email: 'not-an-email' })
      .expect(400);
  });

  it('masks reporter_email for non-privileged support-ticket route callers', async () => {
    const project = { id: `proj-mask-${Date.now()}`, name: 'Mask Project', cwd: '/tmp' };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use((req, _res, next) => {
      const authed = req as AuthenticatedRequest;
      authed.authUserId = 'user-1';
      authed.authUser = 'user@example.com';
      authed.authRole = 'User';
      next();
    });
    const deps = {
      stmts: getStmts(),
      broadcast: vi.fn(),
      findProject: vi.fn((id: string) => (id === project.id ? project : null)),
      findAgent: vi.fn(),
      getEnrichedAgent: vi.fn(),
      handleChat: vi.fn(),
      lastDispatchedReviewId: new Map(),
      scheduleAutonomousEpic: vi.fn(),
      autonomousCrons: new Map(),
      runAutonomousLoop: vi.fn(),
      config: {},
      serverDir: path.dirname(fileURLToPath(import.meta.url)),
    } as unknown as RouteDeps;
    app.use(createSupportTicketRoutes(deps));
    app.use(createBoardRoutes(deps));
    const st = (await import('supertest')).default;
    const maskedRequest = st(app);

    const created = await maskedRequest
      .post(`/api/projects/${project.id}/support-tickets`)
      .send({ body: 'private contact', reporter_email: 'alice@example.com' })
      .expect(201);

    expect(created.body.reporter_email).toBe('al***@example.com');
    expect(created.body.reporter_email_masked).toBe(true);

    const detail = await maskedRequest
      .get(`/api/projects/${project.id}/support-tickets/${created.body.id}`)
      .expect(200);
    expect(detail.body.reporter_email).toBe('al***@example.com');
    expect(detail.body.reporter_email_masked).toBe(true);

    const converted = await maskedRequest
      .post(`/api/projects/${project.id}/support-tickets/${created.body.id}/convert`)
      .expect(201);
    expect(converted.body.card.support_ticket_id).toBe(created.body.id);
    expect(converted.body.card.customer_report_id).toBe(created.body.id);
    expect(converted.body.card.linked_support_ticket).toMatchObject({
      id: created.body.id,
      reporter_email: 'al***@example.com',
      reporter_email_masked: true,
    });
    expect(JSON.stringify(converted.body.card)).not.toContain('alice@example.com');

    const board = await maskedRequest.get(`/api/projects/${project.id}/board`).expect(200);
    const boardCard = board.body.cards.find((c: { id: string }) => c.id === converted.body.card.id);
    expect(boardCard.linked_support_ticket).toMatchObject({
      id: created.body.id,
      reporter_email: 'al***@example.com',
      reporter_email_masked: true,
    });
    expect(JSON.stringify(boardCard)).not.toContain('alice@example.com');
  });

  it('serializeSupportTicket leaves backwards-compatible no-email tickets unmasked', () => {
    const serialized = serializeSupportTicket(
      {
        id: 'tkt-1',
        project_id: 'p1',
        type: 'bug',
        severity: 'medium',
        status: 'new',
        subject: '',
        body: 'legacy',
        reporter: null,
        reporter_email: null,
        ai_summary: null,
        ai_investigation: null,
        ai_investigated_at: null,
        replay_ref: null,
        screenshot_ref: null,
        converted_card_id: null,
        wont_do_reason: null,
        fixed_at: null,
        released_to_prod_at: null,
        release_deployment_id: null,
        customer_notified_at: null,
        read_at: null,
        resolved_at: null,
        created_at: '2026-06-29 00:00:00',
        updated_at: '2026-06-29 00:00:00',
      },
      { canReadReporterEmail: false },
    );

    expect(serialized.reporter_email).toBeNull();
    expect(serialized.reporter_email_masked).toBe(false);
  });

  it('PATCH preserves AI fields not present in the body (partial update)', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'webhook fails', severity: 'high' })
      .expect(201);
    const id = created.body.id as string;

    // Seed both AI fields.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ aiSummary: 'summary v1', aiInvestigation: 'details v1' })
      .expect(200);

    // Send only the summary — the investigation text must survive.
    const patched = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ aiSummary: 'summary v2' })
      .expect(200);
    expect(patched.body.ai_summary).toBe('summary v2');
    expect(patched.body.ai_investigation).toBe('details v1');
  });

  it('PATCH reclassifies ticket type and updates type filters', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'make this a feature', severity: 'medium', type: 'question' })
      .expect(201);
    const id = created.body.id as string;

    const patched = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ type: 'feature_request' })
      .expect(200);
    expect(patched.body.type).toBe('feature_request');

    const questions = await request
      .get(`/api/projects/${projectId}/support-tickets?type=question`)
      .expect(200);
    expect(questions.body.find((t: { id: string }) => t.id === id)).toBeUndefined();

    const features = await request
      .get(`/api/projects/${projectId}/support-tickets?type=feature_request`)
      .expect(200);
    expect(features.body.find((t: { id: string }) => t.id === id)?.type).toBe('feature_request');

    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ type: 'bogus' })
      .expect(400);
  });

  it('PATCH re-rates ticket severity and reorders the queue', async () => {
    const projectId = await newProjectId();
    const low = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'mis-rated at intake', severity: 'low' })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'genuinely urgent', severity: 'high' })
      .expect(201);
    const id = low.body.id as string;

    const patched = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ severity: 'critical' })
      .expect(200);
    expect(patched.body.severity).toBe('critical');

    // The list is severity-ordered server-side, so the re-rated ticket now leads.
    const listed = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(listed.body[0].id).toBe(id);

    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ severity: 'urgent' })
      .expect(400);
    const unchanged = await request
      .get(`/api/projects/${projectId}/support-tickets/${id}`)
      .expect(200);
    expect(unchanged.body.severity).toBe('critical');
  });

  it('PATCH rejects a bad enum before writing any other field', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'all or nothing', severity: 'medium', type: 'question', subject: 'atomic' })
      .expect(201);
    const id = created.body.id as string;

    // A valid field paired with an invalid one must not half-apply: the store
    // mutations run in sequence, so validation has to happen before the first
    // write or `type` lands while `severity` 400s.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ type: 'bug', severity: 'urgent' })
      .expect(400);

    const after = await request.get(`/api/projects/${projectId}/support-tickets/${id}`).expect(200);
    expect(after.body.type).toBe('question');
    expect(after.body.severity).toBe('medium');

    // Same guard in the other direction: a bad status must not land the type.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ type: 'incident', status: 'archived' })
      .expect(400);
    const after2 = await request
      .get(`/api/projects/${projectId}/support-tickets/${id}`)
      .expect(200);
    expect(after2.body.type).toBe('question');
    expect(after2.body.status).toBe('new');
  });

  it('rejects a missing body and invalid status filter', async () => {
    const projectId = await newProjectId();
    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ severity: 'high' })
      .expect(400);
    await request.get(`/api/projects/${projectId}/support-tickets?status=bogus`).expect(400);
  });

  it('converts a ticket into a To Do kanban card with mapped fields', async () => {
    const projectId = await newProjectId();

    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({
        body: 'Checkout button does nothing on mobile',
        subject: 'Broken checkout',
        type: 'bug',
        severity: 'critical',
        reporter_email: 'reporter@example.com',
      })
      .expect(201);
    const ticketId = created.body.id as string;

    const convert = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .expect(201);

    // Response reports the card it became and the retained, now-converted ticket.
    expect(convert.body.converted).toBe(true);
    expect(convert.body.ticketId).toBe(ticketId);
    expect(convert.body.ticket.status).toBe('converted');
    expect(convert.body.ticket.converted_card_id).toBe(convert.body.card.id);

    // Card carries over the mapped fields.
    const card = convert.body.card;
    expect(card.title).toBe('Broken checkout');
    expect(card.priority).toBe('urgent'); // critical → urgent
    expect(card.labels).toBe('support,bug');
    expect(card.support_ticket_id).toBe(ticketId);
    expect(card.customer_report_id).toBe(ticketId);
    expect(card.linked_support_ticket).toMatchObject({
      id: ticketId,
      reporter_email: 'reporter@example.com',
      reporter_email_masked: false,
      status: 'converted',
      type: 'bug',
      severity: 'critical',
    });
    expect(card.description).toContain('Checkout button does nothing on mobile');
    expect(card.description).toContain(ticketId); // back-link footer

    // Card lands in the board's "To Do" column.
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const todo = board.body.columns.find((c: { name: string }) => c.name === 'To Do');
    expect(card.column_id).toBe(todo.id);
    const onBoard = board.body.cards.find((c: { id: string }) => c.id === card.id);
    expect(onBoard).toBeTruthy();
    expect(onBoard.support_ticket_id).toBe(ticketId);
    expect(onBoard.customer_report_id).toBe(ticketId);
    expect(onBoard.linked_support_ticket).toMatchObject({
      id: ticketId,
      reporter_email: 'reporter@example.com',
      reporter_email_masked: false,
    });

    const cardsList = await request.get(`/api/projects/${projectId}/board/cards`).expect(200);
    const listCard = cardsList.body.find((c: { id: string }) => c.id === card.id);
    expect(listCard.linked_support_ticket).toMatchObject({ id: ticketId });

    // Legacy converted cards that predate the new card columns are still
    // readable because board serialization can derive the link from
    // support_tickets.converted_card_id.
    getStmts().linkKanbanCardSupportTicket.run(null, null, card.id);
    const legacyBoard = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const legacyCard = legacyBoard.body.cards.find((c: { id: string }) => c.id === card.id);
    expect(legacyCard.support_ticket_id).toBe(ticketId);
    expect(legacyCard.customer_report_id).toBe(ticketId);
    expect(legacyCard.linked_support_ticket).toMatchObject({ id: ticketId });

    // The source ticket is RETAINED (now converted), not deleted…
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(detail.body.status).toBe('converted');
    // …but it drops out of the default (open) queue view.
    const openList = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(openList.body.find((t: { id: string }) => t.id === ticketId)).toBeUndefined();
  });

  it('stamps the auto-merge preference + a note onto the converted card', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'auto-merge this one', severity: 'high', type: 'bug' })
      .expect(201);
    const ticketId = created.body.id as string;

    const convert = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .send({ autoMerge: true, comment: 'Ship behind a flag.' })
      .expect(201);

    // The new card carries the auto-merge preference so the board assign UI
    // pre-populates the checkbox.
    expect((convert.body.card as { auto_merge?: number | null }).auto_merge).toBe(1);

    // The note is recorded as a card comment.
    const comments = await request
      .get(`/api/projects/${projectId}/board/cards/${convert.body.card.id}/comments`)
      .expect(200);
    expect((comments.body as Array<{ content: string }>).map((c) => c.content)).toContain(
      'Ship behind a flag.',
    );
  });

  it('rejects an over-long convert comment (> 4000 chars) with 400', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'too long a note', severity: 'low', type: 'question' })
      .expect(201);
    const ticketId = created.body.id as string;

    await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .send({ comment: 'y'.repeat(4001) })
      .expect(400);

    // The ticket is NOT converted (still in the open queue).
    const openList = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(openList.body.find((t: { id: string }) => t.id === ticketId)?.status).toBe('new');
  });

  it('names the converted card (short id + title) on every ticket read', async () => {
    // Regression: the ticket only carried the opaque `converted_card_id`, which
    // matches nothing an operator can find on the board — cards are identified
    // there by #short_id and title. Every ticket read must resolve the card.
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'find me on the board', subject: 'Cant find linked card', severity: 'medium' })
      .expect(201);
    const ticketId = created.body.id as string;
    expect(created.body.converted_card).toBeNull();

    const convert = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .expect(201);
    const card = convert.body.card as { id: string; short_id: number; title: string };
    const expected = {
      id: card.id,
      short_id: card.short_id,
      title: 'Cant find linked card',
      column_name: 'To Do',
    };
    expect(convert.body.ticket.converted_card).toEqual(expected);

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(detail.body.converted_card).toEqual(expected);

    const done = await request
      .get(`/api/projects/${projectId}/support-tickets?status=converted`)
      .expect(200);
    expect(done.body.find((t: { id: string }) => t.id === ticketId).converted_card).toEqual(
      expected,
    );

    // A deleted card degrades to null rather than leaving a dangling name.
    await request.delete(`/api/projects/${projectId}/board/cards/${card.id}`).expect(200);
    const orphaned = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(orphaned.body.converted_card_id).toBe(card.id);
    expect(orphaned.body.converted_card).toBeNull();
  });

  it('convert with no body leaves the card auto_merge unset (project default)', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'no preference', severity: 'low', type: 'question' })
      .expect(201);
    const ticketId = created.body.id as string;

    const convert = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .expect(201);
    expect((convert.body.card as { auto_merge?: number | null }).auto_merge ?? null).toBeNull();
  });

  it('retains the ticket after converting — re-converting the same id 409s', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'convert me once', severity: 'low', type: 'question' })
      .expect(201);
    const ticketId = created.body.id as string;

    const first = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .expect(201);
    // The ticket is already converted, so a second convert is a 409 (no dupe card).
    await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .expect(409);

    // Exactly one card was created (no duplicate from a retry).
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const matching = board.body.cards.filter((c: { id: string }) => c.id === first.body.card.id);
    expect(matching).toHaveLength(1);
    // The ticket is retained as converted, and the "Done" filter surfaces it.
    const done = await request
      .get(`/api/projects/${projectId}/support-tickets?status=converted`)
      .expect(200);
    expect(done.body.find((t: { id: string }) => t.id === ticketId)?.status).toBe('converted');
  });

  it('is duplicate-safe — concurrent converts create exactly one card', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'race me', severity: 'medium', type: 'bug' })
      .expect(201);
    const ticketId = created.body.id as string;

    // Fire two converts at once (models a retry after a slow/lost 201). The
    // atomic create+delete-with-claim must let exactly one win and 404 the
    // other rather than inserting a second card.
    const [a, b] = await Promise.all([
      request.post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`),
      request.post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`),
    ]);
    const statuses = [a.status, b.status].sort();
    // One wins (201); the other observes the ticket already converted (409).
    expect(statuses).toEqual([201, 409]);

    // Only one support-ticket card landed on the board for this ticket.
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const supportCards = board.body.cards.filter(
      (c: { support_ticket_id: string | null }) => c.support_ticket_id === ticketId,
    );
    expect(supportCards).toHaveLength(1);
    expect(supportCards[0].customer_report_id).toBe(ticketId);
    expect(supportCards[0].linked_support_ticket).toMatchObject({ id: ticketId });
  });

  it('404s converting an unknown ticket or project', async () => {
    const projectId = await newProjectId();
    await request.post(`/api/projects/${projectId}/support-tickets/nope/convert`).expect(404);
    await request.post('/api/projects/does-not-exist/support-tickets/nope/convert').expect(404);
  });

  it('triggers AI investigation for bug tickets only', async () => {
    const projectId = await newProjectId();

    triggerInvestigation.mockClear();
    const bug = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'crash on save', type: 'bug', severity: 'high' })
      .expect(201);
    expect(triggerInvestigation).toHaveBeenCalledTimes(1);
    expect(triggerInvestigation).toHaveBeenCalledWith(
      bug.body.id,
      expect.objectContaining({ cwd: expect.any(String) }),
    );

    // Non-bug ticket types do not kick off an investigation.
    triggerInvestigation.mockClear();
    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'how do I export?', type: 'question' })
      .expect(201);
    expect(triggerInvestigation).not.toHaveBeenCalled();
  });

  it('keeps ticket listing read-only when a bug summary is missing', async () => {
    const projectId = await newProjectId();
    await createAgent({ projectId, role: 'dev', engine: 'claude-code' });
    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'summary disappeared', type: 'bug', severity: 'medium' })
      .expect(201);

    routeMocks.resolveOwnerUserId.mockReturnValueOnce('support-user');
    triggerInvestigation.mockClear();
    await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);

    expect(triggerInvestigation).not.toHaveBeenCalled();
  });

  it('rejects a selected investigation when no owner can be resolved', async () => {
    const projectId = await newProjectId();
    await createAgent({ projectId, role: 'dev' });
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'customer cannot sign in', type: 'question' })
      .expect(201);

    triggerInvestigation.mockClear();
    const response = await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/investigate`)
      .send({ engine: 'claude-code', model: 'claude-opus-4-8' })
      .expect(400);

    expect(response.body.error).toContain('No acting user');
    expect(triggerInvestigation).not.toHaveBeenCalled();
  });

  it('queues an investigation with the project main dev agent and resolved owner', async () => {
    const projectId = await newProjectId();
    await createAgent({ projectId, role: 'dev', engine: 'claude-code' });
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'customer cannot sign in', type: 'question' })
      .expect(201);

    routeMocks.resolveOwnerUserId.mockReturnValueOnce('user-selected');
    routeMocks.resolveOneShotEngine.mockClear();
    routeMocks.resolveOneShotEngine.mockResolvedValueOnce({
      engine: 'codex-cli',
      model: 'capability-fallback-model',
    });
    triggerInvestigation.mockClear();
    const response = await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/investigate`)
      .send({})
      .expect(202);

    expect(response.body).toMatchObject({
      queued: true,
      engine: 'codex-cli',
      model: 'capability-fallback-model',
    });
    expect(triggerInvestigation).toHaveBeenCalledTimes(1);
    expect(triggerInvestigation).toHaveBeenCalledWith(
      created.body.id,
      expect.objectContaining({
        agentEngine: 'claude-code',
        userId: 'user-selected',
      }),
    );
    expect(routeMocks.resolveOneShotEngine).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        preferred: 'claude-code',
        preferredModel: 'claude-opus-5',
        userId: 'user-selected',
        fallbackChain: ['claude-code'],
      }),
    );
    expect(routeMocks.resolveOneShotEngine).toHaveBeenCalledTimes(1);
  });

  it('does not allow an explicit engine or model selection to override the project agent', async () => {
    const projectId = await newProjectId();
    await createAgent({ projectId, role: 'dev', engine: 'claude-code' });
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'bad model request', type: 'bug' })
      .expect(201);

    routeMocks.resolveOwnerUserId.mockReturnValueOnce('user-selected');
    routeMocks.resolveOneShotEngine.mockResolvedValueOnce({
      engine: 'claude-code',
      model: 'project-default',
    });
    triggerInvestigation.mockClear();
    await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/investigate`)
      .send({ engine: 'codex-cli', model: 'not-a-real-model' })
      .expect(202);
    expect(triggerInvestigation).toHaveBeenCalledTimes(1);
  });

  // 1x1 transparent PNG.
  const PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('persists an attached screenshot and exposes its ref on the ticket', async () => {
    const projectId = await newProjectId();

    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'visual glitch on dashboard', severity: 'medium', screenshot: PNG_DATA_URL })
      .expect(201);

    const ref = created.body.screenshot_ref as string;
    expect(ref).toMatch(/^\/uploads\/support-screenshot-[\w-]+\.png$/);

    // The persisted file is served from /uploads as a PNG.
    const fetched = await request.get(ref).expect(200);
    expect(fetched.headers['content-type']).toMatch(/image\/png/);

    // The detail endpoint returns the same ref.
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${created.body.id}`)
      .expect(200);
    expect(detail.body.screenshot_ref).toBe(ref);
  });

  it('rejects an invalid screenshot data URL with a 400 and creates no ticket', async () => {
    const projectId = await newProjectId();

    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'bad shot', severity: 'low', screenshot: 'data:application/pdf;base64,Zm9v' })
      .expect(400);

    const list = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(list.body).toHaveLength(0);
  });

  it('rolls back the screenshot file when the ticket fails to land (no orphan)', async () => {
    const projectId = await newProjectId();
    const before = screenshotFiles();

    // A valid screenshot but an invalid type — intake throws AFTER the file is
    // written, so the route must delete the orphan.
    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'orphan check', type: 'not-a-type', screenshot: PNG_DATA_URL })
      .expect(400);

    const after = screenshotFiles();
    expect(after.filter((f) => !before.includes(f))).toEqual([]);
  });

  it('PATCH attaches a screenshot, then clearing it deletes the orphaned file', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'attach later', severity: 'high' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.screenshot_ref).toBeNull();

    const attached = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ screenshot: PNG_DATA_URL })
      .expect(200);
    const ref = attached.body.screenshot_ref as string;
    expect(ref).toMatch(/^\/uploads\/support-screenshot-[\w-]+\.png$/);
    await request.get(ref).expect(200); // file is live

    const cleared = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ screenshot: null })
      .expect(200);
    expect(cleared.body.screenshot_ref).toBeNull();
    // The now-unreferenced file must be deleted (not just unlinked from the row).
    await request.get(ref).expect(404);
  });

  it('PATCH replacing a screenshot deletes the prior file', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'replace me', severity: 'high', screenshot: PNG_DATA_URL })
      .expect(201);
    const id = created.body.id as string;
    const firstRef = created.body.screenshot_ref as string;
    await request.get(firstRef).expect(200);

    const replaced = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ screenshot: PNG_DATA_URL })
      .expect(200);
    const secondRef = replaced.body.screenshot_ref as string;
    expect(secondRef).not.toBe(firstRef);

    await request.get(firstRef).expect(404); // prior file gone
    await request.get(secondRef).expect(200); // new file live
  });

  it('converting a ticket PRESERVES its screenshot file (the new card embeds it) and retains the ticket', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'convert with screenshot', severity: 'high', screenshot: PNG_DATA_URL })
      .expect(201);
    const id = created.body.id as string;
    const ref = created.body.screenshot_ref as string;
    await request.get(ref).expect(200);

    // Convert: the card description bakes in the ref as a markdown image, and the
    // retained ticket keeps its own screenshot ref too.
    const convert = await request
      .post(`/api/projects/${projectId}/support-tickets/${id}/convert`)
      .expect(201);
    expect(convert.body.card.description).toContain(ref);

    await request.get(ref).expect(200); // preserved for the card + ticket
    // The source ticket is retained (converted), still carrying its screenshot.
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${id}`)
      .expect(200);
    expect(detail.body.status).toBe('converted');
    expect(detail.body.screenshot_ref).toBe(ref);
  });

  it('DELETE removes the screenshot file of an unconverted ticket', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'delete me', severity: 'low', screenshot: PNG_DATA_URL })
      .expect(201);
    const id = created.body.id as string;
    const ref = created.body.screenshot_ref as string;
    await request.get(ref).expect(200);

    await request.delete(`/api/projects/${projectId}/support-tickets/${id}`).expect(200);
    await request.get(ref).expect(404);
  });

  it('PATCH with an invalid screenshot fails the whole update with a 400', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'guard the patch', severity: 'high', subject: 'orig' })
      .expect(201);
    const id = created.body.id as string;

    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status: 'investigating', screenshot: 'not-a-data-url' })
      .expect(400);

    // The status change must NOT have applied (screenshot validation runs first).
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${id}`)
      .expect(200);
    expect(detail.body.status).toBe('new');
  });

  it('new tickets start unread and the unread-count reflects them', async () => {
    const projectId = await newProjectId();

    // Fresh queue: zero unread.
    const zero = await request
      .get(`/api/projects/${projectId}/support-tickets/unread-count`)
      .expect(200);
    expect(zero.body).toEqual({ count: 0 });

    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'unread on arrival', severity: 'medium', type: 'question' })
      .expect(201);
    expect(created.body.read_at).toBeNull();

    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'also unread', severity: 'low', type: 'question' })
      .expect(201);

    const two = await request
      .get(`/api/projects/${projectId}/support-tickets/unread-count`)
      .expect(200);
    expect(two.body).toEqual({ count: 2 });
  });

  it('marks a ticket read and unread, adjusting the count each way', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'toggle me', severity: 'high', type: 'question' })
      .expect(201);
    const id = created.body.id as string;

    // Mark read.
    const read = await request
      .post(`/api/projects/${projectId}/support-tickets/${id}/read`)
      .expect(200);
    expect(read.body.read_at).not.toBeNull();
    expect(
      (await request.get(`/api/projects/${projectId}/support-tickets/unread-count`).expect(200))
        .body.count,
    ).toBe(0);

    // Re-reading is idempotent (still read, count stays 0).
    const readAgain = await request
      .post(`/api/projects/${projectId}/support-tickets/${id}/read`)
      .expect(200);
    expect(readAgain.body.read_at).toBe(read.body.read_at);

    // Mark unread again.
    const unread = await request
      .post(`/api/projects/${projectId}/support-tickets/${id}/unread`)
      .expect(200);
    expect(unread.body.read_at).toBeNull();
    expect(
      (await request.get(`/api/projects/${projectId}/support-tickets/unread-count`).expect(200))
        .body.count,
    ).toBe(1);
  });

  it('read-all clears every unread ticket in the project', async () => {
    const projectId = await newProjectId();
    for (const sev of ['low', 'high', 'medium']) {
      await request
        .post(`/api/projects/${projectId}/support-tickets`)
        .send({ body: `bulk ${sev}`, severity: sev, type: 'question' })
        .expect(201);
    }

    const result = await request
      .post(`/api/projects/${projectId}/support-tickets/read-all`)
      .expect(200);
    expect(result.body.marked).toBe(3);
    expect(result.body.unreadCount).toBe(0);

    // Every row now carries a read_at.
    const list = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(list.body.every((t: { read_at: string | null }) => t.read_at !== null)).toBe(true);

    // A second read-all marks nothing.
    const again = await request
      .post(`/api/projects/${projectId}/support-tickets/read-all`)
      .expect(200);
    expect(again.body.marked).toBe(0);
  });

  it('converting a ticket marks it read, clearing it from the unread count (ticket retained)', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'convert clears unread', severity: 'high', type: 'question' })
      .expect(201);
    const id = created.body.id as string;

    // The fresh ticket counts as unread.
    expect(
      (await request.get(`/api/projects/${projectId}/support-tickets/unread-count`).expect(200))
        .body.count,
    ).toBe(1);

    await request.post(`/api/projects/${projectId}/support-tickets/${id}/convert`).expect(201);

    // The ticket is retained (converted + read), so the unread count drops to zero.
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${id}`)
      .expect(200);
    expect(detail.body.status).toBe('converted');
    expect(detail.body.read_at).not.toBeNull();
    expect(
      (await request.get(`/api/projects/${projectId}/support-tickets/unread-count`).expect(200))
        .body.count,
    ).toBe(0);
  });

  it('404s read/unread/read-all/unread-count for unknown project or ticket', async () => {
    const projectId = await newProjectId();
    await request.get('/api/projects/nope/support-tickets/unread-count').expect(404);
    await request.post('/api/projects/nope/support-tickets/read-all').expect(404);
    await request.post(`/api/projects/${projectId}/support-tickets/ghost/read`).expect(404);
    await request.post(`/api/projects/${projectId}/support-tickets/ghost/unread`).expect(404);
    await request.post('/api/projects/nope/support-tickets/ghost/read').expect(404);
  });

  it('PATCH rolls back a newly-written screenshot when a later mutation rejects', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'patch orphan check', severity: 'high' })
      .expect(201);
    const id = created.body.id as string;
    const before = screenshotFiles();

    // Valid screenshot (file gets written) but an invalid status (mutation
    // throws) — the route must delete the orphan and leave the row unchanged.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status: 'bogus-status', screenshot: PNG_DATA_URL })
      .expect(400);

    const after = screenshotFiles();
    expect(after.filter((f) => !before.includes(f))).toEqual([]);

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${id}`)
      .expect(200);
    expect(detail.body.status).toBe('new');
    expect(detail.body.screenshot_ref).toBeNull();
  });

  it('hides terminal statuses from the default (open) list and reveals them per-status', async () => {
    const projectId = await newProjectId();

    // One open ticket, plus one of each terminal state.
    const open = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'still open', severity: 'high', type: 'bug' })
      .expect(201);
    const closedT = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'closed one', severity: 'medium', type: 'bug' })
      .expect(201);
    const dupT = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'dup one', severity: 'low', type: 'bug' })
      .expect(201);
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${closedT.body.id}`)
      .send({ status: 'closed' })
      .expect(200);
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${dupT.body.id}`)
      .send({ status: 'duplicate' })
      .expect(200);

    // Default view = open states only.
    const def = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(def.body.map((t: { id: string }) => t.id)).toEqual([open.body.id]);

    // Each terminal state is reachable via its own filter.
    const closed = await request
      .get(`/api/projects/${projectId}/support-tickets?status=closed`)
      .expect(200);
    expect(closed.body.map((t: { id: string }) => t.id)).toEqual([closedT.body.id]);

    const dup = await request
      .get(`/api/projects/${projectId}/support-tickets?status=duplicate`)
      .expect(200);
    expect(dup.body.map((t: { id: string }) => t.id)).toEqual([dupT.body.id]);

    // A comma-separated list unions several states (severity-ordered).
    const both = await request
      .get(`/api/projects/${projectId}/support-tickets?status=closed,duplicate`)
      .expect(200);
    expect(both.body.map((t: { id: string }) => t.id)).toEqual([closedT.body.id, dupT.body.id]);
  });

  it('filters by request type (bug / feature_request)', async () => {
    const projectId = await newProjectId();
    const bug = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'a bug', severity: 'high', type: 'bug' })
      .expect(201);
    const feat = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'a feature', severity: 'high', type: 'feature_request' })
      .expect(201);

    const bugs = await request
      .get(`/api/projects/${projectId}/support-tickets?type=bug`)
      .expect(200);
    expect(bugs.body.map((t: { id: string }) => t.id)).toEqual([bug.body.id]);

    const feats = await request
      .get(`/api/projects/${projectId}/support-tickets?type=feature_request`)
      .expect(200);
    expect(feats.body.map((t: { id: string }) => t.id)).toEqual([feat.body.id]);

    // An invalid type is a 400.
    await request.get(`/api/projects/${projectId}/support-tickets?type=nope`).expect(400);
  });

  it('400s (not 500s) when status/type are repeated into an array query param', async () => {
    const projectId = await newProjectId();
    // A repeated key parses to an array; the route must reject it with a 400
    // rather than throwing while splitting/validating.
    await request
      .get(`/api/projects/${projectId}/support-tickets?status=new&status=closed`)
      .expect(400);
    await request
      .get(`/api/projects/${projectId}/support-tickets?type=bug&type=feature_request`)
      .expect(400);
  });

  it("requires a reason to mark a ticket 'wont_do' and clears it on re-open", async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'maybe later', severity: 'low', type: 'feature_request' })
      .expect(201);
    const id = created.body.id as string;

    // Won't-do without a reason is rejected, and the status must not change.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status: 'wont_do' })
      .expect(400);
    expect(
      (await request.get(`/api/projects/${projectId}/support-tickets/${id}`).expect(200)).body
        .status,
    ).toBe('new');

    // A blank/whitespace reason is also rejected.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status: 'wont_do', wontDoReason: '   ' })
      .expect(400);

    // With a reason it lands, storing the trimmed reason.
    const wontDo = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status: 'wont_do', wontDoReason: '  out of scope for now  ' })
      .expect(200);
    expect(wontDo.body.status).toBe('wont_do');
    expect(wontDo.body.wont_do_reason).toBe('out of scope for now');

    // Hidden from the default queue, visible under the wont_do filter.
    const def = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(def.body.find((t: { id: string }) => t.id === id)).toBeUndefined();
    const wontDoList = await request
      .get(`/api/projects/${projectId}/support-tickets?status=wont_do`)
      .expect(200);
    expect(wontDoList.body.map((t: { id: string }) => t.id)).toEqual([id]);

    // A reason-ONLY edit that would blank the reason (no status change) is
    // rejected — the invariant is that a 'wont_do' ticket always has a reason.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ wontDoReason: '   ' })
      .expect(400);
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ wontDoReason: null })
      .expect(400);
    // The reason survived the rejected edits.
    expect(
      (await request.get(`/api/projects/${projectId}/support-tickets/${id}`).expect(200)).body
        .wont_do_reason,
    ).toBe('out of scope for now');

    // A reason-only edit WITH content updates it in place.
    const reworded = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ wontDoReason: 'duplicate of an existing roadmap item' })
      .expect(200);
    expect(reworded.body.status).toBe('wont_do');
    expect(reworded.body.wont_do_reason).toBe('duplicate of an existing roadmap item');

    // Re-opening clears the reason.
    const reopened = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status: 'investigating' })
      .expect(200);
    expect(reopened.body.status).toBe('investigating');
    expect(reopened.body.wont_do_reason).toBeNull();
  });

  it('clears wont_do_reason when a wont_do ticket is converted to a card', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'reconsidered', severity: 'medium', type: 'bug' })
      .expect(201);
    const id = created.body.id as string;

    // Mark it won't-do with a reason…
    const wontDo = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status: 'wont_do', wontDoReason: 'not now' })
      .expect(200);
    expect(wontDo.body.wont_do_reason).toBe('not now');

    // …then convert it: the lifecycle flips to 'converted', so the stale reason
    // must be cleared inside the same transaction.
    const convert = await request
      .post(`/api/projects/${projectId}/support-tickets/${id}/convert`)
      .expect(201);
    expect(convert.body.ticket.status).toBe('converted');
    expect(convert.body.ticket.wont_do_reason).toBeNull();

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${id}`)
      .expect(200);
    expect(detail.body.wont_do_reason).toBeNull();
  });

  it('marks a linked ticket fixed pending release when its converted card moves to Done', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'released later', severity: 'medium', type: 'bug' })
      .expect(201);
    expect(created.body.release_state).toBeNull();

    const convert = await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/convert`)
      .expect(201);
    const cardId = convert.body.card.id as string;

    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const doneColumn = board.body.columns.find((col: { name: string }) => col.name === 'Done');
    expect(doneColumn).toBeTruthy();

    await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/move`)
      .send({ columnId: doneColumn.id, position: 0 })
      .expect(200);

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${created.body.id}`)
      .expect(200);
    expect(detail.body.release_state).toBe('fixed_pending_release');
    expect(detail.body.fixed_at).toBeTruthy();
    expect(detail.body.released_to_prod_at).toBeNull();
    expect(detail.body.customer_notified_at).toBeNull();
  });

  // Helper: create a plain kanban card in the board's "To Do" column and return
  // its id (the target for link-card tests).
  async function createBoardCard(projectId: string, title: string): Promise<string> {
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const todo = board.body.columns.find((c: { name: string }) => c.name === 'To Do');
    expect(todo).toBeTruthy();
    const card = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title, columnId: todo.id })
      .expect(200);
    return card.body.id as string;
  }

  it('links a ticket to an existing card, stamping the back-link + a comment', async () => {
    const projectId = await newProjectId();
    const cardId = await createBoardCard(projectId, `fix already shipped ${Date.now()}`);

    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'this bug is already fixed', severity: 'high', type: 'bug' })
      .expect(201);
    const ticketId = created.body.id as string;

    const link = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/link-card`)
      .send({ cardId, comment: 'already resolved by this card' })
      .expect(200);

    // Response reports the existing card (linked, not newly created) and the
    // retained, now-converted ticket.
    expect(link.body.linked).toBe(true);
    expect(link.body.ticketId).toBe(ticketId);
    expect(link.body.card.id).toBe(cardId);
    expect(link.body.card.support_ticket_id).toBe(ticketId);
    expect(link.body.card.customer_report_id).toBe(ticketId);
    expect(link.body.ticket.status).toBe('converted');
    expect(link.body.ticket.converted_card_id).toBe(cardId);

    // The ticket dropped out of the default open queue but is retained.
    const openQueue = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(openQueue.body.find((t: { id: string }) => t.id === ticketId)).toBeUndefined();
    const done = await request
      .get(`/api/projects/${projectId}/support-tickets?status=converted`)
      .expect(200);
    expect(done.body.find((t: { id: string }) => t.id === ticketId)?.status).toBe('converted');

    // The operator note + a back-link footer landed as a card comment.
    const comments = await request
      .get(`/api/projects/${projectId}/board/cards/${cardId}/comments`)
      .expect(200);
    const text = JSON.stringify(comments.body);
    expect(text).toContain('already resolved by this card');
    expect(text).toContain(`Linked from support ticket \`${ticketId}\``);
  });

  it('404s linking to a card that is not on this project board', async () => {
    const projectId = await newProjectId();
    const otherProjectId = await newProjectId();
    const foreignCardId = await createBoardCard(otherProjectId, `foreign card ${Date.now()}`);

    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'link me somewhere invalid', severity: 'low', type: 'bug' })
      .expect(201);

    await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/link-card`)
      .send({ cardId: foreignCardId })
      .expect(404);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/link-card`)
      .send({ cardId: 'does-not-exist' })
      .expect(404);

    // The ticket stays open on a failed link.
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${created.body.id}`)
      .expect(200);
    expect(detail.body.status).toBe('new');
    expect(detail.body.converted_card_id).toBeNull();
  });

  it('409s when the ticket is already converted, or the card is linked to another ticket', async () => {
    const projectId = await newProjectId();
    const cardId = await createBoardCard(projectId, `shared card ${Date.now()}`);

    const first = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'first ticket', severity: 'medium', type: 'bug' })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${first.body.id}/link-card`)
      .send({ cardId })
      .expect(200);

    // Re-linking the same (now converted) ticket 409s.
    await request
      .post(`/api/projects/${projectId}/support-tickets/${first.body.id}/link-card`)
      .send({ cardId })
      .expect(409);

    // A different ticket cannot hijack a card already linked to the first.
    const second = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'second ticket', severity: 'medium', type: 'bug' })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${second.body.id}/link-card`)
      .send({ cardId })
      .expect(409);
  });

  it('rejects a missing cardId (400) and an over-long comment (400)', async () => {
    const projectId = await newProjectId();
    const cardId = await createBoardCard(projectId, `validation card ${Date.now()}`);
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'validate me', severity: 'low', type: 'bug' })
      .expect(201);

    await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/link-card`)
      .send({})
      .expect(400);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${created.body.id}/link-card`)
      .send({ cardId, comment: 'x'.repeat(4001) })
      .expect(400);

    // Neither rejected attempt converted the ticket.
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${created.body.id}`)
      .expect(200);
    expect(detail.body.status).toBe('new');
  });

  it('is race-safe — two tickets linking the same card: exactly one wins, no clobber', async () => {
    const projectId = await newProjectId();
    const cardId = await createBoardCard(projectId, `contested card ${Date.now()}`);
    const first = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'first racer', severity: 'medium', type: 'bug' })
      .expect(201);
    const second = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'second racer', severity: 'medium', type: 'bug' })
      .expect(201);

    // Fire two links at the same card for DIFFERENT tickets at once. The
    // in-transaction card re-read must let exactly one claim the card's
    // back-link and 409 the other, so the winner's provenance is never
    // clobbered.
    const [a, b] = await Promise.all([
      request
        .post(`/api/projects/${projectId}/support-tickets/${first.body.id}/link-card`)
        .send({ cardId }),
      request
        .post(`/api/projects/${projectId}/support-tickets/${second.body.id}/link-card`)
        .send({ cardId }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    // The card's back-link points at whichever ticket won, and that ticket is
    // the only one flagged converted; the loser stays open (not clobbered).
    const winnerId = a.status === 200 ? first.body.id : second.body.id;
    const loserId = a.status === 200 ? second.body.id : first.body.id;

    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const contested = board.body.cards.find((c: { id: string }) => c.id === cardId);
    expect(contested.support_ticket_id).toBe(winnerId);
    expect(contested.customer_report_id).toBe(winnerId);

    const winner = await request
      .get(`/api/projects/${projectId}/support-tickets/${winnerId}`)
      .expect(200);
    expect(winner.body.status).toBe('converted');
    expect(winner.body.converted_card_id).toBe(cardId);
    const loser = await request
      .get(`/api/projects/${projectId}/support-tickets/${loserId}`)
      .expect(200);
    expect(loser.body.status).toBe('new');
    expect(loser.body.converted_card_id).toBeNull();
  });

  it('claims the card with a conditional write — a card taken after the pre-guard 409s, no clobber', async () => {
    // The single-process concurrent test above can't interleave (nothing awaits
    // between the pre-transaction card guard and the synchronous transaction),
    // so it passes with OR without the guarded write. This test drives the
    // multi-process race deterministically: the card is genuinely claimed by
    // another ticket in the DB, but the pre-transaction read is stubbed to see
    // it unlinked so control reaches the compare-and-swap claim. The CAS must
    // match 0 rows (card already claimed) and 409 rather than clobbering the
    // real back-link. Fails if the claim write is made unconditional or the
    // `changes === 0` check is dropped.
    const projectId = await newProjectId();
    const cardId = await createBoardCard(projectId, `contended card ${Date.now()}`);
    const otherTicket = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'the real winner', severity: 'medium', type: 'bug' })
      .expect(201);
    const mineTicket = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'the loser', severity: 'medium', type: 'bug' })
      .expect(201);

    // Genuinely claim the card in the DB for `otherTicket` first.
    await request
      .post(`/api/projects/${projectId}/support-tickets/${otherTicket.body.id}/link-card`)
      .send({ cardId })
      .expect(200);

    // Stub ONLY the pre-transaction guard read so `mineTicket` gets past it and
    // reaches the CAS; the CAS itself runs against the real (already-claimed)
    // row and the follow-up disambiguation read returns the real row.
    const stmts = getStmts();
    const realGet = stmts.getKanbanCard.get.bind(stmts.getKanbanCard);
    const claimedRow = realGet(cardId) as Record<string, unknown>;
    let cardReads = 0;
    const spy = vi
      .spyOn(stmts.getKanbanCard, 'get')
      .mockImplementation((...args: unknown[]): unknown => {
        if (args[0] === cardId) {
          cardReads += 1;
          // 1st read = pre-transaction guard: pretend the card is still unlinked
          // so control falls through to the guarded CAS. Every later read (the
          // post-CAS disambiguation) sees the real, already-claimed row.
          if (cardReads === 1) {
            return { ...claimedRow, support_ticket_id: null, customer_report_id: null };
          }
        }
        return realGet(...(args as [unknown]));
      });

    try {
      await request
        .post(`/api/projects/${projectId}/support-tickets/${mineTicket.body.id}/link-card`)
        .send({ cardId })
        .expect(409);
    } finally {
      spy.mockRestore();
    }

    // The real claim was respected: our ticket was not converted, and the card's
    // back-link still points at the real winner (never clobbered).
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${mineTicket.body.id}`)
      .expect(200);
    expect(detail.body.status).toBe('new');
    expect(detail.body.converted_card_id).toBeNull();
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const realCard = board.body.cards.find((c: { id: string }) => c.id === cardId);
    expect(realCard.support_ticket_id).toBe(otherTicket.body.id);
    expect(realCard.customer_report_id).toBe(otherTicket.body.id);
  });
});
