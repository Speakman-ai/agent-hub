import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Alert,
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
import SessionEngineModelSheet from '../components/SessionEngineModelSheet';
import AgentSwitcher from '../components/AgentSwitcher';
import DelegationPanel from '../components/DelegationPanel';
import SessionTail from '../components/SessionTail';
// FinalizeBar — single action row (Summary, View changes, Build, Finalize, Push).
import SessionAgentsPanel from '../components/SessionAgentsPanel';
import ChangesReadyBox from '../components/ChangesReadyBox';
import FinalizeBar from '../components/FinalizeBar';
import SessionDesignFilesPanel from '../components/SessionDesignFilesPanel';
import SessionArtifactsPanel from '../components/SessionArtifactsPanel';
import SessionTimelinePanel from '../components/SessionTimelinePanel';
import MobileTerminalPane from '../components/MobileTerminalPane';
import { ChevronDown, History, SquareTerminal } from 'lucide-react-native';
import { useFinalizeRunPoll } from '../hooks/useFinalizeRunPoll';
import { useSessionCommittable } from '../hooks/useSessionCommittable';
import { isWorkflowProject } from '../utils/project-mode';
import ResolveSessionPrBanner from '../components/ResolveSessionPrBanner';
import { shouldShowViewChanges } from '../utils/sessionExtras';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
  parseResolvePrNumberFromTitle,
} from '@shared/utils/sessionTitlePr';
import { latestSessionEnvLaunchStatus } from '@shared/utils/sessionEnvLaunch';
import { resolveLiveStreamIdentity } from '@shared/utils/activeTaskSnapshot';
import { HUB_ASSISTANT_AGENT_ID } from '@shared/utils/hub';
export default function ChatScreen({
  embedded = false,
  composePrefix = '',
  emptyHint,
  onClearChat,
}: {
  embedded?: boolean;
  composePrefix?: string;
  emptyHint?: string;
  onClearChat?: () => void;
} = {}) {
  const {
    agents,
    activeAgent,
    activeAgentId,
    setActiveAgentId,
    messages,
    thinking,
    streamingContent,
    streamingEngine,
    streamingAgent,
    streamingMsgId,
    sessionModel,
    sessionEngine,
    sessionReasoningEffort,
    modelConfig,
    persistHubModel,
    handleReasoningEffortChange,
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
    sessionConsultMode,
    askSubmitted,
    handleAskSubmit,
    handleCredentialSubmit,
    reloadMessages,
    sessionAgents,
    sessionRoundProcessing,
    handleSessionAgentsUpdated,
    sessions,
    artifactReloadBySession,
    presentedArtifactBySession,
    acknowledgePresentedArtifact,
    hubSessionId,
  } = useApp();
  // NOTE: `activeSession` is declared once below (useMemo) — a duplicate
  // plain declaration here previously made this module fail to parse.
  const navigation = useNavigation<any>();
  const flatListRef = useRef<any>(null);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showHubModelPicker, setShowHubModelPicker] = useState(false);
  const [selectedTimelineAnchor, setSelectedTimelineAnchor] = useState<string | null>(null);
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
  const queuedIds = new Set((messageQueues[activeSessionId] || []).map((q: any) => q.id));
  const activeDelegation = delegations[activeSessionId];
  const pendingChanges = changesReady?.[activeSessionId];
  const activeProject = projects?.find((p: any) => p.id === activeAgent?.projectId);
  const workflowProject = isWorkflowProject(activeProject);
  const activeSession = useMemo<any>(
    () => sessions?.find((s: any) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const hubSession = embedded || activeSession?.session_mode === 'hub';
  const consultLike = sessionConsultMode || activeSession?.session_mode === 'consult' || hubSession;
  // In the embedded Hub assistant tab, only send once the live Hub session is
  // the active one. Before HubScreen's GET resolves (or if it failed) the
  // active session may still be a restored project row — never post there.
  const hubComposerLocked = embedded && (!hubSessionId || activeSessionId !== hubSessionId);
  const sendChat = useCallback(
    (content: any, images: any = [], opts: any = {}) => {
      if (hubComposerLocked) return;
      // In the embedded Hub tab, bind the turn to the canonical Hub identity —
      // `__hub_assistant__` + the live Hub session — never the shared
      // activeAgentId/activeSessionId, which init/restore can leave on a
      // project agent (the server spawns from the message's agentId).
      const merged = embedded
        ? { ...opts, agentId: HUB_ASSISTANT_AGENT_ID, sessionId: hubSessionId }
        : opts;
      if (composePrefix) {
        const body = typeof content === 'string' ? content : String(content || '');
        return handleSend(
          [composePrefix, body.trim()].filter(Boolean).join('\n\n'),
          images,
          merged,
        );
      }
      return handleSend(content, images, merged);
    },
    [composePrefix, handleSend, hubComposerLocked, embedded, hubSessionId],
  );
  useEffect(() => {
    if (!activeSessionId) {
      setShowTerminal(false);
      setShowTimeline(false);
      setShowActions(false);
      setSelectedTimelineAnchor(null);
    }
  }, [activeSessionId]);
  const activeResolvePrBannerInfo = useMemo<any>(() => {
    if (!activeSession?.name || !isResolvePrSessionTitle(activeSession.name)) return null;
    return {
      prUrl: inferPrUrlFromSessionTitle(activeSession.name, activeProject?.githubRepo, {
        gitHost: activeProject?.gitHost ?? null,
        projectId: activeProject?.id ?? null,
      }),
      prNumber: parseResolvePrNumberFromTitle(activeSession.name),
    };
  }, [activeSession, activeProject]);
  const openNativePrDetail = useCallback(
    (projectId: any, prNumber: any) => {
      if (!projectId) return;
      navigation.navigate('PullRequests', {
        projectId,
        project: projects?.find((p: any) => p.id === projectId) ?? undefined,
        prNumber: prNumber ?? undefined,
      });
    },
    [navigation, projects],
  );
  const showFinalizeBar = Boolean(activeSessionId && activeProject?.id);
  const finalize = useFinalizeRunPoll(activeSessionId, {
    enabled: showFinalizeBar && !workflowProject,
  });
  const hasCommittableChanges = useSessionCommittable(activeSessionId, { pendingChanges });
  const liveStream = resolveLiveStreamIdentity({
    streamingAgent,
    streamingEngine,
    sessionAgentName: activeAgent?.name,
    sessionAgentColor: activeAgent?.color,
    sessionModel,
  });
  // Build list data: messages + thinking + streaming indicators
  const listData = [
    ...messages.map((msg: any) => ({ type: 'message', key: msg.id, data: msg })),
    ...(thinking ? [{ type: 'thinking', key: 'thinking' }] : []),
    ...(streamingContent
      ? [
          {
            type: 'streaming',
            key: 'streaming',
            data: { content: streamingContent, engine: liveStream.engine },
          },
        ]
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
  const renderItem = ({ item }: any) => {
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
                onCredentialSubmit={handleCredentialSubmit}
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
        return (
          <ThinkingIndicator
            agentColor={liveStream.agentColor}
            statusText={
              latestSessionEnvLaunchStatus(
                streamingMsgId ? eventsByMessage[streamingMsgId] : undefined,
              ) === 'started'
                ? 'Launching session VM…'
                : undefined
            }
          />
        );
      case 'streaming':
        return (
          <View>
            <StreamingMessage
              content={item.data.content}
              agentColor={liveStream.agentColor}
              agentName={liveStream.agentName}
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
                  session_id: activeSessionId,
                  role: 'assistant',
                  engine: liveStream.engine,
                  model: liveStream.model,
                  agent_name: liveStream.agentName,
                }}
                events={eventsByMessage[streamingMsgId]}
                agentColor={liveStream.agentColor}
                streaming
                onEventsLoaded={handleEventsLoaded}
                onAskSubmit={handleAskSubmit}
                onCredentialSubmit={handleCredentialSubmit}
                askSubmittedIds={askSubmitted}
                browserScreenshots={
                  (activeSessionId && browserScreensBySession[activeSessionId]?.[streamingMsgId]) ||
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
            onOpenPrDetail={openNativePrDetail}
          />
        );
      default:
        return null;
    }
  };
  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyTitle}>{hubSession ? 'Ask Hub' : 'Start a conversation'}</Text>
      {activeAgent && !hubSession ? (
        <Text style={styles.emptySubtitle}>with {activeAgent.name}</Text>
      ) : null}
      <Text style={styles.emptyHint}>
        {emptyHint
          ? emptyHint
          : hubSession
            ? 'What to focus on next, kick off an agent, or configure Agent Hub.'
            : 'Tap the menu to switch agents'}
      </Text>
    </View>
  );
  return (
    <SafeAreaView style={styles.container} edges={embedded ? ['bottom'] : ['top', 'bottom']}>
      {embedded ? null : <TopBar />}
      {hubSession && onClearChat ? (
        <TouchableOpacity
          testID="hub-clear-chat"
          onPress={() => {
            Alert.alert('Clear this Hub chat?', 'History is archived for a day.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Clear', style: 'destructive', onPress: onClearChat },
            ]);
          }}
          style={styles.clearButton}
        >
          <Text style={styles.clearLabel}>Clear chat</Text>
        </TouchableOpacity>
      ) : null}
      {activeSessionId && !hubSession ? (
        <FinalizeBar
          projectId={activeProject?.id}
          project={activeProject}
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
      {activeSessionId && activeSession?.session_mode === 'design' ? (
        <SessionDesignFilesPanel
          sessionId={activeSessionId}
          reloadNonce={isProcessing ? 0 : messages.length}
        />
      ) : null}
      {activeSessionId && !hubSession ? (
        <SessionArtifactsPanel
          sessionId={activeSessionId}
          reloadNonce={artifactReloadBySession?.[activeSessionId] || 0}
          presentedArtifact={presentedArtifactBySession?.[activeSessionId] || null}
          onPresentedArtifact={acknowledgePresentedArtifact}
        />
      ) : null}
      {activeSessionId && !hubSession ? (
        <SessionAgentsPanel
          sessionId={activeSessionId}
          sessionAgents={sessionAgents}
          maxTurns={activeSession?.max_turns}
          agents={agents}
          onUpdated={handleSessionAgentsUpdated}
        />
      ) : null}
      {activeSessionId && !hubSession ? (
        <>
          <View style={styles.terminalToggleRow}>
            <TouchableOpacity
              testID="toggle-mobile-actions"
              accessibilityRole="button"
              accessibilityState={{ expanded: showActions }}
              onPress={() => setShowActions((open) => !open)}
              style={[styles.terminalToggle, showActions && styles.timelineToggleActive]}
            >
              <ChevronDown size={14} color={showActions ? colors.gray200 : colors.gray300} />
              <Text style={styles.terminalToggleText}>Actions</Text>
            </TouchableOpacity>
          </View>
          {showActions ? (
            <View style={styles.actionsMenu} testID="mobile-session-actions-menu">
              <TouchableOpacity
                testID="toggle-mobile-timeline"
                accessibilityRole="button"
                accessibilityState={{ expanded: showTimeline }}
                onPress={() => setShowTimeline((open) => !open)}
                style={[styles.actionRow, showTimeline && styles.actionRowActive]}
              >
                <History size={14} color={showTimeline ? colors.gray200 : colors.gray300} />
                <Text style={styles.terminalToggleText}>
                  {showTimeline ? 'Hide timeline' : 'Timeline'}
                </Text>
              </TouchableOpacity>
              {activeSession?.session_mode !== 'consult' && !hubSession ? (
                <TouchableOpacity
                  testID="toggle-mobile-terminal"
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showTerminal }}
                  onPress={() => setShowTerminal((open) => !open)}
                  style={[styles.actionRow, showTerminal && styles.actionRowActive]}
                >
                  <SquareTerminal
                    size={14}
                    color={showTerminal ? colors.teal300 : colors.gray300}
                  />
                  <Text style={styles.terminalToggleText}>
                    {showTerminal ? 'Hide terminal' : 'Open terminal'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
          {showTimeline ? (
            <SessionTimelinePanel
              messages={messages}
              selectedAnchorId={selectedTimelineAnchor}
              onSelect={(marker) => {
                setSelectedTimelineAnchor(marker.anchorId);
                const idx = messages.findIndex((m: any) => m.id === marker.messageId);
                if (idx >= 0) {
                  flatListRef.current?.scrollToIndex?.({
                    index: idx,
                    animated: true,
                    viewPosition: 0.25,
                  });
                }
              }}
            />
          ) : null}
          {showTerminal && !consultLike ? (
            <MobileTerminalPane
              sessionId={activeSessionId}
              onClose={() => setShowTerminal(false)}
            />
          ) : null}
        </>
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
          keyExtractor={(item: any) => item.key}
          ListEmptyComponent={!thinking && !streamingContent ? renderEmpty : null}
          contentContainerStyle={
            listData.length === 0 ? styles.emptyListContent : styles.listContent
          }
          showsVerticalScrollIndicator={false}
          onScrollToIndexFailed={() => undefined}
          onContentSizeChange={() => {
            if (listData.length > 0) {
              flatListRef.current?.scrollToEnd({ animated: false });
            }
          }}
        />

        {/* Input */}
        <MessageInput
          onSend={sendChat}
          onCancel={handleCancel}
          disabled={!activeAgentId || !connected || isProcessing || hubComposerLocked}
          isProcessing={isProcessing}
          agentColor={activeAgent?.color}
          skills={skills}
          queueLength={(messageQueues[activeSessionId] || []).length}
          consultMode={consultLike}
          consultHint={
            hubSession ? 'Hub assistant — org & account help, no code ship or Finalize' : null
          }
          toolbarStart={
            hubSession ? (
              <TouchableOpacity
                testID="hub-model-picker"
                onPress={() => setShowHubModelPicker(true)}
                style={styles.hubModelChip}
                accessibilityLabel="Hub model"
              >
                <Text style={styles.hubModelLabel} numberOfLines={1}>
                  {sessionModel || 'Model'}
                </Text>
              </TouchableOpacity>
            ) : null
          }
        />
        {hubSession ? (
          <SessionEngineModelSheet
            visible={showHubModelPicker}
            onClose={() => setShowHubModelPicker(false)}
            modelConfig={modelConfig}
            engine={sessionEngine}
            model={sessionModel}
            reasoningEffort={sessionReasoningEffort}
            onSelectEngine={(engine: string) => {
              // Never fall back to the previous engine's model — a cross-engine
              // model is invalid for `engine` and the server would 400 it. Skip
              // the persist when the new engine has no resolvable default.
              const next =
                modelConfig?.engineDefaultModels?.[engine] ||
                modelConfig?.engineValidModels?.[engine]?.[0] ||
                '';
              if (!next) return;
              void persistHubModel(engine, next);
            }}
            onSelectModel={(model: string) => {
              void persistHubModel(sessionEngine, model);
            }}
            onSelectReasoningEffort={handleReasoningEffortChange}
          />
        ) : null}
      </KeyboardAvoidingView>

      {/* Agent Switcher Modal */}
      <AgentSwitcher
        visible={showSwitcher}
        agents={agents}
        onSelect={(id: any) => setActiveAgentId(id)}
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
  terminalToggleRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  terminalToggle: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: colors.gray900,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  terminalToggleActive: {
    borderColor: colors.teal500,
    backgroundColor: colors.teal900_30,
  },
  timelineToggleActive: {
    borderColor: colors.gray500,
    backgroundColor: colors.gray800,
  },
  actionsMenu: {
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 4,
    backgroundColor: colors.gray950,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
  },
  actionRowActive: {
    backgroundColor: colors.gray800,
  },
  terminalToggleText: { color: colors.gray200, fontSize: 12 },
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
  clearButton: {
    alignSelf: 'flex-end',
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  clearLabel: { color: colors.gray300, fontSize: 12, fontWeight: '600' },
  hubModelChip: {
    alignSelf: 'flex-start',
    maxWidth: 220,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  hubModelLabel: { color: colors.gray200, fontSize: 12, fontWeight: '500' },
});
