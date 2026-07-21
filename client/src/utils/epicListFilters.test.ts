import { describe, it, expect } from 'vitest';
import {
  applyEpicListFilters,
  createDefaultEpicListFilters,
  sortEpicsWithEmptyLast,
} from './epicListFilters';

const epics = [
  { id: 'e-empty', name: 'Alpha empty', labels: 'alpha', state: null },
  { id: 'e-full', name: 'Beta full', labels: 'platform, q1', state: 'done' },
  { id: 'e-other', name: 'Gamma other', labels: 'platform', state: 'in_progress' },
  { id: 'e-todo', name: 'Delta todo', labels: 'alpha', state: 'not_started' },
];

const cards = [
  { id: 'c1', epic_id: 'e-full' },
  { id: 'c2', epic_id: 'e-other' },
  { id: 'c3', epic_id: 'e-todo' },
];

describe('epicListFilters', () => {
  it('defaults the epic list to in-progress work', () => {
    const filters = createDefaultEpicListFilters();
    expect(filters.state).toBe('in_progress');
  });

  it('sorts epics with empty ticket counts last', () => {
    const sorted = sortEpicsWithEmptyLast(epics as any, cards);
    expect(sorted.map((e) => e.id)).toEqual(['e-full', 'e-todo', 'e-other', 'e-empty']);
  });

  it('treats an epic with only cancelled cards as empty when columns are supplied', () => {
    const boardColumns = [
      { id: 'col-todo', name: 'To Do' },
      { id: 'col-cancel', name: 'Canceled' },
    ];
    const epicsCanc = [
      { id: 'e-live', name: 'Live', labels: '', state: 'not_started' },
      { id: 'e-cancelled', name: 'All cancelled', labels: '', state: 'in_progress' },
    ];
    const cardsCanc = [
      { id: 'k1', epic_id: 'e-live', column_id: 'col-todo' },
      { id: 'k2', epic_id: 'e-cancelled', column_id: 'col-cancel' },
    ];
    const filters = createDefaultEpicListFilters();
    filters.scope = 'with-tickets';
    filters.state = 'all';
    const filtered = applyEpicListFilters(epicsCanc as any, filters, cardsCanc, boardColumns);
    expect(filtered.map((e) => e.id)).toEqual(['e-live']);
  });

  it('filters by scope and search', () => {
    const filtered = applyEpicListFilters(
      epics as any,
      { ...createDefaultEpicListFilters(), scope: 'empty', search: 'alpha', state: 'all' },
      cards,
    );
    expect(filtered.map((e) => e.id)).toEqual(['e-empty']);
  });

  it('filters by selected labels with OR semantics', () => {
    const filters = createDefaultEpicListFilters();
    filters.state = 'all';
    filters.selectedLabels = new Set(['platform']);
    const filtered = applyEpicListFilters(epics as any, filters, cards);
    expect(filtered.map((e) => e.id)).toEqual(['e-full', 'e-other']);
  });

  it('filters by lifecycle state', () => {
    const filters = createDefaultEpicListFilters();
    filters.state = 'in_progress';
    const filtered = applyEpicListFilters(epics as any, filters, cards);
    expect(filtered.map((e) => e.id)).toEqual(['e-other']);
  });

  it('does not classify empty epics as not started', () => {
    const filters = createDefaultEpicListFilters();
    filters.state = 'not_started';
    const filtered = applyEpicListFilters(epics as any, filters, cards);
    expect(filtered.map((e) => e.id)).toEqual(['e-todo']);
  });

  it('filters by selected lead users with OR semantics', () => {
    const epicsWithUsers = [
      { id: 'e1', name: 'Ryan epic', assigned_user_id: 'u1', labels: '', state: 'in_progress' },
      { id: 'e2', name: 'Alex epic', assigned_user_id: 'u2', labels: '', state: 'in_progress' },
    ];
    const filters = createDefaultEpicListFilters();
    filters.selectedUserIds = new Set(['u1']);
    const filtered = applyEpicListFilters(epicsWithUsers as any, filters, []);
    expect(filtered.map((e) => e.id)).toEqual(['e1']);
  });
});
