import { describe, it, expect, vi } from 'vitest';

// The intake module transitively imports the investigation trigger; stub it so
// nothing in this file can shell out to a CLI engine.
vi.mock('./support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: vi.fn(),
}));

import { getStmts } from './db.js';
import { createSupportTicket, getSupportTicket } from './support-tickets-store.js';
import { setGuardedReplayRef } from './support-ticket-intake.js';

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
