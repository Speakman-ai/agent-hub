import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRequestScope } from './requestScope';
import { saveConnectionConfig } from './connection';
import { setToken } from './auth';

beforeEach(() => localStorage.clear());

describe('useRequestScope', () => {
  it('stays current until something changes', () => {
    const { result } = renderHook(() => useRequestScope());
    expect(result.current('a').isCurrent()).toBe(true);
  });

  it('drops a ticket after unmount', () => {
    const { result, unmount } = renderHook(() => useRequestScope());
    const ticket = result.current('a');
    unmount();
    expect(ticket.isCurrent()).toBe(false);
  });

  it('keeps only the newest ticket of a kind', () => {
    const { result } = renderHook(() => useRequestScope());
    const first = result.current('a');
    const other = result.current('b');
    const second = result.current('a');
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(other.isCurrent()).toBe(true);
  });

  it('drops a ticket when the Server connection changes', () => {
    const { result } = renderHook(() => useRequestScope());
    const ticket = result.current('a');
    saveConnectionConfig({ mode: 'remote', remoteUrl: 'https://other.example.com' });
    expect(ticket.isCurrent()).toBe(false);
  });

  it('drops a ticket when the account or active Server token changes', () => {
    setToken({ token: 'first', expiresAt: null, user: { id: 'u1' } });
    const { result } = renderHook(() => useRequestScope());
    const ticket = result.current('a');
    setToken({ token: 'second', expiresAt: null, user: { id: 'u2' } });
    expect(ticket.isCurrent()).toBe(false);
  });
});
