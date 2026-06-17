import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';

const mdStyles = {
  body: { color: colors.gray200, fontSize: 14 },
  paragraph: { marginTop: 0, marginBottom: 6 },
  code_inline: {
    backgroundColor: colors.gray800,
    color: colors.emerald400,
    paddingHorizontal: 4,
    borderRadius: 3,
    fontSize: 13,
  },
  fence: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
  },
  code_block: { color: colors.gray200, fontSize: 12 },
  link: { color: colors.blue600 },
  strong: { color: colors.white, fontWeight: 'bold' },
};

function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  return (
    <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
      <Text style={styles.roleLabel}>{isUser ? 'You' : 'Design Studio'}</Text>
      {isUser ? (
        <Text style={styles.messageText}>{message.content}</Text>
      ) : (
        <Markdown style={mdStyles}>{message.content || ''}</Markdown>
      )}
    </View>
  );
}

export default function DesignViewScreen({ route, navigation }) {
  const { lastDesignEvent, wsSend, connected } = useApp();
  const designId = route?.params?.designId;
  const initialDesign = route?.params?.design;

  const [design, setDesign] = useState(initialDesign || null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(null);
  const [processing, setProcessing] = useState(false);

  const listRef = useRef(null);
  const designIdRef = useRef(designId);
  designIdRef.current = designId;

  const load = useCallback(async () => {
    if (!designId) return;
    setLoading(true);
    try {
      const [d, msgs, status] = await Promise.all([
        api.getDesign(designId),
        api.getDesignMessages(designId),
        api.getDesignStatus(designId).catch(() => null),
      ]);
      if (designIdRef.current !== designId) return;
      setDesign(d);
      setMessages(Array.isArray(msgs) ? msgs : []);
      if (status?.processing) {
        setProcessing(true);
        if (status.partialContent) {
          setStreaming({ role: 'assistant', content: status.partialContent });
        }
        setThinking(Boolean(status.thinking));
      }
    } catch (err) {
      console.warn('Design load failed:', err.message);
    } finally {
      if (designIdRef.current === designId) setLoading(false);
    }
  }, [designId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!lastDesignEvent || lastDesignEvent.designId !== designId) return;

    switch (lastDesignEvent.type) {
      case 'design_thinking':
        setThinking(true);
        setProcessing(true);
        break;
      case 'design_stream':
        setThinking(false);
        setProcessing(true);
        setStreaming({
          role: 'assistant',
          content: lastDesignEvent.content || lastDesignEvent.partialContent || '',
        });
        break;
      case 'design_message_added': {
        const msg = lastDesignEvent.message;
        if (!msg) break;
        if (msg.role === 'assistant' && msg.streaming) {
          setThinking(false);
          setStreaming(msg);
        } else {
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) {
              return prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m));
            }
            return [...prev, msg];
          });
          if (msg.role === 'assistant' && !msg.streaming) {
            setStreaming(null);
            setThinking(false);
            setProcessing(false);
          }
        }
        break;
      }
      case 'design_updated':
      case 'design_cancelled':
        setStreaming(null);
        setThinking(false);
        setProcessing(false);
        load();
        break;
      default:
        break;
    }
  }, [lastDesignEvent?.bump, designId, load]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || !designId || processing) return;
    // `wsSend` (AppContext → useWebSocket `send`) returns true ONLY when the
    // socket is OPEN and the frame was written. Bail without optimistic state
    // when it couldn't send, so we never clear the composer or flip
    // `processing` for a message that never left the device. The `processing`
    // guard above then prevents duplicate sends once one is in flight.
    const sent = wsSend?.({ type: 'design_chat', designId, content: trimmed });
    if (!sent) return;
    const optimistic = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: trimmed,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput('');
    setProcessing(true);
    setThinking(true);
  };

  const displayMessages = streaming
    ? [...messages.filter((m) => m.id !== streaming.id), streaming]
    : messages;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ProjectScreenHeader
        title={design?.name || 'Design'}
        onBack={() => navigation.goBack()}
        right={
          !connected ? (
            <Text style={styles.offline}>Offline</Text>
          ) : processing ? (
            <ActivityIndicator size="small" color={colors.purple400} style={{ marginLeft: 'auto' }} />
          ) : null
        }
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.blue600} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={displayMessages}
            keyExtractor={(item, index) => item.id || String(index)}
            renderItem={({ item }) => <MessageBubble message={item} />}
            contentContainerStyle={styles.messages}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListFooterComponent={
              thinking ? (
                <View style={styles.thinkingRow}>
                  <ActivityIndicator size="small" color={colors.gray500} />
                  <Text style={styles.thinkingText}>Thinking…</Text>
                </View>
              ) : null
            }
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                Chat with the Design Studio agent to generate UI artifacts.
              </Text>
            }
          />
        )}

        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            value={input}
            onChangeText={setInput}
            placeholder="Describe your design…"
            placeholderTextColor={colors.gray600}
            multiline
            editable={!processing}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || processing) && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!input.trim() || processing}
          >
            <Text style={styles.sendBtnText}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  messages: { padding: 12, paddingBottom: 8 },
  emptyText: { color: colors.gray600, fontSize: 14, textAlign: 'center', marginTop: 40 },
  bubble: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    maxWidth: '95%',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.blue900_40,
    borderWidth: 1,
    borderColor: colors.blue600,
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  roleLabel: { fontSize: 10, color: colors.gray500, marginBottom: 4, fontWeight: '600' },
  messageText: { color: colors.gray200, fontSize: 14 },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8 },
  thinkingText: { color: colors.gray500, fontSize: 12 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.white,
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: colors.purple500,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  offline: { marginLeft: 'auto', fontSize: 11, color: colors.amber400 },
});
