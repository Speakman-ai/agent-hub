import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../utils/api';
import { OfferListSync } from '@shared/utils/offerListSync';
import {
  PROACTIVE_OFFER_BUTTON_LABELS,
  PROACTIVE_OFFER_EVENT,
  proactiveKindLabel,
  type ProactiveOffer,
  type ProactiveOfferAction,
} from '@shared/utils/serverAgentProactive';

/**
 * The caller's open Server Agent offers, kept live by the owner-only
 * `server_agent_offer_update` event (bridged to a window event in App.tsx).
 * `OfferListSync` replays events that arrive while a list fetch is in flight,
 * so an older snapshot can't drop a new offer or revive an accepted one.
 */
export function useServerAgentOffers() {
  const [offers, setOffers] = useState<ProactiveOffer[]>([]);
  const [sync] = useState(() => new OfferListSync(setOffers));
  const [busy, setBusy] = useState<Record<string, ProactiveOfferAction>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const token = sync.beginFetch();
    try {
      const res = await api.listServerAgentOffers('open');
      sync.snapshot(token, res.offers);
    } catch {
      // The list stays as it was; the next event or reload refreshes it.
      sync.fail(token);
    }
  }, [sync]);

  useEffect(() => {
    const onUpdate = (e: Event) => {
      sync.update((e as CustomEvent).detail as { offer?: ProactiveOffer; offerId?: string });
    };
    window.addEventListener(PROACTIVE_OFFER_EVENT, onUpdate);
    void reload();
    return () => window.removeEventListener(PROACTIVE_OFFER_EVENT, onUpdate);
  }, [reload, sync]);

  const act = useCallback(
    async (offer: ProactiveOffer, action: ProactiveOfferAction) => {
      setBusy((b) => ({ ...b, [offer.id]: action }));
      setError(null);
      try {
        const res = await api.actOnServerAgentOffer(offer.id, action);
        sync.update({ offer: res.offer });
        if (action === 'never') sync.removeKind(offer.kind);
        return res;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update the offer.');
        void reload();
        return null;
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[offer.id];
          return next;
        });
      }
    },
    [reload, sync],
  );

  return { offers, busy, error, act, reload };
}

const URGENCY_STYLES: Record<ProactiveOffer['urgency'], string> = {
  urgent: 'border-red-700 bg-red-950/30',
  high: 'border-amber-700 bg-amber-950/20',
  normal: 'border-cyan-900 bg-gray-900',
  low: 'border-gray-800 bg-gray-900',
};

export function OfferCard({
  offer,
  busyAction,
  onAct,
  compact = false,
}: {
  offer: ProactiveOffer;
  busyAction?: ProactiveOfferAction;
  onAct: (action: ProactiveOfferAction) => void;
  compact?: boolean;
}) {
  const disabled = busyAction !== undefined;
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${URGENCY_STYLES[offer.urgency]} ${compact ? 'min-w-[260px] max-w-[320px] shrink-0' : ''}`}
      data-testid="server-agent-offer"
      data-offer-id={offer.id}
    >
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-gray-500">
        <Sparkles size={12} className="text-cyan-400" />
        <span>{proactiveKindLabel(offer.kind)}</span>
        {offer.urgency === 'urgent' && <span className="text-red-400">urgent</span>}
      </div>
      <div className="mt-1 text-sm font-medium text-white" data-testid="server-agent-offer-title">
        {offer.title}
      </div>
      {offer.reason && <div className="mt-0.5 text-xs text-gray-400">{offer.reason}</div>}
      {!compact && offer.action && (
        <div className="mt-1 text-xs text-gray-500">Plan: {offer.action}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct('accept')}
          data-testid="server-agent-offer-accept"
          className="rounded-md bg-cyan-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
        >
          {busyAction === 'accept' ? 'Starting…' : PROACTIVE_OFFER_BUTTON_LABELS.accept}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct('snooze')}
          data-testid="server-agent-offer-snooze"
          className="rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
        >
          {PROACTIVE_OFFER_BUTTON_LABELS.snooze}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct('never')}
          data-testid="server-agent-offer-never"
          className="px-1 py-1 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50"
        >
          {PROACTIVE_OFFER_BUTTON_LABELS.never}
        </button>
      </div>
    </div>
  );
}

/** Offer cards docked at the top of the Server Agent thread. */
export function ServerAgentOffers() {
  const { offers, busy, error, act } = useServerAgentOffers();
  if (offers.length === 0 && !error) return null;
  return (
    <div
      className="max-h-[40vh] shrink-0 space-y-2 overflow-y-auto border-b border-gray-800 px-4 py-2"
      data-testid="server-agent-offers"
    >
      {error && (
        <div role="alert" className="text-xs text-red-400">
          {error}
        </div>
      )}
      {offers.map((offer) => (
        <OfferCard
          key={offer.id}
          offer={offer}
          busyAction={busy[offer.id]}
          onAct={(action) => void act(offer, action)}
        />
      ))}
    </div>
  );
}

/**
 * "Suggested for you": compact, horizontally scrolling offer cards for the
 * Hub dashboard. Hidden when there is nothing to suggest.
 */
export function SuggestedForYouStrip({ onOpenServerAgent }: { onOpenServerAgent?: () => void }) {
  const { offers, busy, error, act } = useServerAgentOffers();
  if (offers.length === 0) return null;
  return (
    <section className="mb-5" data-testid="suggested-for-you">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={14} className="text-cyan-400" />
        <h2 className="flex-1 text-sm font-medium text-white">Suggested for you</h2>
        {onOpenServerAgent && (
          <button
            type="button"
            onClick={onOpenServerAgent}
            data-testid="suggested-for-you-open"
            className="text-xs text-cyan-400 hover:text-cyan-300"
          >
            Open Server Agent
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="mb-1 text-xs text-red-400">
          {error}
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {offers.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            compact
            busyAction={busy[offer.id]}
            onAct={(action) => {
              void act(offer, action).then((res) => {
                if (action === 'accept' && res) onOpenServerAgent?.();
              });
            }}
          />
        ))}
      </div>
    </section>
  );
}
