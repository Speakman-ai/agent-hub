import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';

const BIN_FIELDS = [
  { key: 'claudeBin', label: 'Claude CLI' },
  { key: 'cursorBin', label: 'Cursor Agent CLI' },
  { key: 'geminiBin', label: 'Gemini CLI' },
  { key: 'codexBin', label: 'Codex CLI' },
  { key: 'grokBin', label: 'Grok CLI' },
];

export default function GeneralSettingsSection() {
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => setForm(cfg || {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch = {};
      for (const f of BIN_FIELDS) {
        if (form[f.key] != null) patch[f.key] = form[f.key];
      }
      if (form.defaultCwd != null) patch.defaultCwd = form.defaultCwd;
      await api.updateConfig(patch);
      Alert.alert('Saved', 'Configuration updated.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Text style={styles.muted}>Loading…</Text>;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>General</Text>
      <Text style={styles.hint}>CLI binary paths and default working directory.</Text>
      {BIN_FIELDS.map((f) => (
        <View key={f.key} style={styles.field}>
          <Text style={styles.label}>{f.label}</Text>
          <TextInput
            style={styles.input}
            value={form[f.key] || ''}
            onChangeText={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
            placeholder="/usr/local/bin/…"
            placeholderTextColor={colors.gray600}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ))}
      <View style={styles.field}>
        <Text style={styles.label}>Default CWD</Text>
        <TextInput
          style={styles.input}
          value={form.defaultCwd || ''}
          onChangeText={(v) => setForm((prev) => ({ ...prev, defaultCwd: v }))}
          placeholder="/path/to/projects"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
        />
      </View>
      <TouchableOpacity style={styles.saveButton} onPress={handleSave} disabled={saving}>
        <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  title: { fontSize: 16, fontWeight: '600', color: colors.white },
  hint: { fontSize: 12, color: colors.gray500, marginBottom: 8 },
  field: { marginBottom: 8 },
  label: { fontSize: 12, color: colors.gray400, marginBottom: 4 },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 10,
    color: colors.gray200,
    fontSize: 14,
  },
  saveButton: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  saveText: { color: colors.white, fontWeight: '600' },
  muted: { color: colors.gray500, padding: 16 },
});
