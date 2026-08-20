import { describe, it, expect } from 'vitest';
import {
  hasPartialOrSpecPrefix,
  commentsReferenceFollowupCards,
  blocksDoneStateContractMove,
} from './kanban-done-state-contract.js';

const CARD = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', short_id: 1899 };

describe('hasPartialOrSpecPrefix', () => {
  it('detects [Partial] and [Spec] prefixes case-insensitively', () => {
    expect(hasPartialOrSpecPrefix('[Partial] replace crons')).toBe(true);
    expect(hasPartialOrSpecPrefix('[Spec] design the API')).toBe(true);
    expect(hasPartialOrSpecPrefix('[partial] lower')).toBe(true);
    expect(hasPartialOrSpecPrefix('[ Partial ] spaced')).toBe(true);
    expect(hasPartialOrSpecPrefix('   [Partial] leading ws')).toBe(true);
  });

  it('returns false for full-scope titles and null/undefined', () => {
    expect(hasPartialOrSpecPrefix('Replace crons')).toBe(false);
    expect(hasPartialOrSpecPrefix('Fix [Partial] mid-title')).toBe(false);
    expect(hasPartialOrSpecPrefix('')).toBe(false);
    expect(hasPartialOrSpecPrefix(null)).toBe(false);
    expect(hasPartialOrSpecPrefix(undefined)).toBe(false);
  });
});

describe('commentsReferenceFollowupCards', () => {
  it('finds a follow-up card UUID in a comment', () => {
    expect(
      commentsReferenceFollowupCards({
        card: CARD,
        comments: [{ content: 'Follow-up: 11111111-2222-3333-4444-555555555555' }],
      }),
    ).toBe(true);
  });

  it('finds a follow-up #short-id in a comment', () => {
    expect(
      commentsReferenceFollowupCards({
        card: CARD,
        comments: [{ content: 'Split out into #2001 and #2002' }],
      }),
    ).toBe(true);
  });

  it('ignores self-references (own UUID / own #short-id)', () => {
    expect(
      commentsReferenceFollowupCards({
        card: CARD,
        comments: [{ content: `This card ${CARD.id} (#${CARD.short_id}) is partial` }],
      }),
    ).toBe(false);
  });

  it('returns false when comments only contain prose, no IDs', () => {
    expect(
      commentsReferenceFollowupCards({
        card: CARD,
        comments: [{ content: 'Tracked as a follow-up; crons still coexist.' }],
      }),
    ).toBe(false);
  });

  it('returns false for no comments', () => {
    expect(commentsReferenceFollowupCards({ card: CARD, comments: [] })).toBe(false);
  });
});

describe('blocksDoneStateContractMove', () => {
  const partialCard = { ...CARD, title: '[Partial] replace crons' };
  const fullCard = { ...CARD, title: 'Replace crons' };
  const noFollowup = [{ content: 'crons still coexist' }];
  const withFollowup = [{ content: 'Follow-ups: #2001, #2002' }];

  it('blocks a [Partial] card entering Done with no follow-up IDs', () => {
    expect(
      blocksDoneStateContractMove({
        card: partialCard,
        comments: noFollowup,
        targetColumnName: 'Done',
      }),
    ).toBe(true);
  });

  it('allows a [Partial] card into Done when follow-up IDs are present', () => {
    expect(
      blocksDoneStateContractMove({
        card: partialCard,
        comments: withFollowup,
        targetColumnName: 'Done',
      }),
    ).toBe(false);
  });

  it('allows a full-scope (unprefixed) card into Done with no comments', () => {
    expect(
      blocksDoneStateContractMove({
        card: fullCard,
        comments: [],
        targetColumnName: 'Done',
      }),
    ).toBe(false);
  });

  it('does not fire on non-Done target columns', () => {
    expect(
      blocksDoneStateContractMove({
        card: partialCard,
        comments: noFollowup,
        targetColumnName: 'In Progress',
      }),
    ).toBe(false);
  });

  it('matches Done-ish column names (e.g. "Deployed / Done")', () => {
    expect(
      blocksDoneStateContractMove({
        card: partialCard,
        comments: noFollowup,
        targetColumnName: 'Deployed / Done',
      }),
    ).toBe(true);
  });

  it('force: true bypasses the guard', () => {
    expect(
      blocksDoneStateContractMove({
        card: partialCard,
        comments: noFollowup,
        targetColumnName: 'Done',
        force: true,
      }),
    ).toBe(false);
  });
});
