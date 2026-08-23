import { describe, it, expect, vi } from 'vitest';

// The intake module transitively imports the investigation trigger; stub it so
// nothing in this file can shell out to a CLI engine.
vi.mock('./support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: vi.fn(),
}));

import { getStmts } from './db.js';
import { createSupportTicket, getSupportTicket } from './support-tickets-store.js';
import { setGuardedReplayRef, intakeSupportTicket } from './support-ticket-intake.js';
import config from './config.js';
import { triggerSupportTicketInvestigation } from './support-ticket-investigation.js';

function seedReplay(id: string, projectId: string | null): void {
  getStmts().insertSessionReplay.run(
    id,
    projectId,
    0,
    0,
    0,
    0,
    'local',
    `replays/${id}.bin`,
    null,
    null,
    null,
    null,
    null,
  );
}

describe('setGuardedReplayRef', () => {
  const stmts = getStmts();

  it('keeps a ref that attributes to the ticket project', async () => {
    const ticket = createSupportTicket({ projectId: 'gref-keep', body: 'x' });
    const id = `gref-keep-${Date.now()}`;
    seedReplay(id, null); // unattributed → claimable by this project
    const ref = `/uploads/replay-${id}.json`;

    const updated = await setGuardedReplayRef(stmts, ticket.id, 'gref-keep', ref);
    expect(updated!.replay_ref).toBe(ref);
    expect(getSupportTicket(ticket.id)!.replay_ref).toBe(ref);
  });

  it('clears a ref owned by another project', async () => {
    const ticket = createSupportTicket({ projectId: 'gref-a', body: 'x' });
    const id = `gref-foreign-${Date.now()}`;
    seedReplay(id, 'gref-other'); // owned elsewhere → not claimable
    const ref = `/uploads/replay-${id}.json`;

    const updated = await setGuardedReplayRef(stmts, ticket.id, 'gref-a', ref);
    expect(updated!.replay_ref).toBeNull();
  });

  it('clears a ref with no matching capture', async () => {
    const ticket = createSupportTicket({ projectId: 'gref-b', body: 'x' });

    const updated = await setGuardedReplayRef(
      stmts,
      ticket.id,
      'gref-b',
      '/uploads/replay-missing.json',
    );
    expect(updated!.replay_ref).toBeNull();
  });

  it('clears when passed an explicit null (no guard call needed)', async () => {
    const ticket = createSupportTicket({ projectId: 'gref-c', body: 'x', replayRef: null });

    const updated = await setGuardedReplayRef(stmts, ticket.id, 'gref-c', null);
    expect(updated!.replay_ref).toBeNull();
  });

  it('returns null for a missing ticket', async () => {
    const updated = await setGuardedReplayRef(stmts, 'no-such-ticket', 'gref-c', null);
    expect(updated).toBeNull();
  });
});

describe('intakeSupportTicket — created broadcast payload', () => {
  const stmts = getStmts();

  it('passes the main dev agent and authenticated owner to bug investigation', async () => {
    const broadcast = vi.fn();
    const trigger = vi.mocked(triggerSupportTicketInvestigation);
    trigger.mockClear();
    const ticket = await intakeSupportTicket(
      { projectId: `intake-agent-${Date.now()}`, type: 'bug', severity: 'high', body: 'broken' },
      {
        stmts,
        broadcast,
        config,
        uploadsDir: 'uploads',
        cwd: '/tmp/project',
        agent: { id: 'project-dev', engine: 'codex-cli', model: 'gpt-5.5' },
        userId: 'support-user',
      },
    );

    expect(trigger).toHaveBeenCalledWith(
      ticket.id,
      expect.objectContaining({
        agentId: 'project-dev',
        agentEngine: 'codex-cli',
        agentModel: 'gpt-5.5',
        userId: 'support-user',
      }),
    );
  });

  // Regression: the sidebar/drawer unread badge only updates on a
  // support_ticket_* event that carries `projectId` + numeric `unreadCount`.
  // The authenticated create path (and the public bug-report path) both land
  // tickets through intakeSupportTicket, so the created broadcast MUST carry
  // both fields — otherwise badges go stale until another count-bearing event.
  it('emits projectId + unreadCount on support_ticket_created', async () => {
    const broadcast = vi.fn();
    const projectId = `intake-bcast-${Date.now()}`;

    const ticket = await intakeSupportTicket(
      { projectId, type: 'question', severity: 'low', body: 'how do I export?' },
      { stmts, broadcast, config, uploadsDir: 'uploads' },
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0][0];
    expect(payload).toMatchObject({
      type: 'support_ticket_created',
      projectId,
      unreadCount: 1, // the just-created (unread) ticket
    });
    expect(payload.ticket.id).toBe(ticket.id);
    expect(typeof payload.unreadCount).toBe('number');
  });

  it('masks reporter_email in support_ticket_created broadcasts', async () => {
    const broadcast = vi.fn();
    const projectId = `intake-email-${Date.now()}`;

    const ticket = await intakeSupportTicket(
      {
        projectId,
        type: 'question',
        severity: 'low',
        body: 'please follow up',
        reporterEmail: 'alice@example.com',
      },
      { stmts, broadcast, config, uploadsDir: 'uploads' },
    );

    expect(ticket.reporter_email).toBe('alice@example.com');
    expect(broadcast.mock.calls[0][0].ticket).toMatchObject({
      reporter_email: 'al***@example.com',
      reporter_email_masked: true,
    });
  });
});
