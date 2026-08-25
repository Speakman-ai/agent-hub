/**
 * SessionArtifactsPanel — mobile parity for the web SessionArtifactsPane.
 *
 * Lists the documents an agent generated during a session (PDFs, scripts,
 * reports…) and lets the user open/share or delete them. The web client shows
 * this as a toggleable right-side pane; mobile has no right pane, so this is an
 * inline collapsible panel above the chat (same chrome as SessionDesignFilesPanel).
 *
 * It renders nothing on the common case of a session with no artifacts, so it
 * only appears when there's something to show, on ANY session (not just design).
 *
 * Data flow (all through mobile api.ts / artifactContent, auth-gated):
 *   GET    /api/sessions/:id/artifacts                       → metadata list
 *   GET    /api/sessions/:id/artifacts/:aid/content          → bytes (share/open)
 *   DELETE /api/sessions/:id/artifacts/:aid                  → remove
 *
 * `reloadNonce` is bumped by the parent on every `artifact_created` /
 * `artifact_deleted` WS event for this session so the list stays live.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import AppIcon from './AppIcon';
import { api } from '../utils/api';
import { shareArtifact } from '../utils/artifactContent';
import { formatBytes, isInlineViewable, artifactGlyph } from '@shared/utils/artifactView';
import { shortDate } from '../utils/time';
import { colors } from '../theme/colors';
import SessionArtifactViewerModal from './SessionArtifactViewerModal';

/**
 * Whether a resolved `/artifacts` fetch is stale and must be discarded before
 * touching state. A load is stale if a newer load superseded its sequence, or
 * if the mounted session changed out from under it (the component instance is
 * reused across `activeSessionId`, so a slow prior-session response could
 * otherwise clobber the current session's list). Pure so it can be unit-tested
 * without a hook renderer (mobile vitest env is `node`).
 */
export function isStaleLoad(
  seq: number,
  currentSeq: number,
  requestedSessionId: any,
  currentSessionId: any,
) {
  return seq !== currentSeq || requestedSessionId !== currentSessionId;
}

/**
 * Pure presentational half — no fetching / native modules, so it renders in
 * the react-dom/server test harness. Returns null when there is nothing to
 * show (no artifacts, not loading, no error) to stay invisible on ordinary
 * sessions.
 */
export function SessionArtifactsPanelContent({
  artifacts = [],
  loading = false,
  error = null,
  busyId = '',
  onView,
  onDownload,
  onDelete,
  onRefresh,
}: any) {
  if (!loading && !error && artifacts.length === 0) return null;
  return (
    <View style={styles.panel} testID="session-artifacts-panel">
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <AppIcon name="cube-outline" size={14} color={colors.purple400} />
          <Text style={styles.headerTitle}>Artifacts</Text>
          <Text style={styles.headerBadge}>{artifacts.length}</Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={onRefresh}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Refresh artifacts"
          testID="session-artifacts-refresh"
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.gray400} />
          ) : (
            <AppIcon name="sync-outline" size={13} color={colors.gray400} />
          )}
        </TouchableOpacity>
      </View>

      {error ? (
        <Text style={styles.errorText} testID="session-artifacts-error">
          {error}
        </Text>
      ) : artifacts.length === 0 ? (
        <Text style={styles.emptyText}>Loading…</Text>
      ) : (
        <ScrollView style={styles.list} nestedScrollEnabled>
          {artifacts.map((artifact: any) => {
            const canView = isInlineViewable(artifact.contentType, artifact.filename);
            const isBusy = busyId === artifact.id;
            return (
              <View key={artifact.id} style={styles.row} testID="session-artifacts-item">
                <Text style={styles.glyph} accessibilityElementsHidden>
                  {artifactGlyph(artifact.contentType, artifact.filename)}
                </Text>
                <View style={styles.rowInfo}>
                  <Text style={styles.filename} numberOfLines={1}>
                    {artifact.filename}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {formatBytes(artifact.size)}
                    {artifact.createdAt ? ` · ${shortDate(artifact.createdAt)}` : ''}
                    {artifact.createdBy ? ` · ${artifact.createdBy}` : ''}
                  </Text>
                </View>
                <View style={styles.actions}>
                  {isBusy ? <ActivityIndicator size="small" color={colors.gray400} /> : null}
                  {canView ? (
                    <TouchableOpacity
                      onPress={() => onView?.(artifact)}
                      disabled={isBusy}
                      accessibilityRole="button"
                      accessibilityLabel={`View ${artifact.filename}`}
                      testID="session-artifacts-view"
                      style={styles.actionBtn}
                    >
                      <AppIcon name="open-outline" size={15} color={colors.gray400} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    onPress={() => onDownload?.(artifact)}
                    disabled={isBusy}
                    accessibilityRole="button"
                    accessibilityLabel={`Download ${artifact.filename}`}
                    testID="session-artifacts-download"
                    style={styles.actionBtn}
                  >
                    <AppIcon name="download-outline" size={15} color={colors.gray400} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onDelete?.(artifact)}
                    disabled={isBusy}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${artifact.filename}`}
                    testID="session-artifacts-delete"
                    style={styles.actionBtn}
                  >
                    <AppIcon name="trash-outline" size={15} color={colors.red400} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

export default function SessionArtifactsPanel({
  sessionId,
  reloadNonce = 0,
  presentedArtifact = null,
  onPresentedArtifact,
}: any) {
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [busyId, setBusyId] = useState('');
  const [selectedArtifact, setSelectedArtifact] = useState<any>(null);

  // Stale-response guard (mirrors the web SessionArtifactsPane): this component
  // instance is reused when `activeSessionId` changes, so a slow load for the
  // previous session can resolve after a newer one and clobber state with the
  // wrong session's artifacts — which would then route View/Delete through the
  // wrong `sessionId`. Discard any resolved fetch whose sequence is superseded
  // or whose session no longer matches the mounted one.
  const loadSeqRef = useRef(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const load = useCallback(async () => {
    if (!sessionId) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSessionArtifacts(sessionId);
      if (isStaleLoad(seq, loadSeqRef.current, sessionId, sessionRef.current)) return;
      setArtifacts(Array.isArray(res?.artifacts) ? res.artifacts : []);
    } catch (err: any) {
      if (isStaleLoad(seq, loadSeqRef.current, sessionId, sessionRef.current)) return;
      setError(err?.message || 'Failed to load artifacts');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [sessionId]);

  // Clear the list immediately on session switch so a stale list can't linger
  // (and be acted on) during the new session's load window.
  useEffect(() => {
    setArtifacts([]);
    setError(null);
    setSelectedArtifact(null);
  }, [sessionId]);

  useEffect(() => {
    if (!presentedArtifact?.id) return;
    setSelectedArtifact(presentedArtifact);
    onPresentedArtifact?.(sessionId, presentedArtifact.id);
  }, [onPresentedArtifact, presentedArtifact, sessionId]);

  useEffect(() => {
    load();
  }, [load, reloadNonce]);

  const handleView = useCallback((artifact: any) => setSelectedArtifact(artifact), []);

  const handleDownload = useCallback(
    async (artifact: any) => {
      setBusyId(artifact.id);
      try {
        await shareArtifact(sessionId, artifact, { download: true });
      } catch (err: any) {
        setError(err?.message || 'Failed to download artifact');
      } finally {
        setBusyId('');
      }
    },
    [sessionId],
  );

  const handleDelete = useCallback(
    (artifact: any) => {
      Alert.alert('Delete artifact', `Delete "${artifact.filename}"?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusyId(artifact.id);
            try {
              await api.deleteSessionArtifact(sessionId, artifact.id);
              setArtifacts((prev: any) => prev.filter((a: any) => a.id !== artifact.id));
            } catch (err: any) {
              setError(err?.message || 'Failed to delete artifact');
            } finally {
              setBusyId('');
            }
          },
        },
      ]);
    },
    [sessionId],
  );

  return (
    <>
      <SessionArtifactsPanelContent
        artifacts={artifacts}
        loading={loading}
        error={error}
        busyId={busyId}
        onView={handleView}
        onDownload={handleDownload}
        onDelete={handleDelete}
        onRefresh={load}
      />
      <SessionArtifactViewerModal
        sessionId={sessionId}
        artifact={selectedArtifact}
        onClose={() => setSelectedArtifact(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray950,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.gray200,
  },
  headerBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.gray400,
    backgroundColor: colors.gray800,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  refreshBtn: {
    padding: 4,
    minWidth: 24,
    alignItems: 'center',
  },
  list: {
    marginTop: 6,
    maxHeight: 200,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  glyph: {
    fontSize: 16,
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
  },
  filename: {
    fontSize: 12,
    color: colors.gray200,
  },
  meta: {
    fontSize: 10,
    color: colors.gray500,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionBtn: {
    padding: 4,
  },
  emptyText: {
    marginTop: 6,
    fontSize: 11,
    color: colors.gray500,
  },
  errorText: {
    marginTop: 6,
    fontSize: 11,
    color: colors.amber400,
  },
});
