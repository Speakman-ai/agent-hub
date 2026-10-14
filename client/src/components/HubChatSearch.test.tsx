import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({ api: { hubChat: { search: vi.fn() } } }));

import HubChatSearch from './HubChatSearch';
import { api } from '../utils/api';

const search = (api as unknown as { hubChat: { search: ReturnType<typeof vi.fn> } }).hubChat.search;

const hit = {
  message: {
    id: 'm1',
    channelId: 'c1',
    seq: 4,
    authorKind: 'user',
    authorUserId: 'u-bob',
    authorAgentId: null,
    body: 'the zebra build is green',
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
  },
  channel: {
    id: 'c1',
    kind: 'channel',
    name: 'general',
    dmPeerUserId: null,
    isPrivate: false,
    isMember: true,
  },
};

beforeEach(() => search.mockReset());

function setup() {
  const onPick = vi.fn();
  render(
    <HubChatSearch usernames={new Map([['u-bob', 'bob']])} viewerUserId="u-alice" onPick={onPick}>
      <div data-testid="rail">rail</div>
    </HubChatSearch>,
  );
  return { onPick, input: screen.getByTestId('hub-chat-search-input') };
}

describe('HubChatSearch', () => {
  it('shows the rail until a query is typed, then highlighted hits that jump on click', async () => {
    search.mockResolvedValue({ results: [hit], hasMore: false });
    const { onPick, input } = setup();
    expect(screen.getByTestId('rail')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'zeb' } });
    expect(screen.queryByTestId('rail')).toBeNull();
    const row = await screen.findByTestId('hub-chat-search-result');
    expect(search).toHaveBeenCalledWith('zeb', { limit: 30 });
    expect(row.textContent).toContain('# general');
    expect(row.textContent).toContain('bob:');
    expect(row.querySelector('mark')?.textContent).toBe('zebra');

    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith(hit);
    expect(screen.getByTestId('rail')).toBeTruthy();
  });

  it('says when nothing matches and clears on Escape', async () => {
    search.mockResolvedValue({ results: [], hasMore: false });
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'nope' } });
    await screen.findByText('No messages found.');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('rail')).toBeTruthy());
  });

  it('ignores a slower earlier response', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    search
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ results: [], hasMore: false });
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'zeb' } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'zebr' } });
    await screen.findByText('No messages found.');
    resolveFirst({ results: [hit], hasMore: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('hub-chat-search-result')).toBeNull();
  });
});
