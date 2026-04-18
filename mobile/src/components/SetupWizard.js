/**
 * Mobile first-run setup wizard.
 *
 * Mirrors (a trimmed-down version of) the web client's `SetupWizard` — since
 * mobile is always a remote client, we only need: Welcome → Server connection
 * → Done. CLI/project configuration is left to the server-side setup.
 *
 * The wizard is rendered by `App.js` while `needsSetup` is true. It updates
 * the active org (or creates one if orgs are empty) and calls `onComplete`,
 * which flips a persisted "dismissed" flag so the wizard never reappears.
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
import {
  createOrg,
  updateOrg,
  switchOrg,
  getActiveOrg,
  testConnection,
} from '../utils/orgs';
import { normalizeServerUrl, validateServerUrl } from '../utils/setupState';

const STEPS = ['Welcome', 'Connect', 'Done'];

function StepIndicator({ currentStep }) {
  return (
    <View style={styles.stepRow}>
      {STEPS.map((label, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === currentStep;
        const isCompleted = stepNum < currentStep;
        return (
          <View key={label} style={styles.stepItem}>
            {i > 0 && (
              <View
                style={[
                  styles.stepConnector,
                  (isCompleted || isActive) && styles.stepConnectorActive,
                ]}
              />
            )}
            <View
              style={[
                styles.stepDot,
                isActive && styles.stepDotActive,
                isCompleted && styles.stepDotCompleted,
              ]}
            >
              <Text
                style={[
                  styles.stepDotText,
                  (isActive || isCompleted) && styles.stepDotTextActive,
                ]}
              >
                {isCompleted ? '✓' : stepNum}
              </Text>
            </View>
            <Text
              style={[
                styles.stepLabel,
                isActive && styles.stepLabelActive,
                isCompleted && styles.stepLabelCompleted,
              ]}
            >
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default function SetupWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [orgName, setOrgName] = useState('Personal');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const handleTest = async () => {
    setTestResult(null);
    const validationError = validateServerUrl(remoteUrl);
    if (validationError) {
      setTestResult({ ok: false, message: validationError });
      return;
    }
    setTesting(true);
    const result = await testConnection(normalizeServerUrl(remoteUrl), apiKey);
    setTestResult(result);
    setTesting(false);
  };

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
          name: orgName.trim() || existing.name || 'Personal',
          remoteUrl: normalized,
          apiKey: apiKey.trim(),
        });
        await switchOrg(existing.id);
      } else {
        const created = await createOrg({
          name: orgName.trim() || 'Personal',
          remoteUrl: normalized,
          apiKey: apiKey.trim(),
          color: '#6366f1',
        });
        await switchOrg(created.id);
      }
      setStep(3);
    } catch (err) {
      setSaveError(err?.message || 'Failed to save connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <StepIndicator currentStep={step} />

          {step === 1 && (
            <View style={styles.card}>
              <Text style={styles.title}>Welcome to Agent Hub</Text>
              <Text style={styles.subtitle}>
                Agent Hub orchestrates AI coding agents across your projects.
                On mobile, we connect to an Agent Hub server you already run
                on your laptop or in the cloud.
              </Text>
              <Text style={styles.bullet}>• Chat with your agents on the go</Text>
              <Text style={styles.bullet}>• Track kanban boards and PRs</Text>
              <Text style={styles.bullet}>• Review wiki notes & threads</Text>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => setStep(2)}
              >
                <Text style={styles.primaryBtnText}>Get Started</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.skipBtn}
                onPress={onComplete}
              >
                <Text style={styles.skipBtnText}>Skip for now</Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 2 && (
            <View style={styles.card}>
              <Text style={styles.title}>Connect to your server</Text>
              <Text style={styles.subtitle}>
                Enter the URL of your Agent Hub server. You can find it in the
                web app under Settings → Server Connections.
              </Text>

              <Text style={styles.inputLabel}>Name</Text>
              <TextInput
                style={styles.textInput}
                value={orgName}
                onChangeText={setOrgName}
                placeholder="Personal"
                placeholderTextColor={colors.gray500}
                autoCorrect={false}
              />

              <Text style={[styles.inputLabel, { marginTop: 14 }]}>
                Server URL
              </Text>
              <TextInput
                style={styles.textInput}
                value={remoteUrl}
                onChangeText={(v) => {
                  setRemoteUrl(v);
                  setTestResult(null);
                  setSaveError(null);
                }}
                placeholder="https://my-server.example.com:3051"
                placeholderTextColor={colors.gray500}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <Text style={[styles.inputLabel, { marginTop: 14 }]}>
                API Key (optional)
              </Text>
              <View style={styles.apiKeyRow}>
                <TextInput
                  style={[styles.textInput, { flex: 1 }]}
                  value={apiKey}
                  onChangeText={(v) => {
                    setApiKey(v);
                    setTestResult(null);
                  }}
                  placeholder="Enter API key if required"
                  placeholderTextColor={colors.gray500}
                  secureTextEntry={!showApiKey}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  onPress={() => setShowApiKey((v) => !v)}
                  style={styles.showHideBtn}
                >
                  <Text style={styles.showHideText}>
                    {showApiKey ? 'Hide' : 'Show'}
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.testBtn, (testing || !remoteUrl) && styles.btnDisabled]}
                onPress={handleTest}
                disabled={testing || !remoteUrl}
              >
                {testing ? (
                  <ActivityIndicator size="small" color={colors.gray300} />
                ) : (
                  <Text style={styles.testBtnText}>Test Connection</Text>
                )}
              </TouchableOpacity>
              {testResult && (
                <Text
                  style={[
                    styles.testResultText,
                    {
                      color: testResult.ok ? colors.emerald400 : colors.red400,
                    },
                  ]}
                >
                  {testResult.ok ? '✓ ' : '✕ '}
                  {testResult.message}
                </Text>
              )}

              {saveError && (
                <Text style={[styles.testResultText, { color: colors.red400 }]}>
                  {saveError}
                </Text>
              )}

              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => setStep(1)}
                >
                  <Text style={styles.secondaryBtnText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    styles.primaryBtnInline,
                    (!remoteUrl || saving) && styles.btnDisabled,
                  ]}
                  onPress={handleContinue}
                  disabled={!remoteUrl || saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color={colors.white} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Continue</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {step === 3 && (
            <View style={styles.card}>
              <Text style={styles.emoji}>🚀</Text>
              <Text style={styles.title}>You're all set</Text>
              <Text style={styles.subtitle}>
                Your Agent Hub server is connected. You can manage additional
                server connections, push notifications, and more from Settings.
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={onComplete}>
                <Text style={styles.primaryBtnText}>Open Agent Hub</Text>
              </TouchableOpacity>
            </View>
          )}
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
    padding: 20,
    paddingTop: 28,
  },
  stepRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    flexWrap: 'wrap',
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepConnector: {
    width: 24,
    height: 1,
    backgroundColor: colors.gray700,
    marginHorizontal: 6,
  },
  stepConnectorActive: {
    backgroundColor: colors.emerald500,
  },
  stepDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.gray700,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  stepDotActive: {
    borderColor: colors.emerald500,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
  },
  stepDotCompleted: {
    borderColor: colors.emerald500,
    backgroundColor: colors.emerald500,
  },
  stepDotText: {
    color: colors.gray500,
    fontSize: 11,
    fontWeight: '700',
  },
  stepDotTextActive: {
    color: colors.white,
  },
  stepLabel: {
    fontSize: 11,
    color: colors.gray500,
    fontWeight: '500',
  },
  stepLabelActive: {
    color: colors.emerald400,
  },
  stepLabelCompleted: {
    color: colors.emerald500,
  },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 20,
  },
  emoji: {
    fontSize: 44,
    textAlign: 'center',
    marginBottom: 8,
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
    marginBottom: 16,
    textAlign: 'center',
  },
  bullet: {
    fontSize: 13,
    color: colors.gray300,
    marginBottom: 4,
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
  apiKeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  showHideBtn: {
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  showHideText: {
    color: colors.gray400,
    fontSize: 13,
  },
  testBtn: {
    marginTop: 14,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  testBtnText: {
    color: colors.gray300,
    fontSize: 13,
    fontWeight: '500',
  },
  testResultText: {
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  primaryBtn: {
    backgroundColor: colors.emerald500,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 20,
  },
  primaryBtnInline: {
    flex: 1,
    marginTop: 0,
  },
  primaryBtnText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryBtn: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: colors.gray300,
    fontSize: 14,
    fontWeight: '500',
  },
  skipBtn: {
    marginTop: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  skipBtnText: {
    color: colors.gray500,
    fontSize: 13,
  },
  btnDisabled: {
    opacity: 0.5,
  },
});
