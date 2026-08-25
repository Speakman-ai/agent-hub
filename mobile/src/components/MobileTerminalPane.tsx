import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { RotateCw, SquareTerminal, X } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { getTerminalWsUrl } from '../utils/config';
import {
  buildTerminalHtml,
  buildTerminalReceiveScript,
  encodeTerminalInputBase64,
  parseTerminalBridgeMessage,
  TerminalOutputBatcher,
} from '../utils/mobileTerminal';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

type TerminalStatus = 'connecting' | 'connected' | 'reconnecting' | 'exited' | 'error';

const SPECIAL_KEYS = [
  { label: 'Ctrl-C', data: '\u0003' },
  { label: 'Ctrl-D', data: '\u0004' },
  { label: 'Esc', data: '\u001b' },
  { label: 'Tab', data: '\t' },
  { label: '↑', data: '\u001b[A' },
  { label: '↓', data: '\u001b[B' },
  { label: '←', data: '\u001b[D' },
  { label: '→', data: '\u001b[C' },
];

function statusLabel(status: TerminalStatus): string {
  if (status === 'connected') return 'Connected';
  if (status === 'reconnecting') return 'Reconnecting…';
  if (status === 'exited') return 'Exited';
  if (status === 'error') return 'Connection error';
  return 'Connecting…';
}

export default function MobileTerminalPane({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose?: () => void;
}) {
  const webRef = useRef<WebView>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputBatcherRef = useRef<TerminalOutputBatcher | null>(null);
  const attachedRef = useRef(false);
  const webReadyRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const dimensionsRef = useRef({ cols: 80, rows: 24 });
  const snapshotPendingRef = useRef(false);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [error, setError] = useState('');

  const html = useMemo(() => buildTerminalHtml(), []);

  const postToWebView = useCallback((frame: Record<string, unknown>) => {
    webRef.current?.injectJavaScript(buildTerminalReceiveScript(frame));
  }, []);

  const sendFrame = useCallback((frame: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current || !webReadyRef.current || reconnectTimerRef.current) return;
    setStatus('reconnecting');
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
    webReadyRef.current = false;
    attachedRef.current = false;
    reconnectAttemptRef.current = 0;
    setStatus('connecting');
    setError('');

    const batcher = new TerminalOutputBatcher((chunks) => {
      if (!snapshotPendingRef.current && attachedRef.current) {
        postToWebView({ type: 'output_batch', data: chunks });
      }
    });
    outputBatcherRef.current = batcher;

    const connect = () => {
      if (intentionalCloseRef.current || !webReadyRef.current || socketRef.current) return;
      const url = getTerminalWsUrl(sessionId);
      if (!url) {
        setStatus('error');
        setError('No server configured');
        return;
      }
      setStatus(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        socket.send(JSON.stringify({ type: 'attach', ...dimensionsRef.current }));
      };

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        let frame: any;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          setStatus('error');
          setError('The terminal server sent an invalid frame');
          return;
        }
        if (!frame || typeof frame.type !== 'string') return;
        if (frame.type === 'attached' && frame.encoding === 'base64') {
          // The server guarantees this is the first data frame. Keep the
          // snapshot ahead of any output batch crossing the second bridge.
          snapshotPendingRef.current = true;
          postToWebView(frame);
          attachedRef.current = true;
          snapshotPendingRef.current = false;
          batcher.flushNow();
          reconnectAttemptRef.current = 0;
          setStatus('connected');
          setError('');
          sendFrame({ type: 'resize', ...dimensionsRef.current });
          return;
        }
        if (frame.type === 'output' && frame.encoding === 'base64') {
          batcher.push(frame.data);
          return;
        }
        if (frame.type === 'detached') {
          attachedRef.current = false;
          return;
        }
        if (frame.type === 'exit') {
          attachedRef.current = false;
          intentionalCloseRef.current = true;
          setStatus('exited');
          postToWebView(frame);
          return;
        }
        if (frame.type === 'error') {
          attachedRef.current = false;
          setStatus('error');
          setError(frame.message || 'Terminal connection failed');
          postToWebView(frame);
        }
      };

      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        attachedRef.current = false;
        batcher.dispose();
        if (!intentionalCloseRef.current) scheduleReconnect();
      };

      socket.onerror = () => {
        if (socketRef.current !== socket || intentionalCloseRef.current) return;
        setError('Terminal connection interrupted');
      };
    };
    connectRef.current = connect;

    return () => {
      intentionalCloseRef.current = true;
      webReadyRef.current = false;
      attachedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'detach' }));
      socket?.close(1000, 'Terminal pane closed');
      batcher.dispose();
      outputBatcherRef.current = null;
    };
  }, [postToWebView, scheduleReconnect, sendFrame, sessionId]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseTerminalBridgeMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === 'ready') {
        dimensionsRef.current = {
          cols: message.cols || 80,
          rows: message.rows || 24,
        };
        webReadyRef.current = true;
        // A ready message also fires after a WebView reload. The old socket is
        // tied to the old JS terminal, so replace it and request a fresh
        // server snapshot instead of trying to replay into a lost renderer.
        const oldSocket = socketRef.current;
        socketRef.current = null;
        attachedRef.current = false;
        oldSocket?.close(1000, 'Terminal WebView reloaded');
        connectRef.current();
      } else if (message.type === 'input' && message.encoding === 'base64') {
        if (attachedRef.current) sendFrame(message);
      } else if (message.type === 'resize') {
        dimensionsRef.current = { cols: message.cols!, rows: message.rows! };
        if (attachedRef.current) sendFrame(message);
      } else if (message.type === 'error') {
        setStatus('error');
        setError(message.message || 'Terminal renderer failed');
      }
    },
    [sendFrame],
  );

  const reloadWebView = useCallback(() => {
    setStatus('connecting');
    setError('');
    webReadyRef.current = false;
    const socket = socketRef.current;
    socketRef.current = null;
    attachedRef.current = false;
    socket?.close(1000, 'Terminal WebView reloading');
    webRef.current?.reload();
  }, []);

  const sendSpecialKey = useCallback(
    (data: string) => {
      if (!attachedRef.current) return;
      sendFrame({ type: 'input', encoding: 'base64', data: encodeTerminalInputBase64(data) });
    },
    [sendFrame],
  );

  return (
    <View style={styles.container} testID="mobile-terminal-pane">
      <View style={styles.header}>
        <SquareTerminal size={15} color={colors.teal300} />
        <Text style={styles.title}>Terminal</Text>
        <Text style={styles.status}>{statusLabel(status)}</Text>
        <TouchableOpacity onPress={reloadWebView} accessibilityLabel="Reload terminal">
          <RotateCw size={15} color={colors.gray400} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} accessibilityLabel="Close terminal">
          <X size={16} color={colors.gray400} />
        </TouchableOpacity>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <WebView
        ref={webRef}
        testID="mobile-terminal-webview"
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        onMessage={onMessage}
        style={styles.webview}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.keyBar}
      >
        {SPECIAL_KEYS.map((key) => (
          <TouchableOpacity
            key={key.label}
            style={styles.key}
            onPress={() => sendSpecialKey(key.data)}
            accessibilityLabel={`Send ${key.label}`}
          >
            <Text style={styles.keyText}>{key.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 340,
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
  status: { flex: 1, color: colors.gray500, fontSize: 11 },
  error: {
    color: colors.red400,
    backgroundColor: colors.red900_50,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  webview: { flex: 1, backgroundColor: colors.gray950 },
  keyBar: { gap: 6, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.gray900 },
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
