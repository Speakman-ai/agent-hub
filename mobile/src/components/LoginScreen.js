/**
 * Mobile login gate.
 *
 * Mirrors the web client's `LoginScreen.jsx`. Renders a "sign in" form when
 * the server has auth configured, and a first-run "create owner account"
 * form when not. Called by `App.js` when `needsAuth` is true.
 *
 * On success, invokes `onAuthenticated` so the parent can re-render into
 * the normal app.
 */

import React, { useState, useEffect } from 'react';
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
import { login, setup, getAuthStatus } from '../utils/auth';
import { getApiBaseUrl } from '../utils/config';

export default function LoginScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('loading'); // loading | login | setup
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const baseUrl = getApiBaseUrl();
        if (!baseUrl) {
          if (!cancelled) {
            setError('No server URL configured.');
            setMode('login');
          }
          return;
        }
        const status = await getAuthStatus(baseUrl);
        if (cancelled) return;
        setMode(status.authConfigured ? 'login' : 'setup');
        if (status.username) setUsername(status.username);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || 'Failed to reach server');
        setMode('login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async () => {
    setError(null);
    if (!username || !password) return;
    if (mode === 'setup' && password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const baseUrl = getApiBaseUrl();
      if (mode === 'setup') {
        await setup({ baseUrl, username, password });
      } else {
        await login({ baseUrl, username, password });
      }
      onAuthenticated?.();
    } catch (err) {
      setError(err?.message || 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  const isSetup = mode === 'setup';
  const title = isSetup ? 'Create your account' : 'Sign in to Agent Hub';
  const subtitle = isSetup
    ? 'No user has been configured yet. Pick a username and password for this environment.'
    : 'Enter your credentials to continue.';

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
          <View style={styles.card}>
            <View style={styles.iconBadge}>
              {mode === 'loading' ? (
                <ActivityIndicator size="small" color={colors.emerald400} />
              ) : (
                <Text style={styles.iconEmoji}>{isSetup ? '👤' : '🔑'}</Text>
              )}
            </View>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>

            {mode !== 'loading' && (
              <>
                <Text style={styles.inputLabel}>Username</Text>
                <TextInput
                  style={styles.textInput}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="owner"
                  placeholderTextColor={colors.gray500}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="username"
                  testID="login-username"
                />

                <Text style={[styles.inputLabel, { marginTop: 14 }]}>
                  Password
                </Text>
                <TextInput
                  style={styles.textInput}
                  value={password}
                  onChangeText={setPassword}
                  placeholder={isSetup ? '12+ characters' : 'Your password'}
                  placeholderTextColor={colors.gray500}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  testID="login-password"
                />
                {isSetup && (
                  <Text style={styles.helpText}>
                    12–256 characters. This single credential protects everything
                    served from this environment — pick something strong.
                  </Text>
                )}

                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}

                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    (submitting || !username || !password) &&
                      styles.primaryBtnDisabled,
                  ]}
                  onPress={handleSubmit}
                  disabled={submitting || !username || !password}
                  testID="login-submit"
                >
                  {submitting ? (
                    <ActivityIndicator size="small" color={colors.white} />
                  ) : (
                    <Text style={styles.primaryBtnText}>
                      {isSetup ? 'Create account' : 'Sign in'}
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}
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
    padding: 20,
    paddingTop: 28,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 20,
  },
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 12,
  },
  iconEmoji: {
    fontSize: 26,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.white,
    marginBottom: 6,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.gray400,
    marginBottom: 18,
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
    color: colors.white,
    fontSize: 14,
  },
  helpText: {
    fontSize: 11,
    color: colors.gray500,
    marginTop: 6,
    lineHeight: 15,
  },
  errorBox: {
    marginTop: 14,
    padding: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 8,
  },
  errorText: {
    color: colors.red400,
    fontSize: 12,
    lineHeight: 17,
  },
  primaryBtn: {
    marginTop: 18,
    backgroundColor: colors.emerald500,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnDisabled: {
    backgroundColor: colors.gray700,
  },
  primaryBtnText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
});
