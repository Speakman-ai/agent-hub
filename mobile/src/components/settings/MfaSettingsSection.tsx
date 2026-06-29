import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { api } from '../../utils/api';
import { copyToClipboard } from '../../utils/clipboard';
import { colors } from '../../theme/colors';

export function normalizeMfaCode(value: any) {
  return String(value || '').trim().replace(/\s+/g, '');
}

export function getMfaQrCodeProps(otpauthUri: string) {
  return {
    value: otpauthUri,
    size: 220,
    backgroundColor: colors.white,
    color: colors.gray950,
  };
}

export default function MfaSettingsSection() {
  const [me, setMe] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [enrollment, setEnrollment] = useState<any>(null);
  const [code, setCode] = useState('');
  const [actionCode, setActionCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const body = await api.getMe();
      setMe(body?.user || null);
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setMfaEnabled = (enabled: boolean) => {
    setMe((prev: any) => (prev ? { ...prev, mfaEnabled: enabled } : prev));
  };

  const startEnrollment = async () => {
    setBusy('start');
    setStatus(null);
    setRecoveryCodes([]);
    try {
      setEnrollment(await api.startMfaEnrollment());
      setStatus({ type: 'success', message: 'Scan the QR code, then enter a current code.' });
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setBusy(null);
    }
  };

  const confirmEnrollment = async () => {
    setBusy('confirm');
    setStatus(null);
    try {
      const body = await api.confirmMfaEnrollment(normalizeMfaCode(code));
      setRecoveryCodes(body.recoveryCodes || []);
      setEnrollment(null);
      setCode('');
      setMfaEnabled(true);
      setStatus({ type: 'success', message: 'MFA enabled. Save these recovery codes now.' });
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    setBusy('regenerate');
    setStatus(null);
    try {
      const body = await api.regenerateMfaRecoveryCodes(normalizeMfaCode(actionCode));
      setRecoveryCodes(body.recoveryCodes || []);
      setActionCode('');
      setStatus({ type: 'success', message: 'Recovery codes regenerated. Save the new codes now.' });
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setBusy(null);
    }
  };

  const disable = () => {
    Alert.alert('Disable MFA', 'Disable MFA for your account?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disable',
        style: 'destructive',
        onPress: async () => {
          setBusy('disable');
          setStatus(null);
          try {
            await api.disableMfa(normalizeMfaCode(actionCode));
            setActionCode('');
            setRecoveryCodes([]);
            setEnrollment(null);
            setMfaEnabled(false);
            setStatus({ type: 'success', message: 'MFA disabled.' });
          } catch (err: any) {
            setStatus({ type: 'error', message: err.message || String(err) });
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  };

  if (loading) return <Text style={styles.emptyText}>Loading MFA...</Text>;
  if (!me) return null;

  const enabled = !!me.mfaEnabled;

  return (
    <View style={styles.accountCard}>
      <View style={styles.headerRow}>
        <Text style={styles.accountCardTitle}>Multi-factor authentication</Text>
        <Text style={[styles.statusPill, { color: enabled ? colors.emerald400 : colors.gray500 }]}>
          {enabled ? 'Enabled' : 'Not enabled'}
        </Text>
      </View>
      <Text style={styles.sectionDesc}>App-based one-time codes plus single-use recovery codes.</Text>

      {!enabled && !enrollment && recoveryCodes.length === 0 ? (
        <TouchableOpacity style={styles.saveBtn} onPress={startEnrollment} disabled={busy !== null}>
          <Text style={styles.saveBtnText}>{busy === 'start' ? 'Starting...' : 'Start enrollment'}</Text>
        </TouchableOpacity>
      ) : null}

      {enrollment ? (
        <View style={styles.enrollmentBox}>
          <View style={styles.qrBox}>
            <QRCode {...getMfaQrCodeProps(enrollment.otpauthUri)} />
          </View>
          <Text style={styles.inputLabel}>Manual secret</Text>
          <Text selectable style={styles.secretText}>
            {enrollment.secret}
          </Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={() => copyToClipboard(enrollment.secret)}>
            <Text style={styles.cancelBtnText}>Copy secret</Text>
          </TouchableOpacity>
          <Text style={[styles.inputLabel, { marginTop: 12 }]}>Current code</Text>
          <TextInput
            style={styles.textInput}
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            placeholderTextColor={colors.gray600}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            testID="mfa-confirm-code"
          />
          <View style={styles.actionRow}>
            <TouchableOpacity style={[styles.saveBtn, !normalizeMfaCode(code) && { opacity: 0.4 }]} onPress={confirmEnrollment} disabled={!normalizeMfaCode(code) || busy !== null}>
              <Text style={styles.saveBtnText}>{busy === 'confirm' ? 'Confirming...' : 'Confirm and enable'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => {
              setEnrollment(null);
              setCode('');
            }}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {recoveryCodes.length > 0 ? (
        <View style={styles.recoveryBox}>
          <Text style={styles.recoveryTitle}>Recovery codes are shown once.</Text>
          {recoveryCodes.map((item: any) => (
            <Text selectable key={item} style={styles.recoveryCode}>
              {item}
            </Text>
          ))}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => copyToClipboard(recoveryCodes.join('\n'))}>
              <Text style={styles.cancelBtnText}>Copy codes</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setRecoveryCodes([])}>
              <Text style={styles.cancelBtnText}>I saved these codes</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {enabled ? (
        <View style={styles.enabledBox}>
          <Text style={styles.inputLabel}>Authenticator or recovery code</Text>
          <TextInput
            style={styles.textInput}
            value={actionCode}
            onChangeText={setActionCode}
            placeholder="Code"
            placeholderTextColor={colors.gray600}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="one-time-code"
          />
          <View style={styles.actionRow}>
            <TouchableOpacity style={[styles.saveBtn, !normalizeMfaCode(actionCode) && { opacity: 0.4 }]} onPress={regenerate} disabled={!normalizeMfaCode(actionCode) || busy !== null}>
              <Text style={styles.saveBtnText}>{busy === 'regenerate' ? 'Regenerating...' : 'Regenerate codes'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.dangerBtn, !normalizeMfaCode(actionCode) && { opacity: 0.4 }]} onPress={disable} disabled={!normalizeMfaCode(actionCode) || busy !== null}>
              <Text style={styles.dangerBtnText}>{busy === 'disable' ? 'Disabling...' : 'Disable MFA'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {status ? (
        <Text style={[styles.statusText, { color: status.type === 'success' ? colors.emerald400 : colors.red400 }]}>
          {status.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  accountCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  accountCardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 8,
  },
  statusPill: {
    fontSize: 12,
    fontWeight: '600',
  },
  sectionDesc: {
    fontSize: 13,
    color: colors.gray500,
    marginBottom: 16,
  },
  inputLabel: {
    color: colors.gray400,
    fontSize: 13,
    fontWeight: '600',
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
  cancelBtn: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: colors.gray200,
    fontSize: 13,
    fontWeight: '600',
  },
  dangerBtn: {
    backgroundColor: colors.red600,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  dangerBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  enrollmentBox: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  qrBox: {
    width: 220,
    height: 220,
    borderRadius: 8,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 8,
  },
  secretText: {
    color: colors.gray200,
    backgroundColor: colors.gray900,
    borderColor: colors.gray700,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 12,
  },
  recoveryBox: {
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  recoveryTitle: {
    color: colors.yellow400,
    fontSize: 13,
    fontWeight: '600',
  },
  recoveryCode: {
    color: colors.white,
    backgroundColor: colors.gray900,
    borderRadius: 6,
    padding: 8,
    fontSize: 12,
  },
  enabledBox: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  statusText: {
    fontSize: 13,
    marginTop: 12,
  },
  emptyText: {
    fontSize: 14,
    color: colors.gray500,
  },
});
