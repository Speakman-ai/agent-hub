/**
 * Mobile first-run server connection screen.
 *
 * Mobile is a pure client: it connects to an *existing* Agent Hub server rather
 * than running or provisioning one. So first-run only needs the server's
 * address — the user then authenticates on the `LoginScreen` (gated by
 * `needsAuth` in `App.js`). No API key is collected here; sign-in is handled by
 * the login flow.
 *
 * Rendered by `App.js` while `needsSetup` is true. Persists the address into
 * the active org (creating one if none exists) and calls `onComplete`, which
 * raises the login gate.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../theme/colors';
import { createOrg, updateOrg, switchOrg, getActiveOrg } from '../utils/orgs';
import { normalizeServerUrl, validateServerUrl } from '../utils/setupState';
export default function SetupWizard({ onComplete }: any) {
  const [remoteUrl, setRemoteUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<any>(null);
  const handleContinue = async () => {
    setSaveError(null);
    const validationError = validateServerUrl(remoteUrl);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(true);
    try {
      const normalized = normalizeServerUrl(remoteUrl);
      const existing = getActiveOrg();
      if (existing) {
        await updateOrg(existing.id, {
          name: existing.name?.trim() || 'Personal',
          remoteUrl: normalized,
        });
        await switchOrg(existing.id);
      } else {
        const created = await createOrg({
          name: 'Personal',
          remoteUrl: normalized,
          color: '#6366f1',
        });
        await switchOrg(created.id);
      }
      // Hand back to App.js, which raises the login gate now that a server
      // address is configured. Keep `saving` true through the unmount so the
      // button can't be tapped twice.
      await onComplete?.();
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save connection.');
      setSaving(false);
    }
  };
  const canContinue = remoteUrl.trim().length > 0 && !saving;
  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.title}>Connect to your server</Text>
            <Text style={styles.subtitle}>
              Enter the address of the Agent Hub server you want to use. You'll sign in on the next
              screen. You can find the address in the web app under Settings → Server Connections.
            </Text>

            <Text style={styles.inputLabel}>Server address</Text>
            <TextInput
              style={styles.textInput}
              value={remoteUrl}
              onChangeText={(v: any) => {
                setRemoteUrl(v);
                setSaveError(null);
              }}
              placeholder="https://my-server.example.com:3051"
              placeholderTextColor={colors.gray500}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (canContinue) handleContinue();
              }}
            />

            {saveError && <Text style={styles.errorText}>{saveError}</Text>}

            <TouchableOpacity
              style={[styles.primaryBtn, !canContinue && styles.btnDisabled]}
              onPress={handleContinue}
              disabled={!canContinue}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Text style={styles.primaryBtnText}>Continue to sign in</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.white,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.gray400,
    marginBottom: 20,
    textAlign: 'center',
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.gray400,
    marginBottom: 6,
  },
  textInput: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.white,
  },
  errorText: {
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
    color: colors.red400,
  },
  primaryBtn: {
    backgroundColor: colors.emerald500,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 20,
  },
  primaryBtnText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.5,
  },
});
