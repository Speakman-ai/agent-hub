import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SIDEBAR_NAV_GROUPS_KEY,
  readNavGroupCollapsed,
  writeNavGroupCollapsed,
} from './sidebarNavGroupCollapse';

describe('sidebarNavGroupCollapse', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns an empty map when nothing is persisted (all groups default collapsed)', () => {
    expect(readNavGroupCollapsed()).toEqual({});
  });

  it('round-trips a mixed collapse map', () => {
    const state = { 'proj-a:git': false, 'proj-a:settings': true };
    writeNavGroupCollapsed(state);
    expect(readNavGroupCollapsed()).toEqual(state);
  });

  it('preserves explicit false (user-expanded) entries, not just collapsed ones', () => {
    writeNavGroupCollapsed({ 'proj-a:git': false });
    expect(readNavGroupCollapsed()).toEqual({ 'proj-a:git': false });
  });

  it('removes the storage key when the map is empty', () => {
    localStorage.setItem(SIDEBAR_NAV_GROUPS_KEY, JSON.stringify({ 'proj-a:git': true }));
    writeNavGroupCollapsed({});
    expect(localStorage.getItem(SIDEBAR_NAV_GROUPS_KEY)).toBeNull();
  });

  it('ignores malformed JSON', () => {
    localStorage.setItem(SIDEBAR_NAV_GROUPS_KEY, '{not json');
    expect(readNavGroupCollapsed()).toEqual({});
  });

  it('ignores non-object payloads (arrays / primitives)', () => {
    localStorage.setItem(SIDEBAR_NAV_GROUPS_KEY, JSON.stringify(['proj-a:git']));
    expect(readNavGroupCollapsed()).toEqual({});
  });

  it('drops non-boolean and empty-key entries', () => {
    localStorage.setItem(
      SIDEBAR_NAV_GROUPS_KEY,
      JSON.stringify({ 'proj-a:git': 'yes', '': true, 'proj-a:ai': true }),
    );
    expect(readNavGroupCollapsed()).toEqual({ 'proj-a:ai': true });
  });

  it('does not throw when storage access fails on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readNavGroupCollapsed()).toEqual({});
  });

  it('swallows storage failures on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeNavGroupCollapsed({ 'proj-a:git': true })).not.toThrow();
  });
});
