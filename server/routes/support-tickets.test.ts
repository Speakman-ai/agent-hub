import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type supertest from 'supertest';
import { readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRequest, createProject } from '../test/helpers.js';

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
    expect(card.description).toContain('Checkout button does nothing on mobile');
    expect(card.description).toContain(ticketId); // back-link footer

    // Card lands in the board's "To Do" column.
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const todo = board.body.columns.find((c: { name: string }) => c.name === 'To Do');
    expect(card.column_id).toBe(todo.id);
    const onBoard = board.body.cards.find((c: { id: string }) => c.id === card.id);
    expect(onBoard).toBeTruthy();

    // The source ticket is RETAINED (now converted), not deleted…
    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(detail.body.status).toBe('converted');
    // …but it drops out of the default (open) queue view.
    const openList = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(openList.body.find((t: { id: string }) => t.id === ticketId)).toBeUndefined();
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
      (c: { labels: string | null; description: string | null }) =>
        (c.labels || '').includes('support') && (c.description || '').includes(ticketId),
    );
    expect(supportCards).toHaveLength(1);
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
});
