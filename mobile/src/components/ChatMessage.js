import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';

const ENGINE_BADGES = {
  'claude-code': { emoji: '🟣', label: 'Claude Code' },
  'cursor-agent': { emoji: '🟢', label: 'Cursor Agent' },
};

const markdownStyles = {
  body: {
    color: colors.gray200,
    fontSize: 14,
    lineHeight: 20,
  },
  heading1: {
    color: colors.white,
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 12,
    marginBottom: 6,
  },
  heading2: {
    color: colors.white,
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 10,
    marginBottom: 6,
  },
  heading3: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 10,
    marginBottom: 4,
  },
  paragraph: {
    marginTop: 4,
    marginBottom: 4,
  },
  code_inline: {
    backgroundColor: colors.gray800,
    color: colors.emerald400,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  code_block: {
    backgroundColor: colors.gray900,
    color: colors.gray200,
    padding: 12,
    borderRadius: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    marginVertical: 6,
  },
  fence: {
    backgroundColor: colors.gray900,
    color: colors.gray200,
    padding: 12,
    borderRadius: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    marginVertical: 6,
  },
  blockquote: {
    borderLeftWidth: 4,
    borderLeftColor: colors.gray600,
    paddingLeft: 12,
    marginVertical: 6,
    color: colors.gray400,
    fontStyle: 'italic',
  },
  link: {
    color: colors.blue400,
  },
  list_item: {
    color: colors.gray200,
    marginVertical: 2,
  },
  bullet_list: {
    marginVertical: 4,
  },
  ordered_list: {
    marginVertical: 4,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.gray700,
    marginVertical: 6,
  },
  thead: {
    backgroundColor: colors.gray800,
  },
  th: {
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 6,
    color: colors.gray200,
    fontSize: 12,
  },
  td: {
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 6,
    color: colors.gray200,
    fontSize: 12,
  },
  hr: {
    backgroundColor: colors.gray700,
    marginVertical: 12,
  },
  strong: {
    color: colors.white,
    fontWeight: 'bold',
  },
  em: {
    color: colors.gray300,
    fontStyle: 'italic',
  },
};

function ChatMessage({ message, agentColor }) {
  const isUser = message.role === 'user';
  const engineBadge = !isUser && message.engine ? ENGINE_BADGES[message.engine] : null;
  const modelLabel = !isUser && message.model
    ? message.model.replace('claude-', '').replace('-', ' ')
    : null;

  return (
    <View style={[styles.container, isUser ? styles.containerUser : styles.containerAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
      >
        {/* Assistant header */}
        {!isUser && (
          <View style={styles.assistantHeader}>
            <View style={[styles.headerDot, { backgroundColor: agentColor }]} />
            <Text style={styles.headerLabel}>Assistant</Text>
            {engineBadge && (
              <Text style={styles.engineBadge}>
                {engineBadge.emoji} {engineBadge.label}
              </Text>
            )}
            {modelLabel && (
              <Text style={styles.modelLabel}>· {modelLabel}</Text>
            )}
          </View>
        )}

        {/* Content */}
        {isUser ? (
          <Text style={styles.userText}>{message.content}</Text>
        ) : (
          <Markdown style={markdownStyles}>{message.content}</Markdown>
        )}

        {/* Timestamp */}
        <Text style={[styles.timestamp, isUser ? styles.timestampUser : styles.timestampAssistant]}>
          {message.created_at && relativeTime(message.created_at)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  containerUser: {
    justifyContent: 'flex-end',
  },
  containerAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 16,
  },
  bubbleUser: {
    backgroundColor: colors.blue600,
    borderBottomRightRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  bubbleAssistant: {
    backgroundColor: colors.gray800,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  assistantHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  headerLabel: {
    fontSize: 11,
    color: colors.gray500,
    fontWeight: '500',
  },
  engineBadge: {
    fontSize: 10,
    color: colors.gray600,
  },
  modelLabel: {
    fontSize: 10,
    color: colors.gray600,
  },
  userText: {
    color: colors.white,
    fontSize: 14,
    lineHeight: 20,
  },
  timestamp: {
    fontSize: 10,
    marginTop: 4,
  },
  timestampUser: {
    color: colors.blue300,
  },
  timestampAssistant: {
    color: colors.gray600,
  },
});

export default memo(ChatMessage);
