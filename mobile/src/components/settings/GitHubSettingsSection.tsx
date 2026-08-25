import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { api } from '../../utils/api';
import { signInWithGithub } from '../../utils/oauthSignIn';
import { colors } from '../../theme/colors';
export default function GitHubSettingsSection() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getGithubAuthStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const handleConnect = async () => {
    setConnecting(true);
    try {
      const outcome = await signInWithGithub();
      if (outcome.ok) {
        await load();
      } else if (!outcome.cancelled) {
        Alert.alert('GitHub sign-in failed', 'The sign-in did not complete. Please try again.');
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to start GitHub sign-in');
    } finally {
      setConnecting(false);
    }
  };
  const handleDisconnect = () => {
    Alert.alert('Disconnect GitHub?', 'Agents will lose GitHub API access until reconnected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.disconnectGithub();
            await load();
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Failed to disconnect');
          }
        },
      },
    ]);
  };
  if (loading) return <Text style={styles.muted}>Loading…</Text>;
  const connected = status?.connected;
  return (
    <View style={styles.container}>
      <Text style={styles.title}>GitHub</Text>
      <Text style={styles.hint}>
        Connect the Hub to GitHub for PRs, repo access, and mirroring.
      </Text>
      <View style={styles.card}>
        <Text style={styles.statusLabel}>Status</Text>
        <Text style={[styles.statusValue, connected ? styles.connected : styles.disconnected]}>
          {connected ? `Connected as ${status.login || 'user'}` : 'Not connected'}
        </Text>
      </View>
      {connected ? (
        <TouchableOpacity style={styles.dangerButton} onPress={handleDisconnect}>
          <Text style={styles.dangerText}>Disconnect</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.primaryButton, connecting && styles.primaryButtonDisabled]}
          onPress={handleConnect}
          disabled={connecting}
        >
          <Text style={styles.primaryText}>{connecting ? 'Connecting…' : 'Connect GitHub'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 10 },
  title: { fontSize: 16, fontWeight: '600', color: colors.white },
  hint: { fontSize: 12, color: colors.gray500, marginBottom: 8 },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    padding: 12,
  },
  statusLabel: { fontSize: 11, color: colors.gray500 },
  statusValue: { fontSize: 14, marginTop: 4 },
  connected: { color: colors.emerald400 },
  disconnected: { color: colors.gray400 },
  primaryButton: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryText: { color: colors.white, fontWeight: '600' },
  dangerButton: {
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  dangerText: { color: colors.red400, fontWeight: '600' },
  muted: { color: colors.gray500, padding: 16 },
});
