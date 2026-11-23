import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { colors } from '../../theme/colors';
import {
  DEFAULT_BRANCH_AUTOFIX_HINT,
  DEFAULT_BRANCH_AUTOFIX_LABEL,
  defaultBranchFixAgentOptions,
} from '@shared/utils/defaultBranchAutoFix';

/**
 * Mobile mirror of the web `DefaultBranchAutoFixSetting` in CiRunsSection.
 * `onSave` receives the `ciOnPush` PATCH body and throws on a server error.
 */
export default function DefaultBranchAutoFixSection({ project, onSave }: any) {
  const autoFix = project?.ciOnPush?.autoFix === true;
  const agentId: string = project?.ciOnPush?.autoFixAgentId || '';
  const agents = [{ id: '', name: 'Default (first dev agent)' }].concat(
    defaultBranchFixAgentOptions(project),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err: any) {
      setError(String(err?.message || err || 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.title}>{DEFAULT_BRANCH_AUTOFIX_LABEL}</Text>
          <Text style={styles.hint}>{DEFAULT_BRANCH_AUTOFIX_HINT}</Text>
        </View>
        <Switch
          value={autoFix}
          disabled={saving}
          onValueChange={() => save({ autoFix: !autoFix })}
          accessibilityLabel={DEFAULT_BRANCH_AUTOFIX_LABEL}
        />
      </View>

      {autoFix ? (
        <>
          <Text style={styles.label}>Agent</Text>
          <View style={styles.options}>
            {agents.map((a) => {
              const on = a.id === agentId;
              return (
                <TouchableOpacity
                  key={a.id || 'default'}
                  disabled={saving}
                  onPress={() => save({ autoFixAgentId: a.id || null })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Text style={[styles.optionText, on && styles.optionTextOn]}>{a.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      ) : null}

      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.gray800 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  title: { fontSize: 16, fontWeight: '600', color: colors.white },
  hint: { fontSize: 12, color: colors.gray500, marginTop: 4 },
  label: { fontSize: 13, color: colors.gray300, marginTop: 14, marginBottom: 6 },
  options: { gap: 6 },
  option: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  optionOn: { borderColor: colors.emerald600, backgroundColor: colors.emerald800 },
  optionText: { fontSize: 12, color: colors.gray300 },
  optionTextOn: { color: colors.emerald300 },
  error: { fontSize: 12, color: colors.red400, marginTop: 8 },
});
