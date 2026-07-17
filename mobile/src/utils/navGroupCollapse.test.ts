// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
// In-memory AsyncStorage mock, mirroring the auth/setupState test pattern.
// Must live above the module import below.
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    default: {
      getItem: vi.fn(async (key: any) => (store.has(key) ? store.get(key) : null)),
      setItem: vi.fn(async (key: any, value: any) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: any) => {
        store.delete(key);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
      _store: store,
    },
  };
});
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NAV_GROUPS_STORAGE_KEY,
  parseNavGroupCollapsed,
  mergeHydratedNavGroups,
  loadNavGroupCollapsed,
  saveNavGroupCollapsed,
} from './navGroupCollapse';

describe('mergeHydratedNavGroups', () => {
  it('returns the stored map when there are no local changes', () => {
    expect(mergeHydratedNavGroups({ 'p:git': true }, {})).toEqual({ 'p:git': true });
  });

  it('keeps a pre-hydration user toggle (local wins over stored)', () => {
    // User expanded git before the async load resolved; stored says collapsed.
    expect(mergeHydratedNavGroups({ 'p:git': true }, { 'p:git': false })).toEqual({
      'p:git': false,
    });
  });

  it('unions stored and local keys', () => {
    expect(mergeHydratedNavGroups({ 'p:git': true }, { 'p:ai': false })).toEqual({
      'p:git': true,
      'p:ai': false,
    });
  });

  it('does not mutate its inputs', () => {
    const stored = { 'p:git': true };
    const local = { 'p:git': false };
    mergeHydratedNavGroups(stored, local);
    expect(stored).toEqual({ 'p:git': true });
    expect(local).toEqual({ 'p:git': false });
  });
});

describe('parseNavGroupCollapsed', () => {
  it('returns empty for null / empty input (all groups default collapsed)', () => {
    expect(parseNavGroupCollapsed(null)).toEqual({});
    expect(parseNavGroupCollapsed('')).toEqual({});
  });

  it('parses a valid mixed map', () => {
    expect(parseNavGroupCollapsed('{"proj-a:git":false,"proj-a:ai":true}')).toEqual({
      'proj-a:git': false,
      'proj-a:ai': true,
    });
  });

  it('ignores malformed JSON', () => {
    expect(parseNavGroupCollapsed('{not json')).toEqual({});
  });

  it('ignores arrays and primitives', () => {
    expect(parseNavGroupCollapsed('["proj-a:git"]')).toEqual({});
    expect(parseNavGroupCollapsed('42')).toEqual({});
  });

  it('drops non-boolean and empty-key entries', () => {
    expect(parseNavGroupCollapsed('{"proj-a:git":"yes","":true,"proj-a:ai":true}')).toEqual({
      'proj-a:ai': true,
    });
  });
});

describe('loadNavGroupCollapsed / saveNavGroupCollapsed', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    vi.clearAllMocks();
  });

  it('returns empty when nothing is persisted', async () => {
    expect(await loadNavGroupCollapsed()).toEqual({});
  });

  it('round-trips a collapse map, preserving user-expanded (false) entries', async () => {
    const state = { 'proj-a:git': false, 'proj-a:settings': true };
    await saveNavGroupCollapsed(state);
    expect(await loadNavGroupCollapsed()).toEqual(state);
  });

  it('removes the key when saving an empty map', async () => {
    await saveNavGroupCollapsed({ 'proj-a:git': true });
    await saveNavGroupCollapsed({});
    expect(await AsyncStorage.getItem(NAV_GROUPS_STORAGE_KEY)).toBeNull();
  });

  it('swallows storage read failures', async () => {
    AsyncStorage.getItem.mockRejectedValueOnce(new Error('denied'));
    expect(await loadNavGroupCollapsed()).toEqual({});
  });

  it('swallows storage write failures', async () => {
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('quota'));
    await expect(saveNavGroupCollapsed({ 'proj-a:git': true })).resolves.toBeUndefined();
  });
});
