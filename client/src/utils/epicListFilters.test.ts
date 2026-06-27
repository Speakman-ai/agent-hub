import { describe, it, expect } from 'vitest';
import {
  applyEpicListFilters,
  createDefaultEpicListFilters,
  sortEpicsWithEmptyLast,
} from './epicListFilters';

const epics = [
  { id: 'e-empty', name: 'Alpha empty', labels: 'alpha' },
  { id: 'e-full', name: 'Beta full', labels: 'platform, q1' },
  { id: 'e-other', name: 'Gamma other', labels: 'platform' },
];

const cards = [
  { id: 'c1', epic_id: 'e-full' },
  { id: 'c2', epic_id: 'e-other' },
];

describe('epicListFilters', () => {
  it('sorts epics with empty ticket counts last', () => {
    const sorted = sortEpicsWithEmptyLast(epics as any, cards);
    expect(sorted.map((e) => e.id)).toEqual(['e-full', 'e-other', 'e-empty']);
  });

  it('filters by scope and search', () => {
    const filtered = applyEpicListFilters(
      epics as any,
      { ...createDefaultEpicListFilters(), scope: 'empty', search: 'alpha' },
      cards,
    );
    expect(filtered.map((e) => e.id)).toEqual(['e-empty']);
  });

  it('filters by selected labels with OR semantics', () => {
    const filters = createDefaultEpicListFilters();
    filters.selectedLabels = new Set(['platform']);
    const filtered = applyEpicListFilters(epics as any, filters, cards);
    expect(filtered.map((e) => e.id)).toEqual(['e-full', 'e-other']);
  });

  it('filters by selected lead users with OR semantics', () => {
    const epicsWithUsers = [
      { id: 'e1', name: 'Ryan epic', assigned_user_id: 'u1', labels: '' },
      { id: 'e2', name: 'Alex epic', assigned_user_id: 'u2', labels: '' },
    ];
    const filters = createDefaultEpicListFilters();
    filters.selectedUserIds = new Set(['u1']);
    const filtered = applyEpicListFilters(epicsWithUsers as any, filters, []);
    expect(filtered.map((e) => e.id)).toEqual(['e1']);
  });
});
