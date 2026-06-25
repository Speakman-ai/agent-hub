import { describe, it, expect, beforeAll, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from '../test/helpers.js';
import { setSupportTicketReplayRef, getSupportTicket } from '../support-tickets-store.js';

// A bug ticket would fire the AI investigation (which shells out to an engine);
// stub it so these tests never spawn a CLI. We only exercise the replay-link
// surface here, not the investigation.
vi.mock('../support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: vi.fn(),
}));

const META = { type: 4, timestamp: 1000, data: { href: 'https://app.example/dashboard' } };
const SNAPSHOT = { type: 2, timestamp: 1001, data: { node: {} } };

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

async function newProjectId(): Promise<string> {
  return (await createProject()).id as string;
}

/** Ingest an anonymous (orphan) replay; returns its id + ref. */
async function ingestOrphanReplay(meta?: Record<string, unknown>): Promise<{
  replayId: string;
  replayRef: string;
}> {
  const res = await request
    .post('/api/replays')
    .send({ events: [META, SNAPSHOT], meta: meta ?? { trigger: 'bug-report' } })
    .expect(201);
  return { replayId: res.body.replayId, replayRef: res.body.replayRef };
}

async function createTicket(projectId: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/support-tickets`)
    .send({ type: 'bug', severity: 'high', subject: 'Broken', body: 'It broke' })
    .expect(201);
  return res.body.id as string;
}

describe('replays-dashboard routes', () => {
  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/replays').expect(404);
    await request.post('/api/projects/does-not-exist/replays/x/link').send({}).expect(404);
    await request.delete('/api/projects/does-not-exist/replays/x/link').expect(404);
  });

  it('rejects an invalid filter', async () => {
    const projectId = await newProjectId();
    await request.get(`/api/projects/${projectId}/replays?filter=bogus`).expect(400);
  });

  it('rejects an invalid kind', async () => {
    const projectId = await newProjectId();
    await request.get(`/api/projects/${projectId}/replays?kind=bogus`).expect(400);
  });

  it('classifies captures and filters by kind (continuous vs on-error)', async () => {
    const projectId = await newProjectId();

    // Two captures attributed to the project via the ticket-link flow: one
    // continuous (trigger=continuous), one on-error (trigger=error).
    const cont = await ingestOrphanReplay({ trigger: 'continuous', url: 'https://app/x' });
    const err = await ingestOrphanReplay({ trigger: 'error', url: 'https://app/y' });
    for (const r of [cont, err]) {
      const ticketId = await createTicket(projectId);
      await request
        .post(`/api/projects/${projectId}/replays/${r.replayId}/link`)
        .send({ supportTicketId: ticketId })
        .expect(200);
    }

    // Capture-kind is surfaced on every row, and `live` is present.
    const all = await request.get(`/api/projects/${projectId}/replays`).expect(200);
    expect(all.body.kind).toBe('all');
    const contRow = all.body.replays.find((r: any) => r.id === cont.replayId);
    const errRow = all.body.replays.find((r: any) => r.id === err.replayId);
    expect(contRow.captureKind).toBe('continuous');
    expect(errRow.captureKind).toBe('on-error');
    expect(typeof contRow.live).toBe('boolean');
    expect(typeof contRow.updatedAt).toBe('string');
    // A finalized (ticket-linked) capture is never "live".
    expect(contRow.live).toBe(false);
    expect(errRow.live).toBe(false);

    // kind=continuous keeps only the continuous capture.
    const continuous = await request
      .get(`/api/projects/${projectId}/replays?kind=continuous`)
      .expect(200);
    expect(continuous.body.kind).toBe('continuous');
    expect(continuous.body.replays.map((r: any) => r.id)).toContain(cont.replayId);
    expect(continuous.body.replays.map((r: any) => r.id)).not.toContain(err.replayId);

    // kind=on-error keeps only the on-error capture.
    const onError = await request
      .get(`/api/projects/${projectId}/replays?kind=on-error`)
      .expect(200);
    expect(onError.body.replays.map((r: any) => r.id)).toContain(err.replayId);
    expect(onError.body.replays.map((r: any) => r.id)).not.toContain(cont.replayId);
  });

  it('keeps SQL kind filter and captureKind in agreement on blank/non-string trigger fallback', async () => {
    const projectId = await newProjectId();
    // Blank trigger must fall through to `reason` — classified continuous AND
    // matched by ?kind=continuous (the exact mismatch the SQL fix targets).
    const blank = await ingestOrphanReplay({ trigger: '', reason: 'interval' });
    // Non-string trigger must be skipped, falling through to `reason`.
    const numeric = await ingestOrphanReplay({ trigger: 5, reason: 'continuous' });

    const cont = await request
      .get(`/api/projects/${projectId}/replays?filter=orphans&kind=continuous`)
      .expect(200);
    const ids = cont.body.replays.map((r: any) => r.id);
    expect(ids).toContain(blank.replayId);
    expect(ids).toContain(numeric.replayId);
    for (const r of cont.body.replays) {
      if (r.id === blank.replayId || r.id === numeric.replayId) {
        expect(r.captureKind).toBe('continuous');
      }
    }

    // …and they must NOT leak into the on-error view.
    const onError = await request
      .get(`/api/projects/${projectId}/replays?filter=orphans&kind=on-error`)
      .expect(200);
    const errIds = onError.body.replays.map((r: any) => r.id);
    expect(errIds).not.toContain(blank.replayId);
    expect(errIds).not.toContain(numeric.replayId);
  });

  it('reports a fresh, unlinked continuous capture as live', async () => {
    const projectId = await newProjectId();
    // Stamp the project via a RUM-less link is not possible without finalizing,
    // so assert liveness on the orphan (unfinalized) continuous capture instead.
    const { replayId } = await ingestOrphanReplay({ trigger: 'interval' });
    const orphans = await request
      .get(`/api/projects/${projectId}/replays?filter=orphans&kind=continuous`)
      .expect(200);
    const row = orphans.body.replays.find((r: any) => r.id === replayId);
    expect(row).toBeTruthy();
    expect(row.captureKind).toBe('continuous');
    expect(row.live).toBe(true);
  });

  it('surfaces an orphan, links it to a ticket, then unlinks it', async () => {
    const projectId = await newProjectId();
    const { replayId, replayRef } = await ingestOrphanReplay({
      trigger: 'manual',
      url: 'https://app.example/orders',
    });

    // Orphan filter (privileged apiKey caller) includes the fresh capture, and
    // it is NOT yet in the project-scoped `all` list.
    const orphans = await request
      .get(`/api/projects/${projectId}/replays?filter=orphans`)
      .expect(200);
    expect(orphans.body.canViewOrphans).toBe(true);
    const orphan = orphans.body.replays.find((r: { id: string }) => r.id === replayId);
    expect(orphan).toBeTruthy();
    expect(orphan.orphaned).toBe(true);
    expect(orphan.pageUrl).toBe('https://app.example/orders');
    expect(orphan.replayRef).toBe(replayRef);

    const allBefore = await request.get(`/api/projects/${projectId}/replays`).expect(200);
    expect(allBefore.body.replays.find((r: { id: string }) => r.id === replayId)).toBeUndefined();

    // Link to a ticket — claims the orphan into this project.
    const ticketId = await createTicket(projectId);
    const linked = await request
      .post(`/api/projects/${projectId}/replays/${replayId}/link`)
      .send({ supportTicketId: ticketId })
      .expect(200);
    expect(linked.body.replay.projectId).toBe(projectId);
    expect(linked.body.replay.ticket).toMatchObject({ id: ticketId, subject: 'Broken' });
    expect(linked.body.ticket.replay_ref).toBe(replayRef);

    // Now it shows up in `all` and `linked`, but not `unlinked`.
    const all = await request.get(`/api/projects/${projectId}/replays?filter=all`).expect(200);
    expect(all.body.replays.find((r: { id: string }) => r.id === replayId)).toBeTruthy();
    const linkedList = await request
      .get(`/api/projects/${projectId}/replays?filter=linked`)
      .expect(200);
    expect(linkedList.body.replays.find((r: { id: string }) => r.id === replayId)).toBeTruthy();
    const unlinkedList = await request
      .get(`/api/projects/${projectId}/replays?filter=unlinked`)
      .expect(200);
    expect(
      unlinkedList.body.replays.find((r: { id: string }) => r.id === replayId),
    ).toBeUndefined();

    // Unlink — detaches the ticket but keeps the project attribution.
    const unlinked = await request
      .delete(`/api/projects/${projectId}/replays/${replayId}/link`)
      .expect(200);
    expect(unlinked.body.replay.ticket).toBeNull();
    expect(unlinked.body.replay.projectId).toBe(projectId);

    const ticketAfter = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(ticketAfter.body.replay_ref).toBeNull();
  });

  it('rejects a link with a missing supportTicketId or unknown ticket', async () => {
    const projectId = await newProjectId();
    const { replayId } = await ingestOrphanReplay();
    await request.post(`/api/projects/${projectId}/replays/${replayId}/link`).send({}).expect(400);
    await request
      .post(`/api/projects/${projectId}/replays/${replayId}/link`)
      .send({ supportTicketId: 'nope' })
      .expect(404);
  });

  it('404s when linking an unknown replay id', async () => {
    const projectId = await newProjectId();
    const ticketId = await createTicket(projectId);
    await request
      .post(`/api/projects/${projectId}/replays/does-not-exist/link`)
      .send({ supportTicketId: ticketId })
      .expect(404);
  });

  it('409s when re-linking a replay already attached to a different ticket, and stays idempotent for the same ticket', async () => {
    const projectId = await newProjectId();
    const { replayId, replayRef } = await ingestOrphanReplay();
    const ticketA = await createTicket(projectId);
    const ticketB = await createTicket(projectId);

    // Link to ticket A.
    await request
      .post(`/api/projects/${projectId}/replays/${replayId}/link`)
      .send({ supportTicketId: ticketA })
      .expect(200);

    // Re-linking to a DIFFERENT ticket is rejected, and must not stamp ticket
    // B's replay_ref (no split inverse pointer).
    await request
      .post(`/api/projects/${projectId}/replays/${replayId}/link`)
      .send({ supportTicketId: ticketB })
      .expect(409);
    const bAfter = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketB}`)
      .expect(200);
    expect(bAfter.body.replay_ref).toBeNull();

    // Ticket A still owns the replay.
    const aAfter = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketA}`)
      .expect(200);
    expect(aAfter.body.replay_ref).toBe(replayRef);

    // Re-linking to the SAME ticket is idempotent (200, ref intact).
    const again = await request
      .post(`/api/projects/${projectId}/replays/${replayId}/link`)
      .send({ supportTicketId: ticketA })
      .expect(200);
    expect(again.body.ticket.replay_ref).toBe(replayRef);
  });

  it('409s when the target ticket is already linked to a different replay', async () => {
    const projectId = await newProjectId();
    const ticketId = await createTicket(projectId);
    const a = await ingestOrphanReplay();
    const b = await ingestOrphanReplay();

    // Ticket links replay A.
    await request
      .post(`/api/projects/${projectId}/replays/${a.replayId}/link`)
      .send({ supportTicketId: ticketId })
      .expect(200);

    // Attaching replay B to the same (already-occupied) ticket is rejected, so
    // the ticket keeps pointing at A and B is never claimed.
    await request
      .post(`/api/projects/${projectId}/replays/${b.replayId}/link`)
      .send({ supportTicketId: ticketId })
      .expect(409);

    const ticketAfter = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(ticketAfter.body.replay_ref).toBe(a.replayRef);

    // B stayed orphaned (never claimed into the project / ticket).
    const orphans = await request
      .get(`/api/projects/${projectId}/replays?filter=orphans`)
      .expect(200);
    const bRow = orphans.body.replays.find((r: { id: string }) => r.id === b.replayId);
    expect(bRow).toBeTruthy();
    expect(bRow.ticket).toBeNull();
  });

  it('unlink only clears the ticket ref when it still points at this replay', async () => {
    const projectId = await newProjectId();
    const ticketId = await createTicket(projectId);
    const a = await ingestOrphanReplay();
    const b = await ingestOrphanReplay();

    // Link replay A to the ticket via the dashboard.
    await request
      .post(`/api/projects/${projectId}/replays/${a.replayId}/link`)
      .send({ supportTicketId: ticketId })
      .expect(200);

    // Re-point the SAME ticket at replay B through the support-ticket PATCH path
    // (simulates a concurrent ticket-first/link flow). A's support_ticket_id is
    // now stale while the ticket's ref points at B.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .send({ replayRef: b.replayRef })
      .expect(200);

    // Unlinking A must NOT erase the ticket's ref — it now points at B.
    await request.delete(`/api/projects/${projectId}/replays/${a.replayId}/link`).expect(200);

    const ticketAfter = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}`)
      .expect(200);
    expect(ticketAfter.body.replay_ref).toBe(b.replayRef);
  });

  it('409s (and does not overwrite) when the ticket holds a non-empty unparseable/legacy ref', async () => {
    const projectId = await newProjectId();
    const ticketId = await createTicket(projectId);
    const { replayId } = await ingestOrphanReplay();

    // Seed a legacy / unparseable replay_ref directly (a ref that
    // parseReplayIdFromRef() can't resolve). Linking from the dashboard must NOT
    // silently overwrite it.
    const legacyRef = '/uploads/legacy-replay.bin';
    setSupportTicketReplayRef(ticketId, legacyRef);

    await request
      .post(`/api/projects/${projectId}/replays/${replayId}/link`)
      .send({ supportTicketId: ticketId })
      .expect(409);

    // The legacy ref is preserved, and the replay was never claimed.
    expect(getSupportTicket(ticketId)?.replay_ref).toBe(legacyRef);
    const orphans = await request
      .get(`/api/projects/${projectId}/replays?filter=orphans`)
      .expect(200);
    const row = orphans.body.replays.find((r: { id: string }) => r.id === replayId);
    expect(row).toBeTruthy();
    expect(row.ticket).toBeNull();
  });

  it('refuses to link a replay already owned by another project (409)', async () => {
    const projectA = await newProjectId();
    const projectB = await newProjectId();
    const { replayId } = await ingestOrphanReplay();

    // Project A claims it first.
    const ticketA = await createTicket(projectA);
    await request
      .post(`/api/projects/${projectA}/replays/${replayId}/link`)
      .send({ supportTicketId: ticketA })
      .expect(200);

    // Project B can no longer see it (404 on link — masked), nor claim it.
    const ticketB = await createTicket(projectB);
    await request
      .post(`/api/projects/${projectB}/replays/${replayId}/link`)
      .send({ supportTicketId: ticketB })
      .expect(404);
  });
});
