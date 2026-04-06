import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import TopBar from '../components/TopBar';
import ChatMessage from '../components/ChatMessage';
import StreamingMessage from '../components/StreamingMessage';
import ThinkingIndicator from '../components/ThinkingIndicator';
import MessageInput from '../components/MessageInput';
import AgentSwitcher from '../components/AgentSwitcher';

export default function ChatScreen({ navigation }) {
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

  // Build list data: messages + thinking + streaming indicators
  const listData = [
    ...messages.map((msg) => ({ type: 'message', key: msg.id, data: msg })),
    ...(thinking
      ? [{ type: 'thinking', key: 'thinking' }]
      : []),
    ...(streamingContent
      ? [{ type: 'streaming', key: 'streaming', data: { content: streamingContent, engine: streamingEngine } }]
      : []),
  ];

  const renderItem = ({ item }) => {
    switch (item.type) {
      case 'message':
        return (
          <ChatMessage
            message={item.data}
            agentColor={activeAgent?.color}
          />
        );
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
      default:
        return null;
    }
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyEmoji}>💬</Text>
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
    <View style={styles.container}>
      <TopBar navigation={navigation} />

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
        />
      </KeyboardAvoidingView>

      {/* Agent Switcher Modal */}
      <AgentSwitcher
        visible={showSwitcher}
        agents={agents}
        onSelect={(id) => setActiveAgentId(id)}
        onClose={() => setShowSwitcher(false)}
      />
    </View>
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
