import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createUseAiSignInGuide } from '@shared/hooks/useAiSignInGuide';
const useSharedGuide = createUseAiSignInGuide(React);
const identity = { server: '/api', user: 'one' };
const storage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};
function useAiSignInGuide(status: Parameters<typeof useSharedGuide>[0]['status']) {
  return useSharedGuide({ server: identity.server, user: { id: identity.user }, status, storage });
}
beforeEach(() => {
  localStorage.clear();
  identity.server = '/api';
  identity.user = 'one';
});
it('only guides users with a confirmed lack of AI credentials after Hub setup', async () => {
  const { result, rerender } = renderHook(({ status }) => useAiSignInGuide(status), {
    initialProps: { status: {} as any },
  });
  expect(result.current.showAiSignInGuide).toBe(false);
  rerender({ status: { authConfigured: false, hasAnyAiCredentials: false } });
  expect(result.current.showAiSignInGuide).toBe(false);
  rerender({ status: { authConfigured: true, hasAnyAiCredentials: false } });
  await waitFor(() => expect(result.current.showAiSignInGuide).toBe(true));
  rerender({ status: { hasAnyAiCredentials: true } });
  expect(result.current.showAiSignInGuide).toBe(false);
});
it('remembers completion across remounts, scoped to the account and server', async () => {
  const status = { hasAnyAiCredentials: false };
  const hook = renderHook(() => useAiSignInGuide(status));
  await waitFor(() => expect(hook.result.current.showAiSignInGuide).toBe(true));
  act(() => hook.result.current.dismissAiSignInGuide());
  expect(hook.result.current.showAiSignInGuide).toBe(false);
  hook.unmount();
  const next = renderHook(() => useAiSignInGuide(status));
  await act(async () => {});
  expect(next.result.current.showAiSignInGuide).toBe(false);
  identity.user = 'two';
  next.rerender();
  await waitFor(() => expect(next.result.current.showAiSignInGuide).toBe(true));
  identity.user = 'one';
  identity.server = 'https://other.test/api';
  next.rerender();
  await waitFor(() => expect(next.result.current.showAiSignInGuide).toBe(true));
});
it('still dismisses when browser storage is unavailable', async () => {
  const mock = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  const hook = renderHook(() => useAiSignInGuide({ hasAnyAiCredentials: false }));
  await waitFor(() => expect(hook.result.current.showAiSignInGuide).toBe(true));
  act(() => hook.result.current.dismissAiSignInGuide());
  expect(hook.result.current.showAiSignInGuide).toBe(false);
  mock.mockRestore();
});
