import { describe, it, expect } from 'vitest';
import {
  formatHeadlineTiles,
  priorityRows,
  columnRows,
  activityLabel,
  filterActivity,
  countByType,
  ACTIVITY_TYPE_KEYS,
  HEADLINE_TILES,
  PRIORITY_KEYS,
} from './dashboard.js';

describe('formatHeadlineTiles', () => {
  it('returns one tile per canonical key in display order', () => {
    const tiles = formatHeadlineTiles({
      projects: 4,
      agents: 9,
      sessions: 123,
      activeSessions: 2,
      openCards: 17,
      openPRs: 3,
      escalations: 1,
    });
    expect(tiles).toHaveLength(HEADLINE_TILES.length);
    expect(tiles.map((t) => t.key)).toEqual(HEADLINE_TILES.map((t) => t.key));
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t.value]));
    expect(byKey.projects).toBe(4);
    expect(byKey.openPRs).toBe(3);
    expect(byKey.escalations).toBe(1);
  });

  it('defaults missing keys to 0', () => {
    const tiles = formatHeadlineTiles({});
    for (const t of tiles) expect(t.value).toBe(0);
  });

  it('coerces string counts to numbers', () => {
    const tiles = formatHeadlineTiles({ projects: '7' });
    expect(tiles.find((t) => t.key === 'projects').value).toBe(7);
  });

  it('handles a missing payload entirely', () => {
    expect(formatHeadlineTiles()).toHaveLength(HEADLINE_TILES.length);
  });
});

describe('priorityRows', () => {
  it('returns rows in fixed priority order with computed percent', () => {
    const rows = priorityRows({ urgent: 2, high: 4, medium: 8, low: 0 });
    expect(rows.map((r) => r.key)).toEqual(PRIORITY_KEYS);
    expect(rows.find((r) => r.key === 'medium').count).toBe(8);
    expect(rows.find((r) => r.key === 'medium').percent).toBe(100);
    // Urgent: 2/8 = 25%
    expect(rows.find((r) => r.key === 'urgent').percent).toBe(25);
    expect(rows.find((r) => r.key === 'low').percent).toBe(0);
  });

  it('handles all-zero buckets without divide-by-zero', () => {
    const rows = priorityRows({ urgent: 0, high: 0, medium: 0, low: 0 });
    for (const r of rows) expect(r.percent).toBe(0);
  });

  it('treats missing buckets as zero', () => {
    const rows = priorityRows({});
    expect(rows).toHaveLength(PRIORITY_KEYS.length);
    for (const r of rows) {
      expect(r.count).toBe(0);
      expect(r.percent).toBe(0);
    }
  });
});

describe('columnRows', () => {
  it('preserves server-provided ordering and computes percent of max', () => {
    const rows = columnRows([
      { columnName: 'To Do', count: 20 },
      { columnName: 'In Progress', count: 5 },
      { columnName: 'Review', count: 0 },
    ]);
    expect(rows.map((r) => r.columnName)).toEqual(['To Do', 'In Progress', 'Review']);
    expect(rows[0].percent).toBe(100);
    expect(rows[1].percent).toBe(25);
    expect(rows[2].percent).toBe(0);
  });

  it('returns an empty array for an empty input', () => {
    expect(columnRows([])).toEqual([]);
  });
});

describe('activityLabel', () => {
  it('maps known event types to friendly labels', () => {
    expect(activityLabel('card_created')).toBe('Card created');
    expect(activityLabel('card_updated')).toBe('Card updated');
    expect(activityLabel('session_created')).toBe('Session started');
    expect(activityLabel('escalation')).toBe('Escalation');
    expect(activityLabel('pr_created')).toBe('PR opened');
  });

  it('falls back to a generic label for unknown types', () => {
    expect(activityLabel('zoltan')).toBe('Activity');
    expect(activityLabel(undefined)).toBe('Activity');
  });
});

const SAMPLE_ACTIVITY = [
  { type: 'card_created', id: 'c1' },
  { type: 'card_updated', id: 'c2' },
  { type: 'card_created', id: 'c3' },
  { type: 'session_created', id: 's1' },
  { type: 'escalation', id: 'e1' },
  { type: 'pr_created', id: 'p1' },
];

describe('filterActivity', () => {
  it('returns the full list when no filter is active', () => {
    expect(filterActivity(SAMPLE_ACTIVITY, new Set())).toEqual(SAMPLE_ACTIVITY);
    expect(filterActivity(SAMPLE_ACTIVITY, [])).toEqual(SAMPLE_ACTIVITY);
    expect(filterActivity(SAMPLE_ACTIVITY, null)).toEqual(SAMPLE_ACTIVITY);
    expect(filterActivity(SAMPLE_ACTIVITY, undefined)).toEqual(SAMPLE_ACTIVITY);
  });

  it('narrows the list when filter contains one type', () => {
    const result = filterActivity(SAMPLE_ACTIVITY, new Set(['card_created']));
    expect(result.map((i) => i.id)).toEqual(['c1', 'c3']);
  });

  it('narrows the list across multiple selected types', () => {
    const result = filterActivity(SAMPLE_ACTIVITY, ['session_created', 'escalation']);
    expect(result.map((i) => i.id)).toEqual(['s1', 'e1']);
  });

  it('returns an empty list when filter matches nothing', () => {
    const result = filterActivity(SAMPLE_ACTIVITY, new Set(['nope']));
    expect(result).toEqual([]);
  });

  it('handles invalid or missing items gracefully', () => {
    expect(filterActivity(null, new Set(['card_created']))).toEqual([]);
    expect(filterActivity(undefined, new Set(['card_created']))).toEqual([]);
    // Items without a `type` are filtered out when a narrow filter is on.
    const result = filterActivity([{ id: 'x' }, ...SAMPLE_ACTIVITY], new Set(['card_created']));
    expect(result.map((i) => i.id)).toEqual(['c1', 'c3']);
  });
});

describe('countByType', () => {
  it('returns a count map keyed by activity type', () => {
    const counts = countByType(SAMPLE_ACTIVITY);
    expect(counts).toEqual({
      card_created: 2,
      card_updated: 1,
      session_created: 1,
      escalation: 1,
      pr_created: 1,
    });
  });

  it('returns an empty object for empty or invalid input', () => {
    expect(countByType([])).toEqual({});
    expect(countByType(null)).toEqual({});
    expect(countByType(undefined)).toEqual({});
  });

  it('ignores items without a type', () => {
    expect(countByType([{ id: 'x' }, { type: 'pr_created', id: 'p' }])).toEqual({
      pr_created: 1,
    });
  });
});

describe('ACTIVITY_TYPE_KEYS', () => {
  it('lists every known type once in canonical order', () => {
    expect(ACTIVITY_TYPE_KEYS).toEqual([
      'card_created',
      'card_updated',
      'session_created',
      'escalation',
      'pr_created',
    ]);
  });
});
