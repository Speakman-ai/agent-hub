import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import { relativeTime } from '../../utils/time';

interface GoogleSurface {
  key: string;
  label: string;
  scopes: string[];
}

export interface GoogleStatus {
  connected: boolean;
  email: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  serverConfigured: boolean;
}

export const GOOGLE_SURFACES: GoogleSurface[] = [
  {
    key: 'calendar',
    label: 'Calendar',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  },
  {
    key: 'gmail',
    label: 'Gmail (send + modify)',
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
  },
  {
    key: 'sheets',
    label: 'Sheets',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  },
  {
    key: 'drive',
    label: 'Drive / Docs (app files)',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  },
];

export const ALL_SURFACE_SCOPES: string[] = GOOGLE_SURFACES.flatMap((surface) => surface.scopes);

export function scopeLabel(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
}

export async function openGoogleOAuth({
  apiClient,
  openURL,
  scopes,
}: {
  apiClient: { startGoogleOAuth: (opts?: any) => Promise<{ authorizeUrl: string }> };
  openURL: (url: string) => Promise<unknown>;
  scopes?: string[];
}): Promise<string> {
  const body = await apiClient.startGoogleOAuth({
    returnTo: '/settings?tab=account',
    ...(scopes?.length ? { scopes } : {}),
  });
  await openURL(body.authorizeUrl);
  return body.authorizeUrl;
}

export function GoogleConnectionContent({
  status,
  loading,
  error,
  busy,
  onConnect,
  onUpgrade,
  onDisconnect,
}: {
  status: GoogleStatus | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onConnect: () => void;
  onUpgrade: () => void;
  onDisconnect: () => void;
}) {
  if (loading) {
    return (
      <View style={styles.card} testID="google-connection-loading">
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.blue500} />
          <Text style={styles.muted}>Loading Google connection...</Text>
        </View>
      </View>
    );
  }

  const connected = !!status?.connected;
  const serverConfigured = status?.serverConfigured !== false;
  const grantedScopes = Array.isArray(status?.grantedScopes) ? status.grantedScopes : [];

  return (
    <View style={styles.card} testID="google-connection-section">
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>Google Account</Text>
          <Text style={styles.hint}>
            Connect Calendar, Gmail, Sheets, Drive, and Docs access to your account.
          </Text>
        </View>
        {connected ? (
          <Text style={[styles.badge, styles.badgeConnected]}>Connected</Text>
        ) : (
          <Text style={styles.badge}>Not connected</Text>
        )}
      </View>

      {!serverConfigured && !connected ? (
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>
            Google is not configured on this server. An Admin needs to set the Google OAuth app
            credentials before you can connect.
          </Text>
        </View>
      ) : null}

      {connected ? (
        <View style={styles.connectedBody}>
          <View style={styles.statusPanel}>
            <Text style={styles.statusLabel}>Connected as</Text>
            <Text style={styles.emailText}>{status?.email || 'Google account'}</Text>
            {status?.connectedAt ? (
              <Text style={styles.connectedAt}>Connected {relativeTime(status.connectedAt)}</Text>
            ) : null}
          </View>

          <View>
            <Text style={styles.statusLabel}>Granted access</Text>
            {grantedScopes.length ? (
              <View style={styles.scopeList}>
                {grantedScopes.map((scope) => (
                  <Text key={scope} style={styles.scopeChip}>
                    {scopeLabel(scope)}
                  </Text>
                ))}
              </View>
            ) : (
              <Text style={styles.muted}>Identity only (no data scopes granted yet).</Text>
            )}
          </View>

          <View style={styles.actionRow}>
            {serverConfigured ? (
              <TouchableOpacity
                style={[styles.secondaryButton, busy && styles.buttonDisabled]}
                onPress={onUpgrade}
                disabled={busy}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryButtonText}>
                  {busy ? 'Opening...' : 'Re-consent / upgrade access'}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.dangerButton, busy && styles.buttonDisabled]}
              onPress={onDisconnect}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.dangerButtonText}>{busy ? 'Working...' : 'Disconnect'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.connectedBody}>
          <Text style={styles.hint}>
            Link your Google account so Agent Hub can work with your Google surfaces on your behalf.
            You can grant individual surfaces later from their own views.
          </Text>
          {serverConfigured ? (
            <TouchableOpacity
              style={[styles.primaryButton, busy && styles.buttonDisabled]}
              onPress={onConnect}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>{busy ? 'Opening...' : 'Connect Google'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function GoogleConnectionSection() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      setStatus(await api.getGoogleStatus());
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void load({ silent: true });
      }
    });
    return () => sub.remove();
  }, [load]);

  const startOAuth = async (scopes?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await openGoogleOAuth({
        apiClient: api,
        openURL: (url) => Linking.openURL(url),
        scopes,
      });
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    Alert.alert('Disconnect Google?', 'Agents will lose Google API access until reconnected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError(null);
          try {
            await api.disconnectGoogle();
            await load({ silent: true });
          } catch (err: any) {
            setError(err?.message || String(err));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <GoogleConnectionContent
      status={status}
      loading={loading}
      error={error}
      busy={busy}
      onConnect={() => void startOAuth()}
      onUpgrade={() => void startOAuth(ALL_SURFACE_SCOPES)}
      onDisconnect={disconnect}
    />
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
    justifyContent: 'space-between',
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 4,
  },
  hint: {
    fontSize: 12,
    color: colors.gray500,
    lineHeight: 18,
  },
  muted: {
    fontSize: 12,
    color: colors.gray500,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    flexShrink: 0,
    fontSize: 11,
    color: colors.gray300,
    backgroundColor: colors.gray700,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
  },
  badgeConnected: {
    color: colors.emerald400,
    backgroundColor: colors.emerald900_50,
  },
  warningBox: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.amber400,
    borderRadius: 8,
    backgroundColor: colors.amber900_40,
    padding: 10,
  },
  warningText: {
    fontSize: 12,
    color: colors.amber400,
    lineHeight: 18,
  },
  connectedBody: {
    gap: 12,
    marginTop: 14,
  },
  statusPanel: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 12,
  },
  statusLabel: {
    fontSize: 11,
    color: colors.gray500,
    marginBottom: 4,
  },
  emailText: {
    fontSize: 14,
    color: colors.emerald300,
    fontFamily: 'monospace',
  },
  connectedAt: {
    fontSize: 11,
    color: colors.gray600,
    marginTop: 4,
  },
  scopeList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  scopeChip: {
    fontSize: 10,
    color: colors.gray300,
    fontFamily: 'monospace',
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  primaryButton: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
  dangerButton: {
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  dangerButtonText: {
    color: colors.red400,
    fontSize: 12,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  errorBox: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 8,
    backgroundColor: colors.red900_50,
    padding: 10,
  },
  errorText: {
    fontSize: 12,
    color: colors.red400,
  },
});
