import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { formatHubChatRefToken } from '@shared/utils/hubChatRefTokens';
import { CHAT_TRIGGER_EVENT_INFO, type ChatTriggerCard } from '@shared/utils/chatTriggers';
import { hubChatRefCache } from '../utils/hubChatInstance';
import { HubChatMessageBody, type HubChatRefOpenHandler } from './HubChatRefs';
import { colors } from '../theme/colors';

const STATUS_COLOR: Record<ChatTriggerCard['status'], string> = {
  success: colors.emerald400,
  failure: colors.red400,
  warning: colors.amber400,
  waiting: colors.blue400,
  info: colors.gray400,
};

/** A message posted by a project chat trigger, rendered as a status card. */
export default function HubChatTriggerCard({
  card,
  onOpenRef,
}: {
  card: ChatTriggerCard;
  onOpenRef?: HubChatRefOpenHandler;
}) {
  hubChatRefCache.useRefs(card.refs);
  const chips = card.refs
    .map((r) => formatHubChatRefToken(r.label, r.kind, r.targetId))
    .filter((t): t is string => !!t)
    .join(' ');
  const primary = card.refs[0]
    ? hubChatRefCache.get(card.refs[0].kind, card.refs[0].targetId)
    : null;
  const tone = STATUS_COLOR[card.status] ?? colors.gray400;

  return (
    <View testID="hub-chat-trigger-card" style={[styles.card, { borderLeftColor: tone }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{card.title}</Text>
        {card.statusLabel ? (
          <Text style={[styles.status, { color: tone, borderColor: tone }]}>
            {card.statusLabel}
          </Text>
        ) : null}
        {primary?.visible && onOpenRef ? (
          <TouchableOpacity
            testID="hub-chat-trigger-open"
            accessibilityRole="link"
            onPress={() => onOpenRef(primary)}
            style={styles.open}
          >
            <Text style={styles.openText}>Open</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={styles.event}>{CHAT_TRIGGER_EVENT_INFO[card.event]?.label}</Text>
      {chips ? <HubChatMessageBody body={chips} onOpenRef={onOpenRef} /> : null}
      {card.detail ? <Text style={styles.detail}>{card.detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 2,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray800,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  title: { color: colors.gray100, fontWeight: '600', fontSize: 14, flexShrink: 1 },
  status: {
    fontSize: 11,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    textTransform: 'capitalize',
  },
  open: { marginLeft: 'auto', paddingHorizontal: 6, paddingVertical: 2 },
  openText: { color: colors.blue400, fontSize: 12 },
  event: { color: colors.gray500, fontSize: 11, marginTop: 2 },
  detail: { color: colors.gray300, fontSize: 12, marginTop: 4 },
});
