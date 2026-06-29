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
import {
  login,
  setup,
  getAuthStatus,
  updateEmail,
  needsEmailUpdate,
  forgotPassword,
} from '../utils/auth';
import { getApiBaseUrl } from '../utils/config';
function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
export default function LoginScreen({ onAuthenticated }: any) {
  const [mode, setMode] = useState('loading'); // loading | login | setup | email-update | forgot | forgot-sent
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<any>(null);
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
        if (needsEmailUpdate() || (status.activeOrgIsLocal && status.needsEmailUpdate)) {
          setMode('email-update');
          return;
        }
        setMode(status.authConfigured ? 'login' : 'setup');
        if (status.email) setUsername(status.email);
      } catch (err: any) {
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
    if (!username || (mode !== 'email-update' && mode !== 'forgot' && !password)) return;
    if (mode === 'forgot') {
      if (!isValidEmail(username)) {
        setError('Enter a valid email address.');
        return;
      }
      setSubmitting(true);
      try {
        await forgotPassword({ baseUrl: getApiBaseUrl(), email: username.trim() });
        setMode('forgot-sent');
        setPassword('');
      } catch (err: any) {
        setError(err?.message || 'Password reset request failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (mode === 'email-update') {
      if (!isValidEmail(username)) {
        setError('Enter a valid email address.');
        return;
      }
      setSubmitting(true);
      try {
        await updateEmail({ baseUrl: getApiBaseUrl(), email: username.trim() });
        onAuthenticated?.();
      } catch (err: any) {
        setError(err?.message || 'Failed to save email');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (mode === 'setup' && !isValidEmail(username)) {
      setError('Enter a valid email address.');
      return;
    }
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
      if (needsEmailUpdate()) {
        setPassword('');
        setMode('email-update');
      } else {
        onAuthenticated?.();
      }
    } catch (err: any) {
      setError(err?.message || 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };
  const isSetup = mode === 'setup';
  const isEmailUpdate = mode === 'email-update';
  const isForgot = mode === 'forgot';
  const isForgotSent = mode === 'forgot-sent';
  const acceptsLegacyIdentifier = !isSetup && !isEmailUpdate && !isForgot;
  const title =
    isForgot || isForgotSent
      ? 'Reset your password'
      : isEmailUpdate
        ? 'Set your email'
        : isSetup
          ? 'Create your account'
          : 'Sign in to Agent Hub';
  const subtitle = isForgotSent
    ? 'If that email can be reset, a reset link or Owner-issued code is now available.'
    : isForgot
      ? 'Enter your account email to request a password reset.'
      : isEmailUpdate
        ? 'Agent Hub now uses email as the sign-in identifier.'
        : isSetup
          ? 'No user has been configured yet. Pick an email and password for this environment.'
          : 'Enter your email and password to continue. Existing sign-in names still work during migration.';
  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <View style={styles.iconBadge}>
              {mode === 'loading' ? (
                <ActivityIndicator size="small" color={colors.emerald400} />
              ) : (
                <Text style={styles.iconEmoji}>{isSetup ? 'U' : 'K'}</Text>
              )}
            </View>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>

            {mode !== 'loading' && (
              <>
                <Text style={styles.inputLabel}>Email</Text>
                <TextInput
                  style={styles.textInput}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="owner@example.com"
                  placeholderTextColor={colors.gray500}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType={acceptsLegacyIdentifier ? 'default' : 'email-address'}
                  testID="login-username"
                />

                {!isEmailUpdate && !isForgot && !isForgotSent && (
                  <>
                    <Text style={[styles.inputLabel, { marginTop: 14 }]}>Password</Text>
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
                        12-256 characters. This single credential protects everything served from
                        this environment. Pick something strong.
                      </Text>
                    )}
                  </>
                )}

                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}

                {!isForgotSent && (
                  <TouchableOpacity
                    style={[
                      styles.primaryBtn,
                      (submitting || !username || (!isEmailUpdate && !isForgot && !password)) &&
                        styles.primaryBtnDisabled,
                    ]}
                    onPress={handleSubmit}
                    disabled={submitting || !username || (!isEmailUpdate && !isForgot && !password)}
                    testID="login-submit"
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Text style={styles.primaryBtnText}>
                        {isForgot
                          ? 'Request reset'
                          : isEmailUpdate
                            ? 'Save email'
                            : isSetup
                              ? 'Create account'
                              : 'Sign in'}
                      </Text>
                    )}
                  </TouchableOpacity>
                )}
                {!isSetup && !isEmailUpdate && (
                  <TouchableOpacity
                    style={styles.secondaryBtn}
                    onPress={() => {
                      setError(null);
                      setMode(isForgot || isForgotSent ? 'login' : 'forgot');
                    }}
                  >
                    <Text style={styles.secondaryBtnText}>
                      {isForgot || isForgotSent ? 'Back to sign in' : 'Forgot password?'}
                    </Text>
                  </TouchableOpacity>
                )}
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
  secondaryBtn: {
    marginTop: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: colors.gray400,
    fontSize: 13,
    fontWeight: '600',
  },
});
