import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (el: any) => { unmount: () => void };

const storage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

const { useSessionsViewMode, SESSIONS_VIEW_STORAGE_KEY } = await import('./useSessionsViewMode');

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function harness() {
  let latest: ReturnType<typeof useSessionsViewMode>;
  function Harness() {
    latest = useSessionsViewMode();
    return null;
  }
  return {
    get mode() {
      return latest[0];
    },
    get change() {
      return latest[1];
    },
    async render() {
      await act(async () => {
        create(<Harness />);
        await flush();
      });
    },
  };
}

describe('useSessionsViewMode', () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset().mockResolvedValue(undefined);
  });

  it('hydrates the stored mode', async () => {
    storage.getItem.mockResolvedValue('board');
    const h = harness();
    await h.render();
    expect(storage.getItem).toHaveBeenCalledWith(SESSIONS_VIEW_STORAGE_KEY);
    expect(h.mode).toBe('board');
  });

  it('ignores an invalid stored value', async () => {
    storage.getItem.mockResolvedValue('grid');
    const h = harness();
    await h.render();
    expect(h.mode).toBe('list');
  });

  it('does not let a late hydration read overwrite a toggle press', async () => {
    let resolveRead!: (v: string | null) => void;
    storage.getItem.mockReturnValue(
      new Promise((r) => {
        resolveRead = r;
      }),
    );
    const h = harness();
    await h.render();
    expect(h.mode).toBe('list');

    await act(async () => {
      h.change('board');
      await flush();
    });
    expect(h.mode).toBe('board');
    expect(storage.setItem).toHaveBeenCalledWith(SESSIONS_VIEW_STORAGE_KEY, 'board');

    // The previously saved mode arrives after the user already picked one.
    await act(async () => {
      resolveRead('list');
      await flush();
    });
    expect(h.mode).toBe('board');
  });
});
