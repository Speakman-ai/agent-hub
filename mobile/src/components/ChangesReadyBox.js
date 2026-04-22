import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Linking,
  ScrollView,
  Platform,
} from 'react-native';
import { colors } from '../theme/colors';
import { api } from '../utils/api';

/**
 * ChangesReadyBox (mobile)
 * ------------------------
 * Mirrors `client/src/components/ChangesReadyBox.jsx`. Appears in chat after
 * an agent finishes work in a worktree with uncommitted changes and no
 * existing kanban card. Offers a Create PR button with an optional
 * auto-merge toggle.
 *
 * Props:
 *   sessionId         — the session with pending changes
 *   changes           — { agentId, branch, hasUncommitted, hasUnpushed }
 *   defaultAutoMerge  — initial value for the per-PR auto-merge toggle
 *                       (project's `githubWorkflow.autoMerge`)
 *   onCreated(sessionId, { prUrl, cardId }) — success callback
 *   livePrLog(string)  — streamed git/gh output from the server WebSocket
 *   onPublishStart(sessionId)  — before a new attempt; parent clears stale log
 *   onDismiss(sessionId)                    — dismiss callback
 */
export default function ChangesReadyBox({
  sessionId,
  changes,
  livePrLog = '',
  defaultAutoMerge = false,
  onPublishStart,
  onCreated,
  onDismiss,
}) {
  const [autoMerge, setAutoMerge] = useState(!!defaultAutoMerge);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const logScrollRef = useRef(null);

  useEffect(() => {
    if (!livePrLog) return;
    const t = setTimeout(() => {
      logScrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(t);
  }, [livePrLog]);

  const handleCreate = async () => {
    if (loading) return;
    onPublishStart?.(sessionId);
    setLoading(true);
    setError(null);
    try {
      const res = await api.createPrFromSession(sessionId, { autoMerge });
      setResult(res);
      onCreated?.(sessionId, res);
    } catch (err) {
      setError((err && err.message) || 'Failed to create PR');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenPr = () => {
    if (result?.prUrl) {
      Linking.openURL(result.prUrl).catch(() => {});
    }
  };

  // Success state — show a link to the created PR
  if (result?.prUrl) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <Text style={styles.icon}>🔀</Text>
            <Text style={styles.title}>PR created</Text>
          </View>
          <TouchableOpacity
            onPress={() => onDismiss?.(sessionId)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.dismiss}>✕</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={handleOpenPr}
          accessibilityRole="link"
          style={styles.prLinkButton}
        >
          <Text style={styles.prLinkText} numberOfLines={2}>
            {result.prUrl}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.icon}>🔀</Text>
          <Text style={styles.title}>Changes ready</Text>
          {!!changes?.branch && (
            <Text style={styles.branch} numberOfLines={1}>
              ({changes.branch})
            </Text>
          )}
        </View>
        <TouchableOpacity
          onPress={() => onDismiss?.(sessionId)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Dismiss"
        >
          <Text style={styles.dismiss}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Auto-merge toggle */}
      <TouchableOpacity
        style={styles.toggleRow}
        onPress={() => setAutoMerge((v) => !v)}
        activeOpacity={0.7}
        accessibilityRole="switch"
        accessibilityState={{ checked: autoMerge }}
      >
        <View style={[styles.track, autoMerge ? styles.trackOn : styles.trackOff]}>
          <View style={[styles.thumb, autoMerge ? styles.thumbOn : styles.thumbOff]} />
        </View>
        <Text style={styles.toggleLabel}>Auto merge when done</Text>
      </TouchableOpacity>

      {/* Description */}
      <Text style={styles.description}>
        {autoMerge
          ? 'A reviewer will review the PR. If approved, it will be merged automatically.'
          : 'A reviewer will review the PR. After approval, a human will merge.'}
      </Text>

      {/* Error */}
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {(loading || livePrLog) ? (
        <View style={styles.logOuter}>
          <Text style={styles.logHeader}>Publish log</Text>
          <ScrollView
            ref={logScrollRef}
            style={styles.logScroll}
            nestedScrollEnabled
          >
            <Text style={styles.logBody} selectable>
              {livePrLog || (loading ? 'Starting…\n' : '')}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      {/* Action button */}
      <TouchableOpacity
        onPress={handleCreate}
        disabled={loading}
        style={[styles.button, loading ? styles.buttonDisabled : styles.buttonEnabled]}
        accessibilityRole="button"
        accessibilityLabel={loading ? 'Creating ticket & PR' : 'Create ticket & PR'}
      >
        {loading ? (
          <>
            <ActivityIndicator size="small" color={colors.gray400} />
            <Text style={styles.buttonTextDisabled}>Creating ticket & PR…</Text>
          </>
        ) : (
          <Text style={styles.buttonTextEnabled}>Create ticket & PR</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const PURPLE = '#7C3AED'; // purple-600
const RED_BG = 'rgba(127, 29, 29, 0.25)';
const RED_TEXT = '#F87171';

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginVertical: 8,
    padding: 12,
    backgroundColor: 'rgba(31, 41, 55, 0.8)', // gray-800/80
    borderWidth: 1,
    borderColor: 'rgba(55, 65, 81, 0.6)', // gray-700/60
    borderRadius: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: 6,
  },
  icon: { fontSize: 14, color: colors.purple400 },
  title: { color: colors.gray300, fontWeight: '600', fontSize: 14 },
  branch: {
    color: colors.gray500,
    fontSize: 11,
    marginLeft: 2,
    flexShrink: 1,
  },
  dismiss: { color: colors.gray500, fontSize: 14, paddingHorizontal: 4 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  track: {
    width: 36,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  trackOn: { backgroundColor: PURPLE },
  trackOff: { backgroundColor: colors.gray600 },
  thumb: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.white,
  },
  thumbOn: { alignSelf: 'flex-end' },
  thumbOff: { alignSelf: 'flex-start' },
  toggleLabel: { color: colors.gray400, fontSize: 12 },
  description: {
    color: colors.gray500,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 10,
  },
  errorBox: {
    backgroundColor: RED_BG,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 8,
  },
  errorText: { color: RED_TEXT, fontSize: 12 },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonEnabled: { backgroundColor: PURPLE },
  buttonDisabled: { backgroundColor: colors.gray700 },
  buttonTextEnabled: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonTextDisabled: {
    color: colors.gray400,
    fontSize: 14,
    fontWeight: '600',
  },
  prLinkButton: {
    backgroundColor: 'rgba(76, 29, 149, 0.35)', // purple-900/35
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.3)',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  prLinkText: {
    color: colors.purple400,
    fontSize: 13,
    fontWeight: '500',
  },
  logOuter: {
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(55, 65, 81, 0.8)',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    overflow: 'hidden',
  },
  logHeader: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.gray500,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(55, 65, 81, 0.6)',
  },
  logScroll: {
    maxHeight: 160,
  },
  logBody: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    color: colors.gray200,
  },
});

