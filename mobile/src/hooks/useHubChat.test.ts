import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/hubChatInstance', () => ({ hubChatStore: {} }));
const { scopeToAccount, scopeValue } = await import('./useHubChat');

describe('account-scoped values', () => {
  it('binds to the active account even before its list has loaded', () => {
    const s = scopeValue('c1', { account: 2, active: true });
    expect(s).toEqual({ value: 'c1', account: 2 });
    expect(scopeToAccount(s, { account: 2, active: true })).toBe(s);
  });
  it('drops a value set under another account, active or not', () => {
    const s = scopeValue('c1', { account: 2, active: true });
    expect(scopeToAccount(s, { account: 3, active: false }).value).toBeNull();
    expect(scopeToAccount(s, { account: 3, active: true }).value).toBeNull();
  });
  it('lets the next active account adopt a value set while none was active', () => {
    const s = scopeValue('c1', { account: 0, active: false });
    expect(s.account).toBeNull();
    const waiting = scopeToAccount(s, { account: 1, active: false });
    expect(waiting.value).toBe('c1');
    const adopted = scopeToAccount(waiting, { account: 1, active: true });
    expect(adopted).toEqual({ value: 'c1', account: 1 });
    expect(scopeToAccount(adopted, { account: 2, active: true }).value).toBeNull();
  });
});
