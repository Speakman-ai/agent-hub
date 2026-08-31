import { describe, it, expect, beforeEach } from 'vitest';

import {
  addSupportTicketComment,
  countSupportTicketComments,
  getSupportTicketVote,
  getSupportTicketVoteAggregate,
  hideSupportTicketComment,
  listSupportTicketComments,
  retractSupportTicketVote,
  SUPPORT_TICKET_COMMENT_MAX_LEN,
  upsertSupportTicketVote,
} from './support-ticket-voting-store.js';
import { createSupportTicket, deleteSupportTicket } from './support-tickets-store.js';
import { getDb } from './db.js';
import { wipeTables } from './test/destructive-db.js';

beforeEach(() => {
  wipeTables(getDb(), ['support_ticket_votes', 'support_ticket_comments', 'support_tickets']);
});

function ticket(body = 'please add dark mode') {
  return createSupportTicket({
    projectId: 'p1',
    type: 'feature_request',
    body,
  });
}

describe('support_ticket_votes UNIQUE', () => {
  it('rejects a second raw INSERT for the same (ticket, voter_key)', () => {
    const t = ticket();
    const insert = getDb().prepare(
      `INSERT INTO support_ticket_votes (id, support_ticket_id, voter_key, value)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run('v1', t.id, 'voter-a', 1);
    expect(() => insert.run('v2', t.id, 'voter-a', -1)).toThrow(/UNIQUE constraint failed/i);
    const rows = getDb()
      .prepare('SELECT id, value FROM support_ticket_votes WHERE support_ticket_id = ?')
      .all(t.id) as { id: string; value: number }[];
    expect(rows).toEqual([{ id: 'v1', value: 1 }]);
  });

  it('allows the same voter_key on a different ticket', () => {
    const a = ticket('a');
    const b = ticket('b');
    upsertSupportTicketVote({ supportTicketId: a.id, voterKey: 'voter-a', value: 1 });
    upsertSupportTicketVote({ supportTicketId: b.id, voterKey: 'voter-a', value: -1 });
    expect(getSupportTicketVote(a.id, 'voter-a')?.value).toBe(1);
    expect(getSupportTicketVote(b.id, 'voter-a')?.value).toBe(-1);
  });
});

describe('upsert / retract', () => {
  it('inserts a vote then flips value in place', () => {
    const t = ticket();
    const first = upsertSupportTicketVote({
      supportTicketId: t.id,
      voterKey: ' voter-a ',
      value: 1,
    });
    expect(first.value).toBe(1);
    expect(first.voter_key).toBe('voter-a');

    const flipped = upsertSupportTicketVote({
      supportTicketId: t.id,
      voterKey: 'voter-a',
      value: -1,
    });
    expect(flipped.id).toBe(first.id);
    expect(flipped.value).toBe(-1);
    expect(flipped.updated_at >= first.updated_at).toBe(true);

    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM support_ticket_votes WHERE support_ticket_id = ?')
      .get(t.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it('retract deletes the row and is a no-op the second time', () => {
    const t = ticket();
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'voter-a', value: 1 });
    expect(retractSupportTicketVote(t.id, 'voter-a')).toBe(true);
    expect(getSupportTicketVote(t.id, 'voter-a')).toBeNull();
    expect(retractSupportTicketVote(t.id, 'voter-a')).toBe(false);
  });

  it('rejects a missing ticket, empty voter_key, or invalid value', () => {
    expect(() =>
      upsertSupportTicketVote({ supportTicketId: 'missing', voterKey: 'v', value: 1 }),
    ).toThrow(/support ticket not found/);
    const t = ticket();
    expect(() =>
      upsertSupportTicketVote({ supportTicketId: t.id, voterKey: '  ', value: 1 }),
    ).toThrow(/voter_key is required/);
    expect(() =>
      upsertSupportTicketVote({
        supportTicketId: t.id,
        voterKey: 'v',
        value: 0 as unknown as 1,
      }),
    ).toThrow(/value must be 1 or -1/);
  });
});

describe('vote aggregate', () => {
  it('returns zeros when nobody has voted', () => {
    const t = ticket();
    expect(getSupportTicketVoteAggregate(t.id, 'voter-a')).toEqual({
      score: 0,
      upvotes: 0,
      downvotes: 0,
      myVote: null,
    });
  });

  it('computes score as SUM(value) with up/down counts and myVote', () => {
    const t = ticket();
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'a', value: 1 });
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'b', value: 1 });
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'c', value: -1 });

    expect(getSupportTicketVoteAggregate(t.id, 'a')).toEqual({
      score: 1,
      upvotes: 2,
      downvotes: 1,
      myVote: 1,
    });
    expect(getSupportTicketVoteAggregate(t.id, 'c')).toEqual({
      score: 1,
      upvotes: 2,
      downvotes: 1,
      myVote: -1,
    });
    expect(getSupportTicketVoteAggregate(t.id, 'nobody')).toEqual({
      score: 1,
      upvotes: 2,
      downvotes: 1,
      myVote: null,
    });
    expect(getSupportTicketVoteAggregate(t.id)).toEqual({
      score: 1,
      upvotes: 2,
      downvotes: 1,
      myVote: null,
    });
  });

  it('updates the aggregate after a flip and a retract', () => {
    const t = ticket();
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'a', value: 1 });
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'b', value: 1 });
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'a', value: -1 });
    expect(getSupportTicketVoteAggregate(t.id, 'a')).toEqual({
      score: 0,
      upvotes: 1,
      downvotes: 1,
      myVote: -1,
    });
    retractSupportTicketVote(t.id, 'a');
    expect(getSupportTicketVoteAggregate(t.id, 'a')).toEqual({
      score: 1,
      upvotes: 1,
      downvotes: 0,
      myVote: null,
    });
  });
});

describe('support_ticket_comments', () => {
  it('adds, lists, and counts non-hidden comments', () => {
    const t = ticket();
    const first = addSupportTicketComment({
      supportTicketId: t.id,
      body: '  ship it  ',
      displayName: 'Ada',
      source: 'hub',
    });
    addSupportTicketComment({
      supportTicketId: t.id,
      body: 'from st',
      source: 'external',
    });
    expect(first.body).toBe('ship it');
    expect(first.display_name).toBe('Ada');
    expect(first.hidden_at).toBeNull();
    expect(countSupportTicketComments(t.id)).toBe(2);
    expect(listSupportTicketComments(t.id).map((c) => c.body)).toEqual(['ship it', 'from st']);
  });

  it('hides a comment so list and count skip it', () => {
    const t = ticket();
    const keep = addSupportTicketComment({
      supportTicketId: t.id,
      body: 'visible',
      source: 'hub',
    });
    const hide = addSupportTicketComment({
      supportTicketId: t.id,
      body: 'spam',
      source: 'external',
    });
    const hidden = hideSupportTicketComment(hide.id);
    expect(hidden?.hidden_at).toBeTruthy();
    expect(hideSupportTicketComment(hide.id)).toBeNull();
    expect(listSupportTicketComments(t.id).map((c) => c.id)).toEqual([keep.id]);
    expect(listSupportTicketComments(t.id, { includeHidden: true }).map((c) => c.id)).toEqual([
      keep.id,
      hide.id,
    ]);
    expect(countSupportTicketComments(t.id)).toBe(1);
  });

  it('rejects empty or overlong bodies and unknown sources', () => {
    const t = ticket();
    expect(() =>
      addSupportTicketComment({ supportTicketId: t.id, body: '  ', source: 'hub' }),
    ).toThrow(/body is required/);
    expect(() =>
      addSupportTicketComment({
        supportTicketId: t.id,
        body: 'x'.repeat(SUPPORT_TICKET_COMMENT_MAX_LEN + 1),
        source: 'hub',
      }),
    ).toThrow(/4000/);
    expect(() =>
      addSupportTicketComment({
        supportTicketId: t.id,
        body: 'ok',
        source: 'anon' as 'hub',
      }),
    ).toThrow(/source must be one of/);
  });
});

describe('cascade delete', () => {
  it('removes votes and comments when the ticket is hard-deleted', () => {
    const t = ticket();
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'a', value: 1 });
    addSupportTicketComment({ supportTicketId: t.id, body: 'note', source: 'hub' });

    expect(deleteSupportTicket(t.id)).toBe(true);

    const votes = getDb()
      .prepare('SELECT COUNT(*) AS n FROM support_ticket_votes WHERE support_ticket_id = ?')
      .get(t.id) as { n: number };
    const comments = getDb()
      .prepare('SELECT COUNT(*) AS n FROM support_ticket_comments WHERE support_ticket_id = ?')
      .get(t.id) as { n: number };
    expect(votes.n).toBe(0);
    expect(comments.n).toBe(0);
  });

  it('cascades when deleting every ticket in a project', () => {
    const t = ticket();
    upsertSupportTicketVote({ supportTicketId: t.id, voterKey: 'a', value: -1 });
    addSupportTicketComment({ supportTicketId: t.id, body: 'note', source: 'external' });
    getDb().prepare('DELETE FROM support_tickets WHERE project_id = ?').run('p1');
    const leftover = getDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM support_ticket_votes) AS votes,
           (SELECT COUNT(*) FROM support_ticket_comments) AS comments`,
      )
      .get() as { votes: number; comments: number };
    expect(leftover).toEqual({ votes: 0, comments: 0 });
  });
});
