import { beforeEach, afterEach, expect, it, vi } from 'vitest';
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer } = await import('react-test-renderer');
const state = vi.hoisted(() => ({
  server: 'https://hub.test/api',
  user: 'one',
  store: new Map<string, string>(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => state.store.get(key)),
    setItem: vi.fn(async (key: string, value: string) => {
      state.store.set(key, value);
    }),
  },
}));
const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
const { createUseAiSignInGuide } = await import('@shared/hooks/useAiSignInGuide');
const useAiSignInGuide = createUseAiSignInGuide(React);
async function loadStatus(server: string, signal: AbortSignal) {
  const response = await fetch(`${server}/setup/status`, {
    headers: { Authorization: 'Bearer test' },
    signal,
  });
  return response.ok ? response.json() : null;
}
let latest: ReturnType<typeof useAiSignInGuide>;
let renderer: ReturnType<typeof TestRenderer.create>;
function Harness({ enabled = true }: { enabled?: boolean }) {
  latest = useAiSignInGuide({
    enabled,
    server: state.server,
    user: { id: state.user },
    storage: AsyncStorage,
    loadStatus,
  });
  return null;
}
const render = async (enabled = true) => {
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<Harness enabled={enabled} />);
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  state.store.clear();
  state.user = 'one';
  state.server = 'https://hub.test/api';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hasAnyAiCredentials: false, authConfigured: true }),
    }),
  );
});
afterEach(async () => {
  await TestRenderer.act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
it('does not probe before login, then guides authenticated users without credentials', async () => {
  await render(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(latest.showAiSignInGuide).toBe(false);
  await TestRenderer.act(async () => renderer.update(<Harness enabled />));
  expect(fetch).toHaveBeenCalledWith(
    'https://hub.test/api/setup/status',
    expect.objectContaining({ headers: { Authorization: 'Bearer test' } }),
  );
  expect(latest.showAiSignInGuide).toBe(true);
});
it('persists dismissal for this account without hiding guidance from another account', async () => {
  await render();
  await TestRenderer.act(async () => latest.dismissAiSignInGuide());
  expect(latest.showAiSignInGuide).toBe(false);
  await TestRenderer.act(async () => renderer.unmount());
  await render();
  expect(latest.showAiSignInGuide).toBe(false);
  state.user = 'two';
  await TestRenderer.act(async () => renderer.update(<Harness />));
  expect(latest.showAiSignInGuide).toBe(true);
});
it('ignores a late status response from the previous account', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  state.user = 'two';
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ hasAnyAiCredentials: true }),
  } as Response);
  await TestRenderer.act(async () => renderer.update(<Harness />));
  await TestRenderer.act(async () => resolve(Response.json({ hasAnyAiCredentials: false })));
  expect(latest.showAiSignInGuide).toBe(false);
});
it('does not show guidance after an unsuccessful status probe', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
  await render();
  expect(latest.showAiSignInGuide).toBe(false);
});

it('keeps dismissal in memory when native storage fails and the guide is enabled again', async () => {
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Storage unavailable'));
  await render();
  expect(latest.showAiSignInGuide).toBe(true);
  await TestRenderer.act(async () => latest.dismissAiSignInGuide());
  await TestRenderer.act(async () => renderer.update(<Harness enabled={false} />));
  await TestRenderer.act(async () => renderer.update(<Harness enabled />));
  expect(latest.showAiSignInGuide).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not revive dismissed guidance when an in-flight status request resolves', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await TestRenderer.act(async () => latest.dismissAiSignInGuide());
  await TestRenderer.act(async () => resolve(Response.json({ hasAnyAiCredentials: false })));
  expect(latest.showAiSignInGuide).toBe(false);
});

it('can still guide and dismiss when reading native storage fails', async () => {
  vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('Storage unavailable'));
  await render();
  expect(latest.showAiSignInGuide).toBe(true);
  await TestRenderer.act(async () => latest.dismissAiSignInGuide());
  expect(latest.showAiSignInGuide).toBe(false);
});
