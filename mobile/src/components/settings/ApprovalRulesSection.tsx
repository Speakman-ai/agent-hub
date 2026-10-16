import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  groupApprovalRules,
  ruleEffectLabel,
  type ApprovalRuleWire,
} from '@shared/utils/approvals';
import type { BrowserProfileWire } from '@shared/utils/browserProfiles';
import { formatPolicyDomain } from '@shared/utils/desktopAppPolicy';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Mobile parity for web Settings → Approvals: the rules "Always allow" saved,
 * grouped by browser profile, with delete.
 */
export default function ApprovalRulesSection() {
  const [rules, setRules] = useState<ApprovalRuleWire[] | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfileWire[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listApprovalRules();
      setRules(res.rules);
    } catch (err) {
      setError(message(err, 'Failed to load approval rules'));
      setRules((prev) => prev ?? []);
    }
    // Profile names only label the groups; rules still show without them.
    api
      .getMyBrowserProfiles()
      .then((res) => setProfiles(res.profiles))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupApprovalRules(rules ?? [], profiles), [rules, profiles]);

  const remove = useCallback(async (rule: ApprovalRuleWire) => {
    setBusy(rule.id);
    setError(null);
    try {
      await api.deleteApprovalRule(rule.id);
      setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
    } catch (err) {
      setError(message(err, 'Failed to delete rule'));
    } finally {
      setBusy(null);
    }
  }, []);

  function confirmRemove(rule: ApprovalRuleWire) {
    Alert.alert(
      'Delete rule?',
      `Stop always allowing "${rule.action}" on ${formatPolicyDomain(rule.domain)}? The agent will ask you again next time.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void remove(rule) },
      ],
    );
  }

  return (
    <View style={styles.container} testID="approval-rules">
      <Text style={styles.title}>Approvals</Text>
      <Text style={styles.subtitle}>
        Actions you told an agent it may always take on a site. Delete a rule and the agent asks you
        again before that action.
      </Text>

      {error ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {rules === null ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.gray400} />
          <Text style={styles.muted}> Loading approval rules…</Text>
        </View>
      ) : null}

      {rules !== null && rules.length === 0 && !error ? (
        <Text style={styles.muted} testID="approval-rules-empty">
          No remembered approvals. Choose Always allow when answering an approval to add one.
        </Text>
      ) : null}

      {groups.map((group) => (
        <View
          key={group.profileId}
          style={styles.card}
          testID={`approval-rules-profile-${group.profileId}`}
        >
          <Text style={styles.groupLabel}>{group.label}</Text>
          {group.rules.map((rule) => (
            <View key={rule.id} style={styles.rule} testID={`approval-rule-${rule.id}`}>
              <View style={{ flex: 1 }}>
                <Text
                  style={styles.ruleText}
                >{`${rule.action} on ${formatPolicyDomain(rule.domain)}`}</Text>
                <Text style={styles.small}>{ruleEffectLabel(rule.effect)}</Text>
              </View>
              <TouchableOpacity
                style={[styles.deleteBtn, busy !== null && styles.disabled]}
                onPress={() => confirmRemove(rule)}
                disabled={busy !== null}
                accessibilityLabel={`Delete rule ${rule.action} on ${formatPolicyDomain(rule.domain)}`}
                testID={`approval-rule-delete-${rule.id}`}
              >
                {busy === rule.id ? (
                  <ActivityIndicator size="small" color={colors.red400} />
                ) : (
                  <Text style={styles.deleteText}>Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  title: { fontSize: 18, fontWeight: '600', color: colors.white },
  subtitle: { fontSize: 13, color: colors.gray400 },
  row: { flexDirection: 'row', alignItems: 'center' },
  muted: { fontSize: 13, color: colors.gray500 },
  small: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  errorBox: {
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: { fontSize: 13, color: colors.red400 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  groupLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  rule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  ruleText: { fontSize: 14, color: colors.gray200 },
  deleteBtn: {
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minWidth: 64,
    alignItems: 'center',
  },
  deleteText: { fontSize: 12, color: colors.red400 },
  disabled: { opacity: 0.45 },
});
