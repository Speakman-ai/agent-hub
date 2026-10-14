import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    hubChat: {
      updateChannel: vi.fn(),
      addMembers: vi.fn(),
      setNotifyLevel: vi.fn(),
      members: vi.fn(),
      channels: vi.fn(),
      messages: vi.fn(),
      post: vi.fn(),
      markRead: vi.fn(),
      openDm: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(),
      join: vi.fn(),
      channel: vi.fn(),
      digest: vi.fn(() => Promise.resolve({ digest: null })),
    },
  },
}));

import HubChatPage from './HubChatPage';
import ChatPane from './ChatPane';
import { api } from '../utils/api';
import { requestOpenChatSpace, takePendingOpenChatSpace } from '../utils/googleChatNotifications';
import type { HubChatChannel, HubChatMessage } from '../utils/hubChat';
import {
  getHubChatSession,
  resetHubChatSessionForTests,
  updateHubChatSession,
} from '../utils/hubChatSession';
import {
  HUB_ASSISTANT_CHANNEL_ID,
  getHubAssistantUnread,
  markHubAssistantReplyUnseen,
  resetHubAssistantUnreadForTests,
} from '../utils/hubAssistantChat';
import { CHAT_PANE_SIDE_KEY, resetChatPaneSideForTests } from '../utils/chatPaneSide';

const chat = (api as unknown as { hubChat: Record<string, ReturnType<typeof vi.fn>> }).hubChat;

function channel(over: Partial<HubChatChannel>): HubChatChannel {
  return {
    id: 'c1',
    orgId: 'acme',
    kind: 'channel',
    name: 'general',
    topic: null,
    isPrivate: false,
    projectId: null,
    agentId: null,
    dmPeerUserId: null,
    createdByUserId: 'alice',
    archivedAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    lastSeq: 0,
    membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}

function message(seq: number, over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id: `m${seq}`,
    channelId: 'dm1',
    seq,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: `hello ${seq}`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const DM = channel({ id: 'dm1', kind: 'dm', name: '', dmPeerUserId: 'bob', lastSeq: 1 });
const GENERAL = channel({ id: 'gen', name: 'general', lastSeq: 2, unreadCount: 2 });

function wsEvent(type: string, detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(type, { detail: { type, ...detail } }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHubChatSessionForTests();
  resetHubAssistantUnreadForTests();
  window.localStorage.removeItem(CHAT_PANE_SIDE_KEY);
  resetChatPaneSideForTests();
  chat.members.mockResolvedValue({
    members: [
      { userId: 'alice', username: 'alice', role: 'User' },
      { userId: 'bob', username: 'bob', role: 'User' },
    ],
  });
  chat.channels.mockResolvedValue({ channels: [DM, GENERAL], viewerUserId: 'alice' });
  chat.messages.mockImplementation((id: string) =>
    Promise.resolve({
      messages: id === 'dm1' ? [message(1)] : [],
      hasMore: false,
    }),
  );
  chat.markRead.mockResolvedValue({ lastReadSeq: 0 });
});

describe('HubChatPage rail', () => {
  it('shows sections and unread badges, and updates them from live events', async () => {
    render(<HubChatPage />);
    await screen.findByTestId('hub-chat-channel-gen');
    // The pinned assistant DM only shows when the app wires the assistant in.
    expect(screen.queryByTestId('hub-chat-assistant')).toBeNull();
    expect(within(screen.getByTestId('hub-chat-section-dms')).getByText('bob')).toBeTruthy();
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('2');

    // The DM opens first; a new message in #general bumps its badge.
    await screen.findByText('hello 1');
    wsEvent('hub_chat_message', {
      channelId: 'gen',
      message: message(3, { channelId: 'gen', body: 'news' }),
    });
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('3');

    // The viewer read #general on another device.
    wsEvent('hub_chat_read', { channelId: 'gen', lastReadSeq: 3 });
    expect(screen.queryByTestId('hub-chat-unread-gen')).toBeNull();
  });

  it('does not badge the viewer’s own messages', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    wsEvent('hub_chat_message', {
      channelId: 'gen',
      message: message(3, { channelId: 'gen', authorUserId: 'alice' }),
    });
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('2');
  });
});

describe('HubChatPage pinned Agent Hub DM', () => {
  it('opens the assistant transcript it is given and keeps it open', async () => {
    render(
      <HubChatPage
        assistantEnabled
        assistant={<div data-testid="assistant-transcript">hub session</div>}
      />,
    );
    await screen.findByText('hello 1');
    const row = screen.getByTestId('hub-chat-assistant');
    expect(row.textContent).toContain('Agent Hub');

    fireEvent.click(row);
    expect(getHubChatSession().selectedId).toBe(HUB_ASSISTANT_CHANNEL_ID);
    expect(await screen.findByTestId('assistant-transcript')).toBeTruthy();
    // The rail does not fall back to the first channel while the DM is open.
    await waitFor(() => expect(screen.queryByText('hello 1')).toBeNull());
    expect(getHubChatSession().selectedId).toBe(HUB_ASSISTANT_CHANNEL_ID);

    // Back to a channel.
    fireEvent.click(screen.getByTestId('hub-chat-channel-dm1'));
    expect(await screen.findByText('hello 1')).toBeTruthy();
    expect(screen.queryByTestId('assistant-transcript')).toBeNull();
  });

  it('badges an unseen assistant reply and clears it when the DM opens', async () => {
    render(<HubChatPage assistantEnabled />);
    await screen.findByText('hello 1');
    expect(screen.queryByTestId('hub-chat-assistant-unread')).toBeNull();

    act(() => markHubAssistantReplyUnseen());
    expect(screen.getByTestId('hub-chat-assistant-unread').textContent).toBe('1');

    fireEvent.click(screen.getByTestId('hub-chat-assistant'));
    expect(screen.queryByTestId('hub-chat-assistant-unread')).toBeNull();
    expect(getHubAssistantUnread()).toBe(0);
    // The transcript is mounted in the assistant column instead.
    expect(screen.getByTestId('hub-chat-assistant-elsewhere')).toBeTruthy();
  });

  it('falls back to a channel when the assistant DM is not available', async () => {
    updateHubChatSession((st) => ({ ...st, selectedId: HUB_ASSISTANT_CHANNEL_ID }));
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    expect(getHubChatSession().selectedId).toBe('dm1');
  });

  it('renders the assistant through ChatPane', async () => {
    render(
      <ChatPane assistantEnabled assistant={<div data-testid="assistant-transcript">hub</div>} />,
    );
    fireEvent.click(await screen.findByTestId('hub-chat-assistant'));
    expect(await screen.findByTestId('assistant-transcript')).toBeTruthy();
  });
});

describe('HubChatPage messages', () => {
  it('shows a live DM message and marks it read', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    wsEvent('hub_chat_message', {
      channelId: 'dm1',
      message: message(2, { body: 'are you there?' }),
    });
    expect(await screen.findByText('are you there?')).toBeTruthy();
    // Same sender inside five minutes: one header for the run.
    const rows = screen.getAllByTestId('hub-chat-message');
    expect(rows.map((r) => r.getAttribute('data-header'))).toEqual(['true', null]);
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledWith('dm1', 2));
  });

  it('sends from the composer and renders the post as own', async () => {
    chat.post.mockResolvedValue({
      message: message(2, { authorUserId: 'alice', body: 'hi **bob**' }),
    });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    const box = screen.getByTestId('hub-chat-composer');
    fireEvent.change(box, { target: { value: 'hi **bob**' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.post).toHaveBeenCalledWith('dm1', 'hi **bob**'));
    const own = (await screen.findAllByTestId('hub-chat-message')).find(
      (r) => r.getAttribute('data-own') === 'true',
    );
    expect(own?.querySelector('strong')?.textContent).toBe('bob');
    // The WS echo of the same post does not duplicate it.
    wsEvent('hub_chat_message', {
      channelId: 'dm1',
      message: message(2, { authorUserId: 'alice', body: 'hi **bob**' }),
    });
    expect(screen.getAllByTestId('hub-chat-message')).toHaveLength(2);
  });

  it('shows the Unread line at the read position when opening a channel', async () => {
    chat.messages.mockImplementation((id: string) =>
      Promise.resolve({
        messages:
          id === 'gen'
            ? [
                message(1, { channelId: 'gen', authorUserId: 'alice' }),
                message(2, { channelId: 'gen' }),
              ]
            : [message(1)],
        hasMore: false,
      }),
    );
    chat.channels.mockResolvedValue({
      channels: [
        DM,
        channel({
          id: 'gen',
          lastSeq: 2,
          unreadCount: 1,
          membership: { role: 'member', lastReadSeq: 1, notifyLevel: 'all', mutedUntil: null },
        }),
      ],
      viewerUserId: 'alice',
    });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText('hello 2');
    expect(screen.getByTestId('hub-chat-unread-divider')).toBeTruthy();
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledWith('gen', 2));
    expect(screen.queryByTestId('hub-chat-unread-gen')).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function range(from: number, to: number) {
  const out: HubChatMessage[] = [];
  for (let seq = from; seq <= to; seq++) out.push(message(seq));
  return out;
}

describe('HubChatPage reconnect catch-up', () => {
  it('follows hasMore across pages so no range goes missing', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    chat.messages.mockImplementation((_id: string, opts: { after?: number }) => {
      // The loaded window starts at seq 1, so reconcile re-reads from there.
      if (opts?.after === 0) return Promise.resolve({ messages: range(1, 100), hasMore: true });
      if (opts?.after === 100)
        return Promise.resolve({ messages: range(101, 103), hasMore: false });
      return Promise.reject(new Error(`unexpected ${JSON.stringify(opts)}`));
    });
    act(() => {
      window.dispatchEvent(new CustomEvent('agenthub:ws_reconnected'));
    });
    await screen.findByText('hello 103');
    expect(screen.getAllByTestId('hub-chat-message')).toHaveLength(103);
    expect(screen.getByText('hello 50')).toBeTruthy();
  });

  it('reloads the latest page when the backlog is too long to page through', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    chat.messages.mockImplementation((_id: string, opts: { after?: number }) => {
      if (opts?.after !== undefined) {
        const from = opts.after + 1;
        return Promise.resolve({ messages: range(from, from + 99), hasMore: true });
      }
      return Promise.resolve({ messages: range(5000, 5049), hasMore: true });
    });
    act(() => {
      window.dispatchEvent(new CustomEvent('agenthub:ws_reconnected'));
    });
    await screen.findByText('hello 5049');
    // Contiguous latest page only: the stale head is gone and history pages back.
    expect(screen.queryByText('hello 1')).toBeNull();
    expect(screen.getAllByTestId('hub-chat-message')).toHaveLength(50);
    expect(screen.getByText('Load older messages')).toBeTruthy();
  });
});

describe('HubChatPage reconnect reconcile', () => {
  it('picks up edits and deletions made while offline', async () => {
    chat.messages.mockImplementation((id: string) =>
      Promise.resolve({
        messages:
          id === 'dm1' ? [message(1, { body: 'original' }), message(2, { body: 'doomed' })] : [],
        hasMore: false,
      }),
    );
    render(<HubChatPage />);
    await screen.findByText('doomed');
    chat.messages.mockImplementation((_id: string, opts: { after?: number }) =>
      Promise.resolve({
        messages:
          opts?.after === 0
            ? [
                message(1, { body: 'rewritten', editedAt: new Date().toISOString() }),
                message(2, { body: '', deletedAt: new Date().toISOString() }),
                message(3, { body: 'new while away' }),
              ]
            : [],
        hasMore: false,
      }),
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('agenthub:ws_reconnected'));
    });
    await screen.findByText('rewritten');
    expect(screen.queryByText('original')).toBeNull();
    expect(screen.queryByText('doomed')).toBeNull();
    expect(screen.getByText('Message deleted')).toBeTruthy();
    expect(screen.getByText('new while away')).toBeTruthy();
  });

  it('does not let an older channel list response roll back a live unread bump', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    const stale = deferred<{ channels: HubChatChannel[]; viewerUserId: string }>();
    chat.channels.mockReturnValueOnce(stale.promise);
    // A channel update triggers a refetch; a live message lands before it returns.
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'updated' });
    wsEvent('hub_chat_message', { channelId: 'gen', message: message(3, { channelId: 'gen' }) });
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('3');
    await act(async () => {
      stale.resolve({ channels: [DM, GENERAL], viewerUserId: 'alice' });
    });
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('3');
  });
});

describe('HubChatPage stale responses vs live events', () => {
  it('a channel list requested before a read event does not restore the badge', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('2');
    const stale = deferred<{ channels: HubChatChannel[]; viewerUserId: string }>();
    chat.channels.mockReturnValueOnce(stale.promise);
    wsEvent('hub_chat_channel_update', { channelId: 'other', reason: 'created' });
    // Read on another device while the refresh is in flight.
    wsEvent('hub_chat_read', { channelId: 'gen', lastReadSeq: 2 });
    expect(screen.queryByTestId('hub-chat-unread-gen')).toBeNull();
    await act(async () => {
      stale.resolve({ channels: [DM, GENERAL], viewerUserId: 'alice' });
    });
    expect(screen.queryByTestId('hub-chat-unread-gen')).toBeNull();
  });

  it('a history page fetched before a live delete or edit does not bring the old body back', async () => {
    chat.messages.mockImplementation(() =>
      Promise.resolve({
        messages: [message(1, { body: 'keep me?' }), message(2, { body: 'typo' })],
        hasMore: false,
      }),
    );
    render(<HubChatPage />);
    await screen.findByText('keep me?');
    const page = deferred<{ messages: HubChatMessage[]; hasMore: boolean }>();
    chat.messages.mockReturnValueOnce(page.promise);
    act(() => {
      window.dispatchEvent(new CustomEvent('agenthub:ws_reconnected'));
    });
    wsEvent('hub_chat_message_update', {
      channelId: 'dm1',
      message: message(1, { body: '', deletedAt: new Date().toISOString() }),
    });
    wsEvent('hub_chat_message_update', {
      channelId: 'dm1',
      message: message(2, { body: 'fixed', editedAt: new Date().toISOString() }),
    });
    await act(async () => {
      page.resolve({
        messages: [message(1, { body: 'keep me?' }), message(2, { body: 'typo' })],
        hasMore: false,
      });
    });
    expect(screen.queryByText('keep me?')).toBeNull();
    expect(screen.getByText('Message deleted')).toBeTruthy();
    expect(screen.getByText('fixed')).toBeTruthy();
    expect(screen.queryByText('typo')).toBeNull();
  });
});

describe('HubChatPage updates that race history and refreshes', () => {
  it('applies a delete that arrives before the page holding the message', async () => {
    const page = deferred<{ messages: HubChatMessage[]; hasMore: boolean }>();
    chat.messages.mockReturnValueOnce(page.promise);
    render(<HubChatPage />);
    await screen.findByTestId('hub-chat-channel-dm1');
    await waitFor(() => expect(chat.messages).toHaveBeenCalledWith('dm1', { limit: 50 }));
    wsEvent('hub_chat_message_update', {
      channelId: 'dm1',
      message: message(1, { body: '', deletedAt: new Date().toISOString() }),
    });
    await act(async () => {
      page.resolve({ messages: [message(1, { body: 'secret' }), message(2)], hasMore: false });
    });
    // One load: the update reached the view before any copy of the message.
    expect(chat.messages).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('secret')).toBeNull();
    expect(screen.getByText('Message deleted')).toBeTruthy();
    expect(screen.getByText('hello 2')).toBeTruthy();
  });

  it('keeps a remote rename that races a live message, then settles the count', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    const first = deferred<{ channels: HubChatChannel[]; viewerUserId: string }>();
    chat.channels.mockReturnValueOnce(first.promise);
    chat.channels.mockResolvedValueOnce({
      channels: [DM, { ...GENERAL, name: 'lobby', lastSeq: 3, unreadCount: 3 }],
      viewerUserId: 'alice',
    });
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'updated' });
    wsEvent('hub_chat_message', { channelId: 'gen', message: message(3, { channelId: 'gen' }) });
    await act(async () => {
      first.resolve({
        channels: [DM, { ...GENERAL, name: 'lobby' }],
        viewerUserId: 'alice',
      });
    });
    await waitFor(() => expect(chat.channels).toHaveBeenCalledTimes(3));
    const row = screen.getByTestId('hub-chat-channel-gen');
    expect(row.textContent).toContain('# lobby');
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('3');
  });
});

describe('HubChatPage read writes and removal', () => {
  const UNREAD_DM = channel({
    id: 'dm1',
    kind: 'dm',
    name: '',
    dmPeerUserId: 'bob',
    lastSeq: 1,
    unreadCount: 1,
  });

  it('rolls back a rejected read and writes it again when the channel is reopened', async () => {
    chat.channels.mockResolvedValue({ channels: [UNREAD_DM, GENERAL], viewerUserId: 'alice' });
    chat.markRead.mockRejectedValueOnce(new Error('offline'));
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledWith('dm1', 1));
    // The failure triggers a refresh; the server still has it unread.
    await waitFor(() => expect(chat.channels).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await waitFor(() => expect(screen.getByTestId('hub-chat-unread-dm1').textContent).toBe('1'));

    chat.markRead.mockResolvedValueOnce({ lastReadSeq: 1 });
    fireEvent.click(screen.getByTestId('hub-chat-channel-dm1'));
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledTimes(2));
    expect(chat.markRead).toHaveBeenLastCalledWith('dm1', 1);
    await waitFor(() => expect(screen.queryByTestId('hub-chat-unread-dm1')).toBeNull());
  });

  it('retries a rejected read on reconnect', async () => {
    chat.channels.mockResolvedValue({ channels: [UNREAD_DM, GENERAL], viewerUserId: 'alice' });
    chat.markRead.mockRejectedValueOnce(new Error('offline'));
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    await waitFor(() => expect(chat.channels).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new CustomEvent('agenthub:ws_reconnected'));
    });
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledTimes(2));
    expect(chat.markRead).toHaveBeenLastCalledWith('dm1', 1);
  });

  it('moves to the next channel when removed from the open one, despite a stale refresh', async () => {
    const FIRST = channel({ id: 'a1', name: 'aaa', lastSeq: 1 });
    chat.channels.mockResolvedValue({ channels: [FIRST, GENERAL], viewerUserId: 'alice' });
    chat.messages.mockImplementation((id: string) =>
      Promise.resolve({
        messages: id === 'a1' ? [message(1, { channelId: 'a1', body: 'in aaa' })] : [],
        hasMore: false,
      }),
    );
    render(<HubChatPage />);
    await screen.findByText('in aaa');

    // A refresh is in flight when the removal arrives.
    const stale = deferred<{ channels: HubChatChannel[]; viewerUserId: string }>();
    chat.channels.mockReturnValueOnce(stale.promise);
    chat.channels.mockResolvedValueOnce({ channels: [GENERAL], viewerUserId: 'alice' });
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'updated' });
    wsEvent('hub_chat_channel_update', {
      channelId: 'a1',
      reason: 'member_removed',
      userIds: ['alice'],
    });

    expect(screen.queryByTestId('hub-chat-channel-a1')).toBeNull();
    await screen.findByPlaceholderText('Message # general (Markdown)');
    await act(async () => {
      stale.resolve({ channels: [FIRST, GENERAL], viewerUserId: 'alice' });
    });
    await waitFor(() => expect(chat.channels).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('hub-chat-channel-a1')).toBeNull();
    expect(screen.queryByText('in aaa')).toBeNull();
    expect(screen.getByPlaceholderText('Message # general (Markdown)')).toBeTruthy();
  });
});

describe('HubChatPage responses from an earlier opening', () => {
  const win = (from: number, to: number) => range(from, to);

  it('drops a Load older response after the channel was left and reopened', async () => {
    chat.messages.mockResolvedValueOnce({ messages: win(51, 100), hasMore: true });
    chat.channels.mockResolvedValue({
      channels: [{ ...DM, lastSeq: 100 }, GENERAL],
      viewerUserId: 'alice',
    });
    render(<HubChatPage />);
    await screen.findByText('hello 100');

    const older = deferred<{ messages: HubChatMessage[]; hasMore: boolean }>();
    chat.messages.mockReturnValueOnce(older.promise);
    fireEvent.click(screen.getByText('Load older messages'));

    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    wsEvent('hub_chat_message', { channelId: 'dm1', message: message(101) });

    chat.messages.mockResolvedValueOnce({ messages: win(52, 101), hasMore: true });
    fireEvent.click(screen.getByTestId('hub-chat-channel-dm1'));
    await screen.findByText('hello 101');

    await act(async () => {
      older.resolve({ messages: win(1, 50), hasMore: false });
    });
    expect(screen.queryByText('hello 1')).toBeNull();
    expect(screen.queryByText('hello 50')).toBeNull();
    // History is still reachable from the new window's head.
    expect(screen.getByText('Load older messages')).toBeTruthy();
    expect(screen.getAllByTestId('hub-chat-message')).toHaveLength(50);
  });

  it('drops an initial load from an earlier opening', async () => {
    const firstLoad = deferred<{ messages: HubChatMessage[]; hasMore: boolean }>();
    chat.messages.mockReturnValueOnce(firstLoad.promise);
    render(<HubChatPage />);
    await screen.findByTestId('hub-chat-channel-gen');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);

    chat.messages.mockResolvedValueOnce({ messages: win(51, 100), hasMore: true });
    fireEvent.click(screen.getByTestId('hub-chat-channel-dm1'));
    await screen.findByText('hello 100');

    await act(async () => {
      firstLoad.resolve({ messages: win(1, 3), hasMore: false });
    });
    expect(screen.queryByText('hello 1')).toBeNull();
    expect(screen.getByText('Load older messages')).toBeTruthy();
  });
});

describe('HubChatPage pending requests', () => {
  it('keeps text typed while a send is in flight', async () => {
    const post = deferred<{ message: HubChatMessage }>();
    chat.post.mockReturnValue(post.promise);
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    const box = screen.getByTestId('hub-chat-composer') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'second' } });
    await act(async () => {
      post.resolve({ message: message(2, { authorUserId: 'alice', body: 'first' }) });
    });
    await screen.findByText('first');
    expect(box.value).toBe('second');
  });

  it('does not clear another channel’s draft when a send resolves after switching', async () => {
    const post = deferred<{ message: HubChatMessage }>();
    chat.post.mockReturnValue(post.promise);
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.change(screen.getByTestId('hub-chat-composer'), { target: { value: 'to bob' } });
    fireEvent.keyDown(screen.getByTestId('hub-chat-composer'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    fireEvent.change(screen.getByTestId('hub-chat-composer'), { target: { value: 'to general' } });
    await act(async () => {
      post.resolve({ message: message(2, { authorUserId: 'alice', body: 'to bob' }) });
    });
    expect((screen.getByTestId('hub-chat-composer') as HTMLTextAreaElement).value).toBe(
      'to general',
    );
    expect(screen.queryByText('to bob')).toBeNull();
    fireEvent.click(screen.getByTestId('hub-chat-channel-dm1'));
    await screen.findByText('hello 1');
    expect((screen.getByTestId('hub-chat-composer') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not put an edit or delete response into a channel opened meanwhile', async () => {
    chat.messages.mockImplementation((id: string) =>
      Promise.resolve({
        messages: id === 'dm1' ? [message(1, { authorUserId: 'alice', body: 'mine' })] : [],
        hasMore: false,
      }),
    );
    const edit = deferred<{ message: HubChatMessage }>();
    const remove = deferred<{ message: HubChatMessage }>();
    chat.edit.mockReturnValue(edit.promise);
    chat.remove.mockReturnValue(remove.promise);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<HubChatPage />);
    await screen.findByText('mine');

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const editBox = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(editBox, { target: { value: 'mine, edited' } });
    fireEvent.keyDown(editBox, { key: 'Enter' });

    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    await act(async () => {
      edit.resolve({
        message: message(1, {
          authorUserId: 'alice',
          body: 'mine, edited',
          editedAt: new Date().toISOString(),
        }),
      });
      remove.resolve({
        message: message(1, {
          authorUserId: 'alice',
          body: '',
          deletedAt: new Date().toISOString(),
        }),
      });
    });
    expect(screen.queryAllByTestId('hub-chat-message')).toHaveLength(0);
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
  });
});

describe('HubChatPage edit attempts', () => {
  async function openEditorAndSave(text: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
  }

  beforeEach(() => {
    chat.messages.mockImplementation((id: string) =>
      Promise.resolve({
        messages: id === 'dm1' ? [message(1, { authorUserId: 'alice', body: 'mine' })] : [],
        hasMore: false,
      }),
    );
  });

  it.each([
    ['succeeds', true],
    ['fails', false],
  ])('a save that %s after cancel and reopen leaves the new editor alone', async (_l, ok) => {
    const save = deferred<{ message: HubChatMessage }>();
    chat.edit.mockReturnValueOnce(
      ok ? save.promise : save.promise.then(() => Promise.reject(new Error('boom'))),
    );
    render(<HubChatPage />);
    await screen.findByText('mine');
    await openEditorAndSave('first try');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
      target: { value: 'second try' },
    });
    await act(async () => {
      save.resolve({
        message: message(1, {
          authorUserId: 'alice',
          body: 'first try',
          editedAt: new Date().toISOString(),
        }),
      });
    });
    const box = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement;
    expect(box.value).toBe('second try');
    expect(box.disabled).toBe(false);
    expect(screen.queryByText('boom')).toBeNull();
  });
});

describe('HubChatPage member names', () => {
  it('ignores an older member list that resolves after a newer one', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    const older = deferred<{ members: { userId: string; username: string; role: string }[] }>();
    chat.members.mockReturnValueOnce(older.promise);
    chat.members.mockResolvedValueOnce({
      members: [
        { userId: 'alice', username: 'alice', role: 'User' },
        { userId: 'bob', username: 'robert', role: 'User' },
      ],
    });
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'member_added' });
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'member_added' });
    await waitFor(() =>
      expect(within(screen.getByTestId('hub-chat-section-dms')).getByText('robert')).toBeTruthy(),
    );
    await act(async () => {
      older.resolve({
        members: [
          { userId: 'alice', username: 'alice', role: 'User' },
          { userId: 'bob', username: 'bob', role: 'User' },
        ],
      });
    });
    expect(within(screen.getByTestId('hub-chat-section-dms')).getByText('robert')).toBeTruthy();
  });
});

describe('HubChatPage events batched before a render', () => {
  const OPS = channel({ id: 'ops', name: 'ops', lastSeq: 1, unreadCount: 1 });

  function batch(events: [string, Record<string, unknown>][]) {
    act(() => {
      for (const [type, detail] of events) {
        window.dispatchEvent(new CustomEvent(type, { detail: { type, ...detail } }));
      }
    });
  }

  it('applies reads for two channels dispatched in one batch', async () => {
    chat.channels.mockResolvedValue({ channels: [DM, GENERAL, OPS], viewerUserId: 'alice' });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('2');
    expect(screen.getByTestId('hub-chat-unread-ops').textContent).toBe('1');
    batch([
      ['hub_chat_read', { channelId: 'gen', lastReadSeq: 2 }],
      ['hub_chat_read', { channelId: 'ops', lastReadSeq: 1 }],
    ]);
    expect(screen.queryByTestId('hub-chat-unread-gen')).toBeNull();
    expect(screen.queryByTestId('hub-chat-unread-ops')).toBeNull();
    expect(chat.channels).toHaveBeenCalledTimes(1);
  });

  it('keeps a live message and a read for another channel from the same batch', async () => {
    chat.channels.mockResolvedValue({ channels: [DM, GENERAL, OPS], viewerUserId: 'alice' });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    batch([
      ['hub_chat_message', { channelId: 'gen', message: message(3, { channelId: 'gen' }) }],
      ['hub_chat_read', { channelId: 'ops', lastReadSeq: 1 }],
      ['hub_chat_message', { channelId: 'gen', message: message(4, { channelId: 'gen' }) }],
    ]);
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('4');
    expect(screen.queryByTestId('hub-chat-unread-ops')).toBeNull();
  });
});

describe('HubChatPage settings responses', () => {
  const READ_GEN = channel({
    id: 'gen',
    name: 'general',
    lastSeq: 2,
    membership: { role: 'owner', lastReadSeq: 2, notifyLevel: 'all', mutedUntil: null },
  });

  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
  }

  afterEach(() => setHidden(false));

  it('a delayed rename response keeps a live message that arrived meanwhile', async () => {
    chat.channels.mockResolvedValueOnce({ channels: [DM, READ_GEN], viewerUserId: 'alice' });
    chat.channel.mockResolvedValue({ channel: READ_GEN, members: [] });
    const save = deferred<{ channel: HubChatChannel }>();
    chat.updateChannel.mockReturnValueOnce(save.promise);
    // The follow-up refresh after the estimate sees the settled server state.
    chat.channels.mockResolvedValue({
      channels: [DM, { ...READ_GEN, name: 'lobby', lastSeq: 3, unreadCount: 1 }],
      viewerUserId: 'alice',
    });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    fireEvent.click(screen.getByTestId('hub-chat-settings-button'));
    const dialog = await screen.findByTestId('hub-chat-settings');
    fireEvent.change(within(dialog).getByLabelText('Channel name'), {
      target: { value: 'lobby' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    // A message lands while the tab is hidden, before the response arrives.
    setHidden(true);
    wsEvent('hub_chat_message', { channelId: 'gen', message: message(3, { channelId: 'gen' }) });
    await act(async () => {
      // Captured by the server before message 3.
      save.resolve({ channel: { ...READ_GEN, name: 'lobby' } });
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    setHidden(false);
    fireEvent.click(screen.getByTestId('hub-chat-channel-dm1'));
    await screen.findByText('hello 1');
    expect(screen.getByTestId('hub-chat-channel-gen').textContent).toContain('# lobby');
    expect(screen.getByTestId('hub-chat-unread-gen').textContent).toBe('1');
  });
});

describe('HubChatPage own responses and unmount', () => {
  it('shows a saved rename even when its update event started a refresh first', async () => {
    chat.channel.mockResolvedValue({ channel: GENERAL, members: [] });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    fireEvent.click(screen.getByTestId('hub-chat-settings-button'));
    const dialog = await screen.findByTestId('hub-chat-settings');
    const save = deferred<{ channel: HubChatChannel }>();
    chat.updateChannel.mockReturnValueOnce(save.promise);
    fireEvent.change(within(dialog).getByLabelText('Channel name'), {
      target: { value: 'lobby' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    // The server renamed it and broadcast before the PATCH response arrived.
    const refresh = deferred<{ channels: HubChatChannel[]; viewerUserId: string }>();
    chat.channels.mockReturnValueOnce(refresh.promise);
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'updated' });
    await act(async () => {
      save.resolve({ channel: { ...GENERAL, name: 'lobby' } });
    });
    expect(screen.getByTestId('hub-chat-channel-gen').textContent).toContain('# lobby');
    await act(async () => {
      refresh.resolve({ channels: [DM, { ...GENERAL, name: 'lobby' }], viewerUserId: 'alice' });
    });
    expect(screen.getByTestId('hub-chat-channel-gen').textContent).toContain('# lobby');
  });

  it('does not mark read a history page that lands after switching to Google Chat', async () => {
    const page = deferred<{ messages: HubChatMessage[]; hasMore: boolean }>();
    chat.messages.mockReturnValueOnce(page.promise);
    render(<ChatPane google={<div data-testid="google-side" />} />);
    await waitFor(() => expect(chat.messages).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('chat-pane-google'));
    await act(async () => {
      page.resolve({ messages: [message(1)], hasMore: false });
    });
    expect(chat.markRead).not.toHaveBeenCalled();
  });

  it('does not mark read a reconnect catch-up that lands after switching to Google Chat', async () => {
    render(<ChatPane google={<div data-testid="google-side" />} />);
    await screen.findByText('hello 1');
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledTimes(1));
    const catchUp = deferred<{ messages: HubChatMessage[]; hasMore: boolean }>();
    chat.messages.mockReturnValueOnce(catchUp.promise);
    act(() => {
      window.dispatchEvent(new CustomEvent('agenthub:ws_reconnected'));
    });
    fireEvent.click(screen.getByTestId('chat-pane-google'));
    await act(async () => {
      catchUp.resolve({ messages: [message(1), message(2)], hasMore: false });
    });
    expect(chat.markRead).toHaveBeenCalledTimes(1);
  });
});

describe('HubChatPage delayed responses after removal', () => {
  async function startRenameOnGeneral() {
    chat.channel.mockResolvedValue({ channel: GENERAL, members: [] });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    fireEvent.click(screen.getByTestId('hub-chat-settings-button'));
    const dialog = await screen.findByTestId('hub-chat-settings');
    const save = deferred<{ channel: HubChatChannel }>();
    chat.updateChannel.mockReturnValueOnce(save.promise);
    fireEvent.change(within(dialog).getByLabelText('Channel name'), {
      target: { value: 'lobby' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    return save;
  }

  it('a delayed save response does not overwrite a newer remote rename', async () => {
    const save = await startRenameOnGeneral();
    // Another member renames it to "boardroom"; the refresh lands first.
    chat.channels.mockResolvedValue({
      channels: [DM, { ...GENERAL, name: 'boardroom' }],
      viewerUserId: 'alice',
    });
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'updated' });
    await waitFor(() =>
      expect(screen.getByTestId('hub-chat-channel-gen').textContent).toContain('# boardroom'),
    );
    await act(async () => {
      save.resolve({ channel: { ...GENERAL, name: 'lobby' } });
    });
    expect(screen.getByTestId('hub-chat-channel-gen').textContent).toContain('# boardroom');
  });

  it('does not re-add a channel the viewer was removed from', async () => {
    const save = await startRenameOnGeneral();
    chat.channels.mockResolvedValue({ channels: [DM], viewerUserId: 'alice' });
    wsEvent('hub_chat_channel_update', {
      channelId: 'gen',
      reason: 'member_removed',
      userIds: ['alice'],
    });
    await waitFor(() => expect(chat.channels).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('hub-chat-channel-gen')).toBeNull();
    await act(async () => {
      save.resolve({ channel: { ...GENERAL, name: 'lobby' } });
    });
    expect(screen.queryByTestId('hub-chat-channel-gen')).toBeNull();
  });

  it('does not re-add a channel a refresh found gone', async () => {
    const save = await startRenameOnGeneral();
    chat.channels.mockResolvedValue({ channels: [DM], viewerUserId: 'alice' });
    wsEvent('hub_chat_channel_update', { channelId: 'dm1', reason: 'updated' });
    await waitFor(() => expect(screen.queryByTestId('hub-chat-channel-gen')).toBeNull());
    await act(async () => {
      save.resolve({ channel: { ...GENERAL, name: 'lobby' } });
    });
    expect(screen.queryByTestId('hub-chat-channel-gen')).toBeNull();
  });
});

describe('HubChatPage settings form', () => {
  it('shows a remote rename while open and saves only the edited topic', async () => {
    chat.channel.mockResolvedValue({ channel: GENERAL, members: [] });
    chat.updateChannel.mockImplementation((_id: string, body: Record<string, unknown>) =>
      Promise.resolve({ channel: { ...GENERAL, name: 'boardroom', topic: body.topic ?? null } }),
    );
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    fireEvent.click(screen.getByTestId('hub-chat-settings-button'));
    const dialog = await screen.findByTestId('hub-chat-settings');

    chat.channels.mockResolvedValue({
      channels: [DM, { ...GENERAL, name: 'boardroom' }],
      viewerUserId: 'alice',
    });
    wsEvent('hub_chat_channel_update', { channelId: 'gen', reason: 'updated' });
    const nameInput = within(dialog).getByLabelText('Channel name') as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('boardroom'));

    fireEvent.change(within(dialog).getByLabelText('Channel topic'), {
      target: { value: 'Planning' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(chat.updateChannel).toHaveBeenCalledTimes(1));
    expect(chat.updateChannel).toHaveBeenCalledWith('gen', { topic: 'Planning' });
    await waitFor(() =>
      expect(screen.getByTestId('hub-chat-channel-gen').textContent).toContain('# boardroom'),
    );
  });
});

describe('HubChatPage settings members', () => {
  it('refreshes the member list when someone joins while settings are open', async () => {
    chat.channel.mockResolvedValueOnce({
      channel: GENERAL,
      members: [{ userId: 'alice', username: 'alice', role: 'owner', joinedAt: 'x' }],
    });
    chat.channel.mockResolvedValue({
      channel: GENERAL,
      members: [
        { userId: 'alice', username: 'alice', role: 'owner', joinedAt: 'x' },
        { userId: 'bob', username: 'bob', role: 'member', joinedAt: 'y' },
      ],
    });
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    fireEvent.click(screen.getByTestId('hub-chat-settings-button'));
    const list = await screen.findByTestId('hub-chat-settings-members');
    expect(within(list).queryByText('bob')).toBeNull();
    wsEvent('hub_chat_channel_update', {
      channelId: 'gen',
      reason: 'member_added',
      userIds: ['bob'],
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('hub-chat-settings-members')).getByText('bob')).toBeTruthy(),
    );
  });
});

describe('HubChatPage settings saves in flight', () => {
  async function openGeneralSettings() {
    render(<HubChatPage />);
    await screen.findByText('hello 1');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText(/No messages yet/);
    fireEvent.click(screen.getByTestId('hub-chat-settings-button'));
    return screen.findByTestId('hub-chat-settings');
  }

  it('keeps text typed while a save is pending', async () => {
    chat.channel.mockResolvedValue({ channel: GENERAL, members: [] });
    const save = deferred<{ channel: HubChatChannel }>();
    chat.updateChannel.mockReturnValueOnce(save.promise);
    const dialog = await openGeneralSettings();
    const topic = within(dialog).getByLabelText('Channel topic') as HTMLInputElement;
    fireEvent.change(topic, { target: { value: 'Planning' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    fireEvent.change(topic, { target: { value: 'Planning, weekly' } });
    await act(async () => {
      save.resolve({ channel: { ...GENERAL, topic: 'Planning' } });
    });
    expect(chat.updateChannel).toHaveBeenCalledWith('gen', { topic: 'Planning' });
    expect(topic.value).toBe('Planning, weekly');
  });

  it('keeps people picked while an add is pending', async () => {
    chat.members.mockResolvedValue({
      members: [
        { userId: 'alice', username: 'alice', role: 'User' },
        { userId: 'bob', username: 'bob', role: 'User' },
        { userId: 'carol', username: 'carol', role: 'User' },
        { userId: 'dave', username: 'dave', role: 'User' },
      ],
    });
    chat.channel.mockResolvedValue({
      channel: GENERAL,
      members: [{ userId: 'alice', username: 'alice', role: 'owner', joinedAt: 'x' }],
    });
    const add = deferred<{ members: unknown[] }>();
    chat.addMembers.mockReturnValueOnce(add.promise);
    const dialog = await openGeneralSettings();
    await within(dialog).findByTestId('hub-chat-settings-members');
    fireEvent.click(within(dialog).getByLabelText('carol'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add/ }));
    fireEvent.click(within(dialog).getByLabelText('dave'));
    await act(async () => {
      add.resolve({
        members: [
          { userId: 'alice', username: 'alice', role: 'owner', joinedAt: 'x' },
          { userId: 'carol', username: 'carol', role: 'member', joinedAt: 'y' },
        ],
      });
    });
    expect(chat.addMembers).toHaveBeenCalledWith('gen', ['carol']);
    expect((within(dialog).getByLabelText('dave') as HTMLInputElement).checked).toBe(true);
  });
});

describe('ChatPane', () => {
  it('keeps the open channel, drafts and an open edit across a switch to Google Chat', async () => {
    chat.messages.mockImplementation((id: string) =>
      Promise.resolve({
        messages:
          id === 'gen'
            ? [message(1, { channelId: 'gen', authorUserId: 'alice', body: 'mine' })]
            : [],
        hasMore: false,
      }),
    );
    render(<ChatPane google={<div data-testid="google-side" />} />);
    await screen.findByTestId('hub-chat-channel-gen');
    fireEvent.click(screen.getByTestId('hub-chat-channel-gen'));
    await screen.findByText('mine');
    fireEvent.change(screen.getByTestId('hub-chat-composer'), { target: { value: 'half typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
      target: { value: 'mine, fixing' },
    });

    fireEvent.click(screen.getByTestId('chat-pane-google'));
    expect(screen.queryByTestId('hub-chat-page')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-pane-hub'));

    await screen.findByRole('textbox', { name: 'Edit message' });
    expect((screen.getByTestId('hub-chat-composer') as HTMLTextAreaElement).value).toBe(
      'half typed',
    );
    expect(
      (screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value,
    ).toBe('mine, fixing');
  });

  it('clears a sent draft even if the page unmounted before the send finished', async () => {
    const post = deferred<{ message: HubChatMessage }>();
    chat.post.mockReturnValue(post.promise);
    render(<ChatPane google={<div data-testid="google-side" />} />);
    await screen.findByText('hello 1');
    fireEvent.change(screen.getByTestId('hub-chat-composer'), { target: { value: 'bye' } });
    fireEvent.keyDown(screen.getByTestId('hub-chat-composer'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('chat-pane-google'));
    await act(async () => {
      post.resolve({ message: message(2, { authorUserId: 'alice', body: 'bye' }) });
    });
    fireEvent.click(screen.getByTestId('chat-pane-hub'));
    await screen.findByText('hello 1');
    expect((screen.getByTestId('hub-chat-composer') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('hub-chat-send').hasAttribute('disabled')).toBe(true);
  });

  it('defaults to Agent Hub and flips to Google Chat for a notification', async () => {
    render(<ChatPane google={<div data-testid="google-side" />} />);
    expect(screen.getByTestId('chat-pane-hub').getAttribute('aria-selected')).toBe('true');
    await screen.findByTestId('hub-chat-page');
    act(() => requestOpenChatSpace('AAAA'));
    expect(screen.getByTestId('google-side')).toBeTruthy();
    takePendingOpenChatSpace();
  });

  it('shows each side its own unread badge', async () => {
    render(
      <ChatPane google={<div data-testid="google-side" />} hubUnread={3} googleUnread={120} />,
    );
    expect(screen.getByTestId('chat-pane-hub-badge').textContent).toBe('3');
    expect(screen.getByTestId('chat-pane-google-badge').textContent).toBe('99+');
    await screen.findByTestId('hub-chat-page');
  });

  it('hides badges at zero', async () => {
    render(<ChatPane google={<div data-testid="google-side" />} />);
    expect(screen.queryByTestId('chat-pane-hub-badge')).toBeNull();
    expect(screen.queryByTestId('chat-pane-google-badge')).toBeNull();
    await screen.findByTestId('hub-chat-page');
  });

  it('hides the Google side when Google Chat is not connected', async () => {
    window.localStorage.setItem(CHAT_PANE_SIDE_KEY, 'google');
    resetChatPaneSideForTests();
    render(<ChatPane hubUnread={2} />);
    expect(screen.queryByTestId('chat-pane-google')).toBeNull();
    await screen.findByTestId('hub-chat-page');
  });

  it('remembers the last side chosen', async () => {
    const first = render(<ChatPane google={<div data-testid="google-side" />} />);
    fireEvent.click(screen.getByTestId('chat-pane-google'));
    expect(window.localStorage.getItem(CHAT_PANE_SIDE_KEY)).toBe('google');
    first.unmount();
    resetChatPaneSideForTests();
    render(<ChatPane google={<div data-testid="google-side" />} />);
    expect(screen.getByTestId('chat-pane-google').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('google-side')).toBeTruthy();
  });
});

describe('HubChatPage trigger messages', () => {
  it('renders a trigger message as a card instead of a text bubble', async () => {
    chat.messages.mockResolvedValue({
      messages: [
        message(1, {
          authorKind: 'trigger',
          authorUserId: null,
          body: 'Card created',
          payload: {
            type: 'trigger',
            event: 'card_created',
            triggerId: 't1',
            projectId: 'web',
            title: 'Card created',
            status: 'info',
            statusLabel: 'To Do',
            detail: 'Ship triggers',
            refs: [],
          },
        }),
      ],
      hasMore: false,
    });
    render(<HubChatPage />);
    const card = await screen.findByTestId('hub-chat-trigger-card');
    expect(card).toHaveTextContent('Ship triggers');
    expect(screen.queryByTestId('hub-chat-body')).toBeNull();
    expect(screen.getByText('Trigger')).toBeTruthy();
  });
});
