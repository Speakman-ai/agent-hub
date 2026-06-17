import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import {
  validateSecretKey,
  buildUpsertSecretsPayload,
  displaySecretValue,
  describeSecretsPermissionError,
} from '../../utils/settingsSecrets';

const EMPTY_FORM = { key: '', value: '', kind: 'secret' };

/**
 * @param {{ projectId?: string | null }} [props] When `projectId` is provided
 *   (per-project Settings submenu) the section locks to that project and hides
 *   the project picker. Without it (global Settings) it lists projects and
 *   shows the picker.
 */
export default function ProjectSecretsSection({ projectId: lockedProjectId = null } = {}) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(lockedProjectId);
  const [secrets, setSecrets] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(!lockedProjectId);
  const [loadingSecrets, setLoadingSecrets] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Locked to a single project (per-project submenu) — no picker, no list.
    if (lockedProjectId) {
      setProjectId(lockedProjectId);
      return;
    }
    api
      .getProjects()
      .then((list) => {
        const safe = Array.isArray(list) ? list : [];
        setProjects(safe);
        if (safe.length > 0) setProjectId(safe[0].id);
      })
      .catch((err) => setLoadError(err?.message || 'Failed to load projects.'))
      .finally(() => setLoadingProjects(false));
  }, [lockedProjectId]);

  const loadSecrets = useCallback(async (pid) => {
    if (!pid) return;
    setLoadingSecrets(true);
    setLoadError(null);
    setSecrets([]);
    try {
      const body = await api.getProjectSecrets(pid);
      setSecrets(Array.isArray(body?.secrets) ? body.secrets : []);
    } catch (err) {
      setLoadError(
        describeSecretsPermissionError(err, 'read') || err?.message || 'Failed to load secrets.',
      );
    } finally {
      setLoadingSecrets(false);
    }
  }, []);

  useEffect(() => {
    loadSecrets(projectId);
  }, [projectId, loadSecrets]);

  const handleSave = async () => {
    const keyError = validateSecretKey(form.key);
    if (keyError) {
      Alert.alert('Invalid key', keyError);
      return;
    }
    if (!form.value) {
      Alert.alert('Missing value', 'A value is required (it will be write-only once saved).');
      return;
    }
    setSaving(true);
    try {
      const payload = buildUpsertSecretsPayload(secrets, {
        key: form.key,
        value: form.value,
        kind: form.kind,
      });
      const body = await api.putProjectSecrets(projectId, payload);
      setSecrets(Array.isArray(body?.secrets) ? body.secrets : []);
      setForm(EMPTY_FORM);
    } catch (err) {
      Alert.alert(
        'Save failed',
        describeSecretsPermissionError(err, 'write') || err?.message || 'Could not save secret.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (row) => {
    Alert.alert('Delete Secret', `Delete "${row.key}"? Sessions will stop receiving it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteProjectSecret(projectId, row.key);
            setSecrets((prev) => prev.filter((s) => s.key !== row.key));
          } catch (err) {
            Alert.alert(
              'Delete failed',
              describeSecretsPermissionError(err, 'write') ||
                err?.message ||
                'Could not delete secret.',
            );
          }
        },
      },
    ]);
  };

  if (loadingProjects) {
    return <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 40 }} />;
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Project Secrets</Text>
      <Text style={styles.sectionDesc}>
        Environment variables injected into sessions spawned for a project.
      </Text>

      <View style={styles.warnBox}>
        <Text style={styles.warnText}>
          Values are write-only: once saved, secret values are encrypted and can never be read back
          here — only replaced or deleted. Viewing requires the Admin role; changes require Owner.
        </Text>
      </View>

      {/* Project picker only in the global (unlocked) Settings context. */}
      {!lockedProjectId &&
        (projects.length === 0 ? (
          <Text style={styles.emptyText}>No projects configured.</Text>
        ) : (
          <View style={styles.chipRow}>
            {projects.map((p) => {
              const active = projectId === p.id;
              return (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setProjectId(p.id)}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                    numberOfLines={1}
                  >
                    {p.name || p.id}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}

      {loadingSecrets && (
        <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 20 }} />
      )}

      {loadError && !loadingSecrets && (
        <View style={styles.errorBox}>
          <Text style={styles.errorBoxText}>{loadError}</Text>
          <TouchableOpacity onPress={() => loadSecrets(projectId)}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {!loadingSecrets && !loadError && projectId && (
        <>
          {secrets.length === 0 ? (
            <Text style={styles.emptyText}>No secrets for this project yet.</Text>
          ) : (
            secrets.map((row) => (
              <View key={row.key} style={styles.secretRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.secretKey} numberOfLines={1}>
                    {row.key}
                  </Text>
                  <Text style={styles.secretValue} numberOfLines={1}>
                    {displaySecretValue(row)}
                  </Text>
                </View>
                <View style={[styles.kindBadge, row.kind === 'plain' && styles.kindBadgePlain]}>
                  <Text
                    style={[styles.kindBadgeText, row.kind === 'plain' && styles.kindBadgeTextPlain]}
                  >
                    {row.kind}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => setForm({ key: row.key, value: '', kind: row.kind })}
                  accessibilityLabel={`Replace ${row.key}`}
                >
                  <Text style={styles.smallButtonText}>✎</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => handleDelete(row)}
                  accessibilityLabel={`Delete ${row.key}`}
                >
                  <Text style={styles.deleteText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))
          )}

          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Add or replace a key</Text>
            <Text style={styles.fieldLabel}>Key</Text>
            <TextInput
              value={form.key}
              onChangeText={(v) => setForm({ ...form, key: v })}
              placeholder="e.g. DATABASE_URL"
              placeholderTextColor={colors.gray500}
              style={styles.formInput}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Text style={styles.fieldLabel}>Value (write-only)</Text>
            <TextInput
              value={form.value}
              onChangeText={(v) => setForm({ ...form, value: v })}
              placeholder="Value"
              placeholderTextColor={colors.gray500}
              style={styles.formInput}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={form.kind === 'secret'}
            />
            <Text style={styles.fieldLabel}>Kind</Text>
            <View style={styles.chipRow}>
              {['secret', 'plain'].map((kind) => {
                const active = form.kind === kind;
                return (
                  <TouchableOpacity
                    key={kind}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setForm({ ...form, kind })}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {kind === 'secret' ? 'secret (masked)' : 'plain (visible)'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              style={[styles.primaryBtn, saving && { opacity: 0.5 }]}
              onPress={handleSave}
              disabled={saving}
            >
              <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Save Secret'}</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 6,
  },
  sectionDesc: {
    fontSize: 12,
    color: colors.gray500,
    marginBottom: 12,
  },
  warnBox: {
    backgroundColor: colors.yellow900_50,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  warnText: {
    color: colors.yellow400,
    fontSize: 12,
    lineHeight: 17,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 12,
  },
  chip: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    backgroundColor: 'rgba(37, 99, 235, 0.15)',
    borderColor: colors.blue600,
  },
  chipText: {
    fontSize: 12,
    color: colors.gray400,
  },
  chipTextActive: {
    color: colors.blue400,
    fontWeight: '500',
  },
  secretRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.gray800,
    borderRadius: 10,
    padding: 12,
    marginBottom: 6,
  },
  secretKey: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.gray100,
    fontFamily: 'monospace',
  },
  secretValue: {
    fontSize: 11,
    color: colors.gray500,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  kindBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.purple900_40,
  },
  kindBadgePlain: {
    backgroundColor: colors.gray700_40,
  },
  kindBadgeText: {
    fontSize: 10,
    color: colors.purple400,
  },
  kindBadgeTextPlain: {
    color: colors.gray400,
  },
  smallButton: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: {
    fontSize: 12,
    color: colors.gray400,
  },
  deleteText: {
    fontSize: 12,
    color: colors.red400,
  },
  formCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  formTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
  },
  fieldLabel: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 4,
    marginTop: 10,
  },
  formInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '500',
  },
  emptyText: {
    fontSize: 12,
    color: colors.gray600,
    fontStyle: 'italic',
    marginBottom: 8,
  },
  errorBox: {
    backgroundColor: colors.red900_50,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorBoxText: {
    color: colors.red400,
    fontSize: 12,
  },
  retryText: {
    color: colors.gray300,
    fontSize: 12,
    marginTop: 6,
    textDecorationLine: 'underline',
  },
});
