import { describe, expect, it, vi } from 'vitest';
import type { HubChatChannel } from '@shared/utils/hubChat';

const api = vi.hoisted(() => ({ hubChat: { channels: vi.fn(), openDm: vi.fn() } }));
vi.mock('../utils/api', () => ({ api }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { useAccountScoped } = await import('./useHubChat');
const { hubChatStore, hubChatAccountGate } = await import('../utils/hubChatInstance');
process.env.NODE_ENV = originalNodeEnv;

const dm = { id: 'dm-a', kind: 'dm', lastSeq: 0, membership: null } as unknown as HubChatChannel;
const ORG_A = 'https://hub|u1|orgA';
const ORG_B = 'https://hub|u1|orgB';

let selected: string | null = null;
let select: (v: string | null) => void = () => {};
function Holder() {
  const [value, set] = useAccountScoped<string>(null);
  selected = value;
  select = set;
  return null;
}

describe('useAccountScoped with the real store and gate', () => {
  it('a DM opened before the first list lands does not survive an org switch', async () => {
    // Org A's channel list never answers.
    api.hubChat.channels.mockReturnValue(new Promise(() => {}));
    api.hubChat.openDm.mockResolvedValue({ channel: dm });
    await act(async () => {
      hubChatAccountGate.update({ account: ORG_A, userId: 'u1', connected: true });
    });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(Holder));
    });
    expect(hubChatStore.getSnapshot()).toMatchObject({ active: true, loaded: false });

    // Open a DM while the list is still loading, and select it.
    await act(async () => {
      const ch = await hubChatStore.requestChannel(() => api.hubChat.openDm('u2'));
      select(ch!.id);
    });
    expect(selected).toBe('dm-a');

    // Switch org, then org B connects and its list loads.
    api.hubChat.channels.mockResolvedValue({ channels: [], viewerUserId: 'u1' });
    await act(async () => {
      hubChatAccountGate.invalidate();
      hubChatAccountGate.update({ account: ORG_B, userId: 'u1', connected: false });
    });
    expect(selected).toBeNull();
    await act(async () => {
      hubChatAccountGate.update({ account: ORG_B, userId: 'u1', connected: true });
    });
    await act(async () => {});
    expect(hubChatStore.getSnapshot()).toMatchObject({ active: true, loaded: true });
    expect(selected).toBeNull();
    act(() => r.unmount());
  });

  it('nothing can be opened while no account is active', async () => {
    await act(async () => {
      hubChatAccountGate.invalidate();
    });
    expect(await hubChatStore.requestChannel(() => api.hubChat.openDm('u2'))).toBeNull();
    expect(api.hubChat.openDm).toHaveBeenCalledTimes(1);
  });
});
