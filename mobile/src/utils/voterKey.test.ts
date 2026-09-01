import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory AsyncStorage stand-in so getVoterKey persists within a test.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    removeItem: vi.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
  },
}));

import { getVoterKey, _resetVoterKeyMemory } from './voterKey';

describe('getVoterKey (mobile)', () => {
  beforeEach(() => {
    store.clear();
    _resetVoterKeyMemory();
  });

  it('mints and persists a token on first use, reusing it after', async () => {
    const first = await getVoterKey();
    expect(first).toBeTruthy();
    expect(store.get('agent-hub-voter-key')).toBe(first);
    _resetVoterKeyMemory();
    const second = await getVoterKey();
    expect(second).toBe(first);
  });

  it('reuses an existing stored token', async () => {
    store.set('agent-hub-voter-key', 'existing-token');
    expect(await getVoterKey()).toBe('existing-token');
  });
});
