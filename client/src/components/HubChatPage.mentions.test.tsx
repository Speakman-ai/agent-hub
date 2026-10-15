import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    hubChat: {
      members: vi.fn(),
      pins: vi.fn(() => Promise.resolve({ pins: [] })),
      channels: vi.fn(),
      messages: vi.fn(),
      post: vi.fn(),
      markRead: vi.fn(),
      searchRefs: vi.fn(),
      resolveRefs: vi.fn(),
    },
  },
}));

import HubChatPage from './HubChatPage';
import { api } from '../utils/api';
import type { HubChatChannel, HubChatMessage } from '../utils/hubChat';
import { resetHubChatSessionForTests } from '../utils/hubChatSession';
import { resetHubChatRefCacheForTests } from '../utils/hubChatRefCache';

const chat = (api as unknown as { hubChat: Record<string, ReturnType<typeof vi.fn>> }).hubChat;

const GENERAL: HubChatChannel = {
  id: 'gen',
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
  lastSeq: 1,
  membership: { role: 'member', lastReadSeq: 1, notifyLevel: 'all', mutedUntil: null },
  unreadCount: 0,
  mentionCount: 0,
  agentState: null,
  mentionPending: [],
};

function message(over: Partial<HubChatMessage>): HubChatMessage {
  return {
    id: 'm1',
    channelId: 'gen',
    seq: 1,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: 'hello',
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function wsEvent(type: string, detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(type, { detail: { type, ...detail } }));
  });
}

const WEB_DEV = {
  kind: 'agent',
  targetId: 'web-dev',
  label: 'Web Dev',
  detail: 'Web',
  projectId: 'web',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetHubChatSessionForTests();
  resetHubChatRefCacheForTests();
  chat.members.mockResolvedValue({
    members: [
      { userId: 'alice', username: 'alice', role: 'User' },
      { userId: 'bob', username: 'bob', role: 'User' },
    ],
  });
  chat.channels.mockResolvedValue({ channels: [GENERAL], viewerUserId: 'alice' });
  chat.messages.mockResolvedValue({ messages: [message({})], hasMore: false });
  chat.markRead.mockResolvedValue({ lastReadSeq: 1 });
  chat.resolveRefs.mockResolvedValue({ refs: [] });
});

describe('agent mention autocomplete', () => {
  it('offers exactly the agents the server returns for the user and sends the pick', async () => {
    chat.searchRefs.mockResolvedValue({ suggestions: [WEB_DEV] });
    chat.post.mockImplementation((_id: string, body: string) =>
      Promise.resolve({
        message: message({ id: 'm2', seq: 2, authorUserId: 'alice', body }),
        mentionSessions: [{ agentId: 'web-dev', sessionId: 's1' }],
        mentionNotices: [],
      }),
    );
    render(<HubChatPage />);
    const box = (await screen.findByTestId('hub-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@we', selectionStart: 3 } });
    const popup = await screen.findByTestId('hub-chat-mention-popup');
    expect(chat.searchRefs).toHaveBeenCalledWith('@', 'we');
    // The list is the server's, which leaves out agents the user cannot use.
    expect(
      within(popup)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Web DevWebAgent']);

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('@Web Dev '));
    fireEvent.change(box, { target: { value: '@Web Dev why is CI red?', selectionStart: 23 } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(chat.post).toHaveBeenCalledWith('gen', '@[Web Dev](agent:web-dev) why is CI red?'),
    );
    expect(screen.queryByTestId('hub-chat-mention-notices')).toBeNull();
  });
});

describe('mentioned agent pending state', () => {
  it('shows who is working until the reply lands with the agent name and session chip', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello');
    expect(screen.queryByTestId('hub-chat-mention-pending')).toBeNull();

    wsEvent('hub_chat_channel_update', {
      channelId: 'gen',
      reason: 'mention_state',
      mentionPending: [
        { agentId: 'web-dev', agentName: 'Web Dev', sessionId: 's1' },
        { agentId: 'api-dev', agentName: 'API Dev', sessionId: null },
      ],
    });
    expect(screen.getByTestId('hub-chat-mention-pending').textContent).toBe(
      'Web Dev and API Dev are working…',
    );

    chat.resolveRefs.mockResolvedValue({
      refs: [
        {
          kind: 'session',
          targetId: 's1',
          visible: true,
          projectId: 'web',
          label: '@Web Dev in #general',
          title: 'Web Dev',
          status: null,
          agentId: 'web-dev',
          number: null,
        },
      ],
    });
    wsEvent('hub_chat_message', {
      channelId: 'gen',
      message: message({
        id: 'm2',
        seq: 2,
        authorKind: 'agent',
        authorUserId: null,
        authorAgentId: 'web-dev',
        authorAgentName: 'Web Dev',
        body: 'The migration timed out.\n\n@[@Web Dev in #general](session:s1)',
        refs: [{ kind: 'session', targetId: 's1', projectId: 'web' }],
        payload: { sessionId: 's1' },
      }),
    });
    wsEvent('hub_chat_channel_update', {
      channelId: 'gen',
      reason: 'mention_state',
      mentionPending: [{ agentId: 'api-dev', agentName: 'API Dev', sessionId: null }],
    });
    expect(screen.getByTestId('hub-chat-mention-pending').textContent).toBe('API Dev is working…');

    const reply = screen
      .getAllByTestId('hub-chat-message')
      .find((r) => r.getAttribute('data-message-id') === 'm2')!;
    expect(within(reply).getByText('Web Dev')).toBeTruthy();
    expect(within(reply).getByText('The migration timed out.')).toBeTruthy();
    const chip = await within(reply).findByRole('link');
    expect(chip.getAttribute('data-testid')).toBe('hub-chat-ref');
    expect(chip.textContent).toContain('@Web Dev in #general');

    wsEvent('hub_chat_channel_update', {
      channelId: 'gen',
      reason: 'mention_state',
      mentionPending: [],
    });
    expect(screen.queryByTestId('hub-chat-mention-pending')).toBeNull();
  });

  it('restores the indicator from the channel list after a reload', async () => {
    chat.channels.mockResolvedValue({
      channels: [
        {
          ...GENERAL,
          mentionPending: [{ agentId: 'web-dev', agentName: 'Web Dev', sessionId: 's1' }],
        },
      ],
      viewerUserId: 'alice',
    });
    render(<HubChatPage />);
    expect((await screen.findByTestId('hub-chat-mention-pending')).textContent).toBe(
      'Web Dev is working…',
    );
  });
});

describe('mention refusal notice', () => {
  it('shows the server notice once, from the response or the live event, until dismissed', async () => {
    const notice = {
      agentId: 'vault-dev',
      code: 'mention_forbidden',
      message: '@Vault Dev was not asked: you need access to its project to use it.',
    };
    chat.post.mockResolvedValue({
      message: message({ id: 'm2', seq: 2, authorUserId: 'alice', body: '@vault-dev hi' }),
      mentionSessions: [],
      mentionNotices: [notice],
    });
    render(<HubChatPage />);
    const box = await screen.findByTestId('hub-chat-composer');
    fireEvent.change(box, { target: { value: '@vault-dev hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const alert = await screen.findByTestId('hub-chat-mention-notices');
    expect(alert.textContent).toContain(notice.message);
    // The same notice also arrives live; it is not shown twice.
    wsEvent('hub_chat_notice', { channelId: 'gen', messageId: 'm2', ...notice });
    expect(within(alert).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByTestId('hub-chat-mention-pending')).toBeNull();

    fireEvent.click(within(alert).getByLabelText('Dismiss'));
    expect(screen.queryByTestId('hub-chat-mention-notices')).toBeNull();
  });

  it('shows a live notice for another channel only when that channel is open', async () => {
    render(<HubChatPage />);
    await screen.findByText('hello');
    wsEvent('hub_chat_notice', {
      channelId: 'other',
      messageId: 'x1',
      agentId: 'vault-dev',
      code: 'mention_forbidden',
      message: 'nope',
    });
    expect(screen.queryByTestId('hub-chat-mention-notices')).toBeNull();
  });
});
