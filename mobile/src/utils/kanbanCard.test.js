import { describe, it, expect } from 'vitest';
import {
  cardShortLabel,
  assigneeInitials,
  assigneeColors,
  cardLabelList,
  priorityMeta,
  reviewMeta,
  cardMetaModel,
  cardShareUrl,
  toggleLabelCsv,
} from './kanbanCard';

describe('toggleLabelCsv', () => {
  it('adds a label when absent', () => {
    expect(toggleLabelCsv('', 'bug')).toBe('bug');
    expect(toggleLabelCsv('ui', 'bug')).toBe('ui,bug');
  });
  it('removes a label when present', () => {
    expect(toggleLabelCsv('bug,ui', 'bug')).toBe('ui');
    expect(toggleLabelCsv('bug', 'bug')).toBe('');
  });
  it('accepts array input and trims/dedupes', () => {
    expect(toggleLabelCsv([' bug ', 'ui'], 'new')).toBe('bug,ui,new');
  });
  // Regression: the action-sheet Labels submenu stays open for repeated
  // toggles. Chaining the previous result back in must accumulate, not
  // overwrite — the bug was computing each toggle from the stale original card.
  it('accumulates across chained toggles (multi-select)', () => {
    const afterBug = toggleLabelCsv('', 'bug');
    const afterUi = toggleLabelCsv(afterBug, 'ui');
    expect(afterUi).toBe('bug,ui');
    const afterRemoveBug = toggleLabelCsv(afterUi, 'bug');
    expect(afterRemoveBug).toBe('ui');
  });
});

describe('cardShareUrl', () => {
  it('builds the same deep-link format as the web card menu', () => {
    expect(cardShareUrl('https://hub.example.com', 'agent-hub', 'c1')).toBe(
      'https://hub.example.com/projects/agent-hub/board?card=c1',
    );
  });
  it('strips a trailing slash from the base url', () => {
    expect(cardShareUrl('https://hub.example.com/', 'p', 'c')).toBe(
      'https://hub.example.com/projects/p/board?card=c',
    );
  });
  it('returns null when the base url is missing/blank', () => {
    expect(cardShareUrl('', 'p', 'c')).toBeNull();
    expect(cardShareUrl(null, 'p', 'c')).toBeNull();
    expect(cardShareUrl('   ', 'p', 'c')).toBeNull();
  });
  it('returns null when project or card id is missing', () => {
    expect(cardShareUrl('https://h', '', 'c')).toBeNull();
    expect(cardShareUrl('https://h', 'p', null)).toBeNull();
  });
});

describe('cardShortLabel', () => {
  it('combines prefix and short id', () => {
    expect(cardShortLabel('AH', 123)).toBe('AH-123');
  });
  it('falls back to CARD when no prefix', () => {
    expect(cardShortLabel('', 7)).toBe('CARD-7');
    expect(cardShortLabel(null, 7)).toBe('CARD-7');
    expect(cardShortLabel('   ', 7)).toBe('CARD-7');
  });
  it('returns null when short id is missing/non-numeric', () => {
    expect(cardShortLabel('AH', null)).toBeNull();
    expect(cardShortLabel('AH', undefined)).toBeNull();
    expect(cardShortLabel('AH', 'x')).toBeNull();
  });
});

describe('assigneeInitials', () => {
  it('takes first letters of first two words', () => {
    expect(assigneeInitials('Agent Hub Dev')).toBe('AH');
  });
  it('takes first two chars of a single word', () => {
    expect(assigneeInitials('payments')).toBe('PA');
    expect(assigneeInitials('x')).toBe('X');
  });
  it('splits on underscores and dashes', () => {
    expect(assigneeInitials('foo_bar')).toBe('FB');
    expect(assigneeInitials('foo-bar')).toBe('FB');
  });
  it('returns empty string for blank input', () => {
    expect(assigneeInitials('')).toBe('');
    expect(assigneeInitials(null)).toBe('');
    expect(assigneeInitials('   ')).toBe('');
  });
});

describe('assigneeColors', () => {
  it('is deterministic for the same name', () => {
    expect(assigneeColors('Dana')).toEqual(assigneeColors('Dana'));
  });
  it('returns a {bg,text} pair', () => {
    const c = assigneeColors('Dana');
    expect(typeof c.bg).toBe('string');
    expect(typeof c.text).toBe('string');
  });
  it('returns the first palette entry for empty input', () => {
    expect(assigneeColors('')).toEqual(assigneeColors(''));
    expect(assigneeColors(null)).toEqual(assigneeColors(''));
  });
});

describe('cardLabelList', () => {
  it('splits comma strings and trims', () => {
    expect(cardLabelList('a, b ,,c')).toEqual(['a', 'b', 'c']);
  });
  it('accepts arrays', () => {
    expect(cardLabelList([' a', 'b '])).toEqual(['a', 'b']);
  });
  it('returns [] for empty', () => {
    expect(cardLabelList(null)).toEqual([]);
    expect(cardLabelList('')).toEqual([]);
  });
});

describe('priorityMeta', () => {
  it('returns label + color for each level', () => {
    expect(priorityMeta('urgent')).toMatchObject({ value: 'urgent', label: 'Urgent' });
    expect(priorityMeta('low')).toMatchObject({ value: 'low', label: 'Low' });
  });
  it('defaults unknown/empty to medium', () => {
    expect(priorityMeta(undefined).value).toBe('medium');
    expect(priorityMeta('bogus').value).toBe('medium');
  });
});

describe('reviewMeta', () => {
  it('maps known statuses', () => {
    expect(reviewMeta('approved')).toMatchObject({ label: 'Approved' });
    expect(reviewMeta('changes_requested')).toMatchObject({ label: 'Changes' });
  });
  it('returns null for unknown/empty', () => {
    expect(reviewMeta('')).toBeNull();
    expect(reviewMeta('whatever')).toBeNull();
  });
});

describe('cardMetaModel', () => {
  const board = { card_prefix: 'AH' };
  const epics = [{ id: 'e1', name: 'Billing', color: '#abc' }];

  it('normalises a full card row', () => {
    const card = {
      id: 'c1',
      short_id: 42,
      title: 'Fix it',
      priority: 'high',
      assignee: 'Agent Hub Dev',
      session_id: 'sess1',
      epic_id: 'e1',
      labels: 'bug, ui',
      pr_url: 'https://github.com/x/y/pull/313',
      review_status: 'approved',
      created_at: '2026-06-18',
      blockers: [{ done: false }, { done: true }],
    };
    const m = cardMetaModel(card, { board, epics });
    expect(m.shortLabel).toBe('AH-42');
    expect(m.priority).toMatchObject({ value: 'high', label: 'High' });
    expect(m.initials).toBe('AH');
    expect(m.active).toBe(true);
    expect(m.epic).toMatchObject({ id: 'e1', name: 'Billing' });
    expect(m.labels).toEqual(['bug', 'ui']);
    expect(m.blockerCount).toBe(1);
    expect(m.prNumber).toBe('313');
    expect(m.review).toMatchObject({ label: 'Approved' });
  });

  it('handles a sparse card', () => {
    const m = cardMetaModel({ id: 'c2', title: 'x' }, { board, epics });
    expect(m.shortLabel).toBeNull();
    expect(m.priority.value).toBe('medium');
    expect(m.assignee).toBeNull();
    expect(m.initials).toBe('');
    expect(m.active).toBe(false);
    expect(m.epic).toBeNull();
    expect(m.labels).toEqual([]);
    expect(m.blockerCount).toBe(0);
    expect(m.prNumber).toBeNull();
    expect(m.review).toBeNull();
  });

  it('marks active when a session is linked even without an assignee', () => {
    const m = cardMetaModel({ id: 'c3', session_id: 's', title: 't' }, { board, epics });
    expect(m.active).toBe(true);
  });

  it('returns null epic when the epic_id is unknown', () => {
    const m = cardMetaModel({ id: 'c4', epic_id: 'missing', title: 't' }, { board, epics });
    expect(m.epic).toBeNull();
  });

  it('uses "PR" when pr_url has no trailing number', () => {
    const m = cardMetaModel({ id: 'c5', pr_url: 'https://example.com/pr', title: 't' }, { board });
    expect(m.prNumber).toBe('PR');
  });

  it('flags orphaned when the card carries orphaned_at', () => {
    const m = cardMetaModel(
      { id: 'c6', title: 't', orphaned_at: '2026-06-19 20:00:00' },
      { board, epics },
    );
    expect(m.orphaned).toBe(true);
  });

  it('is not orphaned for a live card', () => {
    const m = cardMetaModel({ id: 'c7', title: 't', orphaned_at: null }, { board, epics });
    expect(m.orphaned).toBe(false);
  });
});
