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
    const [recipientSaving, setRecipientSaving] = useState(false);
    const [error, setError] = useState<any>(null);
    const [recipientEmail, setRecipientEmail] = useState('');
    const [recipientLabel, setRecipientLabel] = useState('');
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
            setRecipientEmail('');
            setRecipientLabel('');
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
    const recipients = settings?.releaseDigestRecipients;
    const normalizedRecipientEmail = recipientEmail.trim().toLowerCase();
    const recipientValidationError = useMemo(() => {
        if (!recipientEmail.trim())
            return null;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail.trim()))
            return 'Enter a valid recipient email.';
        if (recipientLabel.trim().length > 120)
            return 'Recipient label must be 120 characters or fewer.';
        if (recipients?.some((recipient: any) => recipient.email.trim().toLowerCase() === normalizedRecipientEmail))
            return 'This recipient is already on the list.';
        return null;
    }, [normalizedRecipientEmail, recipientEmail, recipientLabel, recipients]);
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
    const handleAddRecipient = useCallback(async () => {
        if (!projectId || recipientSaving || !recipientEmail.trim() || recipientValidationError)
            return;
        setRecipientSaving(true);
        setError(null);
        try {
            const recipient = await api.addReleaseDigestRecipient(projectId, {
                email: recipientEmail.trim(),
                displayLabel: recipientLabel.trim() || null,
            });
            setSettings((current: any) => current
                ? {
                    ...current,
                    releaseDigestRecipients: [...(current.releaseDigestRecipients || []), recipient].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.email.localeCompare(b.email)),
                }
                : current);
            setRecipientEmail('');
            setRecipientLabel('');
        }
        catch (err: any) {
            setError(err?.message || 'Failed to add release digest recipient.');
        }
        finally {
            setRecipientSaving(false);
        }
    }, [projectId, recipientEmail, recipientLabel, recipientSaving, recipientValidationError]);
    const handleToggleRecipient = useCallback(async (recipient: any) => {
        if (!projectId || recipientSaving)
            return;
        setRecipientSaving(true);
        setError(null);
        try {
            const updated = await api.updateReleaseDigestRecipient(projectId, recipient.id, {
                enabled: !recipient.enabled,
            });
            setSettings((current: any) => current
                ? {
                    ...current,
                    releaseDigestRecipients: (current.releaseDigestRecipients || []).map((item: any) => item.id === updated.id ? updated : item),
                }
                : current);
        }
        catch (err: any) {
            setError(err?.message || 'Failed to update release digest recipient.');
        }
        finally {
            setRecipientSaving(false);
        }
    }, [projectId, recipientSaving]);
    const handleRemoveRecipient = useCallback(async (recipient: any) => {
        if (!projectId || recipientSaving)
            return;
        setRecipientSaving(true);
        setError(null);
        try {
            await api.removeReleaseDigestRecipient(projectId, recipient.id);
            setSettings((current: any) => current
                ? {
                    ...current,
                    releaseDigestRecipients: (current.releaseDigestRecipients || []).filter((item: any) => item.id !== recipient.id),
                }
                : current);
        }
        catch (err: any) {
            setError(err?.message || 'Failed to remove release digest recipient.');
        }
        finally {
            setRecipientSaving(false);
        }
    }, [projectId, recipientSaving]);
    return (<View style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Release digest prompt</Text>
        {(loading || saving) && <ActivityIndicator color={colors.gray400} size="small"/>}
      </View>
      <Text style={styles.subtitle}>
        Guides release digest tone, audience, and grouping, including custom outlines such as
        departments. Generation stays limited to release items, linked cards, support-ticket
        summaries, and deployment metadata.
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
      {recipients && (<View style={styles.recipientsSection}>
        <Text style={styles.title}>Release digest recipients</Text>
        <Text style={styles.subtitle}>
          Admin-only list for production release digest emails. Disabled recipients are skipped.
        </Text>
        <TextInput style={styles.input} value={recipientEmail} onChangeText={setRecipientEmail} editable={!recipientSaving} keyboardType="email-address" autoCapitalize="none" placeholder="recipient@example.com" placeholderTextColor={colors.gray600}/>
        <TextInput style={styles.input} value={recipientLabel} onChangeText={setRecipientLabel} editable={!recipientSaving} maxLength={121} placeholder="Optional label" placeholderTextColor={colors.gray600}/>
        <TouchableOpacity style={[styles.primaryButton, (!recipientEmail.trim() || !!recipientValidationError || recipientSaving) && styles.buttonDisabled]} onPress={handleAddRecipient} disabled={!recipientEmail.trim() || !!recipientValidationError || recipientSaving}>
          <Text style={styles.primaryButtonText}>{recipientSaving ? 'Saving' : 'Add recipient'}</Text>
        </TouchableOpacity>
        {recipientValidationError && <Text style={styles.error}>{recipientValidationError}</Text>}
        <View style={styles.recipientList}>
          {recipients.length === 0 ? (<Text style={styles.emptyText}>No release digest recipients.</Text>) : recipients.map((recipient: any) => (<View key={recipient.id} style={styles.recipientRow}>
            <View style={styles.recipientInfo}>
              <Text style={styles.recipientEmail}>{recipient.email}</Text>
              <Text style={recipient.enabled ? styles.enabledText : styles.disabledText}>
                {recipient.enabled ? 'Enabled' : 'Disabled'}
              </Text>
              {recipient.displayLabel ? <Text style={styles.recipientLabel}>{recipient.displayLabel}</Text> : null}
            </View>
            <View style={styles.recipientActions}>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => handleToggleRecipient(recipient)} disabled={recipientSaving}>
                <Text style={styles.secondaryButtonText}>{recipient.enabled ? 'Disable' : 'Enable'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dangerButton} onPress={() => handleRemoveRecipient(recipient)} disabled={recipientSaving}>
                <Text style={styles.dangerButtonText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>))}
        </View>
      </View>)}
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
    input: {
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: colors.white,
        fontSize: 14,
        marginBottom: 8,
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
    recipientsSection: {
        marginTop: 20,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
    },
    recipientList: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.gray800 },
    emptyText: { fontSize: 13, color: colors.gray500, paddingVertical: 12 },
    recipientRow: {
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 10,
    },
    recipientInfo: { gap: 3 },
    recipientEmail: { color: colors.gray200, fontSize: 14, fontWeight: '600' },
    recipientLabel: { color: colors.gray500, fontSize: 12 },
    enabledText: { color: colors.emerald400, fontSize: 12 },
    disabledText: { color: colors.gray500, fontSize: 12 },
    recipientActions: { flexDirection: 'row', gap: 8 },
    dangerButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.red900_50,
        backgroundColor: colors.gray900,
    },
    dangerButtonText: { fontSize: 13, color: colors.red400, fontWeight: '600' },
});
