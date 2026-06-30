import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { DRIVE_SURFACE_SCOPES, hasDriveFileScope } from '../utils/googleSurface';

export { DRIVE_SURFACE_SCOPES };

/** Drive is a global, per-user surface — the return hash carries no project. */
export function driveReturnTo() {
  return '/#/drive';
}

export async function openDriveOAuth({ apiClient, openURL }: any) {
  const body = await apiClient.startGoogleOAuth({
    returnTo: driveReturnTo(),
    scopes: DRIVE_SURFACE_SCOPES,
  });
  await openURL(body.authorizeUrl);
  return body.authorizeUrl;
}

/** Human-readable byte size for the Drive `size` string (bytes, may be null). */
export function formatSize(size: any): string {
  if (!size) return '';
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const rounded = u > 0 && n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return `${rounded} ${units[u]}`;
}

function formatDriveTime(value: any): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function DriveContent({
  loading,
  status,
  error,
  files,
  filesLoading,
  onOpenFile,
  onRefreshFiles,
  onConnect,
  onOpenSettings,
}: any) {
  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const driveEnabled = hasDriveFileScope(status);

  if (loading) {
    return (
      <View style={styles.centerCard}>
        <ActivityIndicator color={colors.blue400} />
        <Text style={styles.muted}>Loading Drive...</Text>
      </View>
    );
  }

  let empty: any = null;
  if (!configured && !connected) {
    empty = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Drive can connect.',
      action: 'Open Account settings',
      onAction: onOpenSettings,
    };
  } else if (!connected) {
    empty = {
      title: 'Connect Google to use Drive',
      body: 'Files stay server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: onConnect,
    };
  } else if (!driveEnabled) {
    empty = {
      title: 'Enable Drive access',
      body: `Connected${status?.email ? ` as ${status.email}` : ''}, but Drive access has not been granted yet. Drive only ever lists files created or opened with the Hub (drive.file), never your full Drive.`,
      action: 'Enable Drive',
      onAction: onConnect,
    };
  }

  if (empty) {
    return (
      <View style={styles.content}>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>{empty.title}</Text>
          <Text style={styles.emptyBody}>{empty.body}</Text>
          {empty.action ? (
            <TouchableOpacity onPress={empty.onAction} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>{empty.action}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.content}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Drive</Text>
          <Text style={styles.subtitle}>App files in your Google Drive (drive.file).</Text>
        </View>
        <TouchableOpacity
          onPress={onRefreshFiles}
          disabled={filesLoading}
          style={[styles.secondaryButton, filesLoading && styles.disabledButton]}
        >
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </TouchableOpacity>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {filesLoading ? (
        <View style={styles.centerCard}>
          <ActivityIndicator color={colors.blue400} />
          <Text style={styles.muted}>Loading files...</Text>
        </View>
      ) : (files || []).length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyBody}>
            No files found. Drive only lists files created or opened with the Hub (drive.file).
          </Text>
        </View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item: any, index: number) => item.id || item.name || String(index)}
          renderItem={({ item }: any) => {
            const meta = [formatSize(item.size), formatDriveTime(item.modifiedTime)]
              .filter(Boolean)
              .join(' · ');
            return (
              <TouchableOpacity
                testID={`drive-file-${item.id}`}
                style={styles.fileCard}
                onPress={() => onOpenFile(item)}
              >
                <Text style={styles.fileName}>{item.name || '(untitled)'}</Text>
                {meta ? <Text style={styles.fileMeta}>{meta}</Text> : null}
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

export default function DriveScreen({ navigation }: any) {
  const sidebar = React.useContext(SidebarContext);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    // Clear any prior listing error so a successful retry never leaves a stale
    // failure message after the list has recovered.
    setError(null);
    try {
      const body = await api.listGoogleDriveFiles({
        q: 'trashed = false',
        orderBy: 'modifiedTime desc',
        pageSize: 50,
      });
      setFiles(body.files || []);
    } catch (err: any) {
      setError(err.message || 'Failed to list Drive files');
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextStatus = await api.getGoogleStatus();
      setStatus(nextStatus);
      if (nextStatus.connected && hasDriveFileScope(nextStatus)) {
        await loadFiles();
      } else {
        setFiles([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load Drive');
    } finally {
      setLoading(false);
    }
  }, [loadFiles]);

  useEffect(() => {
    load();
  }, [load]);

  const connect = async () => {
    try {
      await openDriveOAuth({ apiClient: api, openURL: Linking.openURL });
    } catch (err: any) {
      Alert.alert('Google Drive', err.message || 'Failed to start Google consent');
    }
  };

  const openFile = (file: any) => {
    if (file?.webViewLink) Linking.openURL(file.webViewLink);
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={sidebar?.toggleSidebar} style={styles.menuButton}>
          <Text style={styles.menuButtonText}>☰</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Drive</Text>
      </View>
      <DriveContent
        loading={loading}
        status={status}
        error={error}
        files={files}
        filesLoading={filesLoading}
        onOpenFile={openFile}
        onRefreshFiles={loadFiles}
        onConnect={connect}
        onOpenSettings={() => navigation.navigate('Settings', { tab: 'account' })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  menuButton: { padding: 8, marginRight: 8 },
  menuButtonText: { color: colors.gray300, fontSize: 20 },
  topBarTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  content: { flex: 1, padding: 16 },
  centerCard: {
    margin: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    alignItems: 'center',
    gap: 8,
  },
  muted: { color: colors.gray400, fontSize: 13 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  kicker: { color: colors.blue300, fontSize: 11, textTransform: 'uppercase', fontWeight: '700' },
  subtitle: { color: colors.gray400, fontSize: 13, marginTop: 2 },
  primaryButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  primaryButtonText: { color: colors.white, fontSize: 13, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
  },
  secondaryButtonText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  disabledButton: { opacity: 0.5 },
  errorText: { color: colors.red400, fontSize: 12, marginBottom: 10 },
  emptyCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 18,
    gap: 10,
  },
  emptyTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  emptyBody: { color: colors.gray400, fontSize: 13, lineHeight: 19 },
  fileCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  fileName: { color: colors.white, fontSize: 15, fontWeight: '600' },
  fileMeta: { color: colors.gray500, fontSize: 12, marginTop: 4 },
});
