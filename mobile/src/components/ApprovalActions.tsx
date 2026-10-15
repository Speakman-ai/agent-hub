import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  answerErrorMessage,
  type ApprovalDecision,
  type ApprovalWire,
} from '@shared/utils/approvals';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

interface Props {
  approval: Pick<ApprovalWire, 'id' | 'canRemember'>;
  /** Called after the server accepted the answer, or said it is no longer waiting. */
  onSettled: (approvalId: string, decision: ApprovalDecision | null) => void;
  testIDPrefix?: string;
}

/** Allow once / Always allow / Deny for one pending approval (web parity). */
export default function ApprovalActions({ approval, onSettled, testIDPrefix = 'approval' }: Props) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(decision: ApprovalDecision) {
    setBusy(decision);
    setError(null);
    try {
      await api.answerApproval(approval.id, decision);
      onSettled(approval.id, decision);
    } catch (err) {
      if ((err as { status?: number })?.status === 409) {
        onSettled(approval.id, null);
        return;
      }
      setError(answerErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const button = (decision: ApprovalDecision, label: string, style: object, textStyle: object) => (
    <TouchableOpacity
      onPress={() => void answer(decision)}
      disabled={busy !== null}
      style={[styles.button, style, busy !== null && styles.disabled]}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`${testIDPrefix}-${decision}`}
    >
      {busy === decision ? (
        <ActivityIndicator size="small" color={colors.white} />
      ) : (
        <Text style={[styles.buttonText, textStyle]}>{label}</Text>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {button('allow_once', 'Allow once', styles.allow, styles.lightText)}
        {approval.canRemember
          ? button('always_allow', 'Always allow', styles.always, styles.alwaysText)
          : null}
        {button('deny', 'Deny', styles.deny, styles.lightText)}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID={`${testIDPrefix}-error`}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    minHeight: 34,
    minWidth: 72,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allow: { backgroundColor: colors.emerald600 },
  always: { backgroundColor: colors.gray700, borderWidth: 1, borderColor: colors.gray600 },
  deny: { backgroundColor: colors.red600 },
  buttonText: { fontSize: 13, fontWeight: '600' },
  lightText: { color: colors.white },
  alwaysText: { color: colors.gray100 },
  disabled: { opacity: 0.6 },
  error: { color: colors.red400, fontSize: 12 },
});
