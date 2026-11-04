import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { colors } from '../../theme/colors';
import {
  AUTO_UPDATE_HINT,
  BASE_DRIFT_OPTIONS,
  MERGE_CHECK_HINT,
  baseDriftFormDirty,
  baseDriftFormFromSettings,
  baseDriftListsPatch,
  baseDriftMode,
  type BaseDriftForm,
} from '@shared/utils/baseDrift';

/**
 * Mobile mirror of the web `BaseDriftSettings` in CiRunsSection. `onSave`
 * receives the `baseDrift` PATCH body and throws on a server error, which
 * renders inline under the controls.
 */
export default function BaseDriftSection({ settings, onSave }: any) {
  const mode = baseDriftMode(settings);
  const stored = baseDriftFormFromSettings(settings);
  const storedKey = JSON.stringify(stored);
  const [form, setForm] = useState<BaseDriftForm>(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(JSON.parse(storedKey)), [storedKey]);

  const dirty = baseDriftFormDirty(form, settings);
  const autoUpdate = settings?.autoUpdatePrs === true;

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
      <Text style={styles.title}>When main changes the same files during checks</Text>
      <Text style={styles.hint}>
        Finalize normally rebases and re-runs review and every job, because the earlier results were
        checked against older code. The same check runs again when a PR merges.
      </Text>

      <View style={styles.options}>
        {BASE_DRIFT_OPTIONS.map((opt) => {
          const on = opt.value === mode;
          return (
            <TouchableOpacity
              key={opt.value}
              disabled={saving}
              onPress={() => save({ mode: opt.value })}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[styles.option, on && styles.optionOn]}
            >
              <Text style={[styles.optionText, on && styles.optionTextOn]}>{opt.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {mode === 'off' ? (
        <Text style={styles.warning}>
          Changes that only break in combination with main can merge. The next Finalize that rebases
          will see the failure.
        </Text>
      ) : (
        <>
          {mode === 'fast' ? (
            <>
              <Text style={styles.label}>Jobs that keep their earlier result</Text>
              <TextInput
                value={form.reuseText}
                editable={!saving}
                onChangeText={(text) => setForm((f) => ({ ...f, reuseText: text }))}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="e2e"
                placeholderTextColor={colors.gray600}
                style={styles.input}
                accessibilityLabel="Jobs that keep their earlier result"
              />
              <Text style={styles.hint}>
                Job ids from ci.yaml, comma separated. Everything else re-runs. With none listed,
                fast behaves like full.
              </Text>
              <Text style={styles.label}>Always re-run everything when these paths overlap</Text>
              <TextInput
                value={form.hazardText}
                editable={!saving}
                onChangeText={(text) => setForm((f) => ({ ...f, hazardText: text }))}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                accessibilityLabel="Hazard paths"
              />
              <Text style={styles.hint}>
                Globs, comma separated. A file changed on both main and this branch also triggers a
                full re-run.
              </Text>
            </>
          ) : null}

          <Text style={styles.label}>Merge checks</Text>
          <TextInput
            value={form.mergeCheckText}
            editable={!saving}
            onChangeText={(text) => setForm((f) => ({ ...f, mergeCheckText: text }))}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="backend-checks"
            placeholderTextColor={colors.gray600}
            style={styles.input}
            accessibilityLabel="Merge checks"
          />
          <Text style={styles.hint}>{MERGE_CHECK_HINT}</Text>

          <TouchableOpacity
            disabled={saving || !dirty}
            onPress={() => save(baseDriftListsPatch(form))}
            style={[styles.saveBtn, (saving || !dirty) && styles.disabled]}
            accessibilityRole="button"
          >
            <Text style={styles.saveText}>Save</Text>
          </TouchableOpacity>

          <View style={[styles.row, styles.toggleRow]}>
            <View style={styles.flex}>
              <Text style={styles.label}>Update open PRs when main changes their files</Text>
              <Text style={styles.hint}>{AUTO_UPDATE_HINT}</Text>
            </View>
            <Switch
              value={autoUpdate}
              disabled={saving}
              onValueChange={() => save({ autoUpdatePrs: !autoUpdate })}
              accessibilityLabel="Update open PRs when main changes their files"
            />
          </View>
        </>
      )}

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
  toggleRow: { marginTop: 12 },
  flex: { flex: 1 },
  title: { fontSize: 16, fontWeight: '600', color: colors.white },
  hint: { fontSize: 12, color: colors.gray500, marginTop: 4 },
  warning: { fontSize: 12, color: colors.amber400, marginTop: 8 },
  label: { fontSize: 13, color: colors.gray300, marginTop: 14, marginBottom: 6 },
  options: { marginTop: 10, gap: 6 },
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
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 8,
    color: colors.gray200,
    fontFamily: 'monospace',
    fontSize: 12,
  },
  saveBtn: {
    alignSelf: 'flex-start',
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.emerald700,
  },
  disabled: { opacity: 0.4 },
  saveText: { fontSize: 13, color: colors.white, fontWeight: '600' },
  error: { fontSize: 12, color: colors.red400, marginTop: 8 },
});
