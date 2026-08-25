import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';

const DEFAULT_SMTP_FORM = {
  enabled: false,
  host: '',
  port: '587',
  tlsMode: 'starttls',
  username: '',
  password: '',
  from: '',
};

export function smtpFormFromSettings(settings: any) {
  const smtp = settings?.smtp || {};
  return {
    enabled: !!smtp.enabled,
    host: smtp.host || '',
    port: String(smtp.port || 587),
    tlsMode: smtp.tlsMode || 'starttls',
    username: smtp.username || '',
    password: '',
    from: smtp.from || '',
  };
}

export function buildSmtpPatch(form: any, original: any, clearPassword = false) {
  const smtp = original?.smtp || {};
  const patch: Record<string, any> = {
    enabled: !!form.enabled,
    host: String(form.host || '').trim(),
    port: Number(form.port),
    tlsMode: form.tlsMode,
    username: String(form.username || '').trim() || null,
    from: String(form.from || '').trim(),
  };
  if (clearPassword) {
    patch.password = null;
  } else if (form.password) {
    patch.password = form.password;
  } else if (!smtp.passwordSet) {
    patch.password = null;
  }
  return patch;
}

export function smtpStatusText(settings: any) {
  return settings?.smtp?.configured ? 'Configured' : 'Not configured';
}

export function smtpPasswordClearState(form: any) {
  return {
    form: { ...form, password: '' },
    clearPassword: true,
    status: { type: 'success', message: 'Password will be cleared on save.' },
  };
}

export default function SmtpSettingsSection() {
  const [settings, setSettings] = useState<any>(null);
  const [form, setForm] = useState<any>(DEFAULT_SMTP_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [testTo, setTestTo] = useState('');
  const [clearPassword, setClearPassword] = useState(false);

  const load = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const body = await api.getSmtpSettings();
      setSettings(body);
      setForm(smtpFormFromSettings(body));
      setClearPassword(false);
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setField = (key: string, value: any) => {
    setForm((prev: any) => ({ ...prev, [key]: value }));
    setStatus(null);
    if (key === 'password') setClearPassword(false);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body = await api.updateSmtpSettings(buildSmtpPatch(form, settings, clearPassword));
      setSettings(body);
      setForm(smtpFormFromSettings(body));
      setClearPassword(false);
      setStatus({ type: 'success', message: 'Saved SMTP settings.' });
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const body = await api.testSmtpSettings(testTo.trim() ? { to: testTo.trim() } : {});
      setStatus({ type: 'success', message: `Test email sent to ${body.to}.` });
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setTesting(false);
    }
  };

  const configured = settings?.smtp?.configured;
  const passwordSet = settings?.smtp?.passwordSet && !clearPassword;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>SMTP email delivery</Text>
          <Text style={styles.desc}>
            Sends auth email such as invite links and password-reset messages.
          </Text>
        </View>
        {!loading ? (
          <Text
            style={[styles.statusText, { color: configured ? colors.emerald400 : colors.gray500 }]}
          >
            {smtpStatusText(settings)}
          </Text>
        ) : null}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.indigo500} style={{ marginTop: 12 }} />
      ) : (
        <>
          <View style={styles.switchRow}>
            <Text style={styles.inputLabel}>Enabled</Text>
            <Switch
              value={form.enabled}
              onValueChange={(value) => setField('enabled', value)}
              trackColor={{ false: colors.gray700, true: colors.indigo700 }}
              thumbColor={form.enabled ? colors.indigo400 : colors.gray500}
            />
          </View>

          <Text style={styles.inputLabel}>Host</Text>
          <TextInput
            style={styles.textInput}
            value={form.host}
            onChangeText={(value) => setField('host', value)}
            placeholder="smtp.example.com"
            placeholderTextColor={colors.gray600}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.inputLabel}>Port</Text>
          <TextInput
            style={styles.textInput}
            value={form.port}
            onChangeText={(value) => setField('port', value)}
            placeholder="587"
            placeholderTextColor={colors.gray600}
            keyboardType="number-pad"
          />

          <Text style={styles.inputLabel}>TLS mode</Text>
          <View style={styles.segmentRow}>
            {[
              ['none', 'None'],
              ['starttls', 'STARTTLS'],
              ['ssl', 'SSL/TLS'],
            ].map(([id, label]) => (
              <TouchableOpacity
                key={id}
                style={[styles.segmentBtn, form.tlsMode === id && styles.segmentBtnActive]}
                onPress={() => setField('tlsMode', id)}
              >
                <Text style={[styles.segmentText, form.tlsMode === id && styles.segmentTextActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.inputLabel}>From address</Text>
          <TextInput
            style={styles.textInput}
            value={form.from}
            onChangeText={(value) => setField('from', value)}
            placeholder="agenthub@example.com"
            placeholderTextColor={colors.gray600}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />

          <Text style={styles.inputLabel}>Username</Text>
          <TextInput
            style={styles.textInput}
            value={form.username}
            onChangeText={(value) => setField('username', value)}
            placeholder="Username"
            placeholderTextColor={colors.gray600}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.inputLabel}>Password</Text>
          <TextInput
            style={styles.textInput}
            value={form.password}
            onChangeText={(value) => setField('password', value)}
            placeholder={passwordSet ? 'Password configured' : 'Password'}
            placeholderTextColor={colors.gray600}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.4 }]}
              onPress={save}
              disabled={saving}
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save SMTP'}</Text>
            </TouchableOpacity>
            {settings?.smtp?.passwordSet ? (
              <TouchableOpacity
                style={[styles.dangerBtn, saving && { opacity: 0.4 }]}
                disabled={saving}
                onPress={() => {
                  const next = smtpPasswordClearState(form);
                  setForm(next.form);
                  setClearPassword(next.clearPassword);
                  setStatus(next.status);
                }}
              >
                <Text style={styles.dangerBtnText}>Clear password</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.testBlock}>
            <Text style={styles.inputLabel}>Test recipient</Text>
            <TextInput
              style={styles.textInput}
              value={testTo}
              onChangeText={setTestTo}
              placeholder="you@example.com"
              placeholderTextColor={colors.gray600}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            <TouchableOpacity
              style={[styles.testBtn, (!configured || testing) && { opacity: 0.4 }]}
              onPress={sendTest}
              disabled={!configured || testing}
            >
              <Text style={styles.testBtnText}>{testing ? 'Sending...' : 'Send test'}</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {status ? (
        <Text
          style={[
            styles.note,
            { color: status.type === 'success' ? colors.emerald400 : colors.red400 },
          ]}
        >
          {status.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
    marginBottom: 4,
  },
  desc: {
    fontSize: 13,
    color: colors.gray500,
  },
  statusText: {
    fontSize: 12,
    marginTop: 2,
  },
  switchRow: {
    marginTop: 12,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  inputLabel: {
    color: colors.gray400,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
  },
  textInput: {
    backgroundColor: colors.gray900,
    color: colors.white,
    borderColor: colors.gray700,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 8,
  },
  segmentBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  segmentBtnActive: {
    borderColor: colors.indigo500,
    backgroundColor: colors.indigo900_40,
  },
  segmentText: {
    color: colors.gray400,
    fontSize: 13,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.white,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  saveBtn: {
    backgroundColor: colors.indigo600,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  dangerBtn: {
    backgroundColor: colors.red600,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  dangerBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  testBlock: {
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
  },
  testBtn: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  testBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  note: {
    fontSize: 13,
    marginTop: 12,
  },
});
