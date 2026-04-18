import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import TopBar from '../components/TopBar';
import ChatMessage from '../components/ChatMessage';
import StreamingMessage from '../components/StreamingMessage';
import ThinkingIndicator from '../components/ThinkingIndicator';
import MessageInput from '../components/MessageInput';
import AgentSwitcher from '../components/AgentSwitcher';
import DelegationPanel from '../components/DelegationPanel';
import SessionTail from '../components/SessionTail';
import ChangesReadyBox from '../components/ChangesReadyBox';
import { resolveAutoMergeDefault } from '../utils/changesReady';

export default function ChatScreen() {
  const {
    agents,
    activeAgent,
    activeAgentId,
    setActiveAgentId,
    messages,
    thinking,
    streamingContent,
    streamingEngine,
    connected,
    isProcessing,
    handleSend,
    handleCancel,
    skills,
    delegations,
    messageQueues,
    eventsByMessage,
    handleDequeue,
    handleEditQueuedMessage,
    handleDelegationCancel,
    handleEventsLoaded,
    activeSessionId,
    changesReady,
    dismissChangesReady,
    projects,
  } = useApp();

  const flatListRef = useRef(null);
  const [showSwitcher, setShowSwitcher] = useState(false);

  // Auto-scroll when messages change
  useEffect(() => {
    if (messages.length > 0 || thinking || streamingContent) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages, thinking, streamingContent]);

  const queuedIds = new Set((messageQueues[activeSessionId] || []).map((q) => q.id));
  const activeDelegation = delegations[activeSessionId];
  const pendingChanges = changesReady?.[activeSessionId];
  const activeProject = projects?.find((p) => p.id === activeAgent?.projectId);

  // Build list data: messages + thinking + streaming indicators
  const listData = [
    ...messages.map((msg) => ({ type: 'message', key: msg.id, data: msg })),
    ...(thinking
      ? [{ type: 'thinking', key: 'thinking' }]
      : []),
    ...(streamingContent
      ? [{ type: 'streaming', key: 'streaming', data: { content: streamingContent, engine: streamingEngine } }]
      : []),
    ...(activeDelegation?.tasks?.length > 0
      ? [{ type: 'delegation', key: 'delegation', data: activeDelegation }]
      : []),
    ...(pendingChanges && !thinking && !streamingContent
      ? [{ type: 'changes-ready', key: 'changes-ready', data: pendingChanges }]
      : []),
  ];

  const renderItem = ({ item }) => {
    switch (item.type) {
      case 'message': {
        const msg = item.data;
        const isQueued = queuedIds.has(msg.id);
        return (
          <View>
            <ChatMessage
              message={{ ...msg, queued: isQueued }}
              agentColor={activeAgent?.color}
              onDequeue={isQueued ? handleDequeue : undefined}
              onEditQueued={isQueued ? handleEditQueuedMessage : undefined}
            />
            {msg.role === 'assistant' && (
              <SessionTail
                message={msg}
                events={eventsByMessage[msg.id]}
                agentColor={activeAgent?.color}
                onEventsLoaded={handleEventsLoaded}
              />
            )}
          </View>
        );
      }
      case 'thinking':
        return <ThinkingIndicator agentColor={activeAgent?.color} />;
      case 'streaming':
        return (
          <StreamingMessage
            content={item.data.content}
            agentColor={activeAgent?.color}
            engine={item.data.engine}
          />
        );
      case 'delegation':
        return (
          <View style={{ paddingHorizontal: 12 }}>
            <DelegationPanel
              delegations={item.data.tasks}
              sessionId={activeSessionId}
              onCancel={handleDelegationCancel}
            />
          </View>
        );
      case 'changes-ready':
        return (
          <ChangesReadyBox
            sessionId={activeSessionId}
            changes={item.data}
            defaultAutoMerge={resolveAutoMergeDefault(activeProject)}
            onCreated={() => {
              // The server will emit `auto_pr_created` which clears the
              // banner in AppContext. Nothing to do here.
            }}
            onDismiss={dismissChangesReady}
          />
        );
      default:
        return null;
    }
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyTitle}>Start a conversation</Text>
      {activeAgent && (
        <Text style={styles.emptySubtitle}>with {activeAgent.name}</Text>
      )}
      <Text style={styles.emptyHint}>
        Tap the menu to switch agents
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <TopBar />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={listData}
          renderItem={renderItem}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={!thinking && !streamingContent ? renderEmpty : null}
          contentContainerStyle={listData.length === 0 ? styles.emptyListContent : styles.listContent}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => {
            if (listData.length > 0) {
              flatListRef.current?.scrollToEnd({ animated: false });
            }
          }}
        />

        {/* Input */}
        <MessageInput
          onSend={handleSend}
          onCancel={handleCancel}
          disabled={!activeAgentId || !connected || isProcessing}
          isProcessing={isProcessing}
          agentColor={activeAgent?.color}
          skills={skills}
          queueLength={(messageQueues[activeSessionId] || []).length}
        />
      </KeyboardAvoidingView>

      {/* Agent Switcher Modal */}
      <AgentSwitcher
        visible={showSwitcher}
        agents={agents}
        onSelect={(id) => setActiveAgentId(id)}
        onClose={() => setShowSwitcher(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  flex: {
    flex: 1,
  },
  listContent: {
    paddingVertical: 12,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    color: colors.gray600,
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.gray600,
    marginTop: 4,
  },
  emptyHint: {
    fontSize: 12,
    color: colors.gray700,
    marginTop: 16,
  },
});
