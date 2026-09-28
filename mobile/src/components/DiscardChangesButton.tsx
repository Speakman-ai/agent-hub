import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import AppIcon from './AppIcon';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  DISCARD_CONFIRM_TITLE,
  discardConfirmMessage,
  summarizeDiscardDiff,
} from '@shared/utils/discardChanges';

interface Props {
  sessionId: string | null;
  /** Why Discard is unavailable; null when it can run. */
  blockedReason?: string | null;
  onDiscarded?: (result: { sessionId: string; discardedAt: string | null }) => void;
  onError?: (msg: string) => void;
}

/**
 * Mobile counterpart of the web DiscardChangesButton: loads the diff size,
 * asks for confirmation, then resets the session worktree to its base.
 */
export default function DiscardChangesButton({
  sessionId,
  blockedReason = null,
  onDiscarded,
  onError,
}: Props) {
  const [pending, setPending] = useState(false);

  const discard = useCallback(async () => {
    if (!sessionId) return;
    setPending(true);
    try {
      const res: any = await api.discardSessionChanges(sessionId);
      onDiscarded?.({ sessionId, discardedAt: res?.discardedAt ?? null });
    } catch (err: any) {
      onError?.(err?.message || 'Failed to discard changes');
    } finally {
      setPending(false);
    }
  }, [sessionId, onDiscarded, onError]);

  const handlePress = useCallback(async () => {
    if (!sessionId || pending || blockedReason) return;
    setPending(true);
    let summary = null;
    try {
      summary = summarizeDiscardDiff(await api.getSessionChanges(sessionId));
    } catch {
      // The confirm copy says the size is unknown; discarding is still allowed.
    } finally {
      setPending(false);
    }
    Alert.alert(DISCARD_CONFIRM_TITLE, discardConfirmMessage(summary), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => void discard() },
    ]);
  }, [sessionId, pending, blockedReason, discard]);

  const disabled = !sessionId || pending || !!blockedReason;
  return (
    <TouchableOpacity
      style={[styles.btn, disabled && styles.disabled]}
      onPress={() => void handlePress()}
      disabled={disabled}
      testID="discard-changes-button"
      accessibilityRole="button"
      accessibilityLabel="Discard changes"
      accessibilityHint={blockedReason ?? undefined}
    >
      {pending ? (
        <ActivityIndicator size="small" color={colors.red400} />
      ) : (
        <AppIcon name="trash-outline" size={12} color={colors.red400} />
      )}
      <Text style={styles.text}>Discard</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(153,27,27,0.6)',
    backgroundColor: 'rgba(69,10,10,0.3)',
  },
  text: {
    color: colors.red400,
    fontSize: 10,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.45,
  },
});
