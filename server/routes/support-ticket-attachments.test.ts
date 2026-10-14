import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type supertest from 'supertest';
import { existsSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRequest, createProject } from '../test/helpers.js';
import { MAX_ATTACHMENTS_PER_TICKET } from '../support-ticket-attachments.js';

// Creating a bug ticket would otherwise fire an AI investigation (CLI spawn).
vi.mock('../support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: vi.fn(),
}));

// Attachment bytes land in the server's real uploads dir (serverDir = server/).
const UPLOADS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
function attachmentFiles(): string[] {
  try {
    return readdirSync(UPLOADS_DIR).filter((f) => f.startsWith('support-attachment-'));
  } catch {
    return [];
  }
}
const fileFor = (ref: string) => path.join(UPLOADS_DIR, ref.replace(/^\/uploads\//, ''));

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const LOG = Buffer.from('12:00:01 TypeError: x is undefined\n', 'utf8');

let request: supertest.Agent;
let baseline: Set<string>;

beforeAll(async () => {
  request = await getRequest();
  baseline = new Set(attachmentFiles());
}, 60_000);

afterAll(() => {
  for (const f of attachmentFiles()) {
    if (!baseline.has(f)) rmSync(path.join(UPLOADS_DIR, f), { force: true });
  }
});

async function newTicket(): Promise<{ projectId: string; ticketId: string }> {
  const project = await createProject();
  const created = await request
    .post(`/api/projects/${project.id}/support-tickets`)
    .send({ body: 'needs files', severity: 'low', type: 'question' })
    .expect(201);
  expect(created.body.attachments).toEqual([]);
  return { projectId: project.id as string, ticketId: created.body.id as string };
}

function upload(projectId: string, ticketId: string, bytes: Buffer, filename: string) {
  return request
    .post(`/api/projects/${projectId}/support-tickets/${ticketId}/attachments`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Filename', encodeURIComponent(filename))
    .send(bytes);
}

describe('support ticket attachments', () => {
  it('adds several files, lists them on the ticket, and removes one', async () => {
    const { projectId, ticketId } = await newTicket();

    const first = await upload(projectId, ticketId, PNG, 'Écran 1.png').expect(201);
    expect(first.body.attachment).toMatchObject({
      filename: 'Écran 1.png',
      mime: 'image/png',
      size_bytes: PNG.length,
    });
    expect(first.body.attachment.ref).toMatch(/^\/uploads\/support-attachment-[\w-]+\.png$/);
    const second = await upload(projectId, ticketId, LOG, 'console.log').expect(201);
    expect(second.body.attachment.ref).toMatch(/\.txt$/);
    expect(second.body.ticket.attachments).toHaveLength(2);

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(detail.body.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      'Écran 1.png',
      'console.log',
    ]);
    const list = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(list.body[0].attachments).toHaveLength(2);

    const ref = first.body.attachment.ref as string;
    expect(existsSync(fileFor(ref))).toBe(true);
    const removed = await request
      .delete(
        `/api/projects/${projectId}/support-tickets/${ticketId}/attachments/${first.body.attachment.id}`,
      )
      .expect(200);
    expect(removed.body.ticket.attachments.map((a: { id: string }) => a.id)).toEqual([
      second.body.attachment.id,
    ]);
    expect(existsSync(fileFor(ref))).toBe(false);
  });

  it('rejects unsupported types and a missing filename', async () => {
    const { projectId, ticketId } = await newTicket();
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    const res = await upload(projectId, ticketId, html, 'evil.html').expect(400);
    expect(res.body.error).toMatch(/unsupported file type/);
    // Text bytes are only accepted under a text extension.
    await upload(projectId, ticketId, LOG, 'notes.svg').expect(400);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/attachments`)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(400);
  });

  it('enforces the per-ticket attachment cap', async () => {
    const { projectId, ticketId } = await newTicket();
    for (let i = 0; i < MAX_ATTACHMENTS_PER_TICKET; i++) {
      await upload(projectId, ticketId, LOG, `log-${i}.txt`).expect(201);
    }
    const before = attachmentFiles().length;
    await upload(projectId, ticketId, LOG, 'one-too-many.txt').expect(409);
    expect(attachmentFiles().length).toBe(before);
  });

  it('404s for an attachment that belongs to another ticket', async () => {
    const a = await newTicket();
    const b = await newTicket();
    const added = await upload(a.projectId, a.ticketId, PNG, 'a.png').expect(201);
    await request
      .delete(
        `/api/projects/${b.projectId}/support-tickets/${b.ticketId}/attachments/${added.body.attachment.id}`,
      )
      .expect(404);
  });

  it('copies attachments onto a converted card and keeps those files when the ticket is deleted', async () => {
    const { projectId, ticketId } = await newTicket();
    const img = await upload(projectId, ticketId, PNG, 'shot.png').expect(201);
    const log = await upload(projectId, ticketId, LOG, 'server.log').expect(201);

    const converted = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/convert`)
      .send({})
      .expect(201);
    const description = converted.body.card.description as string;
    expect(description).toContain(`![shot.png](${img.body.attachment.ref})`);
    expect(description).toContain(`[server.log](${log.body.attachment.ref})`);

    await request.delete(`/api/projects/${projectId}/support-tickets/${ticketId}`).expect(200);
    expect(existsSync(fileFor(img.body.attachment.ref))).toBe(true);
    expect(existsSync(fileFor(log.body.attachment.ref))).toBe(true);
  });

  it('appends attachment links to a linked card description, keeping its content', async () => {
    const { projectId, ticketId } = await newTicket();
    const img = await upload(projectId, ticketId, PNG, 'shot.png').expect(201);
    const log = await upload(projectId, ticketId, LOG, 'server.log').expect(201);

    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const todo = board.body.columns.find((c: { name: string }) => c.name === 'To Do');
    const card = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'existing fix', description: 'Original card notes.', columnId: todo.id })
      .expect(200);

    const linked = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/link-card`)
      .send({ cardId: card.body.id })
      .expect(200);
    const description = linked.body.card.description as string;
    expect(description.startsWith('Original card notes.')).toBe(true);
    expect(description).toContain(`![shot.png](${img.body.attachment.ref})`);
    expect(description).toContain(`[server.log](${log.body.attachment.ref})`);

    // The card links the files, so deleting the ticket keeps the bytes.
    await request.delete(`/api/projects/${projectId}/support-tickets/${ticketId}`).expect(200);
    expect(existsSync(fileFor(img.body.attachment.ref))).toBe(true);
  });

  it('deletes attachment files with an unconverted ticket', async () => {
    const { projectId, ticketId } = await newTicket();
    const added = await upload(projectId, ticketId, PNG, 'gone.png').expect(201);
    await request.delete(`/api/projects/${projectId}/support-tickets/${ticketId}`).expect(200);
    expect(existsSync(fileFor(added.body.attachment.ref))).toBe(false);
  });
});
