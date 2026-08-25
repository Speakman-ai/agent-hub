import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import MobileBrowserAuthCard from './MobileBrowserAuthCard';
import { signInWithGithub } from '../../utils/oauthSignIn';
import {
  CLI_KEY_PROVIDERS,
  providerKeyConfigured,
  providerStatusLabel,
  buildPutMyAuthBody,
  codexDeviceLoginLabel,
  githubStatusLabel,
} from '../../utils/settingsCliKeys';

const BROWSER_AUTH_PROVIDERS: Record<string, any> = {
  claude: {
    label: 'Claude Code',
    description: 'Use your Claude account subscription instead of a pasted token.',
    loginMode: 'url',
    getStatus: api.getMyClaudeBrowserAuth,
    startLogin: api.startMyClaudeBrowserLogin,
    cancelLogin: api.cancelMyClaudeBrowserLogin,
    logout: api.logoutMyClaudeBrowser,
  },
  cursor: {
    label: 'Cursor Agent',
    description: 'Use your Cursor account for sessions you own.',
    loginMode: 'url',
    getStatus: api.getMyCursorBrowserAuth,
    startLogin: api.startMyCursorBrowserLogin,
    cancelLogin: api.cancelMyCursorBrowserLogin,
    logout: api.logoutMyCursorBrowser,
  },
  codex: {
    label: 'Codex',
    description: 'Sign in with your ChatGPT account using device authorization.',
    loginMode: 'device',
    getStatus: api.getMyCodexBrowserAuth,
    startLogin: api.startMyCodexBrowserDeviceLogin,
    cancelLogin: api.cancelMyCodexBrowserDeviceLogin,
    logout: api.logoutMyCodexBrowser,
  },
};
function ProviderCard({ provider }: any) {
  const [body, setBody] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<any>(null);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.getMyAuth(provider.id);
      setBody(data);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load credential status.');
    } finally {
      setLoading(false);
    }
  }, [provider.id]);
  useEffect(() => {
    load();
  }, [load]);
  const save = async (value: any) => {
    setSaving(true);
    try {
      const updated = await api.putMyAuth(provider.id, buildPutMyAuthBody(provider.id, value));
      setBody(updated);
      setKeyInput('');
    } catch (err: any) {
      Alert.alert('Save failed', err?.message || 'Could not save the key.');
    } finally {
      setSaving(false);
    }
  };
  const handleClear = () => {
    Alert.alert('Remove key', `Remove your ${provider.label} API key?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => save('') },
    ]);
  };
  const configured = providerKeyConfigured(provider.id, body);
  const codexStatus = provider.id === 'codex' ? codexDeviceLoginLabel(body) : null;
  const browserAuth = BROWSER_AUTH_PROVIDERS[provider.id];
  return (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{provider.label}</Text>
          <Text style={styles.cardDesc}>{provider.description}</Text>
        </View>
        {!loading && !loadError && (
          <Text
            style={[styles.statusText, { color: configured ? colors.emerald400 : colors.gray500 }]}
          >
            {configured ? 'Configured' : 'Not configured'}
          </Text>
        )}
      </View>

      {loading ? (
        <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 12 }} />
      ) : loadError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorBoxText}>{loadError}</Text>
          <TouchableOpacity onPress={load}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text style={styles.statusDetail}>{providerStatusLabel(provider.id, body)}</Text>
          {codexStatus && <Text style={styles.statusDetail}>ChatGPT sign-in: {codexStatus}</Text>}

          <Text style={styles.fieldLabel}>
            {configured ? `Replace ${provider.keyLabel}` : `Set ${provider.keyLabel}`}
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              value={keyInput}
              onChangeText={setKeyInput}
              placeholder={provider.placeholder}
              placeholderTextColor={colors.gray500}
              style={[styles.formInput, { flex: 1 }]}
              secureTextEntry={!showKey}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={() => setShowKey((v: any) => !v)} style={styles.showBtn}>
              <Text style={styles.showBtnText}>{showKey ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.primaryBtn, (!keyInput.trim() || saving) && { opacity: 0.4 }]}
              onPress={() => save(keyInput)}
              disabled={!keyInput.trim() || saving}
            >
              <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Save Key'}</Text>
            </TouchableOpacity>
            {configured && (
              <TouchableOpacity
                style={[styles.dangerBtn, saving && { opacity: 0.4 }]}
                onPress={handleClear}
                disabled={saving}
              >
                <Text style={styles.dangerBtnText}>Remove</Text>
              </TouchableOpacity>
            )}
          </View>
          {browserAuth && (
            <MobileBrowserAuthCard
              label={browserAuth.label}
              description={browserAuth.description}
              loginMode={browserAuth.loginMode}
              getStatus={browserAuth.getStatus}
              startLogin={browserAuth.startLogin}
              cancelLogin={browserAuth.cancelLogin}
              logout={browserAuth.logout}
            />
          )}
        </>
      )}
    </View>
  );
}
function GithubCard() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.getGithubAuthStatus();
      setStatus(data);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load GitHub status.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const handleConnect = async () => {
    setBusy(true);
    try {
      const outcome = await signInWithGithub();
      if (outcome.ok) {
        await load();
      } else if (!outcome.cancelled) {
        Alert.alert('GitHub sign-in failed', 'The sign-in did not complete. Please try again.');
      }
    } catch (err: any) {
      Alert.alert('GitHub sign-in failed', err?.message || 'Could not start GitHub sign-in.');
    } finally {
      setBusy(false);
    }
  };
  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect GitHub',
      'Sessions you own will no longer push or open PRs with your GitHub identity.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await api.disconnectGithub();
              await load();
            } catch (err: any) {
              Alert.alert('Disconnect failed', err?.message || 'Could not disconnect.');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };
  const connected = !!status?.connected;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>GitHub</Text>
          <Text style={styles.cardDesc}>
            Connection used for pushes and pull requests on your behalf.
          </Text>
        </View>
        {!loading && !loadError && (
          <Text
            style={[styles.statusText, { color: connected ? colors.emerald400 : colors.gray500 }]}
          >
            {connected ? 'Connected' : 'Not connected'}
          </Text>
        )}
      </View>

      {loading ? (
        <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 12 }} />
      ) : loadError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorBoxText}>{loadError}</Text>
          <TouchableOpacity onPress={load}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text style={styles.statusDetail}>{githubStatusLabel(status)}</Text>
          {!connected && (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => void handleConnect()}
              disabled={busy}
            >
              <Text style={styles.primaryBtnText}>{busy ? 'Connecting…' : 'Connect GitHub'}</Text>
            </TouchableOpacity>
          )}
          {connected && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.dangerBtn, busy && { opacity: 0.4 }]}
                onPress={handleDisconnect}
                disabled={busy}
              >
                <Text style={styles.dangerBtnText}>{busy ? 'Disconnecting…' : 'Disconnect'}</Text>
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
    </View>
  );
}
export default function MyCliKeysSection() {
  return (
    <View>
      <Text style={styles.sectionTitle}>My CLI Keys</Text>
      <Text style={styles.sectionDesc}>
        Personal credentials used when sessions you own spawn an engine CLI. Keys are stored
        per-account and shown masked.
      </Text>
      {CLI_KEY_PROVIDERS.map((provider: any) => (
        <ProviderCard key={provider.id} provider={provider} />
      ))}
      <GithubCard />
    </View>
  );
}
const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 6,
  },
  sectionDesc: {
    fontSize: 12,
    color: colors.gray500,
    marginBottom: 12,
  },
  card: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.white,
  },
  cardDesc: {
    fontSize: 11,
    color: colors.gray500,
    marginTop: 2,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  statusDetail: {
    fontSize: 12,
    color: colors.gray400,
    marginTop: 8,
    fontFamily: 'monospace',
  },
  hintText: {
    fontSize: 11,
    color: colors.gray600,
    fontStyle: 'italic',
    marginTop: 8,
  },
  fieldLabel: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 4,
    marginTop: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  formInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  showBtn: {
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  showBtnText: {
    color: colors.gray400,
    fontSize: 13,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  primaryBtn: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '500',
  },
  dangerBtn: {
    backgroundColor: colors.red900_50,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  dangerBtnText: {
    color: colors.red400,
    fontSize: 13,
    fontWeight: '500',
  },
  errorBox: {
    backgroundColor: colors.red900_50,
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  errorBoxText: {
    color: colors.red400,
    fontSize: 12,
  },
  retryText: {
    color: colors.gray300,
    fontSize: 12,
    marginTop: 6,
    textDecorationLine: 'underline',
  },
});
