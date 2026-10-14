import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    hubChat: {
      members: vi.fn(),
      pins: vi.fn(() => Promise.resolve({ pins: [] })),
      react: vi.fn(),
      unreact: vi.fn(),
      pin: vi.fn(),
      unpin: vi.fn(),
      channels: vi.fn(),
      messages: vi.fn(),
      markRead: vi.fn(),
      channel: vi.fn(),
      message: vi.fn(),
      join: vi.fn(),
    },
  },
}));

// The modals are covered on their own; here they only record what the pane
// handed them.
const ticketDrafts: unknown[] = [];
const seeds: Array<{ contextLabel: string; seedMessage: string }> = [];
vi.mock('./CaptureToTicketModal', () => ({
  default: (props: { draft: unknown }) => {
    ticketDrafts.push(props.draft);
    return <div data-testid="ticket-modal" />;
  },
}));
vi.mock('./StartSessionModal', () => ({
  default: (props: {
    contextLabel: string;
    seedMessage: string;
    onStarted: (s: unknown) => void;
  }) => {
    seeds.push({ contextLabel: props.contextLabel, seedMessage: props.seedMessage });
    return (
      <button
        type="button"
        data-testid="start-session"
        onClick={() => props.onStarted({ id: 's1' })}
      >
        start
      </button>
    );
  },
}));

import HubChatPage from './HubChatPage';
import { api } from '../utils/api';
import type { HubChatChannel, HubChatMessage } from '../utils/hubChat';
import { focusHubChatMessage, resetHubChatSessionForTests } from '../utils/hubChatSession';

const chat = (api as unknown as { hubChat: Record<string, ReturnType<typeof vi.fn>> }).hubChat;

function channel(over: Partial<HubChatChannel>): HubChatChannel {
  return {
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
    lastSeq: 2,
    membership: { role: 'member', lastReadSeq: 2, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}

function message(seq: number, over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id: `m${seq}`,
    channelId: 'gen',
    seq,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: `hello ${seq}`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ticketDrafts.length = 0;
  seeds.length = 0;
  resetHubChatSessionForTests();
  chat.members.mockResolvedValue({
    members: [
      { userId: 'alice', username: 'alice', role: 'User' },
      { userId: 'bob', username: 'bob', role: 'User' },
    ],
  });
  chat.channels.mockResolvedValue({ channels: [channel({})], viewerUserId: 'alice' });
  chat.messages.mockResolvedValue({
    messages: [
      message(1, { body: 'Login fails for @[carol](user:carol)' }),
      message(2, { authorUserId: 'alice', body: 'on it' }),
    ],
    hasMore: false,
  });
  chat.markRead.mockResolvedValue({ lastReadSeq: 2 });
});

function rowById(id: string) {
  return document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
}

function rowFor(text: string) {
  return screen.getByText(text, { exact: false }).closest('li') as HTMLElement;
}

describe('HubChatPage message actions', () => {
  it('creates a ticket whose provenance links back to the message', async () => {
    render(<HubChatPage />);
    await screen.findByText('on it');
    fireEvent.click(within(rowFor('Login fails')).getByLabelText('Create ticket'));

    expect(screen.getByTestId('ticket-modal')).toBeTruthy();
    const draft = ticketDrafts.at(-1) as {
      title: string;
      description: string;
      source: { sourceType: string; sourceId: string; sourceMeta: Record<string, unknown> };
    };
    expect(draft.title).toBe('Login fails for @carol');
    expect(draft.source.sourceType).toBe('hub_chat');
    expect(draft.source.sourceId).toBe('m1');
    expect(draft.source.sourceMeta).toMatchObject({
      channelId: 'gen',
      messageId: 'm1',
      from: 'bob',
    });
    expect(draft.description).toContain('#/hub/chat?channel=gen&message=m1');
  });

  it('seeds a session with the channel reference and hands the session to the app', async () => {
    const onSessionStarted = vi.fn();
    render(<HubChatPage onSessionStarted={onSessionStarted} />);
    await screen.findByText('on it');
    fireEvent.click(within(rowFor('Login fails')).getByLabelText('Send to agent'));

    const { contextLabel, seedMessage } = seeds.at(-1)!;
    expect(contextLabel).toBe('Chat: Login fails for @carol');
    expect(seedMessage).toContain('**Channel:** # general');
    expect(seedMessage).toContain('**Chat reference:** Agent Hub chat channel gen (message m1)');
    expect(seedMessage).toContain('Login fails for @[carol](user:carol)');

    fireEvent.click(screen.getByTestId('start-session'));
    expect(onSessionStarted).toHaveBeenCalledWith({ id: 's1' });
  });

  it('acts on several selected messages at once', async () => {
    render(<HubChatPage />);
    await screen.findByText('on it');
    for (const box of screen.getAllByTestId('hub-chat-message-select')) fireEvent.click(box);

    const bar = screen.getByTestId('hub-chat-selection-bar');
    expect(bar.textContent).toContain('2 selected');
    fireEvent.click(within(bar).getByText('Ticket from selected'));
    const draft = ticketDrafts.at(-1) as { source: { sourceMeta: Record<string, unknown> } };
    expect(draft.source.sourceMeta.messageIds).toEqual(['m1', 'm2']);

    fireEvent.click(within(bar).getByText('Send selected to agent'));
    expect(seeds.at(-1)!.seedMessage).toContain('(messages m1, m2)');
    fireEvent.click(screen.getByTestId('start-session'));
    expect(screen.queryByTestId('hub-chat-selection-bar')).toBeNull();
  });

  it('copies a link that reopens the message', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<HubChatPage />);
    await screen.findByText('on it');
    fireEvent.click(within(rowFor('Login fails')).getByLabelText('Copy link'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toMatch(/#\/hub\/chat\?channel=gen&message=m1$/);
    expect(await within(rowFor('Login fails')).findByLabelText('Link copied')).toBeTruthy();
  });
});

/**
 * A channel holding seqs 1..total, paged like the server: `before` returns the
 * `limit` messages just before it, no cursor the latest page.
 */
function useHistory(total: number, channelId = 'gen') {
  const all = Array.from({ length: total }, (_, i) =>
    message(i + 1, { channelId, body: `msg ${i + 1}` }),
  );
  chat.messages.mockImplementation((id: string, opts: { before?: number; limit?: number }) => {
    if (id !== channelId) return Promise.resolve({ messages: [], hasMore: false });
    const end = (opts?.before ?? total + 1) - 1;
    const start = Math.max(1, end - (opts?.limit ?? 50) + 1);
    return Promise.resolve({ messages: all.slice(start - 1, end), hasMore: start > 1 });
  });
  chat.message.mockImplementation((id: string) => {
    const found = all.find((m) => m.id === id);
    return found
      ? Promise.resolve({ message: found })
      : Promise.reject(Object.assign(new Error('404: Message not found'), { status: 404 }));
  });
}

const GONE = 'The linked message is no longer in this conversation.';

describe('HubChatPage message links', () => {
  it('loads history back to a linked message and highlights it', async () => {
    useHistory(500);
    act(() => focusHubChatMessage('gen', 'm120'));
    render(<HubChatPage />);
    await waitFor(() => expect(rowById('m120').dataset.highlighted).toBe('true'));
    expect(chat.message).toHaveBeenCalledWith('m120');
    // Latest page is 451..500; three pages of 100 reach 120.
    expect(chat.messages).toHaveBeenCalledWith('gen', { before: 451, limit: 100 });
    expect(chat.messages).toHaveBeenCalledWith('gen', { before: 151, limit: 100 });
    expect(chat.messages).not.toHaveBeenCalledWith('gen', { before: 51, limit: 100 });
  });

  it('handles several links in the same channel independently', async () => {
    useHistory(500);
    act(() => focusHubChatMessage('gen', 'm400'));
    render(<HubChatPage />);
    await waitFor(() => expect(rowById('m400').dataset.highlighted).toBe('true'));
    act(() => focusHubChatMessage('gen', 'm5'));
    await waitFor(() => expect(rowById('m5').dataset.highlighted).toBe('true'));
    expect(screen.queryByText(GONE)).toBeNull();
  });

  it('offers to keep loading when the message is further back than one step', async () => {
    // 10 pages of 100 per step: m50 is 1,100 messages behind the latest page.
    useHistory(1200);
    act(() => focusHubChatMessage('gen', 'm50'));
    render(<HubChatPage />);
    const banner = await screen.findByTestId('hub-chat-seek-pending', {}, { timeout: 10_000 });
    expect(banner.textContent).toContain('messages further back');
    expect(screen.queryByText(GONE)).toBeNull();

    fireEvent.click(within(banner).getByText('Keep loading'));
    await waitFor(() => expect(rowById('m50').dataset.highlighted).toBe('true'), {
      timeout: 10_000,
    });
    expect(screen.queryByTestId('hub-chat-seek-pending')).toBeNull();
  }, 30_000);

  it('reports a missing message without paging through the history', async () => {
    useHistory(500);
    act(() => focusHubChatMessage('gen', 'missing'));
    render(<HubChatPage />);
    expect(await screen.findByText(GONE)).toBeTruthy();
    expect(chat.messages).toHaveBeenCalledTimes(1);
  });

  it('says the lookup failed rather than that the message is gone', async () => {
    useHistory(500);
    chat.message.mockRejectedValue(Object.assign(new Error('500: boom'), { status: 500 }));
    act(() => focusHubChatMessage('gen', 'm1'));
    render(<HubChatPage />);
    expect(await screen.findByText('Could not load the linked message: 500: boom')).toBeTruthy();
    expect(screen.queryByText(GONE)).toBeNull();
  });

  it('follows a message whose link named the wrong channel', async () => {
    chat.channels.mockResolvedValue({
      channels: [channel({}), channel({ id: 'ops', name: 'ops' })],
      viewerUserId: 'alice',
    });
    useHistory(10, 'ops');
    act(() => focusHubChatMessage('gen', 'm3'));
    render(<HubChatPage />);
    await waitFor(() => expect(rowById('m3').dataset.highlighted).toBe('true'));
  });

  it('lets the latest link win over an earlier lookup that resolves late', async () => {
    useHistory(500);
    render(<HubChatPage />);
    await waitFor(() => expect(rowById('m500')).toBeTruthy());
    let resolveLookup: (v: unknown) => void = () => {};
    chat.message.mockImplementationOnce(() => new Promise((resolve) => (resolveLookup = resolve)));
    act(() => focusHubChatMessage('gen', 'm120'));
    await waitFor(() => expect(chat.message).toHaveBeenCalledWith('m120'));
    act(() => focusHubChatMessage('gen', 'm480'));
    await waitFor(() => expect(rowById('m480').dataset.highlighted).toBe('true'));

    await act(async () => resolveLookup({ message: message(120, { body: 'msg 120' }) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(rowById('m480').dataset.highlighted).toBe('true');
    expect(rowById('m120')).toBeNull();
    expect(chat.messages).toHaveBeenCalledTimes(1);
  });

  it('lets the latest link win over an earlier history load that resolves late', async () => {
    useHistory(500);
    render(<HubChatPage />);
    await waitFor(() => expect(rowById('m500')).toBeTruthy());
    const pageFor = chat.messages.getMockImplementation() as (
      id: string,
      opts: { before?: number; limit?: number },
    ) => Promise<unknown>;
    let resolvePage: () => void = () => {};
    chat.messages.mockImplementationOnce(
      (id: string, opts: { before?: number; limit?: number }) =>
        new Promise((resolve) => (resolvePage = () => resolve(pageFor(id, opts)))),
    );
    act(() => focusHubChatMessage('gen', 'm120'));
    await waitFor(() => expect(chat.messages).toHaveBeenCalledTimes(2));
    act(() => focusHubChatMessage('gen', 'm470'));
    await waitFor(() => expect(rowById('m470').dataset.highlighted).toBe('true'));

    await act(async () => resolvePage());
    await new Promise((r) => setTimeout(r, 20));
    // The page lands (it is real history) but the old link stops there.
    expect(rowById('m400')).toBeTruthy();
    expect(chat.messages).toHaveBeenCalledTimes(2);
    expect(rowById('m470').dataset.highlighted).toBe('true');
    expect(screen.queryByText(GONE)).toBeNull();
  });

  it('opens a public channel the viewer is not in the rail for', async () => {
    chat.channel.mockResolvedValue({
      channel: channel({ id: 'ops', name: 'ops', membership: null }),
      members: [],
    });
    useHistory(3, 'ops');
    render(<HubChatPage />);
    await screen.findByTestId('hub-chat-channel-gen');
    act(() => focusHubChatMessage('ops', 'm1'));
    await screen.findByText('msg 1');
    expect(chat.channel).toHaveBeenCalledWith('ops');
    await waitFor(() => expect(rowById('m1').dataset.highlighted).toBe('true'));
  });
});
