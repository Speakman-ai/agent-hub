import React, { useState, useRef, useEffect, useContext } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { SidebarContext } from '../context/SidebarContext';
import { formatRoomExport, queueIndicatorText } from '../utils/roomExport';

// Markdown styles matching the app theme
const mdStyles = {
  body: { color: colors.gray200, fontSize: 14 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  code_inline: { backgroundColor: colors.gray800, color: colors.emerald400, paddingHorizontal: 4, borderRadius: 3, fontSize: 13 },
  fence: { backgroundColor: colors.gray800, borderColor: colors.gray700, borderRadius: 8, padding: 12, marginVertical: 8 },
  code_block: { color: colors.gray200, fontSize: 13 },
  link: { color: colors.blue600, textDecorationLine: 'none' },
  heading1: { color: colors.white, fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  heading2: { color: colors.white, fontSize: 18, fontWeight: 'bold', marginBottom: 6 },
  heading3: { color: colors.white, fontSize: 16, fontWeight: '600', marginBottom: 4 },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  list_item: { marginBottom: 2 },
  blockquote: { backgroundColor: colors.gray800, borderLeftColor: colors.gray600, borderLeftWidth: 3, paddingHorizontal: 12, paddingVertical: 4, marginVertical: 8 },
  strong: { color: colors.white, fontWeight: 'bold' },
  em: { color: colors.gray300, fontStyle: 'italic' },
  hr: { backgroundColor: colors.gray700, height: 1, marginVertical: 16 },
};

function RoomMessage({ message, agents }) {
  const isUser = message.role === 'user';
  const agentColor = message.agent_color || agents?.find(a => a.name === message.agent_name)?.color || colors.gray500;

  return (
    <View style={[styles.messageContainer, isUser ? styles.userMessage : styles.agentMessage]}>
      <View style={styles.messageHeader}>
        <View style={[styles.messageDot, { backgroundColor: isUser ? colors.gray500 : agentColor }]} />
        <Text style={[styles.messageName, !isUser && { color: agentColor }]}>
          {isUser ? 'You' : (message.agent_name || 'Agent')}
        </Text>
        {message.created_at && (
          <Text style={styles.messageTime}>{relativeTime(message.created_at)}</Text>
        )}
      </View>
      <View style={styles.messageContent}>
        <Markdown style={mdStyles}>{message.content || ''}</Markdown>
      </View>
    </View>
  );
}

export default function RoomsScreen() {
  const {
    agents,
    rooms,
    activeRoomId,
    setActiveRoomId,
    roomMessages,
    roomStreaming,
    roomThinking,
    roomProcessing,
    roomQueueLength,
    handleRoomSend,
    handleRoomCancel,
    refreshRooms,
    connected,
  } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  const [input, setInput] = useState('');
  const [showManage, setShowManage] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  // Export UI state: null | 'summarizing' | 'copied'
  const [exportState, setExportState] = useState(null);
  const flatListRef = useRef(null);
  const inputRef = useRef(null);

  const room = rooms.find(r => r.id === activeRoomId);
  const roomAgents = room?.agents?.map(id => {
    const a = agents.find(ag => ag.id === (typeof id === 'string' ? id : id?.id));
    return a || (typeof id === 'object' ? id : null);
  }).filter(Boolean) || [];

  // Auto-scroll
  useEffect(() => {
    if (roomMessages.length > 0 || roomThinking || roomStreaming) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [roomMessages, roomThinking, roomStreaming]);

  // Build list data
  const listData = [
    ...roomMessages.map((msg) => ({ type: 'message', key: msg.id || `m-${msg.created_at}`, data: msg })),
    ...(roomThinking ? [{ type: 'thinking', key: 'thinking', data: roomThinking }] : []),
    ...(roomStreaming ? [{ type: 'streaming', key: 'streaming', data: roomStreaming }] : []),
  ];

  const handleSend = () => {
    const text = input.trim();
    // While a round is in flight, the server enqueues messages instead of
    // rejecting them — allow the user to keep typing and queueing.
    if (!text) return;
    handleRoomSend(text);
    setInput('');
    setShowMentions(false);
  };

  const handleShareRaw = async () => {
    try {
      const text = formatRoomExport({ room, messages: roomMessages });
      await Share.share({ message: text });
    } catch (err) {
      Alert.alert('Share failed', err?.message || 'Unable to share transcript');
    }
  };

  const handleSummarize = async () => {
    if (!activeRoomId || exportState === 'summarizing') return;
    setExportState('summarizing');
    try {
      const { summary } = await api.summarizeRoom(activeRoomId);
      try {
        await Share.share({ message: summary });
        setExportState('copied');
      } catch {
        setExportState(null);
      }
      setTimeout(() => setExportState(null), 2000);
    } catch (err) {
      setExportState(null);
      Alert.alert('Summary failed', err?.message || 'Unable to summarize room');
    }
  };

  const handleTextChange = (text) => {
    setInput(text);
    // Check for @mention
    const match = text.match(/(^|[\s])@([^\s]*)$/);
    if (match && roomAgents.length > 0) {
      setMentionFilter(match[2].toLowerCase());
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (agent) => {
    const match = input.match(/(^|[\s])@([^\s]*)$/);
    if (match) {
      const beforeMention = input.slice(0, match.index + match[1].length);
      setInput(`${beforeMention}@${agent.name} `);
    }
    setShowMentions(false);
  };

  const handleAddAgent = async (agentId) => {
    try {
      await api.addRoomAgent(activeRoomId, agentId);
      refreshRooms();
    } catch (err) {
      Alert.alert('Error', 'Failed to add agent');
    }
  };

  const handleRemoveAgent = async (agentId) => {
    try {
      await api.removeRoomAgent(activeRoomId, agentId);
      refreshRooms();
    } catch (err) {
      Alert.alert('Error', 'Failed to remove agent');
    }
  };

  const handleMaxTurns = async (value) => {
    try {
      await api.updateRoom(activeRoomId, { max_turns: value });
      refreshRooms();
    } catch (err) {
      Alert.alert('Error', 'Failed to update max turns');
    }
  };

  const filteredMentions = roomAgents.filter(a =>
    a.name?.toLowerCase().includes(mentionFilter)
  );

  const availableAgents = agents.filter(a =>
    a.active !== false && !roomAgents.some(ra => ra.id === a.id)
  );

  const renderItem = ({ item }) => {
    switch (item.type) {
      case 'message':
        return <RoomMessage message={item.data} agents={agents} />;
      case 'thinking':
        return (
          <View style={styles.thinkingContainer}>
            <View style={[styles.messageDot, { backgroundColor: item.data.agentColor || colors.gray500 }]} />
            <Text style={[styles.thinkingText, { color: item.data.agentColor || colors.gray400 }]}>
              {item.data.agentName} is thinking...
            </Text>
          </View>
        );
      case 'streaming':
        return (
          <View style={styles.messageContainer}>
            <View style={styles.messageHeader}>
              <View style={[styles.messageDot, { backgroundColor: item.data.agentColor || colors.gray500 }]} />
              <Text style={[styles.messageName, { color: item.data.agentColor }]}>
                {item.data.agentName}
              </Text>
              <View style={styles.streamingBadge}>
                <Text style={styles.streamingBadgeText}>streaming</Text>
              </View>
            </View>
            <View style={styles.messageContent}>
              <Markdown style={mdStyles}>{item.data.content || ''}</Markdown>
            </View>
          </View>
        );
      default:
        return null;
    }
  };

  if (!room) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => openSidebar()} style={styles.menuButton}>
            <Text style={styles.menuIcon}>{'\u2630'}</Text>
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Conference Rooms</Text>
        </View>
        <View style={styles.emptyContainer}>

          <Text style={styles.emptyTitle}>No room selected</Text>
          <Text style={styles.emptyHint}>Open the menu to select or create a room</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => openSidebar()} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <View style={styles.topBarCenter}>
          <Text style={styles.topBarTitle} numberOfLines={1}>{room.name}</Text>
          <View style={styles.agentDots}>
            {roomAgents.slice(0, 5).map((a, i) => (
              <View key={a.id || i} style={[styles.miniDot, { backgroundColor: a.color || colors.gray500 }]} />
            ))}
            {roomAgents.length > 5 && (
              <Text style={styles.moreDots}>+{roomAgents.length - 5}</Text>
            )}
          </View>
        </View>
        {roomMessages.length > 0 && (
          <>
            <TouchableOpacity
              style={styles.exportButton}
              onPress={handleShareRaw}
              accessibilityLabel="Copy raw transcript"
            >
              <Text style={styles.exportButtonText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.exportButton,
                exportState === 'summarizing' && styles.exportButtonActive,
              ]}
              onPress={handleSummarize}
              disabled={exportState === 'summarizing'}
              accessibilityLabel="Summarize room"
            >
              <Text style={styles.exportButtonText}>
                {exportState === 'summarizing'
                  ? '…'
                  : exportState === 'copied'
                  ? '\u2713'
                  : 'Summary'}
              </Text>
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          style={[styles.manageButton, showManage && styles.manageButtonActive]}
          onPress={() => setShowManage(!showManage)}
        >
          <Text style={styles.manageButtonText}>{showManage ? 'Done' : 'Manage'}</Text>
        </TouchableOpacity>
      </View>

      {/* Agent Management Panel */}
      {showManage && (
        <View style={styles.managePanel}>
          <Text style={styles.manageSectionTitle}>In Room</Text>
          {roomAgents.length === 0 ? (
            <Text style={styles.manageEmpty}>No agents in this room</Text>
          ) : (
            roomAgents.map((a) => (
              <View key={a.id} style={styles.manageRow}>
                <View style={[styles.manageDot, { backgroundColor: a.color }]} />
                <Text style={styles.manageAgentName} numberOfLines={1}>{a.name}</Text>
                <TouchableOpacity onPress={() => handleRemoveAgent(a.id)}>
                  <Text style={styles.removeButton}>{'\u2715'}</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
          {availableAgents.length > 0 && (
            <>
              <Text style={[styles.manageSectionTitle, { marginTop: 12 }]}>Available</Text>
              {availableAgents.map((a) => (
                <TouchableOpacity key={a.id} style={styles.manageRow} onPress={() => handleAddAgent(a.id)}>
                  <View style={[styles.manageDot, { backgroundColor: a.color }]} />
                  <Text style={styles.manageAgentName} numberOfLines={1}>{a.name}</Text>
                  <Text style={styles.addButton}>+</Text>
                </TouchableOpacity>
              ))}
            </>
          )}
          <Text style={[styles.manageSectionTitle, { marginTop: 12 }]}>Max Turns</Text>
          <View style={styles.turnsRow}>
            {[10, 25, 50, 100, 0].map((v) => (
              <TouchableOpacity
                key={v}
                style={[styles.turnButton, room.max_turns === v && styles.turnButtonActive]}
                onPress={() => handleMaxTurns(v)}
              >
                <Text style={[styles.turnButtonText, room.max_turns === v && styles.turnButtonTextActive]}>
                  {v === 0 ? '\u221E' : v}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={listData}
          renderItem={renderItem}
          keyExtractor={(item) => item.key}
          contentContainerStyle={listData.length === 0 ? styles.emptyListContent : styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
    
              <Text style={styles.emptyTitle}>Start a conference</Text>
              <Text style={styles.emptyHint}>
                {roomAgents.length === 0
                  ? 'Add agents to this room first'
                  : `${roomAgents.length} agent${roomAgents.length > 1 ? 's' : ''} ready`}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => {
            if (listData.length > 0) {
              flatListRef.current?.scrollToEnd({ animated: false });
            }
          }}
        />

        {/* @Mention Autocomplete */}
        {showMentions && filteredMentions.length > 0 && (
          <View style={styles.mentionPopup}>
            {filteredMentions.map((a) => (
              <TouchableOpacity
                key={a.id}
                style={styles.mentionItem}
                onPress={() => insertMention(a)}
              >
                <View style={[styles.manageDot, { backgroundColor: a.color }]} />
                <Text style={styles.mentionName}>{a.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Queue indicator — mirrors web RoomChat amber warning */}
        {queueIndicatorText({ roomProcessing, roomQueueLength }) && (
          <View style={styles.queueIndicator}>
            <Text style={styles.queueIndicatorText}>
              {queueIndicatorText({ roomProcessing, roomQueueLength })}
            </Text>
          </View>
        )}

        {/* Input */}
        <View style={styles.inputContainer}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={input}
            onChangeText={handleTextChange}
            placeholder={
              roomAgents.length === 0
                ? 'Add agents first'
                : roomProcessing
                ? 'Type to queue a message while agents respond...'
                : 'Message the room... (@ to mention)'
            }
            placeholderTextColor={colors.gray600}
            multiline
            maxLength={10000}
            editable={roomAgents.length > 0 && connected}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={handleSend}
          />
          <View style={styles.inputButtons}>
            {roomProcessing && (
              <TouchableOpacity style={styles.cancelButton} onPress={handleRoomCancel}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[
                styles.sendButton,
                roomProcessing && styles.sendButtonQueueing,
                (!input.trim() || roomAgents.length === 0 || !connected) &&
                  styles.sendButtonDisabled,
              ]}
              onPress={handleSend}
              disabled={!input.trim() || roomAgents.length === 0 || !connected}
            >
              <Text style={styles.sendButtonText}>
                {roomProcessing ? 'Queue' : '\u2191'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.gray800, gap: 8,
  },
  menuButton: { padding: 4 },
  menuIcon: { fontSize: 20, color: colors.gray400 },
  topBarCenter: { flex: 1 },
  topBarTitle: { fontSize: 16, fontWeight: '600', color: colors.white },
  agentDots: { flexDirection: 'row', gap: 4, marginTop: 2 },
  miniDot: { width: 8, height: 8, borderRadius: 4 },
  moreDots: { fontSize: 10, color: colors.gray500, marginLeft: 2 },
  manageButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.gray800 },
  manageButtonActive: { backgroundColor: colors.blue600 },
  manageButtonText: { fontSize: 12, color: colors.gray300, fontWeight: '500' },
  exportButton: {
    paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.gray800,
    marginLeft: 4,
  },
  exportButtonActive: { backgroundColor: colors.blue600 },
  exportButtonText: { fontSize: 11, color: colors.gray300, fontWeight: '500' },
  queueIndicator: {
    paddingHorizontal: 16, paddingTop: 6, paddingBottom: 2,
  },
  queueIndicatorText: { fontSize: 11, color: colors.amber400 },
  inputButtons: { flexDirection: 'row', gap: 6, alignItems: 'flex-end' },
  sendButtonQueueing: {
    width: undefined, height: 36, borderRadius: 8, paddingHorizontal: 14,
    backgroundColor: '#D97706',
  },
  managePanel: {
    backgroundColor: colors.gray900, borderBottomWidth: 1, borderBottomColor: colors.gray800,
    paddingHorizontal: 16, paddingVertical: 12, maxHeight: 300,
  },
  manageSectionTitle: { fontSize: 10, fontWeight: '600', color: colors.gray500, letterSpacing: 1, marginBottom: 6 },
  manageEmpty: { fontSize: 12, color: colors.gray600, marginBottom: 8 },
  manageRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  manageDot: { width: 10, height: 10, borderRadius: 5 },
  manageAgentName: { flex: 1, fontSize: 13, color: colors.gray300 },
  removeButton: { color: colors.red600, fontSize: 14, paddingHorizontal: 8 },
  addButton: { color: colors.emerald400, fontSize: 18, fontWeight: 'bold', paddingHorizontal: 8 },
  turnsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  turnButton: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.gray800 },
  turnButtonActive: { backgroundColor: colors.blue600 },
  turnButtonText: { fontSize: 12, color: colors.gray400 },
  turnButtonTextActive: { color: colors.white },
  listContent: { paddingVertical: 12, paddingHorizontal: 12 },
  emptyListContent: { flexGrow: 1 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, color: colors.gray600 },
  emptyHint: { fontSize: 12, color: colors.gray700, marginTop: 8 },
  messageContainer: { marginBottom: 16, paddingHorizontal: 4 },
  userMessage: {},
  agentMessage: {},
  messageHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  messageDot: { width: 8, height: 8, borderRadius: 4 },
  messageName: { fontSize: 13, fontWeight: '600', color: colors.gray400 },
  messageTime: { fontSize: 10, color: colors.gray600 },
  messageContent: { paddingLeft: 14 },
  thinkingContainer: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 8 },
  thinkingText: { fontSize: 13, fontStyle: 'italic' },
  streamingBadge: { backgroundColor: colors.blue600, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  streamingBadgeText: { fontSize: 9, color: colors.white, fontWeight: '600' },
  mentionPopup: {
    backgroundColor: colors.gray800, borderRadius: 8, marginHorizontal: 12, marginBottom: 4,
    borderWidth: 1, borderColor: colors.gray700, overflow: 'hidden',
  },
  mentionItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  mentionName: { fontSize: 13, color: colors.gray200 },
  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: colors.gray800, gap: 8,
  },
  input: {
    flex: 1, backgroundColor: colors.gray800, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    color: colors.white, fontSize: 14, maxHeight: 120,
  },
  sendButton: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.blue600,
    alignItems: 'center', justifyContent: 'center',
  },
  sendButtonDisabled: { backgroundColor: colors.gray700 },
  sendButtonText: { color: colors.white, fontSize: 18, fontWeight: 'bold' },
  cancelButton: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.red600,
  },
  cancelButtonText: { color: colors.white, fontSize: 13, fontWeight: '600' },
});
