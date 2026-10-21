import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { colors } from '../../theme/colors';
import {
  DEFAULT_FULL_RUN_PATHS,
  alwaysRunJobChoices,
  dynamicModeBlockedReason,
  testSelectionFormFromSettings,
  testSelectionListsDirty,
  testSelectionListsKey,
  testSelectionListsPatch,
  testSelectionSaveError,
  toggleAlwaysRunJob,
} from '@shared/utils/testSelection';

/**
 * Mobile mirror of the web `TestSelectionSettings` in CiRunsSection. `onSave`
 * receives the `testSelection` PATCH body and throws on a server error, which
 * renders inline under the controls.
 */
export default function TestSelectionSection({ settings, ciOnPushEnabled, tests, onSave }: any) {
  const stored = testSelectionFormFromSettings(settings);
  const listsKey = testSelectionListsKey(settings);
  const [form, setForm] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);

  useEffect(() => setForm((f) => ({ ...f, ...JSON.parse(listsKey) })), [listsKey]);

  const dynamic = stored.mode === 'dynamic';
  const blocked = dynamicModeBlockedReason(stored.mode, ciOnPushEnabled === true);
  const dirty = testSelectionListsDirty(form, settings);
  const jobs = alwaysRunJobChoices(tests, form.alwaysRun);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(testSelectionSaveError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.title}>Dynamic test selection</Text>
          <Text style={styles.hint}>
            {dynamic
              ? "Finalize runs only the CI jobs and shards that cover the tests this change needs. Anything it can't map runs in full."
              : 'Finalize runs every CI job. Turn on to run only the jobs and shards a change needs.'}
          </Text>
        </View>
        <Switch
          value={dynamic}
          disabled={saving || blocked !== null}
          onValueChange={() => save({ mode: dynamic ? 'full' : 'dynamic' })}
          accessibilityLabel="Dynamic test selection"
        />
      </View>
      {blocked ? <Text style={styles.warning}>{blocked}</Text> : null}

      <Text style={styles.label}>Jobs that always run</Text>
      {jobs.length === 0 ? (
        <Text style={styles.hint}>No jobs found in .agent-hub/ci.yaml yet.</Text>
      ) : (
        <View style={styles.chips}>
          {jobs.map((job) => {
            const on = form.alwaysRun.includes(job.id);
            return (
              <TouchableOpacity
                key={job.id}
                disabled={saving}
                onPress={() =>
                  setForm((f) => ({ ...f, alwaysRun: toggleAlwaysRunJob(f.alwaysRun, job.id) }))
                }
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text
                  style={[
                    styles.chipText,
                    on && styles.chipTextOn,
                    !job.configured && styles.chipStale,
                  ]}
                >
                  {job.id}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <Text style={styles.hint}>
        Build, lint and typecheck jobs usually belong here. Jobs that don't write JUnit results
        always run anyway.
      </Text>

      <Text style={styles.label}>Run everything when these paths change</Text>
      <TextInput
        value={form.fullRunPathsText}
        editable={!saving}
        onChangeText={(text) => setForm((f) => ({ ...f, fullRunPathsText: text }))}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="proto/**"
        placeholderTextColor={colors.gray600}
        style={styles.input}
      />
      <Text style={styles.hint}>
        Globs, one per line. These add to the {DEFAULT_FULL_RUN_PATHS.length} built-in paths.
      </Text>
      <TouchableOpacity onPress={() => setShowDefaults((v) => !v)}>
        <Text style={styles.link}>
          {showDefaults ? 'Hide built-in paths' : 'Show built-in paths'}
        </Text>
      </TouchableOpacity>
      {showDefaults ? (
        <View style={styles.defaults}>
          {DEFAULT_FULL_RUN_PATHS.map((glob) => (
            <Text key={glob} style={styles.mono}>
              {glob}
            </Text>
          ))}
        </View>
      ) : null}

      <TouchableOpacity
        disabled={saving || !dirty}
        onPress={() => save(testSelectionListsPatch(form))}
        style={[styles.saveBtn, (saving || !dirty) && styles.disabled]}
        accessibilityRole="button"
      >
        <Text style={styles.saveText}>Save</Text>
      </TouchableOpacity>
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
  warning: { fontSize: 12, color: colors.amber400, marginTop: 6 },
  label: { fontSize: 13, color: colors.gray300, marginTop: 14, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  chipOn: { borderColor: colors.emerald600, backgroundColor: colors.emerald800 },
  chipText: { fontSize: 12, color: colors.gray400, fontFamily: 'monospace' },
  chipTextOn: { color: colors.emerald300 },
  chipStale: { textDecorationLine: 'line-through' },
  input: {
    minHeight: 64,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 8,
    color: colors.gray200,
    fontFamily: 'monospace',
    fontSize: 12,
    textAlignVertical: 'top',
  },
  link: { fontSize: 12, color: colors.blue400, marginTop: 6 },
  defaults: { marginTop: 6, padding: 8, backgroundColor: colors.gray900, borderRadius: 8 },
  mono: { fontSize: 11, color: colors.gray400, fontFamily: 'monospace' },
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
