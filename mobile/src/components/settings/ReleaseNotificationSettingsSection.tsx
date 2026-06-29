import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';

const FALLBACK_MAX_LENGTH = 4000;

export default function ReleaseNotificationSettingsSection({ projectId }: any) {
    const [settings, setSettings] = useState<any>(null);
    const [value, setValue] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<any>(null);
    useEffect(() => {
        let cancelled = false;
        if (!projectId) {
            setSettings(null);
            setValue('');
            return undefined;
        }
        setLoading(true);
        setError(null);
        api.getReleaseNotificationSettings(projectId)
            .then((res: any) => {
            if (cancelled)
                return;
            setSettings(res);
            setValue(res?.releaseDigestPrompt || '');
        })
            .catch((err: any) => {
            if (!cancelled)
                setError(err?.message || 'Failed to load release settings.');
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [projectId]);
    const maxLength = settings?.promptMaxLength || FALLBACK_MAX_LENGTH;
    const trimmed = value.trim();
    const validationError = useMemo(() => {
        if (!trimmed)
            return 'Prompt is required.';
        if (trimmed.length > maxLength)
            return `Prompt must be ${maxLength} characters or fewer.`;
        return null;
    }, [maxLength, trimmed]);
    const dirty = settings ? value !== settings.releaseDigestPrompt : false;
    const handleSave = useCallback(async () => {
        if (!projectId || validationError || saving)
            return;
        setSaving(true);
        setError(null);
        try {
            const res = await api.updateReleaseNotificationSettings(projectId, {
                releaseDigestPrompt: trimmed,
            });
            setSettings(res);
            setValue(res.releaseDigestPrompt);
        }
        catch (err: any) {
            setError(err?.message || 'Failed to save release settings.');
        }
        finally {
            setSaving(false);
        }
    }, [projectId, saving, trimmed, validationError]);
    const handleReset = useCallback(async () => {
        if (!projectId || saving)
            return;
        setSaving(true);
        setError(null);
        try {
            const res = await api.resetReleaseNotificationSettings(projectId);
            setSettings(res);
            setValue(res.releaseDigestPrompt);
        }
        catch (err: any) {
            setError(err?.message || 'Failed to reset release settings.');
        }
        finally {
            setSaving(false);
        }
    }, [projectId, saving]);
    return (<View style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Release digest prompt</Text>
        {(loading || saving) && <ActivityIndicator color={colors.gray400} size="small"/>}
      </View>
      <Text style={styles.subtitle}>
        Guides release digest tone and grouping. Generation stays limited to release items, linked
        cards, support-ticket summaries, and deployment metadata.
      </Text>
      <TextInput style={styles.textArea} value={value} onChangeText={setValue} multiline textAlignVertical="top" editable={!saving && !!projectId} maxLength={maxLength + 1} placeholder="Release digest guidance" placeholderTextColor={colors.gray600}/>
      <View style={styles.actionRow}>
        <Text style={[styles.counter, trimmed.length > maxLength && styles.counterError]}>
          {trimmed.length}/{maxLength}
          {settings?.isDefault ? ' · using default' : ''}
        </Text>
        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.secondaryButton, (saving || loading || settings?.isDefault) && styles.buttonDisabled]} onPress={handleReset} disabled={saving || loading || settings?.isDefault}>
            <Text style={styles.secondaryButtonText}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.primaryButton, (saving || loading || !dirty || !!validationError) && styles.buttonDisabled]} onPress={handleSave} disabled={saving || loading || !dirty || !!validationError}>
            <Text style={styles.primaryButtonText}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>
      {(error || validationError) && <Text style={styles.error}>{error || validationError}</Text>}
    </View>);
}

const styles = StyleSheet.create({
    section: {
        marginTop: 24,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
    title: { fontSize: 16, fontWeight: '600', color: colors.white },
    subtitle: { fontSize: 12, color: colors.gray500, marginBottom: 12, lineHeight: 16 },
    textArea: {
        minHeight: 148,
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: colors.white,
        fontSize: 14,
    },
    actionRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        marginTop: 10,
    },
    counter: { fontSize: 12, color: colors.gray500, flex: 1 },
    counterError: { color: colors.red400 },
    buttons: { flexDirection: 'row', gap: 8 },
    secondaryButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray700,
        backgroundColor: colors.gray900,
    },
    secondaryButtonText: { fontSize: 13, color: colors.gray300, fontWeight: '600' },
    primaryButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: colors.blue600,
    },
    primaryButtonText: { fontSize: 13, color: colors.white, fontWeight: '600' },
    buttonDisabled: { opacity: 0.5 },
    error: { fontSize: 13, color: colors.red400, marginTop: 8 },
});
