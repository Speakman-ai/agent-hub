import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import {
  chatAccountChoices,
  chatAccountNotice,
  type GoogleChatAccountState,
} from '@shared/utils/googleChatAccount';

/**
 * Picks the one linked Workspace account Google Chat runs as. Mirrors the web
 * `GoogleChatAccountPicker`: Chat stays single-account, so this is an explicit
 * choice that survives changing the default account.
 */
export default function GoogleChatAccountPicker({ reloadKey }: { reloadKey?: unknown }) {
  const [state, setState] = useState<GoogleChatAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.getGoogleChatAccount());
    } catch {
      // Older servers have no Chat account endpoint; the picker stays hidden.
      setState(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  if (!state) return null;
  const choices = chatAccountChoices(state);
  const notice = chatAccountNotice(state);
  if (!choices.length && !notice) return null;

  const apply = async (accountId: string) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.setGoogleChatAccount(accountId));
    } catch (err: any) {
      setError(err?.message || 'Failed to change the Chat account');
    } finally {
      setBusy(false);
    }
  };

  const choose = (accountId: string, email: string) => {
    if (accountId === state.account?.accountId) return;
    if (!state.account) {
      void apply(accountId);
      return;
    }
    Alert.alert(
      'Move Google Chat?',
      `Chat will run as ${email}. Notifications from ${state.account.email} stop, and agent replies waiting for approval are discarded.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Move', onPress: () => void apply(accountId) },
      ],
    );
  };

  return (
    <View style={styles.wrap} testID="google-chat-account">
      <Text style={styles.label}>Google Chat account</Text>
      <View style={styles.row}>
        {choices.map((c) => {
          const selected = c.accountId === state.account?.accountId;
          return (
            <TouchableOpacity
              key={c.accountId}
              style={[styles.chip, selected && styles.chipSelected, busy && styles.disabled]}
              onPress={() => choose(c.accountId, c.email)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`Use ${c.email} for Google Chat`}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{c.email}</Text>
            </TouchableOpacity>
          );
        })}
        {busy ? <ActivityIndicator size="small" color={colors.blue400} /> : null}
      </View>
      <Text style={styles.hint}>
        Chat, its notifications, agent replies, and project chat triggers use this one account. Only
        Google Workspace accounts can use Chat.
      </Text>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6, borderTopWidth: 1, borderTopColor: colors.gray700, paddingTop: 10 },
  label: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipSelected: { borderColor: colors.blue400, backgroundColor: 'rgba(59,130,246,0.15)' },
  chipText: { color: colors.gray300, fontSize: 12 },
  chipTextSelected: { color: colors.white },
  disabled: { opacity: 0.5 },
  hint: { color: colors.gray500, fontSize: 11, lineHeight: 15 },
  notice: { color: colors.amber400, fontSize: 11, lineHeight: 15 },
  error: { color: colors.red400, fontSize: 11 },
});
