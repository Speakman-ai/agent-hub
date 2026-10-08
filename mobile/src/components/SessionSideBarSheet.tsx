import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { MessageCircleQuestion, RotateCcw, Send, Square, Trash2, X } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import { useApp } from '../context/AppContext';
import { createUseSidebarChat, type SidebarChatApi } from '@shared/hooks/useSidebarChat';

const useSidebarChat = createUseSidebarChat({
  useCallback,
  useEffect,
  useRef,
  useState,
});

const sidebarApi: SidebarChatApi = {
  getSessionSidebar: (id) => api.getSessionSidebar(id),
  getMessages: (id) => api.getMessages(id) as Promise<any[]>,
  openSessionSidebar: (id, content) => api.openSessionSidebar(id, content),
  closeSessionSidebar: (id) => api.closeSessionSidebar(id),
};

const noSubscription = () => () => {};

interface Props {
  visible: boolean;
  onClose: () => void;
  parentSessionId: string;
  agentId: string;
  agentName?: string;
}

/**
 * SideBar sheet — mobile counterpart of the web SessionSideBarPane. Side
 * questions on a hidden Consult-mode fork of the session; nothing here goes
 * into the main chat. One SideBar per session. All state transitions live in
 * the shared `useSidebarChat` hook.
 */
export default function SessionSideBarSheet({
  visible,
  onClose,
  parentSessionId,
  agentId,
  agentName,
}: Props) {
  const { wsSend, connected, subscribeSideBarEvents } = useApp() as any;
  const {
    state,
    canAsk,
    ask,
    retryQuestion,
    startFresh,
    discard,
    stop,
    retryLoad,
    draft: input,
    setDraft: setInput,
  } = useSidebarChat({
    parentSessionId,
    agentId,
    enabled: visible,
    connected: !!connected,
    api: sidebarApi,
    send: (msg) => (typeof wsSend === 'function' ? wsSend(msg) : false),
    subscribe:
      typeof subscribeSideBarEvents === 'function' ? subscribeSideBarEvents : noSubscription,
  });
  const scrollRef = useRef<ScrollView | null>(null);

  const submit = useCallback(async () => {
    const content = input.trim();
    if (!content || !connected || !canAsk) return;
    setInput('');
    // A failed send stays in the conversation as undelivered (with Retry);
    // only a refused ask leaves the input as the one copy of the text.
    if ((await ask(content)) === 'rejected') setInput((cur) => cur || content);
  }, [input, connected, canAsk, ask, setInput]);

  const ready = state.phase === 'ready';
  const busyOp = state.pendingOp !== null;
  const canSend = connected && canAsk && input.trim().length > 0;
  const hasConversation = state.messages.length > 0 || !!state.sidebarId;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} testID="mobile-sidebar-sheet">
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <View style={styles.headerTitle}>
              <MessageCircleQuestion size={16} color={colors.amber400} />
              <View style={styles.flex}>
                <Text style={styles.title}>SideBar</Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  Side questions on a fork of this session
                </Text>
              </View>
            </View>
            {hasConversation && (
              <>
                <TouchableOpacity
                  testID="mobile-sidebar-new"
                  accessibilityLabel="New SideBar"
                  disabled={!ready || busyOp || state.busy}
                  onPress={() => void startFresh()}
                  style={styles.iconButton}
                >
                  <RotateCcw size={16} color={colors.gray300} />
                </TouchableOpacity>
                <TouchableOpacity
                  testID="mobile-sidebar-discard"
                  accessibilityLabel="Discard SideBar"
                  disabled={!ready || busyOp}
                  onPress={() => void discard()}
                  style={styles.iconButton}
                >
                  <Trash2 size={16} color={colors.gray300} />
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity
              testID="mobile-sidebar-close"
              accessibilityLabel="Hide SideBar"
              onPress={onClose}
              style={styles.iconButton}
            >
              <X size={18} color={colors.gray300} />
            </TouchableOpacity>
          </View>

          <ScrollView
            ref={scrollRef}
            style={styles.flex}
            contentContainerStyle={styles.messages}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {state.phase === 'load_error' ? (
              <View testID="mobile-sidebar-load-error" style={styles.center}>
                <Text style={styles.errorText}>{state.loadError}</Text>
                <TouchableOpacity
                  testID="mobile-sidebar-retry"
                  onPress={retryLoad}
                  style={styles.retry}
                >
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : state.phase === 'loading' && state.messages.length === 0 ? (
              <ActivityIndicator color={colors.amber400} />
            ) : state.messages.length === 0 && !state.busy ? (
              <Text style={styles.empty}>
                Ask {agentName || 'the agent'} anything about this session. It sees the whole
                conversation, runs in Consult mode, and does not edit code.
              </Text>
            ) : (
              state.messages.map((m) =>
                m.role === 'user' ? (
                  <View key={m.id} style={styles.userColumn}>
                    <View
                      style={[
                        styles.userBubble,
                        m.pending && styles.pending,
                        m.failed && styles.failedBubble,
                      ]}
                    >
                      <Text style={styles.userText}>{m.content}</Text>
                    </View>
                    {m.failed ? (
                      <View style={styles.undelivered} testID="mobile-sidebar-undelivered">
                        <Text style={styles.errorText}>Not delivered</Text>
                        <TouchableOpacity
                          testID="mobile-sidebar-retry-question"
                          accessibilityLabel="Retry question"
                          disabled={!connected || !canAsk}
                          onPress={() => void retryQuestion(m.id)}
                          style={styles.retry}
                        >
                          <Text style={styles.retryText}>Retry</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                ) : (
                  <View key={m.id} testID="mobile-sidebar-assistant-message">
                    <Markdown style={markdownStyles as any}>{m.content}</Markdown>
                  </View>
                ),
              )
            )}
            {state.busy &&
              (state.streamingContent ? (
                <View testID="mobile-sidebar-streaming">
                  <Markdown style={markdownStyles as any}>{state.streamingContent}</Markdown>
                </View>
              ) : (
                <ActivityIndicator color={colors.gray500} />
              ))}
            {state.error ? (
              <Text testID="mobile-sidebar-error" style={styles.errorText}>
                {state.error}
              </Text>
            ) : null}
          </ScrollView>

          <View style={styles.composer}>
            <TextInput
              testID="mobile-sidebar-input"
              value={input}
              onChangeText={setInput}
              editable={connected && ready}
              placeholder={
                !connected ? 'Reconnecting…' : !ready ? 'Loading…' : 'Ask a side question…'
              }
              placeholderTextColor={colors.gray500}
              multiline
              style={styles.input}
            />
            {state.busy ? (
              <TouchableOpacity
                testID="mobile-sidebar-stop"
                accessibilityLabel="Stop"
                onPress={stop}
                style={styles.sendButton}
              >
                <Square size={16} color={colors.gray300} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="mobile-sidebar-send"
                accessibilityLabel="Ask"
                disabled={!canSend}
                onPress={() => void submit()}
                style={[styles.sendButton, !canSend && styles.disabled]}
              >
                {state.pendingOp === 'open' ? (
                  <ActivityIndicator color={colors.gray300} />
                ) : (
                  <Send size={16} color={colors.amber400} />
                )}
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const markdownStyles = {
  body: { color: colors.gray200, fontSize: 14 },
  code_inline: { backgroundColor: colors.gray800, color: colors.gray200 },
  fence: { backgroundColor: colors.gray900, color: colors.gray200 },
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  headerTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.gray200, fontSize: 14, fontWeight: '600' },
  subtitle: { color: colors.gray500, fontSize: 11 },
  iconButton: { padding: 6 },
  messages: { padding: 12, gap: 12 },
  center: { alignItems: 'center', gap: 8 },
  empty: { color: colors.gray500, fontSize: 12, textAlign: 'center', paddingVertical: 24 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  pending: { opacity: 0.7 },
  failedBubble: { borderWidth: 1, borderColor: colors.red400 },
  userColumn: { alignSelf: 'flex-end', maxWidth: '85%', gap: 4 },
  undelivered: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  userText: { color: colors.gray100, fontSize: 14 },
  errorText: { color: colors.red400, fontSize: 12 },
  retry: {
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  retryText: { color: colors.gray200, fontSize: 12 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: colors.gray900,
    color: colors.gray100,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 14,
  },
  sendButton: { padding: 10, borderRadius: 6, backgroundColor: colors.gray800 },
  disabled: { opacity: 0.4 },
});
