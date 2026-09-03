import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Globe, RotateCw, X } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { getBrowserWsUrl } from '../utils/config';
import {
  browserPaneStatusLabel,
  fitFrameInBox,
  mapPointerToViewport,
  normalizeUrlBarInput,
  type BrowserPaneFrame,
  type BrowserPaneStatus,
  type BrowserPaneViewport,
} from '@shared/utils/browserPaneInput';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

/**
 * Mobile twin of the web `SessionBrowserPane`: a live JPEG feed of the
 * agent's public-web Chromium over `/api/sessions/:id/browser/ws`, with tap
 * → click, a text field → typed input, and a URL bar. Distinct from any
 * preview surface: this is the agent's internet browser, not the dev app.
 */
export default function MobileBrowserPane({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose?: () => void;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const attachedRef = useRef(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<BrowserPaneStatus>('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [frame, setFrame] = useState<BrowserPaneFrame | null>(null);
  const [viewport, setViewport] = useState<BrowserPaneViewport | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [urlDirty, setUrlDirty] = useState(false);
  const [typed, setTyped] = useState('');
  const [box, setBox] = useState({ width: 0, height: 0 });

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 2500);
  }, []);

  const sendFrame = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1 || !attachedRef.current) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current || reconnectTimerRef.current) return;
    setStatus('connecting');
    const attempt = reconnectAttemptRef.current;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, delay);
  }, []);

  useEffect(() => {
    intentionalCloseRef.current = false;
    attachedRef.current = false;
    reconnectAttemptRef.current = 0;
    setStatus('connecting');
    setError('');
    setFrame(null);
    setViewport(null);
    setPageUrl(null);
    setUrlDirty(false);

    const connect = () => {
      if (intentionalCloseRef.current || socketRef.current) return;
      const url = getBrowserWsUrl(sessionId);
      if (!url) {
        setStatus('error');
        setError('No server configured');
        return;
      }
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        attachedRef.current = true;
        setError('');
        socket.send(JSON.stringify({ type: 'attach', maxWidth: 900, maxHeight: 700, quality: 50 }));
      };

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          setStatus('error');
          setError('The browser server sent an invalid frame');
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'state') {
          reconnectAttemptRef.current = 0;
          setStatus(msg.status);
          setViewport(msg.viewport ?? null);
          setPageUrl(msg.url ?? null);
          if (msg.status !== 'live') setFrame(null);
        } else if (msg.type === 'frame') {
          setStatus('live');
          setFrame(msg as BrowserPaneFrame);
          if (msg.viewportWidth && msg.viewportHeight) {
            setViewport({ width: msg.viewportWidth, height: msg.viewportHeight });
          }
          if (typeof msg.url === 'string') setPageUrl(msg.url);
        } else if (msg.type === 'input_result') {
          if (msg.ok === false) showNotice(msg.message || 'Input was not accepted');
        } else if (msg.type === 'navigated') {
          if (msg.ok) {
            setUrlDirty(false);
            if (typeof msg.url === 'string') setPageUrl(msg.url);
          } else {
            showNotice(msg.message || 'Navigation refused');
          }
        } else if (msg.type === 'error') {
          setStatus('error');
          setError(msg.message || 'Browser connection failed');
        }
      };

      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        attachedRef.current = false;
        if (!intentionalCloseRef.current) scheduleReconnect();
      };
      socket.onerror = () => {
        /* onclose follows */
      };
    };

    connectRef.current = connect;
    connect();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      attachedRef.current = false;
      socket?.close();
    };
  }, [sessionId, scheduleReconnect, showNotice]);

  useEffect(() => {
    if (!urlDirty) setUrlInput(pageUrl ?? '');
  }, [pageUrl, urlDirty]);

  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    const socket = socketRef.current;
    socketRef.current = null;
    intentionalCloseRef.current = false;
    socket?.close();
    connectRef.current();
  }, []);

  const rendered = fitFrameInBox(frame, box);
  const inputViewport: BrowserPaneViewport | null =
    viewport ?? (frame ? { width: frame.viewportWidth, height: frame.viewportHeight } : null);

  const onTap = (ev: GestureResponderEvent) => {
    const { locationX, locationY } = ev.nativeEvent;
    const p = mapPointerToViewport({ x: locationX, y: locationY }, rendered, inputViewport);
    if (!p) return;
    sendFrame({ type: 'input', input: { kind: 'mouse', type: 'click', ...p } });
  };

  const submitUrl = () => {
    const url = normalizeUrlBarInput(urlInput);
    if (!url) return;
    if (!sendFrame({ type: 'navigate', url })) showNotice('Not connected');
  };

  const sendTyped = () => {
    if (!typed) return;
    if (sendFrame({ type: 'input', input: { kind: 'text', text: typed } })) setTyped('');
    else showNotice('Not connected');
  };

  const sendKey = (key: string) => {
    sendFrame({ type: 'input', input: { kind: 'key', type: 'press', key } });
  };

  const live = status === 'live';

  return (
    <View style={styles.container} testID="mobile-browser-pane">
      <View style={styles.header}>
        <Globe size={15} color={colors.sky400} />
        <Text style={styles.title}>Agent browser</Text>
        <Text style={styles.badge}>public web</Text>
        <Text style={styles.status} testID="mobile-browser-status">
          {browserPaneStatusLabel(status)}
        </Text>
        <TouchableOpacity onPress={reconnectNow} accessibilityLabel="Reconnect agent browser">
          <RotateCw size={15} color={colors.gray400} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} accessibilityLabel="Close agent browser">
          <X size={16} color={colors.gray400} />
        </TouchableOpacity>
      </View>
      <View style={styles.urlRow}>
        <TextInput
          style={styles.urlInput}
          value={urlInput}
          onChangeText={(t) => {
            setUrlInput(t);
            setUrlDirty(true);
          }}
          onSubmitEditing={submitUrl}
          editable={live}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={live ? 'Enter a public URL' : 'No page yet'}
          placeholderTextColor={colors.gray600}
          accessibilityLabel="Agent browser URL"
          testID="mobile-browser-url"
        />
        <TouchableOpacity
          onPress={submitUrl}
          disabled={!live}
          style={[styles.goButton, !live && styles.disabled]}
          accessibilityLabel="Go"
        >
          <Text style={styles.goText}>Go</Text>
        </TouchableOpacity>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? (
        <Text style={styles.notice} testID="mobile-browser-notice">
          {notice}
        </Text>
      ) : null}
      <View
        style={styles.viewport}
        onLayout={(e: LayoutChangeEvent) => {
          const { width, height } = e.nativeEvent.layout;
          setBox({ width: Math.floor(width), height: Math.floor(height) });
        }}
      >
        {live && frame && rendered.width > 0 ? (
          <Pressable
            onPress={onTap}
            accessibilityLabel="Agent browser viewport — tap to click"
            testID="mobile-browser-frame"
          >
            <Image
              source={{ uri: `data:image/jpeg;base64,${frame.data}` }}
              style={{ width: rendered.width, height: rendered.height }}
              resizeMode="contain"
            />
          </Pressable>
        ) : (
          <View style={styles.placeholder}>
            <Globe size={22} color={colors.gray700} />
            <Text style={styles.placeholderText}>{browserPaneStatusLabel(status)}</Text>
            {status === 'waiting' ? (
              <Text style={styles.placeholderHint}>
                The pane goes live the moment the agent runs a browser action.
              </Text>
            ) : null}
          </View>
        )}
      </View>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.typeInput}
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={sendTyped}
          editable={live}
          placeholder="Type into the agent's browser…"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Text to type into the agent browser"
          testID="mobile-browser-type"
        />
        <TouchableOpacity
          onPress={sendTyped}
          disabled={!live}
          style={[styles.key, !live && styles.disabled]}
          accessibilityLabel="Send text"
        >
          <Text style={styles.keyText}>Send</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => sendKey('Enter')}
          disabled={!live}
          style={[styles.key, !live && styles.disabled]}
          accessibilityLabel="Send Enter"
        >
          <Text style={styles.keyText}>⏎</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => sendKey('Tab')}
          disabled={!live}
          style={[styles.key, !live && styles.disabled]}
          accessibilityLabel="Send Tab"
        >
          <Text style={styles.keyText}>Tab</Text>
        </TouchableOpacity>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.gray900,
  },
  title: { color: colors.gray100, fontSize: 13, fontWeight: '600' },
  badge: {
    color: colors.sky300,
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
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
  disabled: { opacity: 0.5 },
  error: {
    color: colors.red400,
    backgroundColor: colors.red900_50,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  notice: {
    color: colors.amber400,
    backgroundColor: colors.amber900_40,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  viewport: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  placeholder: { alignItems: 'center', gap: 6, paddingHorizontal: 20 },
  placeholderText: { color: colors.gray500, fontSize: 12, textAlign: 'center' },
  placeholderHint: { color: colors.gray600, fontSize: 11, textAlign: 'center' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.gray900,
  },
  typeInput: {
    flex: 1,
    color: colors.gray200,
    fontSize: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 5,
    backgroundColor: colors.gray950,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  key: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 5,
    backgroundColor: colors.gray800,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  keyText: { color: colors.gray200, fontSize: 11, fontFamily: 'monospace' },
});
