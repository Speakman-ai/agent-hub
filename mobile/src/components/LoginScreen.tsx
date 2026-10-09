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
import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  completeMfaLogin,
  forgotPassword,
  isAuthenticated,
  clearToken,
} from '../utils/auth';
import { getApiBaseUrl } from '../utils/config';
import { shouldGateAuthFromStatus } from '../utils/setupState';
import BrandLogo from './BrandLogo';
import LoginServerPicker from './LoginServerPicker';

export function getPostAuthenticationMode({
  needsEmailUpdateValue,
}: {
  needsEmailUpdateValue: boolean;
}) {
  return needsEmailUpdateValue ? 'email-update' : 'authenticated';
}

/**
 * What the login screen should do with a fresh `/auth/status` probe.
 *
 * On first mount the app already decided to gate, so the screen just picks a
 * form. After the user switches servers from the picker, the gate decision is
 * stale: the new server goes through the same policy AppContext applies at
 * startup, and `'release'` means the app would not have gated on it at all
 * (e.g. a bundled local server), so the login screen must step aside.
 */
export function resolveProbedLoginMode({
  status,
  serverChanged,
  isAuthenticatedValue,
  needsEmailUpdateValue,
}: {
  status: any;
  serverChanged: boolean;
  isAuthenticatedValue: boolean;
  needsEmailUpdateValue: boolean;
}): 'email-update' | 'login' | 'setup' | 'release' {
  if (needsEmailUpdateValue || (status?.activeOrgIsLocal && status?.needsEmailUpdate)) {
    return 'email-update';
  }
  if (
    serverChanged &&
    !shouldGateAuthFromStatus({
      status,
      isAuthenticated: isAuthenticatedValue,
      needsEmailUpdate: needsEmailUpdateValue,
    })
  ) {
    return 'release';
  }
  return status?.authConfigured ? 'login' : 'setup';
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
export default function LoginScreen({ onAuthenticated, onSwitchOrg }: any) {
  const [mode, setMode] = useState('loading'); // loading | login | setup | email-update
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaMode, setMfaMode] = useState('totp');
  const [pendingMfa, setPendingMfa] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumped by the server picker after an org swap / URL edit so the status
  // probe below re-runs against the new server.
  const [probeNonce, setProbeNonce] = useState(0);
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;
  // Sign-in and server switching are mutually exclusive, and this screen is
  // the only arbiter. The refs are the synchronous source of truth (state
  // lags a render); `switching` mirrors the ref for rendering. The epoch
  // advances when a switch *starts*, so any auth response from before it is
  // stale no matter when the switch finishes.
  const submittingRef = useRef(false);
  const switchingRef = useRef(false);
  const serverEpochRef = useRef(0);
  const [switching, setSwitching] = useState(false);
  const beginServerChange = useCallback(() => {
    if (submittingRef.current || switchingRef.current) return false;
    switchingRef.current = true;
    serverEpochRef.current += 1;
    setSwitching(true);
    return true;
  }, []);
  const endServerChange = useCallback(() => {
    switchingRef.current = false;
    setSwitching(false);
    setMode('loading');
    setError(null);
    setPassword('');
    setMfaCode('');
    setPendingMfa(null);
    setProbeNonce((n) => n + 1);
  }, []);
  const finishAuthentication = () => {
    if (
      getPostAuthenticationMode({ needsEmailUpdateValue: needsEmailUpdate() }) === 'email-update'
    ) {
      setPassword('');
      setMfaCode('');
      setPendingMfa(null);
      setMode('email-update');
      return;
    }
    onAuthenticated?.();
  };
  useEffect(() => {
    // A probe describes the server it was sent to. Once another switch has
    // started, its answer is about a server the user is leaving.
    const epoch = serverEpochRef.current;
    let cancelled = false;
    const stale = () => cancelled || epoch !== serverEpochRef.current;
    (async () => {
      try {
        const baseUrl = getApiBaseUrl();
        if (!baseUrl) {
          if (!stale()) {
            setError('No server URL configured.');
            setMode('login');
          }
          return;
        }
        const status = await getAuthStatus(baseUrl);
        if (stale()) return;
        const next = resolveProbedLoginMode({
          status,
          serverChanged: probeNonce > 0,
          isAuthenticatedValue: isAuthenticated(),
          needsEmailUpdateValue: needsEmailUpdate(),
        });
        if (next === 'release') {
          onAuthenticatedRef.current?.();
          return;
        }
        setMode(next);
        if (next !== 'email-update' && status.email) setUsername(status.email);
      } catch (err: any) {
        if (stale()) return;
        setError(err?.message || 'Failed to reach server');
        setMode('login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [probeNonce]);
  const handleSubmit = async () => {
    if (submittingRef.current || switchingRef.current) return;
    submittingRef.current = true;
    try {
      await submitAuth();
    } finally {
      submittingRef.current = false;
    }
  };
  const submitAuth = async () => {
    setError(null);
    const epoch = serverEpochRef.current;
    // True (after dropping any token it stored) when the server changed while
    // this request was in flight; the caller then abandons the result.
    const isStale = async () => {
      if (epoch === serverEpochRef.current) return false;
      await clearToken();
      return true;
    };
    if (pendingMfa) {
      if (!mfaCode.trim()) return;
      setSubmitting(true);
      try {
        await completeMfaLogin({
          baseUrl: getApiBaseUrl(),
          challengeId: pendingMfa.challengeId,
          code: mfaCode.trim().replace(/\s+/g, ''),
        });
        if (await isStale()) return;
        setMfaCode('');
        setPendingMfa(null);
        finishAuthentication();
      } catch (err: any) {
        setError(err?.message || 'MFA verification failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (!username || (mode !== 'email-update' && mode !== 'forgot' && !password)) return;
    if (mode === 'forgot') {
      setSubmitting(true);
      try {
        await forgotPassword({ baseUrl: getApiBaseUrl(), email: username.trim() });
        setMode('forgot-sent');
      } catch (err: any) {
        setError(err?.message || 'Failed to send reset email');
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
        if (await isStale()) return;
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
        if (await isStale()) return;
      } else {
        const result = await login({ baseUrl, username, password });
        if (await isStale()) return;
        if (result?.mfaRequired) {
          setPendingMfa(result);
          setPassword('');
          return;
        }
      }
      finishAuthentication();
    } catch (err: any) {
      setError(err?.message || 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };
  const authLocked = submitting || switching;
  const isSetup = mode === 'setup';
  const isEmailUpdate = mode === 'email-update';
  const isForgot = mode === 'forgot';
  const isForgotSent = mode === 'forgot-sent';
  const acceptsLegacyIdentifier = !isSetup && !isEmailUpdate && !isForgot;
  const title = pendingMfa
    ? 'Verify MFA'
    : isEmailUpdate
      ? 'Set your email'
      : isForgot || isForgotSent
        ? 'Reset your password'
        : isSetup
          ? 'Create your account'
          : null;
  const subtitle = pendingMfa
    ? 'Enter an authenticator code or use a recovery code.'
    : isForgotSent
      ? 'If that email has an account, a reset link is on its way. The link expires in 30 minutes.'
      : isForgot
        ? 'Enter your email and we will send a password reset link if an account exists.'
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
            <View style={styles.logoWrap}>
              <BrandLogo size="lg" />
            </View>
            {mode === 'loading' ? (
              <ActivityIndicator
                size="small"
                color={colors.emerald400}
                style={styles.loadingSpinner}
              />
            ) : null}
            {title ? <Text style={styles.title}>{title}</Text> : null}
            <Text style={styles.subtitle}>{subtitle}</Text>

            {/* Swap orgs / edit the server URL before signing in, so pointing
                the app at an org without a password never locks the user out.
                Hidden mid-MFA so the challenge isn't abandoned by accident, and
                locked while a sign-in is in flight so it can't complete
                against a server the user already left. */}
            {onSwitchOrg && !pendingMfa && !isEmailUpdate ? (
              <LoginServerPicker
                onSwitchOrg={onSwitchOrg}
                onServerChangeStart={beginServerChange}
                onServerChangeEnd={endServerChange}
                disabled={submitting}
              />
            ) : null}

            {mode !== 'loading' && pendingMfa && (
              <>
                <View style={styles.segmentRow}>
                  <TouchableOpacity
                    style={[styles.segmentBtn, mfaMode === 'totp' && styles.segmentBtnActive]}
                    onPress={() => setMfaMode('totp')}
                  >
                    <Text
                      style={[styles.segmentText, mfaMode === 'totp' && styles.segmentTextActive]}
                    >
                      Authenticator
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.segmentBtn, mfaMode === 'recovery' && styles.segmentBtnActive]}
                    onPress={() => setMfaMode('recovery')}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        mfaMode === 'recovery' && styles.segmentTextActive,
                      ]}
                    >
                      Recovery code
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.inputLabel}>
                  {mfaMode === 'recovery' ? 'Recovery code' : 'Authenticator code'}
                </Text>
                <TextInput
                  style={styles.textInput}
                  value={mfaCode}
                  onChangeText={setMfaCode}
                  placeholder={mfaMode === 'recovery' ? 'Recovery code' : '123456'}
                  placeholderTextColor={colors.gray500}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType={mfaMode === 'recovery' ? 'default' : 'number-pad'}
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  testID="login-mfa-code"
                />
                <TouchableOpacity
                  onPress={() => {
                    setPendingMfa(null);
                    setMfaCode('');
                    setError(null);
                  }}
                  style={styles.secondaryBtn}
                >
                  <Text style={styles.secondaryBtnText}>Back to password</Text>
                </TouchableOpacity>
                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    (authLocked || !mfaCode.trim()) && styles.primaryBtnDisabled,
                  ]}
                  onPress={handleSubmit}
                  disabled={authLocked || !mfaCode.trim()}
                  testID="login-submit"
                >
                  {submitting ? (
                    <ActivityIndicator size="small" color={colors.white} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Verify and sign in</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
            {mode !== 'loading' && !pendingMfa && (
              <>
                {!isForgotSent && (
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

                    {!isEmailUpdate && !isForgot && (
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
                            12–256 characters. This single credential protects everything served
                            from this environment — pick something strong.
                          </Text>
                        )}
                      </>
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
                      (authLocked || !username || (!isEmailUpdate && !isForgot && !password)) &&
                        styles.primaryBtnDisabled,
                    ]}
                    onPress={handleSubmit}
                    disabled={authLocked || !username || (!isEmailUpdate && !isForgot && !password)}
                    testID="login-submit"
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Text style={styles.primaryBtnText}>
                        {isEmailUpdate
                          ? 'Save email'
                          : isForgot
                            ? 'Send reset link'
                            : isSetup
                              ? 'Create account'
                              : 'Sign in'}
                      </Text>
                    )}
                  </TouchableOpacity>
                )}

                {!isSetup && !isEmailUpdate && (
                  <TouchableOpacity
                    onPress={() => {
                      setError(null);
                      setMode(isForgot || isForgotSent ? 'login' : 'forgot');
                    }}
                    style={styles.secondaryBtn}
                    testID="login-forgot-toggle"
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
  logoWrap: {
    alignItems: 'center',
    marginBottom: 12,
  },
  loadingSpinner: {
    marginBottom: 12,
    alignSelf: 'center',
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
  segmentRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  segmentBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  segmentBtnActive: {
    borderColor: colors.emerald500,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
  },
  segmentText: {
    color: colors.gray400,
    fontSize: 12,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.white,
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
