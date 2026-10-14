import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({ api: { hubChat: { pins: vi.fn() } } }));

import { HubChatPinsButton, HubChatReactionBar, useHubChatPins } from './HubChatReactions';
import type { ComponentProps } from 'react';
import { api } from '../utils/api';

const pins = (api as unknown as { hubChat: { pins: ReturnType<typeof vi.fn> } }).hubChat.pins;

const message = (id: string, body: string) => ({
  id,
  channelId: 'c1',
  seq: 1,
  authorKind: 'user',
  authorUserId: 'u-bob',
  authorAgentId: null,
  body,
  refs: [],
  payload: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-10-13T10:00:00.000Z',
});

const usernames = new Map([
  ['u-bob', 'bob'],
  ['u-alice', 'alice'],
]);

beforeEach(() => pins.mockReset());

/** The header button wired to the pins hook, as HubChatPage does. */
function Pins(props: Omit<ComponentProps<typeof HubChatPinsButton>, 'pins'>) {
  const state = useHubChatPins(props.channelId);
  return <HubChatPinsButton {...props} pins={state} />;
}

describe('HubChatReactionBar', () => {
  it('marks the viewer’s reactions and toggles on click', () => {
    const onToggle = vi.fn();
    render(
      <HubChatReactionBar
        reactions={[
          { emoji: '👍', count: 2, userIds: ['u-bob', 'u-alice'] },
          { emoji: '🎉', count: 1, userIds: ['u-bob'] },
        ]}
        usernames={usernames}
        viewerUserId="u-alice"
        canReact
        onToggle={onToggle}
      />,
    );
    const [thumbs, party] = screen.getAllByTestId('hub-chat-reaction');
    expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    expect(thumbs).toHaveAttribute('title', 'bob, You');
    expect(party).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(party!);
    expect(onToggle).toHaveBeenCalledWith('🎉');
  });
});

describe('HubChatPinsButton', () => {
  it('lists pins and refetches when a pin changes live', async () => {
    pins.mockResolvedValueOnce({
      pins: [
        {
          message: message('m1', 'runbook'),
          pinnedByUserId: 'u-alice',
          pinnedAt: '2026-10-13T10:00:00.000Z',
        },
      ],
    });
    const onPick = vi.fn();
    render(
      <Pins channelId="c1" usernames={usernames} canUnpin onPick={onPick} onUnpin={vi.fn()} />,
    );
    const button = screen.getByTestId('hub-chat-pins-button');
    await waitFor(() => expect(button).toHaveAttribute('aria-label', 'Pinned messages (1)'));

    pins.mockResolvedValueOnce({
      pins: [
        {
          message: message('m2', 'deploy notes'),
          pinnedByUserId: 'u-bob',
          pinnedAt: '2026-10-13T11:00:00.000Z',
        },
        {
          message: message('m1', 'runbook'),
          pinnedByUserId: 'u-alice',
          pinnedAt: '2026-10-13T10:00:00.000Z',
        },
      ],
    });
    // Another channel's pin change is ignored.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('hub_chat_message_meta', {
          detail: {
            messageId: 'x',
            channelId: 'c2',
            metaRev: 1,
            reactions: [],
            pinned: null,
            pinChanged: true,
          },
        }),
      );
    });
    expect(pins).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('hub_chat_message_meta', {
          detail: {
            messageId: 'm2',
            channelId: 'c1',
            metaRev: 1,
            reactions: [],
            pinned: { byUserId: 'u-bob', at: '2026-10-13T11:00:00.000Z' },
            pinChanged: true,
          },
        }),
      );
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-label', 'Pinned messages (2)'));

    fireEvent.click(button);
    const items = screen.getAllByTestId('hub-chat-pin');
    expect(items[0]).toHaveTextContent('deploy notes');
    expect(items[0]).toHaveTextContent('Pinned by bob');
    fireEvent.click(screen.getByText('deploy notes'));
    expect(onPick).toHaveBeenCalledWith('m2');
  });

  it('drops a stale response that lands after a newer one', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    pins.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    pins.mockResolvedValueOnce({
      pins: [
        {
          message: message('m1', 'kept'),
          pinnedByUserId: null,
          pinnedAt: '2026-10-13T10:00:00.000Z',
        },
      ],
    });
    render(
      <Pins
        channelId="c1"
        usernames={usernames}
        canUnpin={false}
        onPick={vi.fn()}
        onUnpin={vi.fn()}
      />,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent('hub_chat_message_meta', {
          detail: {
            messageId: 'm1',
            channelId: 'c1',
            metaRev: 1,
            reactions: [],
            pinned: { byUserId: 'u-bob', at: '2026-10-13T10:00:00.000Z' },
            pinChanged: true,
          },
        }),
      );
    });
    const button = screen.getByTestId('hub-chat-pins-button');
    await waitFor(() => expect(button).toHaveAttribute('aria-label', 'Pinned messages (1)'));
    await act(async () => resolveFirst({ pins: [] }));
    expect(button).toHaveAttribute('aria-label', 'Pinned messages (1)');
  });

  it('shows an edit of a pinned message without reloading, and drops a deleted one', async () => {
    pins.mockResolvedValueOnce({
      pins: [
        {
          message: message('m1', 'old text'),
          pinnedByUserId: 'u-alice',
          pinnedAt: '2026-10-13T10:00:00.000Z',
        },
      ],
    });
    render(
      <Pins channelId="c1" usernames={usernames} canUnpin onPick={vi.fn()} onUnpin={vi.fn()} />,
    );
    const button = screen.getByTestId('hub-chat-pins-button');
    await waitFor(() => expect(button).toHaveAttribute('aria-label', 'Pinned messages (1)'));
    fireEvent.click(button);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('hub_chat_message_update', {
          detail: {
            message: { ...message('m1', 'new text'), editedAt: '2026-10-13T10:30:00.000Z' },
          },
        }),
      );
    });
    expect(screen.getByTestId('hub-chat-pin')).toHaveTextContent('new text');
    expect(pins).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('hub_chat_message_update', {
          detail: { message: { ...message('m1', ''), deletedAt: '2026-10-13T10:40:00.000Z' } },
        }),
      );
    });
    expect(button).toHaveAttribute('aria-label', 'Pinned messages');
  });

  it('keeps a live edit when a pins response fetched before it lands afterwards', async () => {
    let resolveSecond: (v: unknown) => void = () => {};
    const listed = {
      message: message('m1', 'old text'),
      pinnedByUserId: 'u-alice',
      pinnedAt: '2026-10-13T10:00:00.000Z',
    };
    pins.mockResolvedValueOnce({ pins: [listed] });
    pins.mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
    render(
      <Pins channelId="c1" usernames={usernames} canUnpin onPick={vi.fn()} onUnpin={vi.fn()} />,
    );
    const button = screen.getByTestId('hub-chat-pins-button');
    await waitFor(() => expect(button).toHaveAttribute('aria-label', 'Pinned messages (1)'));
    // A refetch goes out (reconnect), then the edit arrives before it returns.
    act(() => {
      window.dispatchEvent(new Event('agenthub:ws_reconnected'));
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('hub_chat_message_update', {
          detail: {
            message: { ...message('m1', 'new text'), editedAt: '2026-10-13T10:30:00.000Z' },
          },
        }),
      );
    });
    await act(async () => resolveSecond({ pins: [listed] }));
    fireEvent.click(button);
    expect(screen.getByTestId('hub-chat-pin')).toHaveTextContent('new text');
  });
});
