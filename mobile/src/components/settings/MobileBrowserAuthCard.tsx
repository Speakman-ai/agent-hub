import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { colors } from '../../theme/colors';
import { copyToClipboard } from '../../utils/clipboard';

type BrowserAuthStatus = {
  uiStatus?: string;
  binary?: { present?: boolean; path?: string };
  oauth?: { loggedIn?: boolean | null; email?: string | null };
  loginInProgress?: boolean;
  statusError?: string | null;
};

type BrowserAuthCardProps = {
  label: string;
  description: string;
  loginMode: 'url' | 'device';
  getStatus: () => Promise<BrowserAuthStatus>;
  startLogin: () => Promise<Record<string, any>>;
  cancelLogin: () => Promise<unknown>;
  logout: () => Promise<{ output?: string }>;
};

const POLL_INTERVAL_MS = 3000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export default function MobileBrowserAuthCard({
  label,
  description,
  loginMode,
  getStatus,
  startLogin,
  cancelLogin,
  logout,
}: BrowserAuthCardProps) {
  const [status, setStatus] = useState<BrowserAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const timers = useRef<{ interval: ReturnType<typeof setInterval> | null; timeout: ReturnType<typeof setTimeout> | null }>({
    interval: null,
    timeout: null,
  });
  const statusGeneration = useRef(0);
  const pollInFlightGeneration = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (timers.current.interval) clearInterval(timers.current.interval);
    if (timers.current.timeout) clearTimeout(timers.current.timeout);
    timers.current = { interval: null, timeout: null };
    statusGeneration.current += 1;
  }, []);

  const refresh = useCallback(async (requestGeneration = statusGeneration.current) => {
    const isCurrent = () => statusGeneration.current === requestGeneration;
    try {
      const next = await getStatus();
      if (!isCurrent()) return null;
      setStatus(next);
      setError(null);
      return next;
    } catch (err: any) {
      if (!isCurrent()) return null;
      setError(err?.message || `Failed to load ${label} sign-in status.`);
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [getStatus, label]);

  useEffect(() => {
    void refresh();
    return clearTimers;
  }, [clearTimers, refresh]);

  const startPolling = useCallback(() => {
    clearTimers();
    const generation = statusGeneration.current;
    const poll = async () => {
      if (statusGeneration.current !== generation || pollInFlightGeneration.current === generation) {
        return;
      }
      pollInFlightGeneration.current = generation;
      try {
        const next = await refresh(generation);
        if (!next || statusGeneration.current !== generation) return;
        const loginFinished = next.loginInProgress === false;
        if (
          loginFinished &&
          (next.oauth?.loggedIn === true || next.uiStatus === 'authenticated')
        ) {
          clearTimers();
          setBusy(false);
          setLoginUrl(null);
          setUserCode(null);
          setActionMessage(`${label} sign-in complete.`);
        } else if (next.loginInProgress === false) {
          clearTimers();
          setBusy(false);
          setLoginUrl(null);
          setUserCode(null);
          setActionMessage(next.statusError || `${label} sign-in did not finish. Try again.`);
        }
      } finally {
        if (pollInFlightGeneration.current === generation) {
          pollInFlightGeneration.current = null;
        }
      }
    };
    timers.current.interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    timers.current.timeout = setTimeout(() => {
      clearTimers();
      setBusy(false);
      setActionMessage(`${label} sign-in timed out. Try again.`);
    }, LOGIN_TIMEOUT_MS);
  }, [clearTimers, label, refresh]);

  const handleLogin = async () => {
    clearTimers();
    const generation = statusGeneration.current;
    setBusy(true);
    setError(null);
    setActionMessage(null);
    setLoginUrl(null);
    setUserCode(null);
    try {
      const result = await startLogin();
      if (statusGeneration.current !== generation) return;
      const url = loginMode === 'device' ? result.deviceAuthUrl : result.loginUrl;
      if (url) {
        setLoginUrl(url);
        if (loginMode === 'device' && result.userCode) setUserCode(result.userCode);
        startPolling();
        try {
          await WebBrowser.openBrowserAsync(url);
        } catch {
          // The URL remains visible with a copy action if the native browser
          // cannot be opened on this device.
        }
      } else if (result.completed) {
        await refresh(generation);
        if (statusGeneration.current !== generation) return;
        setBusy(false);
        setActionMessage(`${label} sign-in complete.`);
      } else {
        setBusy(false);
        setActionMessage(result.output || `Could not start ${label} sign-in.`);
      }
    } catch (err: any) {
      if (statusGeneration.current !== generation) return;
      setBusy(false);
      setActionMessage(err?.message || `${label} sign-in failed.`);
    }
  };

  const handleCancel = async () => {
    clearTimers();
    try {
      await cancelLogin();
    } catch {
      // The process may already have exited; status refresh is authoritative.
    }
    setBusy(false);
    setLoginUrl(null);
    setUserCode(null);
    setActionMessage('Sign-in cancelled.');
    await refresh();
  };

  const handleLogout = async () => {
    clearTimers();
    setBusy(true);
    try {
      const result = await logout();
      setLoginUrl(null);
      setUserCode(null);
      setActionMessage(result?.output || `Signed out of ${label}.`);
      await refresh();
    } catch (err: any) {
      setActionMessage(err?.message || `${label} sign-out failed.`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <ActivityIndicator size="small" color={colors.gray500} style={styles.loading} />;
  }

  const statusSignedIn = status?.oauth?.loggedIn === true || status?.uiStatus === 'authenticated';
  const signedIn = statusSignedIn && !(busy && status?.loginInProgress === true);
  const binaryMissing = status?.binary?.present === false;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.grow}>
          <Text style={styles.title}>{label} browser sign-in</Text>
          <Text style={styles.description}>{description}</Text>
        </View>
        {signedIn && <Text style={styles.signedIn}>Signed in</Text>}
      </View>

      {binaryMissing && <Text style={styles.warning}>CLI binary not found at {status?.binary?.path}.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      {status?.statusError && !binaryMissing && <Text style={styles.error}>{status.statusError}</Text>}

      {loginUrl && (
        <View style={styles.loginBox}>
          <Text style={styles.loginHint}>
            {loginMode === 'device' ? 'Complete sign-in in the browser, then return here.' : 'Complete sign-in in the browser; this screen checks for completion.'}
          </Text>
          {userCode && <Text style={styles.code}>{userCode}</Text>}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => void copyToClipboard(loginUrl)}>
              <Text style={styles.secondaryText}>Copy link</Text>
            </TouchableOpacity>
            {userCode && (
              <TouchableOpacity style={styles.secondaryButton} onPress={() => void copyToClipboard(userCode)}>
                <Text style={styles.secondaryText}>Copy code</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {actionMessage && <Text style={styles.message}>{actionMessage}</Text>}

      <View style={styles.actionRow}>
        {signedIn ? (
          <TouchableOpacity style={styles.dangerButton} onPress={() => void handleLogout()} disabled={busy}>
            <Text style={styles.dangerText}>{busy ? 'Signing out…' : 'Sign out'}</Text>
          </TouchableOpacity>
        ) : busy ? (
          <TouchableOpacity style={styles.dangerButton} onPress={() => void handleCancel()}>
            <Text style={styles.dangerText}>Cancel sign-in</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.primaryButton, binaryMissing && styles.disabled]} onPress={() => void handleLogin()} disabled={binaryMissing}>
            <Text style={styles.primaryText}>Sign in with browser</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderTopWidth: 1, borderTopColor: colors.gray700, marginTop: 12, paddingTop: 12 },
  loading: { marginVertical: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  grow: { flex: 1 },
  title: { color: colors.gray300, fontSize: 12, fontWeight: '600' },
  description: { color: colors.gray500, fontSize: 11, marginTop: 3, lineHeight: 16 },
  signedIn: { color: colors.emerald400, fontSize: 11, fontWeight: '600' },
  warning: { color: colors.amber400, fontSize: 11, marginTop: 8 },
  error: { color: colors.red400, fontSize: 11, marginTop: 8 },
  message: { color: colors.gray400, fontSize: 11, marginTop: 8 },
  loginBox: { backgroundColor: colors.gray900, borderRadius: 8, padding: 10, marginTop: 10 },
  loginHint: { color: colors.gray400, fontSize: 11, lineHeight: 16 },
  code: { color: colors.white, fontFamily: 'monospace', fontSize: 17, fontWeight: '600', marginTop: 8 },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  primaryButton: { backgroundColor: colors.blue600, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  primaryText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  secondaryButton: { borderColor: colors.gray700, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7 },
  secondaryText: { color: colors.gray300, fontSize: 11 },
  dangerButton: { backgroundColor: colors.red900_50, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  dangerText: { color: colors.red400, fontSize: 12, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
