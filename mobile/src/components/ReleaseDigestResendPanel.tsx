import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

const BODY_MAX_LENGTH = 50_000;

/**
 * Regenerate a deployment's release digest, let the operator edit it, then
 * queue it to every enabled digest recipient as a new send.
 */
export default function ReleaseDigestResendPanel({
  projectId,
  deploymentId,
  onQueued,
}: {
  projectId: string;
  deploymentId: string;
  onQueued?: (releaseNotifications: any[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await api.generateReleaseDigest(projectId, deploymentId);
      setBody(res?.digestMarkdown || '');
      setSubject((current) => current || res?.subject || '');
    } catch (err: any) {
      setError(err?.message || 'Failed to generate the release digest.');
    } finally {
      setGenerating(false);
    }
  };

  const trimmedBody = body.trim();
  const bodyError = !trimmedBody
    ? 'Digest text is required.'
    : trimmedBody.length > BODY_MAX_LENGTH
      ? `Digest text must be ${BODY_MAX_LENGTH} characters or fewer.`
      : null;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await api.resendReleaseDigest(projectId, deploymentId, {
        digestMarkdown: trimmedBody,
        subject: subject.trim() || null,
      });
      onQueued?.(res?.releaseNotifications || []);
      const count = res?.queued?.length ?? 0;
      Alert.alert(
        'Release digest',
        `Release digest queued for ${count} recipient${count === 1 ? '' : 's'}`,
      );
      setOpen(false);
      setBody('');
      setSubject('');
    } catch (err: any) {
      setError(err?.message || 'Failed to send the release digest.');
    } finally {
      setSending(false);
    }
  };

  const confirmSend = () => {
    if (bodyError || sending) return;
    Alert.alert('Send release digest', 'Send this digest to every enabled recipient?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send', onPress: () => void send() },
    ]);
  };

  if (!open) {
    return (
      <TouchableOpacity
        testID="release-digest-resend-open"
        style={styles.secondaryButton}
        onPress={() => {
          setOpen(true);
          if (!body) void generate();
        }}
      >
        <Text style={styles.secondaryButtonText}>Regenerate & resend digest</Text>
      </TouchableOpacity>
    );
  }

  const busy = generating || sending;
  return (
    <View style={styles.panel} testID="release-digest-resend-panel">
      <Text style={styles.title}>Regenerate & resend digest</Text>
      <Text style={styles.hint}>
        Edit the generated digest before sending. It goes to every enabled recipient as a new send;
        earlier notifications stay in history.
      </Text>
      <TextInput
        style={styles.input}
        value={subject}
        onChangeText={setSubject}
        editable={!sending}
        maxLength={200}
        placeholder="Subject"
        placeholderTextColor={colors.gray600}
      />
      {generating && !body ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.gray400} size="small" />
          <Text style={styles.hint}>Generating digest</Text>
        </View>
      ) : (
        <TextInput
          testID="release-digest-body"
          style={[styles.input, styles.bodyInput]}
          value={body}
          onChangeText={setBody}
          multiline
          textAlignVertical="top"
          editable={!busy}
          placeholder="Digest text"
          placeholderTextColor={colors.gray600}
        />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => {
            setOpen(false);
            setError(null);
          }}
        >
          <Text style={styles.secondaryButtonText}>Close</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.secondaryButton, busy && styles.disabled]}
          onPress={generate}
          disabled={busy}
        >
          <Text style={styles.secondaryButtonText}>Regenerate</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="release-digest-send"
          style={[styles.primaryButton, (busy || !!bodyError) && styles.disabled]}
          onPress={confirmSend}
          disabled={busy || !!bodyError}
        >
          {sending ? <ActivityIndicator color={colors.white} size="small" /> : null}
          <Text style={styles.primaryButtonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: 10,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.blue600,
    backgroundColor: colors.gray950,
    gap: 8,
  },
  title: { fontSize: 13, color: colors.gray200, fontWeight: '600' },
  hint: { fontSize: 12, color: colors.gray500, lineHeight: 16 },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.white,
    fontSize: 13,
  },
  bodyInput: { minHeight: 220, fontFamily: 'monospace', fontSize: 12 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  error: { fontSize: 12, color: colors.red400 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  secondaryButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  secondaryButtonText: { fontSize: 12, color: colors.gray300, fontWeight: '600' },
  primaryButton: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.blue600,
  },
  primaryButtonText: { fontSize: 12, color: colors.white, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
