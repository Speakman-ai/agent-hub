import { describe, it, expect, beforeEach } from 'vitest';
import {
  kanbanFilterSetsKey,
  readFilterSets,
  writeFilterSets,
  snapshotFromState,
  applySnapshot,
  isEmptySnapshot,
  filterSetsEqual,
  saveFilterSet,
  deleteFilterSet,
  findMatchingFilterSet,
} from './kanbanFilterSets';

describe('kanbanFilterSets', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists and reads filter sets per project', () => {
    writeFilterSets('p1', [
      {
        id: 'f1',
        name: 'Bugs',
        searchQuery: 'crash',
        labelSearch: 'bu',
        userSearch: 'ry',
        epicIds: ['e1'],
        labels: ['bug'],
        userIds: ['u1'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(readFilterSets('p1')).toHaveLength(1);
    expect(readFilterSets('p1')[0].labelSearch).toBe('bu');
    expect(readFilterSets('p1')[0].userSearch).toBe('ry');
    expect(readFilterSets('p1')[0].userIds).toEqual(['u1']);
    expect(readFilterSets('p2')).toEqual([]);
    expect(localStorage.getItem(kanbanFilterSetsKey('p1'))).toContain('Bugs');
  });

  it('reads legacy filter sets without list searches or user ids as empty filters', () => {
    localStorage.setItem(
      kanbanFilterSetsKey('p1'),
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          searchQuery: 'crash',
          epicIds: ['e1'],
          labels: ['bug'],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );

    expect(readFilterSets('p1')[0].labelSearch).toBe('');
    expect(readFilterSets('p1')[0].userSearch).toBe('');
    expect(readFilterSets('p1')[0].userIds).toEqual([]);
  });

  it('snapshotFromState and applySnapshot round-trip sets', () => {
    const snapshot = snapshotFromState(
      'auth',
      'bug',
      'ryan',
      new Set(['e1', 'e2']),
      new Set(['bug']),
      new Set(['u1']),
    );
    const applied = applySnapshot(snapshot);
    expect(applied.searchQuery).toBe('auth');
    expect(applied.labelSearch).toBe('bug');
    expect(applied.userSearch).toBe('ryan');
    expect(applied.epicIds).toEqual(new Set(['e1', 'e2']));
    expect(applied.labels).toEqual(new Set(['bug']));
    expect(applied.userIds).toEqual(new Set(['u1']));
  });

  it('isEmptySnapshot detects an empty filter', () => {
    expect(isEmptySnapshot({ searchQuery: '', epicIds: [], labels: [], userIds: [] })).toBe(true);
    expect(isEmptySnapshot({ searchQuery: 'x', epicIds: [], labels: [], userIds: [] })).toBe(false);
    expect(
      isEmptySnapshot({
        searchQuery: '',
        labelSearch: 'bug',
        epicIds: [],
        labels: [],
        userIds: [],
      }),
    ).toBe(false);
    expect(
      isEmptySnapshot({
        searchQuery: '',
        userSearch: 'ryan',
        epicIds: [],
        labels: [],
        userIds: [],
      }),
    ).toBe(false);
    expect(isEmptySnapshot({ searchQuery: '', epicIds: [], labels: [], userIds: ['u1'] })).toBe(
      false,
    );
  });

  it('filterSetsEqual ignores epic/label/user order', () => {
    const a = {
      searchQuery: 'q',
      labelSearch: 'bug',
      userSearch: 'ryan',
      epicIds: ['e2', 'e1'],
      labels: ['b', 'a'],
      userIds: ['u2', 'u1'],
    };
    const b = {
      searchQuery: 'q',
      labelSearch: 'bug',
      userSearch: 'ryan',
      epicIds: ['e1', 'e2'],
      labels: ['a', 'b'],
      userIds: ['u1', 'u2'],
    };
    expect(filterSetsEqual(a, b)).toBe(true);
  });

  it('saveFilterSet creates and updates by name', () => {
    const first = saveFilterSet('p1', 'Platform', {
      searchQuery: '',
      epicIds: ['e1'],
      labels: [],
      userIds: [],
    });
    expect(first).toHaveLength(1);
    expect(first[0].name).toBe('Platform');

    const updated = saveFilterSet('p1', 'platform', {
      searchQuery: 'api',
      labelSearch: 'bu',
      userSearch: 'ry',
      epicIds: ['e1', 'e2'],
      labels: ['bug'],
      userIds: ['u1'],
    });
    expect(updated).toHaveLength(1);
    expect(updated[0].searchQuery).toBe('api');
    expect(updated[0].labelSearch).toBe('bu');
    expect(updated[0].userSearch).toBe('ry');
    expect(updated[0].epicIds).toEqual(['e1', 'e2']);
    expect(updated[0].userIds).toEqual(['u1']);
  });

  it('saveFilterSet rejects empty names and empty snapshots', () => {
    expect(() =>
      saveFilterSet('p1', '  ', { searchQuery: 'x', epicIds: [], labels: [], userIds: [] }),
    ).toThrow('View name is required');
    expect(() =>
      saveFilterSet('p1', 'Empty', { searchQuery: '', epicIds: [], labels: [], userIds: [] }),
    ).toThrow('Change a filter or column before saving');
  });

  it('captures and restores the collapsed-column layout in a view', () => {
    const snapshot = snapshotFromState(
      '',
      '',
      '',
      new Set(),
      new Set(),
      new Set(),
      new Set(['col-2', 'col-1']),
    );
    expect(snapshot.collapsedColumnIds).toEqual(['col-2', 'col-1']);

    const applied = applySnapshot(snapshot);
    expect(applied.collapsedColumnIds).toEqual(new Set(['col-1', 'col-2']));
  });

  it('treats a column-only view as non-empty and saves it', () => {
    const columnOnly = snapshotFromState(
      '',
      '',
      '',
      new Set(),
      new Set(),
      new Set(),
      new Set(['col-1']),
    );
    expect(isEmptySnapshot(columnOnly)).toBe(false);

    const saved = saveFilterSet('p1', 'Hide done', columnOnly);
    expect(saved).toHaveLength(1);
    expect(saved[0].collapsedColumnIds).toEqual(['col-1']);
    // Survives a persistence round-trip.
    expect(readFilterSets('p1')[0].collapsedColumnIds).toEqual(['col-1']);
  });

  it('isEmptySnapshot is true when no filters and no collapsed columns', () => {
    expect(
      isEmptySnapshot({
        searchQuery: '',
        epicIds: [],
        labels: [],
        userIds: [],
        collapsedColumnIds: [],
      }),
    ).toBe(true);
  });

  it('filterSetsEqual distinguishes different collapsed-column layouts', () => {
    const base = {
      searchQuery: 'q',
      epicIds: [],
      labels: [],
      userIds: [],
      collapsedColumnIds: ['c1', 'c2'],
    };
    const sameOrderless = { ...base, collapsedColumnIds: ['c2', 'c1'] };
    const different = { ...base, collapsedColumnIds: ['c1'] };
    expect(filterSetsEqual(base, sameOrderless)).toBe(true);
    expect(filterSetsEqual(base, different)).toBe(false);
  });

  it('reads legacy views without collapsedColumnIds as an empty layout', () => {
    localStorage.setItem(
      kanbanFilterSetsKey('p1'),
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          searchQuery: 'crash',
          epicIds: ['e1'],
          labels: ['bug'],
          userIds: ['u1'],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
    expect(readFilterSets('p1')[0].collapsedColumnIds).toEqual([]);
  });

  it('deleteFilterSet removes one set', () => {
    saveFilterSet('p1', 'One', { searchQuery: 'a', epicIds: [], labels: [], userIds: [] });
    const created = readFilterSets('p1');
    const next = deleteFilterSet('p1', created[0].id);
    expect(next).toEqual([]);
  });

  it('findMatchingFilterSet returns the active saved set', () => {
    const sets = saveFilterSet('p1', 'Match', {
      searchQuery: 'login',
      labelSearch: 'bu',
      userSearch: 'ry',
      epicIds: ['e1'],
      labels: ['bug'],
      userIds: ['u1'],
    });
    const snapshot = snapshotFromState(
      'login',
      'bu',
      'ry',
      new Set(['e1']),
      new Set(['bug']),
      new Set(['u1']),
    );
    expect(findMatchingFilterSet(sets, snapshot)?.name).toBe('Match');
  });
});
