import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

function statusLabel(status: any) {
  if (status === 'submitted') return 'Credentials submitted';
  if (status === 'consumed') return 'Credentials used and discarded';
  if (status === 'expired') return 'Credentials expired';
  return 'Secure credential request';
}

export default function CredentialRequestPrompt({ sessionId, request, onSubmit }: any) {
  const [values, setValues] = useState<any>(() =>
    Object.fromEntries((request.fields || []).map((field: any) => [field.key, ''])),
  );
  const [visible, setVisible] = useState<any>({});
  const [remoteStatus, setRemoteStatus] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSessionCredentialRequest(sessionId, request.requestId)
      .then((body: any) => {
        if (!cancelled) setRemoteStatus(body?.status || null);
      })
      .catch(() => {
        if (!cancelled) setRemoteStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, request.requestId]);

  const complete = remoteStatus === 'submitted' || remoteStatus === 'consumed';
  const expired = remoteStatus === 'expired';
  const canSubmit = useMemo(
    () => (request.fields || []).every((field: any) => values[field.key]?.length > 0) && !complete && !expired,
    [request.fields, values, complete, expired],
  );

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    try {
      const body = await api.submitSessionCredentialRequest(sessionId, request.requestId, {
        service: request.service,
        purpose: request.purpose,
        fields: request.fields,
        values,
        ttlSeconds: request.ttlSeconds,
      });
      setRemoteStatus(body?.status || 'submitted');
      setValues(Object.fromEntries((request.fields || []).map((field: any) => [field.key, ''])));
      onSubmit?.(
        [
          `${request.service} credentials were submitted securely for request \`${request.requestId}\`.`,
          '',
          'They are available once through the session credential request API and then discarded.',
        ].join('\n'),
      );
    } catch (err: any) {
      Alert.alert('Submit failed', err?.message || 'Could not submit credentials.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.headerText}>{statusLabel(remoteStatus)}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.service}>{request.service}</Text>
        <Text style={styles.purpose}>{request.purpose}</Text>
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Values are sent directly to Agent Hub, skipped from chat history, and discarded after
            one use or expiration.
          </Text>
        </View>
        {(request.fields || []).map((field: any) => {
          const hidden = field.type === 'password' && !visible[field.key];
          return (
            <View key={field.key} style={styles.field}>
              <Text style={styles.label}>{field.label}</Text>
              <View style={styles.inputRow}>
                <TextInput
                  value={values[field.key] || ''}
                  onChangeText={(value) => setValues((prev: any) => ({ ...prev, [field.key]: value }))}
                  secureTextEntry={hidden}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!complete && !expired && !saving}
                  style={styles.input}
                />
                {field.type === 'password' ? (
                  <TouchableOpacity
                    style={styles.showBtn}
                    onPress={() => setVisible((prev: any) => ({ ...prev, [field.key]: !prev[field.key] }))}
                    disabled={complete || expired || saving}
                  >
                    <Text style={styles.showText}>{visible[field.key] ? 'Hide' : 'Show'}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          );
        })}
        <TouchableOpacity
          style={[styles.submit, (!canSubmit || saving) && styles.submitDisabled]}
          onPress={submit}
          disabled={!canSubmit || saving}
        >
          <Text style={styles.submitText}>
            {saving ? 'Submitting...' : complete ? 'Submitted' : expired ? 'Expired' : 'Submit'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.emerald700,
    backgroundColor: 'rgba(6, 78, 59, 0.22)',
    borderRadius: 10,
    overflow: 'hidden',
    marginVertical: 6,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: colors.emerald700,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerText: { color: colors.emerald400, fontSize: 12, fontWeight: '600' },
  body: { padding: 12, gap: 10 },
  service: { color: colors.white, fontSize: 15, fontWeight: '600' },
  purpose: { color: colors.gray300, fontSize: 12, lineHeight: 17 },
  notice: {
    borderWidth: 1,
    borderColor: colors.emerald700,
    borderRadius: 8,
    padding: 10,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  noticeText: { color: colors.gray300, fontSize: 12, lineHeight: 17 },
  field: { gap: 4 },
  label: { color: colors.gray300, fontSize: 12 },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    color: colors.white,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  showBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  showText: { color: colors.emerald400, fontSize: 12 },
  submit: {
    alignSelf: 'flex-end',
    backgroundColor: colors.emerald600,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: colors.white, fontSize: 12, fontWeight: '600' },
});
