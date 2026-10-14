import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HubChatBacklinks from './HubChatBacklinks';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: { hubChat: { backlinks: vi.fn() } },
}));

const backlinks = api.hubChat.backlinks as unknown as ReturnType<typeof vi.fn>;

function link(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'm1',
    channelId: 'c1',
    channelKind: 'channel',
    channelLabel: '# general',
    authorKind: 'user',
    authorName: 'alice',
    excerpt: 'Looking at #WEB-1 now',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function emit(type: string, message: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(type, { detail: { message } }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backlinks.mockResolvedValue({ backlinks: [] });
});

describe('HubChatBacklinks', () => {
  it('renders nothing when the entity has no visible backlinks', async () => {
    render(<HubChatBacklinks kind="card" targetId="card-1" />);
    await waitFor(() => expect(backlinks).toHaveBeenCalledWith('card', 'card-1'));
    expect(screen.queryByTestId('hub-chat-backlinks')).toBeNull();
  });

  it('lists backlinks that link to the chat message', async () => {
    backlinks.mockResolvedValue({ backlinks: [link()] });
    render(<HubChatBacklinks kind="card" targetId="card-1" />);
    const row = await screen.findByTestId('hub-chat-backlink');
    expect(screen.getByText('Discussed in chat (1)')).toBeInTheDocument();
    expect(row).toHaveAttribute('href', '#/hub/chat?channel=c1&message=m1');
    expect(row).toHaveTextContent('# general');
    expect(row).toHaveTextContent('Looking at #WEB-1 now');
  });

  it('refetches when a live message references the entity', async () => {
    render(<HubChatBacklinks kind="card" targetId="card-1" />);
    await waitFor(() => expect(backlinks).toHaveBeenCalledTimes(1));
    backlinks.mockResolvedValue({ backlinks: [link({ messageId: 'm2' })] });

    emit('hub_chat_message', { id: 'x', refs: [{ kind: 'card', targetId: 'other' }] });
    expect(backlinks).toHaveBeenCalledTimes(1);

    emit('hub_chat_message', { id: 'm2', refs: [{ kind: 'card', targetId: 'card-1' }] });
    await screen.findByTestId('hub-chat-backlink');
    expect(backlinks).toHaveBeenCalledTimes(2);
  });

  it('refetches when a listed message is edited', async () => {
    backlinks.mockResolvedValue({ backlinks: [link()] });
    render(<HubChatBacklinks kind="card" targetId="card-1" />);
    await screen.findByTestId('hub-chat-backlink');
    backlinks.mockResolvedValue({ backlinks: [] });
    emit('hub_chat_message_update', { id: 'm1', refs: [], deletedAt: null });
    await waitFor(() => expect(screen.queryByTestId('hub-chat-backlink')).toBeNull());
  });

  it('menu variant shows a count chip that opens the list', async () => {
    backlinks.mockResolvedValue({ backlinks: [link(), link({ messageId: 'm2' })] });
    render(<HubChatBacklinks kind="session" targetId="s1" variant="menu" />);
    const toggle = await screen.findByTestId('hub-chat-backlinks-toggle');
    expect(toggle).toHaveTextContent('2');
    expect(screen.queryByTestId('hub-chat-backlinks')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('hub-chat-backlink')).toHaveLength(2);
  });

  it('ignores an older response that resolves after a newer one', async () => {
    let resolveFirst!: (v: unknown) => void;
    backlinks.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    render(<HubChatBacklinks kind="card" targetId="card-1" />);
    await waitFor(() => expect(backlinks).toHaveBeenCalledTimes(1));

    backlinks.mockResolvedValueOnce({ backlinks: [link()] });
    emit('hub_chat_message', { id: 'm1', refs: [{ kind: 'card', targetId: 'card-1' }] });
    await screen.findByTestId('hub-chat-backlink');

    await act(async () => resolveFirst({ backlinks: [] }));
    expect(screen.getByTestId('hub-chat-backlink')).toBeInTheDocument();
  });

  it('drops the previous target rows while the next target loads', async () => {
    backlinks.mockResolvedValueOnce({ backlinks: [link({ channelLabel: '# session-a' })] });
    const { rerender } = render(<HubChatBacklinks kind="session" targetId="a" variant="menu" />);
    fireEvent.click(await screen.findByTestId('hub-chat-backlinks-toggle'));
    expect(screen.getByText('# session-a')).toBeInTheDocument();

    let resolveB!: (v: unknown) => void;
    backlinks.mockReturnValueOnce(new Promise((r) => (resolveB = r)));
    rerender(<HubChatBacklinks kind="session" targetId="b" variant="menu" />);
    expect(backlinks).toHaveBeenLastCalledWith('session', 'b');
    expect(screen.queryByTestId('hub-chat-backlinks-toggle')).toBeNull();
    expect(screen.queryByText('# session-a')).toBeNull();

    await act(async () =>
      resolveB({ backlinks: [link({ messageId: 'm9', channelLabel: '# session-b' })] }),
    );
    const toggle = screen.getByTestId('hub-chat-backlinks-toggle');
    expect(screen.queryByTestId('hub-chat-backlinks')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('# session-b')).toBeInTheDocument();
    expect(screen.queryByText('# session-a')).toBeNull();
  });
});
