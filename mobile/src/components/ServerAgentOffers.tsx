import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import {
  PROACTIVE_OFFER_BUTTON_LABELS,
  proactiveKindLabel,
  type ProactiveOffer,
  type ProactiveOfferAction,
} from '@shared/utils/serverAgentProactive';
import { api } from '../utils/api';
import { OfferListSync } from '@shared/utils/offerListSync';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';

/**
 * The caller's open Server Agent offers, kept live by `server_agent_offer_update`.
 * `OfferListSync` replays events that arrive while a list fetch is in flight,
 * so an older snapshot can't drop a new offer or revive an accepted one.
 */
export function useServerAgentOffers() {
  const { subscribeServerAgentOffers } = useApp() as {
    subscribeServerAgentOffers?: (l: (e: any) => void) => () => void;
  };
  const [offers, setOffers] = useState<ProactiveOffer[]>([]);
  const [sync] = useState(() => new OfferListSync(setOffers));
  const [busy, setBusy] = useState<Record<string, ProactiveOfferAction>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const token = sync.beginFetch();
    try {
      const res = (await api.listServerAgentOffers('open')) as { offers: ProactiveOffer[] };
      sync.snapshot(token, res.offers ?? []);
    } catch {
      // Keep the current list; the next event or reload refreshes it.
      sync.fail(token);
    }
  }, [sync]);

  useEffect(() => {
    const unsubscribe = subscribeServerAgentOffers?.((event) => sync.update(event));
    void reload();
    return unsubscribe;
  }, [reload, subscribeServerAgentOffers, sync]);

  const act = useCallback(
    async (offer: ProactiveOffer, action: ProactiveOfferAction) => {
      setBusy((b) => ({ ...b, [offer.id]: action }));
      setError(null);
      try {
        const res = (await api.actOnServerAgentOffer(offer.id, action)) as {
          offer: ProactiveOffer;
        };
        sync.update({ offer: res.offer });
        if (action === 'never') sync.removeKind(offer.kind);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update the offer.');
        void reload();
        return false;
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

  return { offers, busy, error, act };
}

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
    <View
      style={[
        styles.card,
        offer.urgency === 'urgent' && styles.cardUrgent,
        offer.urgency === 'high' && styles.cardHigh,
        compact && styles.cardCompact,
      ]}
      testID={`server-agent-offer-${offer.id}`}
    >
      <Text style={styles.kind}>
        {proactiveKindLabel(offer.kind)}
        {offer.urgency === 'urgent' ? ' · urgent' : ''}
      </Text>
      <Text style={styles.title}>{offer.title}</Text>
      {offer.reason ? <Text style={styles.reason}>{offer.reason}</Text> : null}
      {!compact && offer.action ? <Text style={styles.plan}>Plan: {offer.action}</Text> : null}
      <View style={styles.buttons}>
        <TouchableOpacity
          testID="server-agent-offer-accept"
          disabled={disabled}
          onPress={() => onAct('accept')}
          accessibilityRole="button"
          style={[styles.primary, disabled && styles.disabled]}
        >
          <Text style={styles.primaryText}>
            {busyAction === 'accept' ? 'Starting…' : PROACTIVE_OFFER_BUTTON_LABELS.accept}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="server-agent-offer-snooze"
          disabled={disabled}
          onPress={() => onAct('snooze')}
          accessibilityRole="button"
          style={[styles.secondary, disabled && styles.disabled]}
        >
          <Text style={styles.secondaryText}>{PROACTIVE_OFFER_BUTTON_LABELS.snooze}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="server-agent-offer-never"
          disabled={disabled}
          onPress={() => onAct('never')}
          accessibilityRole="button"
          style={disabled ? styles.disabled : undefined}
        >
          <Text style={styles.linkText}>{PROACTIVE_OFFER_BUTTON_LABELS.never}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** Offer cards docked at the top of the Server Agent thread. */
export function ServerAgentOffers() {
  const { offers, busy, error, act } = useServerAgentOffers();
  if (offers.length === 0 && !error) return null;
  return (
    <ScrollView
      style={styles.dock}
      contentContainerStyle={styles.dockContent}
      testID="server-agent-offers"
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {offers.map((offer) => (
        <OfferCard
          key={offer.id}
          offer={offer}
          busyAction={busy[offer.id]}
          onAct={(action) => void act(offer, action)}
        />
      ))}
    </ScrollView>
  );
}

/**
 * "Suggested for you": compact, horizontally scrolling offer cards for the
 * Hub dashboard. Peer of the web strip; hidden when there is nothing to offer.
 */
export function SuggestedForYouStrip({ onOpenServerAgent }: { onOpenServerAgent?: () => void }) {
  const { offers, busy, error, act } = useServerAgentOffers();
  if (offers.length === 0) return null;
  return (
    <View style={styles.strip} testID="suggested-for-you">
      <View style={styles.stripHeader}>
        <Text style={styles.stripTitle}>Suggested for you</Text>
        {onOpenServerAgent ? (
          <TouchableOpacity onPress={onOpenServerAgent} testID="suggested-for-you-open">
            <Text style={styles.stripLink}>Open Server Agent</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {offers.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            compact
            busyAction={busy[offer.id]}
            onAct={(action) => {
              void act(offer, action).then((ok) => {
                if (action === 'accept' && ok) onOpenServerAgent?.();
              });
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { marginBottom: 12 },
  stripHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  stripTitle: { flex: 1, color: colors.white, fontSize: 14, fontWeight: '600' },
  stripLink: { color: colors.blue400, fontSize: 12 },
  dock: { maxHeight: 280, borderBottomWidth: 1, borderBottomColor: colors.gray800 },
  dockContent: { padding: 12, gap: 8 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 10,
    padding: 10,
  },
  cardUrgent: { borderColor: colors.red400 },
  cardHigh: { borderColor: colors.amber400 },
  cardCompact: { width: 280, marginRight: 8 },
  kind: { fontSize: 10, color: colors.gray500, textTransform: 'uppercase' },
  title: { marginTop: 4, fontSize: 14, fontWeight: '600', color: colors.white },
  reason: { marginTop: 2, fontSize: 12, color: colors.gray400 },
  plan: { marginTop: 2, fontSize: 12, color: colors.gray500 },
  buttons: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  primary: {
    backgroundColor: colors.blue600,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  primaryText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  secondaryText: { color: colors.gray300, fontSize: 12 },
  linkText: { color: colors.gray500, fontSize: 12 },
  disabled: { opacity: 0.5 },
  error: { color: colors.red400, fontSize: 12 },
});
