import React, { useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, Image, ScrollView, Platform, Alert, ActivityIndicator, } from 'react-native';
import Constants from 'expo-constants';
import { colors } from '../theme/colors';
import { captureScreenshot, submitBugReport } from '../utils/bugReport';
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const TITLE_MAX = 200;
export default function BugReportModal({ visible, onClose, screenshotUri, onRetakeScreenshot, projectId, agentId, sourceUrl = '', }: any) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [severity, setSeverity] = useState('medium');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<any>(null);
    const [currentUri, setCurrentUri] = useState(screenshotUri);
    // Keep the preview URI in sync with whatever the parent hands us.
    React.useEffect(() => {
        setCurrentUri(screenshotUri);
    }, [screenshotUri]);
    // Reset fields whenever the modal is hidden so the next open is fresh.
    React.useEffect(() => {
        if (!visible) {
            setTitle('');
            setDescription('');
            setSeverity('medium');
            setSubmitting(false);
            setError(null);
        }
    }, [visible]);
    const canSubmit = !submitting && title.trim().length > 0;
    const handleRetake = async () => {
        // Briefly dismiss the modal so the screenshot doesn't include it.
        if (onRetakeScreenshot) {
            try {
                const uri = await onRetakeScreenshot();
                if (uri)
                    setCurrentUri(uri);
            }
            catch (e: any) {
                setError(e?.message || 'Failed to retake screenshot');
            }
            return;
        }
        // Fallback: capture directly (modal will still be on-screen).
        try {
            const uri = await captureScreenshot();
            setCurrentUri(uri);
        }
        catch (e: any) {
            setError(e?.message || 'Failed to retake screenshot');
        }
    };
    const handleSubmit = async () => {
        if (!canSubmit)
            return;
        setSubmitting(true);
        setError(null);
        try {
            const appVersion = Constants?.expoConfig?.version || '';
            const userAgent = `${Platform.OS} ${Platform.Version} / Expo ${appVersion}`;
            await submitBugReport({
                screenshotUri: currentUri,
                title: title.trim(),
                description: description.trim(),
                severity,
                sourceUrl,
                userAgent,
                appVersion,
                currentProjectId: projectId || '',
                currentAgentId: agentId || '',
            });
            Alert.alert('Bug reported', 'The intake agent is processing your report.');
            onClose?.();
        }
        catch (e: any) {
            setError(e?.message || 'Failed to submit bug report');
        }
        finally {
            setSubmitting(false);
        }
    };
    return (<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Report a bug</Text>
            <TouchableOpacity onPress={onClose} disabled={submitting} style={styles.closeBtn} accessibilityLabel="Close bug report">
              <Text style={styles.closeX}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>
              Title <Text style={styles.required}>*</Text>
            </Text>
            <TextInput style={styles.input} value={title} onChangeText={(t: any) => setTitle(t.slice(0, TITLE_MAX))} placeholder="Short summary" placeholderTextColor={colors.gray500} editable={!submitting} maxLength={TITLE_MAX}/>
            <Text style={styles.helper}>
              {title.length}/{TITLE_MAX}
            </Text>

            <Text style={styles.label}>Description</Text>
            <TextInput style={[styles.input, styles.textarea]} value={description} onChangeText={setDescription} placeholder="What happened? What did you expect?" placeholderTextColor={colors.gray500} multiline numberOfLines={4} editable={!submitting}/>

            <Text style={styles.label}>Severity</Text>
            <View style={styles.severityRow}>
              {SEVERITIES.map((s: any) => {
            const active = s === severity;
            return (<TouchableOpacity key={s} onPress={() => setSeverity(s)} disabled={submitting} style={[
                    styles.severityBtn,
                    active && styles.severityBtnActive,
                ]}>
                    <Text style={[
                    styles.severityLabel,
                    active && styles.severityLabelActive,
                ]}>
                      {s}
                    </Text>
                  </TouchableOpacity>);
        })}
            </View>

            <Text style={styles.label}>Screenshot</Text>
            {currentUri ? (<Image source={{ uri: currentUri }} style={styles.preview} resizeMode="contain"/>) : (<View style={[styles.preview, styles.previewEmpty]}>
                <Text style={styles.previewEmptyText}>No screenshot</Text>
              </View>)}
            <TouchableOpacity onPress={handleRetake} disabled={submitting} style={styles.retakeBtn}>
              <Text style={styles.retakeLabel}>Retake screenshot</Text>
            </TouchableOpacity>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity onPress={onClose} disabled={submitting} style={[styles.footerBtn, styles.cancelBtn]}>
              <Text style={styles.cancelLabel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSubmit} disabled={!canSubmit} style={[
            styles.footerBtn,
            styles.submitBtn,
            !canSubmit && styles.submitBtnDisabled,
        ]}>
              {submitting ? (<ActivityIndicator color={colors.white}/>) : (<Text style={styles.submitLabel}>Submit</Text>)}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>);
}
const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: colors.black60,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
    },
    sheet: {
        width: '100%',
        maxWidth: 520,
        maxHeight: '92%',
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray800,
        borderRadius: 14,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    headerTitle: {
        color: colors.white,
        fontSize: 16,
        fontWeight: '600',
    },
    closeBtn: {
        padding: 4,
        minWidth: 32,
        alignItems: 'center',
    },
    closeX: {
        color: colors.gray400,
        fontSize: 24,
        lineHeight: 24,
    },
    body: {
        flexGrow: 0,
    },
    bodyContent: {
        padding: 16,
        gap: 6,
    },
    label: {
        color: colors.gray300,
        fontSize: 12,
        fontWeight: '600',
        marginTop: 10,
        marginBottom: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    required: {
        color: colors.red400,
    },
    input: {
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        color: colors.white,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
    },
    textarea: {
        minHeight: 96,
        textAlignVertical: 'top',
    },
    helper: {
        color: colors.gray500,
        fontSize: 11,
        alignSelf: 'flex-end',
        marginTop: 2,
    },
    severityRow: {
        flexDirection: 'row',
        gap: 6,
        flexWrap: 'wrap',
    },
    severityBtn: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: colors.gray700,
        backgroundColor: colors.gray800,
    },
    severityBtnActive: {
        backgroundColor: colors.blue600,
        borderColor: colors.blue500,
    },
    severityLabel: {
        color: colors.gray300,
        fontSize: 12,
        textTransform: 'capitalize',
    },
    severityLabelActive: {
        color: colors.white,
        fontWeight: '600',
    },
    preview: {
        width: '100%',
        height: 180,
        backgroundColor: colors.gray800,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    previewEmpty: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    previewEmptyText: {
        color: colors.gray500,
        fontSize: 12,
    },
    retakeBtn: {
        alignSelf: 'flex-start',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray700,
        backgroundColor: colors.gray800,
        marginTop: 8,
    },
    retakeLabel: {
        color: colors.gray200,
        fontSize: 12,
    },
    error: {
        color: colors.red400,
        fontSize: 13,
        marginTop: 10,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        padding: 12,
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
        backgroundColor: colors.gray900,
    },
    footerBtn: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        minWidth: 96,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cancelBtn: {
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    cancelLabel: {
        color: colors.gray200,
        fontSize: 14,
    },
    submitBtn: {
        backgroundColor: colors.blue600,
    },
    submitBtnDisabled: {
        opacity: 0.5,
    },
    submitLabel: {
        color: colors.white,
        fontSize: 14,
        fontWeight: '600',
    },
});
