import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import { formatReplayDuration } from '../utils/replayFormat';
import {
  REPLAY_CHANNEL,
  buildReplayPlayerDataUrl,
  buildInjectedReceive,
  replayTargetKey,
  streamReplayTarget,
  type ReplayPlayerTarget,
  type ReplayStreamProgress,
  type SessionViewChapter,
} from '../utils/replayPlayer';
import { RRWEB_PLAYER_JS, RRWEB_PLAYER_CSS } from '../utils/rrwebPlayerBundle.generated';

// In-app rrweb replay player (mobile parity of client/src/components/
// ReplayPlayerModal). Plays a stored session/replay inside a react-native-webview
// loaded from an opaque-origin `data:` URL — the same sandboxed, no-network
// island the web player uses. The RN side streams the already-authorized event
// pages into the frame over the WebView bridge and the frame only renders them;
// the frame is cross-origin to the app and cannot reach the RN bridge, app
// storage, or the loopback Hub.

export type PlayerStatus = 'connecting' | 'streaming' | 'playing' | 'error';

/** Status line copy — pure so it's unit-testable without a WebView. */
export function statusLabel(status: PlayerStatus, progress: ReplayStreamProgress): string {
  if (status === 'connecting') return 'Loading player…';
  if (status === 'streaming') {
    if (progress.total) {
      return `Streaming events ${Math.min(progress.loaded, progress.total)}/${progress.total}`;
    }
    return `Streaming events ${progress.loaded}`;
  }
  if (status === 'playing') return 'Playing';
  return 'Error';
}

/**
 * Full-bleed WebView player for one target (a segmented `sessionId` or a
 * monolithic `replayId`). Starts streaming once the frame announces `ready`,
 * tracks streaming/playing state, and renders view-chapter seek controls for a
 * multi-view session.
 */
export default function ReplayWebViewPlayer({
  target,
  onFatalError,
}: {
  target: ReplayPlayerTarget;
  onFatalError?: (message: string) => void;
}) {
  const webRef = useRef<WebView>(null);
  const startedRef = useRef(false);
  const [status, setStatus] = useState<PlayerStatus>('connecting');
  const [progress, setProgress] = useState<ReplayStreamProgress>({ loaded: 0, total: 0 });
  const [views, setViews] = useState<SessionViewChapter[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Build the opaque-origin player document once. Stable across renders so the
  // WebView isn't torn down and rebuilt for the SAME target mid-stream.
  const playerUri = useMemo(
    () => buildReplayPlayerDataUrl(RRWEB_PLAYER_JS, RRWEB_PLAYER_CSS),
    [],
  );

  const abortRef = useRef<AbortController | null>(null);

  // Per-target identity. Also the WebView `key`: a target change remounts the
  // frame, which reloads the (stable) player doc and re-emits its one-time
  // `ready` handshake, so the new target actually starts streaming rather than
  // sitting on the memoized frame that already handshook for the old target.
  const targetKey = replayTargetKey(target);

  // Reset on target change. Critically, ABORT the in-flight stream first so its
  // async chunks can't inject into the freshly-remounted frame (guarded again in
  // the streaming sinks below), then clear per-target UI state. `startedRef` is
  // cleared so the remounted frame's `ready` re-triggers streaming for the new
  // target. Keyed on `targetKey` so it fires exactly when the frame remounts.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    startedRef.current = false;
    setStatus('connecting');
    setProgress({ loaded: 0, total: 0 });
    setViews([]);
    setErrorMsg(null);
  }, [targetKey]);

  const post = (msg: Record<string, unknown>) => {
    webRef.current?.injectJavaScript(buildInjectedReceive(msg));
  };

  const startStreaming = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus('streaming');
    const controller = new AbortController();
    abortRef.current = controller;
    // Every host→frame write and state update is gated on this stream still being
    // the live one, so a stream aborted mid-flight (target switched) neither
    // injects stale chunks into the new frame nor clobbers the new target's UI.
    const live = () => !controller.signal.aborted;
    void (async () => {
      try {
        await streamReplayTarget({
          target,
          api,
          post: (m) => {
            if (live()) post(m);
          },
          onViews: (v) => {
            if (live()) setViews(v);
          },
          onProgress: (p) => {
            if (live()) setProgress(p);
          },
          signal: controller.signal,
        });
      } catch (err: any) {
        if (!live()) return;
        const message = err?.message || 'Failed to load replay';
        setErrorMsg(message);
        setStatus('error');
        post({ type: 'error', message });
        onFatalError?.(message);
      }
    })();
  };

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const onMessage = (e: WebViewMessageEvent) => {
    let d: any;
    try {
      d = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (!d || typeof d !== 'object' || d.ch !== REPLAY_CHANNEL) return;
    if (d.type === 'ready') {
      startStreaming();
    } else if (d.type === 'playing') {
      setStatus('playing');
    } else if (d.type === 'error') {
      setErrorMsg(d.message || 'Playback failed');
      setStatus('error');
      onFatalError?.(d.message || 'Playback failed');
    }
  };

  const jumpToView = (offsetMs: number) => {
    post({ type: 'goto', offsetMs });
  };

  const label = statusLabel(status, progress);
  const showChapters = Boolean(target?.sessionId) && !target?.replayId && views.length > 1;

  return (
    <View style={styles.container} testID="replay-webview-player">
      <View style={styles.frameWrap}>
        <WebView
          // Keyed per target: a new target remounts the frame → fresh player doc
          // load → new `ready` handshake → streaming restarts for the new target.
          key={targetKey}
          ref={webRef}
          testID="replay-webview"
          source={{ uri: playerUri }}
          originWhitelist={['*']}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled={false}
          // No native<->frame two-way navigation; the frame is a render-only island.
          allowsInlineMediaPlayback
          style={styles.webview}
        />
        {status !== 'playing' && status !== 'error' ? (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator size="small" color={colors.gray400} />
            <Text style={styles.overlayText}>{label}</Text>
          </View>
        ) : null}
        {status === 'error' ? (
          <View style={styles.overlay}>
            <Text style={styles.errorText}>{errorMsg || 'Failed to load replay'}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.statusBar}>
        <Text style={styles.statusText} testID="replay-status">
          {label}
        </Text>
      </View>

      {showChapters ? (
        <View style={styles.chapterBar} testID="replay-view-chapters">
          <Text style={styles.chapterHeader}>{views.length} views</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chapterRow}>
            {views.map((v) => (
              <TouchableOpacity
                key={v.viewId}
                testID="replay-view-chapter"
                disabled={status !== 'playing'}
                onPress={() => jumpToView(v.offsetMs)}
                style={[styles.chapterBtn, status !== 'playing' && styles.chapterBtnDisabled]}
              >
                <Text style={styles.chapterLabel}>View {v.index + 1}</Text>
                <Text style={styles.chapterOffset}>{formatReplayDuration(v.offsetMs)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0d12' },
  frameWrap: { flex: 1, backgroundColor: '#0b0d12', position: 'relative' },
  webview: { flex: 1, backgroundColor: '#0b0d12' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
  },
  overlayText: { color: colors.gray400, fontSize: 12 },
  errorText: { color: colors.rose400, fontSize: 13, textAlign: 'center' },
  statusBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  statusText: { color: colors.gray500, fontSize: 11 },
  chapterBar: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    backgroundColor: colors.gray900,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chapterHeader: {
    color: colors.gray600,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  chapterRow: { flexDirection: 'row', gap: 6 },
  chapterBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chapterBtnDisabled: { opacity: 0.4 },
  chapterLabel: { color: colors.gray200, fontSize: 12, fontWeight: '600' },
  chapterOffset: { color: colors.gray500, fontSize: 12 },
});
