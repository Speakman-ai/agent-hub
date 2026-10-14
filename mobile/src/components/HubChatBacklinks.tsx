import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  messageAffectsBacklinks,
  type HubChatBacklink,
  type HubChatBacklinkKind,
} from '@shared/utils/hubChat';
import { api } from '../utils/api';
import { hubChatStore } from '../utils/hubChatInstance';
import { relativeTime } from '../utils/time';
import { colors } from '../theme/colors';

/**
 * "Discussed in chat", the mobile twin of the web `HubChatBacklinks`: Agent
 * Hub chat messages that reference a card, PR, session or ticket. The server
 * returns only messages in channels the viewer can read. Tapping a row calls
 * `onOpenChannel`; hosts route it to the Hub Chat tab.
 */

const NO_BACKLINKS: HubChatBacklink[] = [];

type Props = {
  kind: HubChatBacklinkKind;
  targetId: string | null | undefined;
  /** `chip` is a header count that opens the list in a sheet. */
  variant?: 'section' | 'chip';
  onOpenChannel?: (channelId: string) => void;
};

export default function HubChatBacklinks({
  kind,
  targetId,
  variant = 'section',
  onOpenChannel,
}: Props) {
  // Results carry the entity they were fetched for, so rows for a previous
  // target are never shown while (or after) the current one loads.
  const [loaded, setLoaded] = useState<{ key: string; rows: HubChatBacklink[] } | null>(null);
  const targetKey = targetId ? `${kind}:${targetId}` : null;
  const backlinks = loaded && loaded.key === targetKey ? loaded.rows : NO_BACKLINKS;
  const [open, setOpen] = useState(false);
  const listed = useRef<Set<string>>(new Set());

  useEffect(() => {
    listed.current = new Set();
    setOpen(false);
    if (!targetId || typeof api.hubChat?.backlinks !== 'function') {
      setLoaded(null);
      return;
    }
    const key = `${kind}:${targetId}`;
    let cancelled = false;
    // Refreshes can overlap and resolve out of order; only the latest one applies.
    let generation = 0;
    const load = () => {
      const current = ++generation;
      api.hubChat
        .backlinks(kind, targetId)
        .then((res: { backlinks?: HubChatBacklink[] }) => {
          if (cancelled || current !== generation) return;
          const rows = Array.isArray(res?.backlinks) ? res.backlinks : [];
          listed.current = new Set(rows.map((b) => b.messageId));
          setLoaded({ key, rows });
        })
        .catch(() => {
          if (!cancelled && current === generation) setLoaded({ key, rows: [] });
        });
    };
    load();
    const off = hubChatStore.subscribeLive((event) => {
      if (event.type === 'resync') load();
      else if (
        (event.type === 'hub_chat_message' || event.type === 'hub_chat_message_update') &&
        (listed.current.has(event.message.id) ||
          messageAffectsBacklinks(event.message, kind, targetId))
      ) {
        load();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [kind, targetId]);

  if (!targetId || backlinks.length === 0) return null;

  const openChannel = (b: HubChatBacklink) => {
    setOpen(false);
    onOpenChannel?.(b.channelId);
  };

  const list = (
    <View testID="hub-chat-backlinks">
      <Text style={styles.label}>Discussed in chat ({backlinks.length})</Text>
      {backlinks.map((b) => (
        <TouchableOpacity
          key={b.messageId}
          testID="hub-chat-backlink"
          onPress={() => openChannel(b)}
          accessibilityRole="link"
          accessibilityLabel={`Open ${b.channelLabel}`}
          style={styles.row}
        >
          <View style={styles.rowHead}>
            <Text style={styles.channel} numberOfLines={1}>
              {b.channelLabel}
            </Text>
            {b.authorName ? (
              <Text style={styles.meta} numberOfLines={1}>
                · {b.authorName}
              </Text>
            ) : null}
            <Text style={[styles.meta, styles.time]}>{relativeTime(b.createdAt)}</Text>
          </View>
          {b.excerpt ? (
            <Text style={styles.excerpt} numberOfLines={2}>
              {b.excerpt}
            </Text>
          ) : null}
        </TouchableOpacity>
      ))}
    </View>
  );

  if (variant === 'section') return <View style={styles.wrap}>{list}</View>;

  return (
    <>
      <TouchableOpacity
        testID="hub-chat-backlinks-toggle"
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Discussed in chat: ${backlinks.length}`}
        style={styles.chip}
      >
        <Text style={styles.chipText}>Chat {backlinks.length}</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet}>
            <ScrollView>{list}</ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.gray500,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  row: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  channel: { color: colors.gray200, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  meta: { color: colors.gray400, fontSize: 12, flexShrink: 1 },
  time: { marginLeft: 'auto', color: colors.gray500, flexShrink: 0 },
  excerpt: { color: colors.gray300, fontSize: 12, marginTop: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 6,
  },
  chipText: { color: colors.gray300, fontSize: 11 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    backgroundColor: colors.gray950,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    padding: 14,
    maxHeight: '80%',
  },
});
