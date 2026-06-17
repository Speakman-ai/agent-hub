import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
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
// FinalizeBar — single action row (Summary, View changes, Build, Finalize, Push).
import SessionAgentsPanel from '../components/SessionAgentsPanel';
import ChangesReadyBox from '../components/ChangesReadyBox';
import FinalizeBar from '../components/FinalizeBar';
import { useFinalizeRunPoll } from '../hooks/useFinalizeRunPoll';
import { useSessionCommittable } from '../hooks/useSessionCommittable';
import { isWorkflowProject } from '../utils/project-mode';
import { shouldShowViewChanges } from '../utils/sessionExtras';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
  parseResolvePrNumberFromTitle,
} from '../../../shared/utils/sessionTitlePr.js';

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
    streamingMsgId,
    sessionModel,
    connected,
    isProcessing,
    handleSend,
    handleCancel,
    chatScrollNonce,
    skills,
    delegations,
    messageQueues,
    eventsByMessage,
    browserScreensBySession,
    handleDequeue,
    handleInterruptQueuedMessage,
    handleEditQueuedMessage,
    handleDelegationCancel,
    handleEventsLoaded,
    activeSessionId,
    changesReady,
    dismissChangesReady,
    triggerCreateTicketAndPr,
    shipFailureAt,
    projects,
    sessionHandoffs,
    handleOpenHandoffSession,
    sessionAskMode,
    askSubmitted,
    handleAskSubmit,
    reloadMessages,
    sessionAgents,
    sessionRoundProcessing,
    handleSessionAgentsUpdated,
    sessions,
  } = useApp();

  // NOTE: `activeSession` is declared once below (useMemo) — a duplicate
  // plain declaration here previously made this module fail to parse.

  const navigation = useNavigation();
  const flatListRef = useRef(null);
  const [showSwitcher, setShowSwitcher] = useState(false);

  // Reload the active session's messages every time the Chat screen gains
  // focus — either from a cold launch, returning from another stack screen,
  // or the user tapping a session in the drawer (which routes through
  // `navigation.navigate('Chat')`). This guarantees the chat reflects the
  // server's latest history without having to toggle sessions off-and-on.
  // The `activeSessionId` dep also covers the case where the session changes
  // while this screen is already focused.
  useFocusEffect(
    useCallback(() => {
      if (activeSessionId) {
        reloadMessages();
      }
    }, [activeSessionId, reloadMessages]),
  );

  // Auto-scroll when messages change or the user interrupts a stream.
  useEffect(() => {
    if (messages.length > 0 || thinking || streamingContent || chatScrollNonce > 0) {
      const scroll = () => flatListRef.current?.scrollToEnd({ animated: chatScrollNonce === 0 });
      setTimeout(scroll, 50);
      setTimeout(scroll, 150);
    }
  }, [messages, thinking, streamingContent, activeSessionId, chatScrollNonce]);

  const queuedIds = new Set((messageQueues[activeSessionId] || []).map((q) => q.id));
  const activeDelegation = delegations[activeSessionId];
  const pendingChanges = changesReady?.[activeSessionId];
  const activeProject = projects?.find((p) => p.id === activeAgent?.projectId);
  const workflowProject = isWorkflowProject(activeProject);
  const activeSession = useMemo(
    () => sessions?.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const activeResolvePrBannerInfo = useMemo(() => {
    if (!activeSession?.name || !isResolvePrSessionTitle(activeSession.name)) return null;
    return {
      prUrl: inferPrUrlFromSessionTitle(activeSession.name, activeProject?.githubRepo),
      prNumber: parseResolvePrNumberFromTitle(activeSession.name),
    };
  }, [activeSession, activeProject]);

  const showFinalizeBar = Boolean(activeSessionId && activeProject?.id);
  const finalize = useFinalizeRunPoll(activeSessionId, { enabled: showFinalizeBar });
  const hasCommittableChanges = useSessionCommittable(activeSessionId, { pendingChanges });

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
    ...(pendingChanges &&
    !workflowProject &&
    !thinking &&
    !streamingContent &&
    activeResolvePrBannerInfo
      ? [{ type: 'resolve-pr-banner', key: 'resolve-pr-banner', data: activeResolvePrBannerInfo }]
      : []),
    // Finalize controls live in FinalizeBar below TopBar (not inline in the feed).
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
              agentName={activeAgent?.name}
              onDequeue={isQueued ? handleDequeue : undefined}
              onEditQueued={isQueued ? handleEditQueuedMessage : undefined}
              onInterrupt={isQueued && isProcessing ? handleInterruptQueuedMessage : undefined}
              inFlightWhileStreaming={isQueued && isProcessing}
              fromAgent={activeAgent}
              agents={agents}
              sessionHandoffs={sessionHandoffs}
              onOpenSession={handleOpenHandoffSession}
            />
            {msg.role === 'assistant' && (
              <SessionTail
                message={msg}
                events={eventsByMessage[msg.id]}
                agentColor={activeAgent?.color}
                onEventsLoaded={handleEventsLoaded}
                onAskSubmit={handleAskSubmit}
                askSubmittedIds={askSubmitted}
                browserScreenshots={
                  (activeSessionId && browserScreensBySession[activeSessionId]?.[msg.id]) || {}
                }
              />
            )}
          </View>
        );
      }
      case 'thinking':
        return <ThinkingIndicator agentColor={activeAgent?.color} />;
      case 'streaming':
        return (
          <View>
            <StreamingMessage
              content={item.data.content}
              agentColor={activeAgent?.color}
              agentName={activeAgent?.name}
              engine={item.data.engine}
              onInterrupt={handleCancel}
            />
            {/* Parity with web (client/src/App.jsx): render a SessionTail for
                the live-streaming message so stream events like
                `ask_user_question` surface their picker in real time, rather
                than only appearing after `done` adds the assistant message to
                `messages`. */}
            {streamingMsgId && (
              <SessionTail
                message={{
                  id: streamingMsgId,
                  role: 'assistant',
                  engine: streamingEngine,
                  model: sessionModel,
                }}
                events={eventsByMessage[streamingMsgId]}
                agentColor={activeAgent?.color}
                streaming
                onEventsLoaded={handleEventsLoaded}
                onAskSubmit={handleAskSubmit}
                askSubmittedIds={askSubmitted}
                browserScreenshots={
                  (activeSessionId &&
                    browserScreensBySession[activeSessionId]?.[streamingMsgId]) ||
                  {}
                }
              />
            )}
          </View>
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
      case 'resolve-pr-banner':
        return (
          <ResolveSessionPrBanner
            sessionId={activeSessionId}
            prUrl={item.data.prUrl}
            prNumber={item.data.prNumber}
            branchLabel={pendingChanges?.branch}
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
      {activeSessionId ? (
        <FinalizeBar
          projectId={activeProject?.id}
          sessionId={activeSessionId}
          cardId={activeSession?.card_id ?? null}
          session={activeSession}
          sessionAgents={sessionAgents}
          hosted={activeProject?.gitHost === 'agenthub'}
          hasChanges={hasCommittableChanges}
          showViewChanges={shouldShowViewChanges(activeSession)}
          onViewChanges={() =>
            navigation.navigate('SessionChanges', {
              sessionId: activeSessionId,
              sessionName: activeSession?.name || '',
              projectId: activeProject?.id || null,
              cardId: activeSession?.card_id ?? null,
              hosted: activeProject?.gitHost === 'agenthub',
              session: activeSession || null,
            })
          }
          showFinalize={showFinalizeBar}
          status={finalize.status}
          phase={finalize.phase}
          phases={finalize.phases}
          run={finalize.run}
          onChanged={finalize.refetch}
        />
      ) : null}
      {activeSessionId ? (
        <SessionAgentsPanel
          sessionId={activeSessionId}
          sessionAgents={sessionAgents}
          maxTurns={activeSession?.max_turns}
          agents={agents}
          onUpdated={handleSessionAgentsUpdated}
        />
      ) : null}
      {pendingChanges && !workflowProject ? (
        <ChangesReadyBox
          sessionId={activeSessionId}
          changes={pendingChanges}
          onTrigger={triggerCreateTicketAndPr}
          onDismiss={dismissChangesReady}
          isSessionProcessing={isProcessing}
          shipFailureAt={shipFailureAt}
        />
      ) : null}
      {sessionRoundProcessing ? (
        <View style={styles.roundBanner}>
          <Text style={styles.roundBannerText}>Multi-agent round in progress…</Text>
        </View>
      ) : null}

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
          askMode={sessionAskMode}
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
  roundBanner: {
    backgroundColor: 'rgba(120, 53, 15, 0.25)',
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  roundBannerText: { color: colors.amber400 || '#fbbf24', fontSize: 12 },
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
