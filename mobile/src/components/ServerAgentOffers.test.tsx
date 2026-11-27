import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../utils/api', () => ({
  api: { listServerAgentOffers: vi.fn(), actOnServerAgentOffer: vi.fn() },
}));
const offerListeners = new Set<(e: unknown) => void>();
const subscribeServerAgentOffers = (l: (e: unknown) => void) => {
  offerListeners.add(l);
  return () => offerListeners.delete(l);
};
vi.mock('../context/AppContext', () => ({ useApp: () => ({ subscribeServerAgentOffers }) }));

const { OfferCard, SuggestedForYouStrip } = await import('./ServerAgentOffers');
const { api } = (await import('../utils/api')) as unknown as {
  api: Record<string, ReturnType<typeof vi.fn>>;
};
import type { ProactiveOffer } from '@shared/utils/serverAgentProactive';

const offer: ProactiveOffer = {
  id: 'o1',
  kind: 'finalize_failed',
  area: 'dev',
  title: 'Fix Finalize',
  reason: 'lint failed',
  action: 'open the session',
  urgency: 'high',
  status: 'open',
  source: 'scheduled',
  target: {},
  createdAt: '2026-11-27T10:00:00Z',
  updatedAt: '2026-11-27T10:00:00Z',
  expiresAt: null,
  snoozedUntil: null,
  actedAt: null,
  actionSessionId: null,
  revision: 1,
};

let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));

function texts(): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .map((t) => [].concat(t.props.children).join(''));
}

describe('mobile OfferCard', () => {
  it('shows the offer and sends each of the three actions', () => {
    const onAct = vi.fn();
    act(() => {
      renderer = TestRenderer.create(React.createElement(OfferCard, { offer, onAct }));
    });
    expect(texts()).toEqual(
      expect.arrayContaining(['Fix Finalize', 'Do it', 'Not now', 'Never for this kind']),
    );
    for (const [id, action] of [
      ['server-agent-offer-accept', 'accept'],
      ['server-agent-offer-snooze', 'snooze'],
      ['server-agent-offer-never', 'never'],
    ] as const) {
      act(() => renderer.root.findByProps({ testID: id }).props.onPress());
      expect(onAct).toHaveBeenLastCalledWith(action);
    }
    expect(onAct).toHaveBeenCalledTimes(3);
  });

  it('disables every button while an action is in flight', () => {
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(OfferCard, { offer, onAct: vi.fn(), busyAction: 'accept' }),
      );
    });
    for (const id of [
      'server-agent-offer-accept',
      'server-agent-offer-snooze',
      'server-agent-offer-never',
    ]) {
      expect(renderer.root.findByProps({ testID: id }).props.disabled).toBe(true);
    }
    expect(texts()).toContain('Starting…');
  });
});

describe('mobile SuggestedForYouStrip', () => {
  it('renders offers and opens the Server Agent after Do it', async () => {
    api.listServerAgentOffers.mockResolvedValue({ offers: [offer] });
    api.actOnServerAgentOffer.mockResolvedValue({
      offer: { ...offer, status: 'accepted', revision: 2 },
    });
    const onOpen = vi.fn();
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(SuggestedForYouStrip, { onOpenServerAgent: onOpen }),
      );
    });
    expect(texts()).toContain('Suggested for you');
    await act(async () => {
      renderer.root.findByProps({ testID: 'server-agent-offer-accept' }).props.onPress();
    });
    expect(api.actOnServerAgentOffer).toHaveBeenCalledWith('o1', 'accept');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without offers', async () => {
    api.listServerAgentOffers.mockResolvedValue({ offers: [] });
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SuggestedForYouStrip, {}));
    });
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('mobile offers with a list fetch in flight', () => {
  function slowList() {
    let resolve: (v: { offers: ProactiveOffer[] }) => void = () => undefined;
    api.listServerAgentOffers.mockImplementation(() => new Promise((r) => (resolve = r)));
    return (offers: ProactiveOffer[]) => resolve({ offers });
  }
  const emit = (event: unknown) => act(() => offerListeners.forEach((l) => l(event)));

  it('keeps an offer created before an older empty response lands', async () => {
    const respond = slowList();
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SuggestedForYouStrip, {}));
    });
    emit({ offer: { ...offer, id: 'new', title: 'Brand new' } });
    await act(async () => respond([]));
    expect(texts()).toContain('Brand new');
  });

  it('does not revive an offer accepted before an older response lands', async () => {
    const respond = slowList();
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SuggestedForYouStrip, {}));
    });
    emit({ offer: { ...offer, status: 'accepted', revision: 2 } });
    await act(async () => respond([offer, { ...offer, id: 'o2', title: 'Other' }]));
    expect(texts()).not.toContain('Fix Finalize');
    expect(texts()).toContain('Other');
  });
});

describe('mobile action response vs live events', () => {
  it('a reopen event that beats the slow accept response keeps the card', async () => {
    api.listServerAgentOffers.mockReset().mockResolvedValue({ offers: [offer] });
    let respond: (v: unknown) => void = () => undefined;
    api.actOnServerAgentOffer
      .mockReset()
      .mockImplementation(() => new Promise((r) => (respond = r)));
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SuggestedForYouStrip, {}));
    });
    act(() => renderer.root.findByProps({ testID: 'server-agent-offer-accept' }).props.onPress());
    act(() =>
      offerListeners.forEach((l) => l({ offer: { ...offer, status: 'open', revision: 4 } })),
    );
    await act(async () => respond({ offer: { ...offer, status: 'accepted', revision: 2 } }));
    expect(texts()).toContain('Fix Finalize');
  });
});
