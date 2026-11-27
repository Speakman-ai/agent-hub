import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import type { ProactiveOffer } from '@shared/utils/serverAgentProactive';

(vi as any).mock('../utils/api', () => ({
  api: {
    listServerAgentOffers: vi.fn(),
    actOnServerAgentOffer: vi.fn(),
  },
}));

import { api } from '../utils/api';
import { ServerAgentOffers, SuggestedForYouStrip } from './ServerAgentOffers';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function offer(id: string, over: Partial<ProactiveOffer> = {}): ProactiveOffer {
  return {
    id,
    kind: 'finalize_failed',
    area: 'dev',
    title: `Fix ${id}`,
    reason: 'lint failed',
    action: 'open the session',
    urgency: 'normal',
    status: 'open',
    source: 'scheduled',
    target: { sessionId: 's1' },
    createdAt: '2026-11-27T10:00:00Z',
    updatedAt: '2026-11-27T10:00:00Z',
    expiresAt: null,
    snoozedUntil: null,
    actedAt: null,
    actionSessionId: null,
    revision: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.listServerAgentOffers.mockResolvedValue({ offers: [offer('a'), offer('b')] });
});
afterEach(() => cleanup());

describe('ServerAgentOffers', () => {
  it('renders nothing without offers', async () => {
    mocked.listServerAgentOffers.mockResolvedValue({ offers: [] });
    const { container } = render(<ServerAgentOffers />);
    await waitFor(() => expect(mocked.listServerAgentOffers).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('Do it accepts the offer and removes the card', async () => {
    mocked.actOnServerAgentOffer.mockResolvedValue({
      offer: offer('a', { status: 'accepted', revision: 2 }),
      sessionId: 'hub-1',
      suppression: null,
    });
    render(<ServerAgentOffers />);
    await screen.findByText('Fix a');
    fireEvent.click(screen.getAllByTestId('server-agent-offer-accept')[0]);
    await waitFor(() => expect(mocked.actOnServerAgentOffer).toHaveBeenCalledWith('a', 'accept'));
    await waitFor(() => expect(screen.queryByText('Fix a')).toBeNull());
    expect(screen.getByText('Fix b')).toBeTruthy();
  });

  it('Not now snoozes the offer', async () => {
    mocked.actOnServerAgentOffer.mockResolvedValue({
      offer: offer('b', { status: 'dismissed', revision: 2 }),
      sessionId: null,
      suppression: null,
    });
    render(<ServerAgentOffers />);
    await screen.findByText('Fix b');
    fireEvent.click(screen.getAllByTestId('server-agent-offer-snooze')[1]);
    await waitFor(() => expect(mocked.actOnServerAgentOffer).toHaveBeenCalledWith('b', 'snooze'));
    await waitFor(() => expect(screen.queryByText('Fix b')).toBeNull());
  });

  it('Never for this kind removes every card of that kind', async () => {
    mocked.listServerAgentOffers.mockResolvedValue({
      offers: [offer('a'), offer('b'), offer('c', { kind: 'stale_card' })],
    });
    mocked.actOnServerAgentOffer.mockResolvedValue({
      offer: offer('a', { status: 'suppressed', revision: 2 }),
      sessionId: null,
      suppression: {
        id: 'r',
        kind: 'finalize_failed',
        label: 'Failed Finalize runs',
        createdAt: '',
      },
    });
    render(<ServerAgentOffers />);
    await screen.findByText('Fix a');
    fireEvent.click(screen.getAllByTestId('server-agent-offer-never')[0]);
    await waitFor(() => expect(mocked.actOnServerAgentOffer).toHaveBeenCalledWith('a', 'never'));
    await waitFor(() => expect(screen.queryByText('Fix b')).toBeNull());
    expect(screen.getByText('Fix c')).toBeTruthy();
  });

  it('adds offers from the live event', async () => {
    render(<ServerAgentOffers />);
    await screen.findByText('Fix a');
    act(() => {
      window.dispatchEvent(
        new CustomEvent('server_agent_offer_update', {
          detail: { action: 'created', offer: offer('z', { urgency: 'urgent' }) },
        }),
      );
    });
    expect(await screen.findByText('Fix z')).toBeTruthy();
  });
});

describe('SuggestedForYouStrip', () => {
  it('stays hidden with no offers', async () => {
    mocked.listServerAgentOffers.mockResolvedValue({ offers: [] });
    render(<SuggestedForYouStrip />);
    await waitFor(() => expect(mocked.listServerAgentOffers).toHaveBeenCalled());
    expect(screen.queryByTestId('suggested-for-you')).toBeNull();
  });

  it('shows compact cards and opens the Server Agent after Do it', async () => {
    const onOpen = vi.fn();
    mocked.actOnServerAgentOffer.mockResolvedValue({
      offer: offer('a', { status: 'accepted', revision: 2 }),
      sessionId: 'hub-1',
      suppression: null,
    });
    render(<SuggestedForYouStrip onOpenServerAgent={onOpen} />);
    expect(await screen.findByText('Suggested for you')).toBeTruthy();
    expect(screen.queryByText(/Plan:/)).toBeNull();
    fireEvent.click(screen.getAllByTestId('server-agent-offer-accept')[0]);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });
});

describe('ServerAgentOffers with a list fetch in flight', () => {
  function slowList() {
    let resolve: (v: { offers: ProactiveOffer[] }) => void = () => undefined;
    mocked.listServerAgentOffers.mockImplementation(() => new Promise((r) => (resolve = r)));
    return (offers: ProactiveOffer[]) => resolve({ offers });
  }

  const emit = (detail: unknown) =>
    act(() => {
      window.dispatchEvent(new CustomEvent('server_agent_offer_update', { detail }));
    });

  it('keeps an offer created before an older empty response lands', async () => {
    const respond = slowList();
    render(<ServerAgentOffers />);
    await waitFor(() => expect(mocked.listServerAgentOffers).toHaveBeenCalled());
    emit({ action: 'created', offer: offer('new') });
    await act(async () => respond([]));
    expect(screen.getByText('Fix new')).toBeTruthy();
  });

  it('does not revive an offer accepted before an older response lands', async () => {
    const respond = slowList();
    render(<ServerAgentOffers />);
    await waitFor(() => expect(mocked.listServerAgentOffers).toHaveBeenCalled());
    emit({ action: 'updated', offer: offer('a', { status: 'accepted', revision: 2 }) });
    await act(async () => respond([offer('a'), offer('b')]));
    expect(screen.queryByText('Fix a')).toBeNull();
    expect(screen.getByText('Fix b')).toBeTruthy();
  });
});

describe('ServerAgentOffers action response vs live events', () => {
  it('a reopen event that beats the slow accept response keeps the card', async () => {
    mocked.listServerAgentOffers.mockResolvedValue({ offers: [offer('a')] });
    let respond: (v: unknown) => void = () => undefined;
    mocked.actOnServerAgentOffer.mockImplementation(() => new Promise((r) => (respond = r)));
    render(<ServerAgentOffers />);
    await screen.findByText('Fix a');
    fireEvent.click(screen.getByTestId('server-agent-offer-accept'));
    // The dispatch failed after the grace window: the server reopened it (rev 4)…
    act(() => {
      window.dispatchEvent(
        new CustomEvent('server_agent_offer_update', {
          detail: { action: 'updated', offer: offer('a', { status: 'open', revision: 4 }) },
        }),
      );
    });
    // …and only then does the HTTP response with the accepted copy (rev 2) land.
    await act(async () =>
      respond({
        offer: offer('a', { status: 'accepted', revision: 2 }),
        sessionId: 's',
        suppression: null,
      }),
    );
    expect(screen.getByText('Fix a')).toBeTruthy();
    expect(screen.getByTestId('server-agent-offer-accept')).not.toHaveProperty('disabled', true);
  });
});
