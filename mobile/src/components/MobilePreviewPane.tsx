import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Maximize2, Minimize2, Monitor, RefreshCw, X } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import { getServerBaseUrl } from '../utils/config';
import {
  previewEventUrl,
  previewPaneStatus,
  previewLifecycleSeq,
  resolvePreviewEvent,
  type PreviewHydration,
  type PreviewPaneStatus,
} from '../utils/previewEvents';
import {
  bustPreviewUrl,
  previewLoadUrl,
  previewTicketAllowed,
  withPreviewTicket,
} from '../utils/previewUrl';

const STATUS_LABEL: Record<PreviewPaneStatus, string> = {
  idle: 'No preview yet',
  starting: 'Starting…',
  ready: 'Live',
  failed: 'Failed',
  unavailable: 'Unavailable',
};

/**
 * Session preview in the same chrome as the agent browser: a header, a URL
 * bar, and a viewport you can actually use. The viewport is a WebView of the
 * running app (not a screenshot), so taps, scrolling, and typing hit the
 * preview directly. Fullscreen hides the chat; the same button brings the
 * session back with the preview docked underneath the actions.
 */
type PreviewPaneProps = {
  sessionId: string;
  event?: any;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose?: () => void;
};

export default function MobilePreviewPane(props: PreviewPaneProps) {
  // Everything the pane holds (snapshot, loaded page, typed URL, start state)
  // belongs to one session; a new session starts from scratch.
  return <SessionPreviewPane key={props.sessionId} {...props} />;
}

function SessionPreviewPane({
  sessionId,
  event,
  fullscreen,
  onToggleFullscreen,
  onClose,
}: PreviewPaneProps) {
  const [hydration, setHydration] = useState<PreviewHydration | null>(null);
  const eventRef = useRef(event);
  eventRef.current = event;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [urlInput, setUrlInput] = useState('');
  // True while the user is typing in the URL bar; the bar follows the server
  // target only when it changes and the user is not mid-edit.
  const urlEditing = useRef(false);
  const [src, setSrc] = useState('');
  const webRef = useRef<any>(null);
  const manualUrlRef = useRef<string | null>(null);
  const seenServerUrl = useRef('');

  const liveEvent = useMemo(() => resolvePreviewEvent(event, hydration), [event, hydration]);
  const status =
    starting && previewPaneStatus(liveEvent) === 'idle' ? 'starting' : previewPaneStatus(liveEvent);
  const serverUrl = previewLoadUrl(previewEventUrl(liveEvent), getServerBaseUrl());

  useEffect(() => {
    let cancelled = false;
    setHydration(null);
    const seqAtRequest = previewLifecycleSeq(eventRef.current);
    api
      .getSessionPreviewState(sessionId)
      .then((res: any) => {
        if (!cancelled) setHydration({ event: res?.event ?? null, seqAtRequest });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!urlEditing.current) setUrlInput(serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    if (previewPaneStatus(liveEvent) !== 'idle') setStarting(false);
  }, [liveEvent]);

  // Everything that decides what the WebView shows (a new target, a refresh,
  // a ticket retry, the user's own URL) takes a new load generation. Only the
  // latest one may write `src`, so a ticket that arrives after the user
  // navigated, or after the target moved, is dropped.
  const loadGen = useRef(0);
  useEffect(
    () => () => {
      loadGen.current++;
    },
    [],
  );

  // The one way a URL reaches the WebView, for the server's target and for a
  // URL the user typed alike: a protected preview URL is opened with a fresh
  // ticket (keeping its path), anything else as is. Each call takes a new
  // load generation, so only the latest load can write `src`.
  const openUrl = useCallback(
    (url: string, bust: unknown, replacesPage = false) => {
      const gen = ++loadGen.current;
      const current = () => gen === loadGen.current;
      setLoadError('');
      // Opening a different page: the old one must not stay up (and be what
      // Reload reloads) while, or if, the new one's ticket fails.
      if (replacesPage) setSrc('');
      const scope = {
        hubBase: getServerBaseUrl(),
        sessionId,
        reportedUrl: reportedUrlRef.current,
      };
      if (!previewTicketAllowed(url, scope)) {
        setSrc(bustPreviewUrl(url, bust));
        return;
      }
      api
        .mintSessionPreviewTicket(sessionId)
        .then((res: any) => {
          if (!current()) return;
          const ticketed = res?.ticket ? withPreviewTicket(url, res.ticket) : url;
          setSrc(bustPreviewUrl(ticketed, bust));
        })
        .catch(() => {
          if (current()) setLoadError('Could not open the preview. Try again.');
        });
    },
    [sessionId],
  );

  const bust = liveEvent?.refreshAt || null;
  // The preview URL the Hub reported; it decides which hosts may get a ticket.
  const reportedUrlRef = useRef(serverUrl);
  reportedUrlRef.current = serverUrl;
  useEffect(() => {
    if (seenServerUrl.current !== serverUrl) {
      // A new target: the page loaded for the old one must not stay on
      // screen (or stay usable) while the new one's ticket is requested.
      seenServerUrl.current = serverUrl;
      manualUrlRef.current = null;
      loadGen.current++;
      setSrc('');
      setLoadError('');
    }
    // A URL the user opened stays put through refreshes of the server target.
    if (!serverUrl || manualUrlRef.current) return;
    openUrl(serverUrl, bust);
  }, [serverUrl, bust, openUrl]);

  const reload = () => {
    if (src && webRef.current) {
      webRef.current.reload();
      return;
    }
    // Nothing loaded (e.g. the ticket request failed): open it again.
    const target = manualUrlRef.current ?? serverUrl;
    if (target) openUrl(target, manualUrlRef.current ? null : bust);
  };

  const start = () => {
    setStarting(true);
    setStartError('');
    api.startSessionPreview(sessionId, { reason: 'Opened from the phone' }).catch((err: any) => {
      setStarting(false);
      setStartError(err?.message || 'Could not start the preview');
    });
  };

  const go = () => {
    const next = urlInput.trim();
    if (!next) return;
    manualUrlRef.current = next;
    urlEditing.current = false;
    openUrl(next, null, true);
  };

  const ready = status === 'ready' && !!src;

  return (
    <View style={[styles.container, fullscreen && styles.fullscreen]} testID="mobile-preview-pane">
      <View style={styles.header}>
        <Monitor size={15} color={colors.sky400} />
        <Text style={styles.title}>Preview</Text>
        <Text style={styles.status} testID="mobile-preview-status">
          {STATUS_LABEL[status]}
        </Text>
        <TouchableOpacity
          onPress={onToggleFullscreen}
          accessibilityLabel={fullscreen ? 'Show session' : 'Fullscreen preview'}
          testID="toggle-preview-fullscreen"
        >
          {fullscreen ? (
            <Minimize2 size={16} color={colors.gray300} />
          ) : (
            <Maximize2 size={16} color={colors.gray300} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={reload}
          accessibilityLabel="Reload preview"
          testID="mobile-preview-reload"
        >
          <RefreshCw size={15} color={colors.gray400} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} accessibilityLabel="Close preview">
          <X size={16} color={colors.gray400} />
        </TouchableOpacity>
      </View>
      <View style={styles.urlRow}>
        <TextInput
          style={styles.urlInput}
          value={urlInput}
          onChangeText={(t) => {
            setUrlInput(t);
            urlEditing.current = true;
          }}
          onSubmitEditing={go}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={ready ? 'Preview URL' : 'No preview yet'}
          placeholderTextColor={colors.gray600}
          accessibilityLabel="Preview URL"
          testID="mobile-preview-url"
        />
        <TouchableOpacity onPress={go} style={styles.goButton} accessibilityLabel="Go">
          <Text style={styles.goText}>Go</Text>
        </TouchableOpacity>
      </View>
      {startError ? <Text style={styles.error}>{startError}</Text> : null}
      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      {status === 'failed' && liveEvent?.error ? (
        <Text style={styles.error}>{String(liveEvent.error)}</Text>
      ) : null}
      <View style={styles.viewport}>
        {ready ? (
          <WebView
            ref={webRef}
            key={src}
            source={{ uri: src }}
            style={styles.web}
            testID="mobile-preview-webview"
            originWhitelist={['*']}
            setSupportMultipleWindows={false}
            onError={() => setLoadError('The preview page failed to load.')}
          />
        ) : (
          <View style={styles.placeholder}>
            {status === 'starting' ? (
              <ActivityIndicator color={colors.sky400} />
            ) : (
              <Monitor size={22} color={colors.gray700} />
            )}
            <Text style={styles.placeholderText}>
              {status === 'idle'
                ? 'Start the session preview to use the running app here.'
                : STATUS_LABEL[status]}
            </Text>
            {status === 'idle' || status === 'failed' ? (
              <TouchableOpacity
                onPress={start}
                style={styles.startButton}
                testID="mobile-preview-start"
                accessibilityLabel="Start preview"
              >
                <Text style={styles.startText}>Start preview</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 420,
    backgroundColor: colors.gray950,
    borderTopWidth: 1,
    borderColor: colors.gray800,
  },
  fullscreen: {
    flex: 1,
    height: undefined,
    borderTopWidth: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.gray900,
  },
  title: { color: colors.gray100, fontSize: 13, fontWeight: '600' },
  status: { flex: 1, color: colors.gray500, fontSize: 11 },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.gray900,
  },
  urlInput: {
    flex: 1,
    color: colors.gray200,
    fontSize: 12,
    fontFamily: 'monospace',
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 5,
    backgroundColor: colors.gray950,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  goButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 5,
    backgroundColor: colors.gray800,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  goText: { color: colors.sky300, fontSize: 11, fontWeight: '600' },
  error: {
    color: colors.red400,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  viewport: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  placeholderText: { color: colors.gray500, fontSize: 12, textAlign: 'center' },
  startButton: {
    marginTop: 4,
    borderRadius: 6,
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  startText: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
