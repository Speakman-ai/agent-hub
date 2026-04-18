// Mobile viewer for PR capture artifacts (screenshots + videos).
// Read-only MVP — lists captures attached to a PR, lets the user browse
// screenshots in a lightbox, and opens videos externally (RN has no built-in
// video player and expo-av isn't in deps).
//
// Integrated into the PR detail view in PullRequestsScreen.js.

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Dimensions,
  Linking,
  Alert,
} from 'react-native';
import { api } from '../utils/api';
import { getServerBaseUrl } from '../utils/config';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import {
  deriveServerBase,
  buildCaptureAssetUrl,
  filterCapturesByPr,
  partitionArtifacts,
  formatFileSize,
  formatDuration,
  captureStatusBadge,
} from '../utils/captures';

function StatusPill({ status }) {
  const b = captureStatusBadge(status);
  return (
    <View style={[styles.statusPill, { backgroundColor: b.bg }]}>
      <Text style={[styles.statusPillText, { color: b.color }]}>{b.label}</Text>
    </View>
  );
}

function ScreenshotLightbox({ screenshots, initialIndex, serverBase, captureId, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const current = screenshots[index];
  const screenWidth = Dimensions.get('window').width;
  const screenHeight = Dimensions.get('window').height;

  if (!current) return null;

  const uri = buildCaptureAssetUrl(serverBase, captureId, current.filename);

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.lightboxRoot}>
        <TouchableOpacity
          style={styles.lightboxClose}
          onPress={onClose}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.lightboxCloseText}>{'\u2715'}</Text>
        </TouchableOpacity>
        <Text style={styles.lightboxLabel} numberOfLines={1}>
          {current.label || current.name || current.filename}{' '}
          <Text style={styles.lightboxIndex}>
            ({index + 1}/{screenshots.length})
          </Text>
        </Text>
        {uri ? (
          <Image
            source={{ uri }}
            style={{ width: screenWidth * 0.95, height: screenHeight * 0.7 }}
            resizeMode="contain"
          />
        ) : (
          <Text style={styles.errorText}>Missing image URL</Text>
        )}
        <View style={styles.lightboxNav}>
          <TouchableOpacity
            style={[styles.navBtn, index === 0 && styles.navBtnDisabled]}
            disabled={index === 0}
            onPress={() => setIndex(index - 1)}
          >
            <Text style={styles.navBtnText}>{'\u2190 Prev'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.navBtn,
              index >= screenshots.length - 1 && styles.navBtnDisabled,
            ]}
            disabled={index >= screenshots.length - 1}
            onPress={() => setIndex(index + 1)}
          >
            <Text style={styles.navBtnText}>{'Next \u2192'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function CaptureDetailModal({ capture, projectId, onClose }) {
  const [artifacts, setArtifacts] = useState(
    Array.isArray(capture.artifacts) ? capture.artifacts : null,
  );
  const [loading, setLoading] = useState(artifacts === null);
  const [error, setError] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (artifacts !== null) return;
    setLoading(true);
    setError(null);
    api
      .getProjectCapture(projectId, capture.id)
      .then((data) => {
        if (cancelled) return;
        setArtifacts(data.artifacts || []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[Captures] detail fetch failed:', err?.message || err);
        setError(err?.message || 'Failed to load capture');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, capture.id, artifacts]);

  const serverBase = deriveServerBase(getServerBaseUrl() ? getServerBaseUrl() : '');
  const { screenshots, videos, consoleErrors } = partitionArtifacts(artifacts || []);

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={styles.detailRoot}>
        <View style={styles.detailHeader}>
          <TouchableOpacity onPress={onClose} style={styles.backBtn}>
            <Text style={styles.backBtnText}>{'\u2190 Back'}</Text>
          </TouchableOpacity>
          <Text style={styles.detailTitle} numberOfLines={1}>
            Capture · PR #{capture.pr_number}
          </Text>
          <StatusPill status={capture.status} />
        </View>

        <ScrollView contentContainerStyle={styles.detailBody}>
          <View style={styles.metaRow}>
            {!!capture.branch && (
              <Text style={styles.metaText}>
                Branch: <Text style={styles.codeInline}>{capture.branch}</Text>
              </Text>
            )}
            {!!capture.commit_sha && (
              <Text style={styles.metaText}>
                Commit: <Text style={styles.codeInline}>{capture.commit_sha.slice(0, 7)}</Text>
              </Text>
            )}
            {capture.duration_ms > 0 && (
              <Text style={styles.metaText}>Duration: {formatDuration(capture.duration_ms)}</Text>
            )}
            {!!capture.created_at && (
              <Text style={styles.metaText}>Created {relativeTime(capture.created_at)}</Text>
            )}
            {capture.pr_url && (
              <TouchableOpacity onPress={() => Linking.openURL(capture.pr_url)}>
                <Text style={styles.linkText}>Open PR on GitHub {'\u2197'}</Text>
              </TouchableOpacity>
            )}
            {capture.comment_url && (
              <TouchableOpacity onPress={() => Linking.openURL(capture.comment_url)}>
                <Text style={styles.linkText}>View PR comment {'\u2197'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {capture.status === 'error' && capture.error_message && (
            <View style={styles.errorBlock}>
              <Text style={styles.errorBlockTitle}>Capture failed</Text>
              <Text style={styles.errorBlockBody}>{capture.error_message}</Text>
            </View>
          )}

          {loading && (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.gray400} />
              <Text style={styles.dimText}>Loading artifacts…</Text>
            </View>
          )}

          {error && !loading && <Text style={styles.errorText}>{error}</Text>}

          {!loading && !error && screenshots.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>Screenshots ({screenshots.length})</Text>
              <View style={styles.thumbGrid}>
                {screenshots.map((ss, i) => {
                  const uri = buildCaptureAssetUrl(serverBase, capture.id, ss.filename);
                  return (
                    <TouchableOpacity
                      key={ss.id || ss.filename || i}
                      style={styles.thumbWrap}
                      onPress={() => setLightboxIndex(i)}
                      activeOpacity={0.8}
                    >
                      {uri && <Image source={{ uri }} style={styles.thumb} resizeMode="cover" />}
                      <View style={styles.thumbLabelWrap}>
                        <Text style={styles.thumbLabel} numberOfLines={1}>
                          {ss.label || ss.name || ss.filename}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {!loading && !error && videos.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>Video Walkthrough</Text>
              {videos.map((vid) => {
                const uri = buildCaptureAssetUrl(serverBase, capture.id, vid.filename);
                return (
                  <View key={vid.id || vid.filename} style={styles.videoRow}>
                    <Text style={styles.videoLabel} numberOfLines={2}>
                      {vid.label || vid.name || vid.filename}
                    </Text>
                    {vid.file_size > 0 && (
                      <Text style={styles.videoSize}>{formatFileSize(vid.file_size)}</Text>
                    )}
                    <TouchableOpacity
                      style={styles.videoBtn}
                      onPress={() => {
                        if (!uri) {
                          Alert.alert('Video unavailable', 'No URL is configured for this video.');
                          return;
                        }
                        Linking.openURL(uri).catch(() => {
                          Alert.alert('Unable to open video', uri);
                        });
                      }}
                    >
                      <Text style={styles.videoBtnText}>{'\u25B6 Play'}</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          )}

          {!loading && !error && consoleErrors.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionHeader, { color: colors.red400 }]}>
                Console Errors ({consoleErrors.length})
              </Text>
              <View style={styles.errorList}>
                {consoleErrors.map((ce, i) => (
                  <Text key={i} style={styles.consoleErrorText}>
                    <Text style={styles.consoleErrorRoute}>[{ce.route}]</Text>{' '}
                    {typeof ce.error === 'string' ? ce.error : JSON.stringify(ce.error)}
                  </Text>
                ))}
              </View>
            </View>
          )}

          {!loading &&
            !error &&
            screenshots.length === 0 &&
            videos.length === 0 &&
            capture.status !== 'error' && (
              <Text style={styles.dimText}>No artifacts produced by this capture.</Text>
            )}

          <View style={{ height: 40 }} />
        </ScrollView>

        {lightboxIndex !== null && (
          <ScreenshotLightbox
            screenshots={screenshots}
            initialIndex={lightboxIndex}
            serverBase={serverBase}
            captureId={capture.id}
            onClose={() => setLightboxIndex(null)}
          />
        )}
      </View>
    </Modal>
  );
}

/**
 * Section embedded in the PR detail view. Fetches project captures, filters
 * to this PR, and renders a compact list. Tapping a row opens the detail modal.
 *
 * @param {{ projectId: string, prNumber: number|string }} props
 */
export default function PrCapturesSection({ projectId, prNumber }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [captures, setCaptures] = useState([]);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    if (!projectId || prNumber === null || prNumber === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const all = await api.getProjectCaptures(projectId);
      const mine = filterCapturesByPr(all, prNumber);
      // Most-recent first (server already orders DESC but be defensive).
      mine.sort((a, b) => {
        const at = Date.parse(a.created_at || '') || 0;
        const bt = Date.parse(b.created_at || '') || 0;
        return bt - at;
      });
      setCaptures(mine);
    } catch (err) {
      console.warn('[Captures] list failed:', err?.message || err);
      setError(err?.message || 'Failed to load captures');
      setCaptures([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, prNumber]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.sectionWrap}>
      <View style={styles.sectionRow}>
        <Text style={styles.sectionHeader}>Captures</Text>
        <TouchableOpacity onPress={load} disabled={loading}>
          <Text style={[styles.linkText, loading && styles.dimText]}>
            {loading ? 'Loading…' : 'Refresh'}
          </Text>
        </TouchableOpacity>
      </View>

      {loading && captures.length === 0 && (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.gray400} />
        </View>
      )}

      {!loading && error && <Text style={styles.errorText}>{error}</Text>}

      {!loading && !error && captures.length === 0 && (
        <Text style={styles.emptyText}>No captures for this PR.</Text>
      )}

      {captures.map((c) => (
        <TouchableOpacity
          key={c.id}
          style={styles.captureRow}
          onPress={() => setSelected(c)}
          activeOpacity={0.7}
        >
          <View style={styles.captureRowHeader}>
            <StatusPill status={c.status} />
            <Text style={styles.captureCommit}>
              {c.commit_sha ? c.commit_sha.slice(0, 7) : '—'}
            </Text>
            <Text style={styles.captureTime}>{relativeTime(c.created_at)}</Text>
          </View>
          <Text style={styles.captureMeta}>
            {c.screenshot_count > 0
              ? `${c.screenshot_count} screenshot${c.screenshot_count === 1 ? '' : 's'}`
              : 'No screenshots'}
            {c.has_video ? ' · video' : ''}
            {c.duration_ms > 0 ? ` · ${formatDuration(c.duration_ms)}` : ''}
          </Text>
          {c.status === 'error' && !!c.error_message && (
            <Text style={styles.captureErrorLine} numberOfLines={2}>
              {c.error_message}
            </Text>
          )}
        </TouchableOpacity>
      ))}

      {selected && (
        <CaptureDetailModal
          capture={selected}
          projectId={projectId}
          onClose={() => setSelected(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionWrap: {
    marginTop: 12,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionHeader: {
    color: colors.gray300,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  linkText: { color: colors.blue400, fontSize: 13 },
  dimText: { color: colors.gray500, fontSize: 13, marginTop: 6 },
  emptyText: { color: colors.gray500, fontSize: 13, marginTop: 4 },
  errorText: { color: colors.red400, fontSize: 13, marginTop: 4 },

  captureRow: {
    padding: 10,
    marginVertical: 4,
    backgroundColor: colors.gray900,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  captureRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  captureCommit: {
    color: colors.gray300,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  captureTime: { color: colors.gray500, fontSize: 11, marginLeft: 'auto' },
  captureMeta: { color: colors.gray400, fontSize: 12 },
  captureErrorLine: {
    color: colors.red400,
    fontSize: 11,
    marginTop: 4,
    fontFamily: 'monospace',
  },

  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  statusPillText: { fontSize: 11, fontWeight: '600' },

  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },

  // Detail modal
  detailRoot: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  backBtn: { paddingRight: 8 },
  backBtnText: { color: colors.blue400, fontSize: 14 },
  detailTitle: {
    flex: 1,
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  detailBody: { padding: 16 },
  metaRow: { gap: 4, marginBottom: 12 },
  metaText: { color: colors.gray400, fontSize: 12 },
  codeInline: { color: colors.gray200, fontFamily: 'monospace', fontSize: 12 },
  section: { marginTop: 16 },
  thumbGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumbWrap: {
    width: '48%',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  thumb: {
    width: '100%',
    height: 100,
  },
  thumbLabelWrap: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    backgroundColor: colors.gray900,
  },
  thumbLabel: { color: colors.gray300, fontSize: 11 },
  videoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
    marginBottom: 8,
  },
  videoLabel: { flex: 1, color: colors.gray200, fontSize: 13 },
  videoSize: { color: colors.gray500, fontSize: 11 },
  videoBtn: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  videoBtnText: { color: colors.white, fontSize: 13, fontWeight: '600' },
  errorBlock: {
    backgroundColor: colors.red900_50,
    borderWidth: 1,
    borderColor: colors.red400,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  errorBlockTitle: { color: colors.red400, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  errorBlockBody: { color: colors.gray200, fontSize: 12, fontFamily: 'monospace' },
  errorList: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  consoleErrorText: { color: colors.gray300, fontSize: 12, fontFamily: 'monospace' },
  consoleErrorRoute: { color: colors.gray500 },

  // Lightbox
  lightboxRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  lightboxClose: { position: 'absolute', top: 40, right: 20, padding: 8 },
  lightboxCloseText: { color: colors.white, fontSize: 22 },
  lightboxLabel: { color: colors.gray200, fontSize: 13, marginBottom: 8, paddingHorizontal: 12 },
  lightboxIndex: { color: colors.gray500 },
  lightboxNav: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  navBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { color: colors.white, fontSize: 13 },
});
