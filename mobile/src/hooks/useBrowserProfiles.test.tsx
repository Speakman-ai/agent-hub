import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (el: any) => unknown;

const apiMock = vi.hoisted(() => ({
  getMyBrowserProfiles: vi.fn<() => Promise<any>>(),
  clearBrowserProfileDomain: vi.fn<(id: string, domain: string) => Promise<any>>(),
  deleteBrowserProfile: vi.fn<(id: string) => Promise<any>>(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { useBrowserProfiles } = await import('./useBrowserProfiles');
type Hook = ReturnType<typeof useBrowserProfiles>;

function profile(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    agentId: 'dev',
    agentName: 'Dev',
    projectId: 'p1',
    projectName: 'Project One',
    domains: ['github.com', 'example.com'],
    hasState: true,
    inUse: false,
    lastUsedAt: '2026-10-15 10:00:00',
    createdAt: '2026-10-01 00:00:00',
    updatedAt: '2026-10-15 10:00:00',
    ...over,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function mount(): Promise<{ current: Hook }> {
  const ref = {} as { current: Hook };
  function Harness() {
    ref.current = useBrowserProfiles();
    return null;
  }
  await act(async () => {
    create(<Harness />);
    await flush();
  });
  return ref;
}

describe('useBrowserProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads profiles and groups them by agent name', async () => {
    apiMock.getMyBrowserProfiles.mockResolvedValue({
      profiles: [
        profile('a', { agentId: 'zed', agentName: 'Zed' }),
        profile('b'),
        profile('c', { projectId: 'p2', projectName: 'Two' }),
      ],
    });
    const h = await mount();
    expect(h.current.profiles).toHaveLength(3);
    expect(h.current.groups.map((g) => g.agentName)).toEqual(['Dev', 'Zed']);
    expect(h.current.groups[0].profiles.map((p) => p.id)).toEqual(['b', 'c']);
    expect(h.current.error).toBeNull();
  });

  it('surfaces a load error and settles to an empty list', async () => {
    apiMock.getMyBrowserProfiles.mockRejectedValue(new Error('500: boom'));
    const h = await mount();
    expect(h.current.error).toBe('500: boom');
    expect(h.current.profiles).toEqual([]);
  });

  it('replaces the profile with the server copy after clearing a domain', async () => {
    apiMock.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile('a'), profile('b')] });
    apiMock.clearBrowserProfileDomain.mockResolvedValue(profile('a', { domains: ['example.com'] }));
    const h = await mount();
    await act(async () => {
      await h.current.clearDomain(h.current.profiles![0], 'github.com');
    });
    expect(apiMock.clearBrowserProfileDomain).toHaveBeenCalledWith('a', 'github.com');
    expect(h.current.profiles!.find((p) => p.id === 'a')!.domains).toEqual(['example.com']);
    expect(h.current.profiles!.find((p) => p.id === 'b')!.domains).toHaveLength(2);
    expect(h.current.busy).toBeNull();
  });

  it('keeps the domain and reports the error when clearing fails (e.g. 409 in use)', async () => {
    apiMock.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile('a')] });
    apiMock.clearBrowserProfileDomain.mockRejectedValue(new Error('409: in use'));
    const h = await mount();
    await act(async () => {
      await h.current.clearDomain(h.current.profiles![0], 'github.com');
    });
    expect(h.current.error).toBe('409: in use');
    expect(h.current.profiles![0].domains).toContain('github.com');
    expect(h.current.busy).toBeNull();
  });

  it('removes a deleted profile from the list', async () => {
    apiMock.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile('a'), profile('b')] });
    apiMock.deleteBrowserProfile.mockResolvedValue({ ok: true });
    const h = await mount();
    await act(async () => {
      await h.current.deleteProfile(h.current.profiles![0]);
    });
    expect(apiMock.deleteBrowserProfile).toHaveBeenCalledWith('a');
    expect(h.current.profiles!.map((p) => p.id)).toEqual(['b']);
  });

  it('keeps the profile when delete fails', async () => {
    apiMock.getMyBrowserProfiles.mockResolvedValue({ profiles: [profile('a')] });
    apiMock.deleteBrowserProfile.mockRejectedValue(new Error('404: gone'));
    const h = await mount();
    await act(async () => {
      await h.current.deleteProfile(h.current.profiles![0]);
    });
    expect(h.current.error).toBe('404: gone');
    expect(h.current.profiles!.map((p) => p.id)).toEqual(['a']);
  });
});
