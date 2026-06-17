import React, { useState, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import AppIcon from './AppIcon';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { copyToClipboard } from '../utils/clipboard';
import { engineOptionsFromConfig, modelsForEngine, modelDisplay } from '../utils/engineOptions';
import ForwardSessionModal, { filterForwardTargets } from './ForwardSessionModal';
import SessionStateIcon from './SessionStateIcon';
import SessionEngineModelSheet from './SessionEngineModelSheet';
import { truncateSessionId } from '../utils/sessionId';

export default function TopBar() {
  const {
    activeAgent,
    sessionEngine,
    sessionModel,
    modelConfig,
    sessionAskMode,
    handleEngineChange,
    handleModelChange,
    activeSessionId,
    activeSessionState,
    agents,
    handleOpenHandoffSession,
  } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  const [showPicker, setShowPicker] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const canForward =
    !!activeSessionId && filterForwardTargets(agents || [], activeAgent).length > 0;

  const handleSummarize = async () => {
    if (!activeSessionId || summarizing) return;
    setSummarizing(true);
    try {
      const { summary } = await api.summarizeSession(activeSessionId);
      if (!summary) throw new Error('Empty summary returned');
      const copied = await copyToClipboard(summary);
      Alert.alert(
        copied ? 'Summary copied' : 'Summary ready',
        summary,
        [{ text: 'OK' }],
      );
    } catch (err) {
      Alert.alert('Summary failed', err?.message || 'Unknown error');
    } finally {
      setSummarizing(false);
    }
  };

  const handleCopySessionId = async () => {
    if (!activeSessionId) return;
    const copied = await copyToClipboard(activeSessionId);
    Alert.alert(copied ? 'Session id copied' : 'Session id', activeSessionId);
  };

  const engineOptions = engineOptionsFromConfig(modelConfig);
  const currentEngine = engineOptions.find((e) => e.id === sessionEngine) || engineOptions[0];
  const engineModels = modelsForEngine(sessionEngine, modelConfig);
  const currentModel =
    engineModels.find((m) => m.id === sessionModel) ||
    engineModels[0] ||
    modelDisplay(sessionModel || 'unknown-model');
  return (
    <View style={styles.container}>
      <View style={styles.left}>
        <TouchableOpacity
          style={styles.menuButton}
          onPress={openSidebar}
        >
          <AppIcon name="menu" size={24} color={colors.gray400} />
        </TouchableOpacity>
        {activeAgent && (
          <View style={styles.agentInfo}>
            <View style={[styles.agentDot, { backgroundColor: activeAgent.color }]} />
            {activeSessionId ? (
              <SessionStateIcon
                state={activeSessionState}
                size={14}
                testID="topbar-session-state-icon"
              />
            ) : null}
            <View style={styles.agentText}>
              <Text style={styles.agentName} numberOfLines={1}>
                {activeAgent.name}
              </Text>
              {activeSessionId ? (
                <TouchableOpacity
                  onPress={handleCopySessionId}
                  accessibilityRole="button"
                  accessibilityLabel={`Copy session id ${activeSessionId}`}
                  style={styles.sessionIdBadge}
                >
                  <Text style={styles.sessionIdLabel} numberOfLines={1}>
                    Session
                  </Text>
                  <Text style={styles.sessionIdText} numberOfLines={1}>
                    {truncateSessionId(activeSessionId)}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        )}
      </View>

      <View style={styles.right}>
        {/* Ask-mode badge — only when read-only mode is active */}
        {activeAgent && sessionAskMode && (
          <TouchableOpacity
            onPress={() => setShowPicker(true)}
            accessibilityRole="button"
            accessibilityLabel="Ask mode on — read-only, no file changes or commands"
            style={styles.askBadge}
          >
            <Text style={styles.askBadgeText}>Ask</Text>
          </TouchableOpacity>
        )}

        {/* Engine + Model button */}
        {activeAgent && (
          <TouchableOpacity
            style={styles.engineButton}
            onPress={() => setShowPicker(true)}
          >
            <View style={[styles.engineDotSmall, { backgroundColor: currentEngine.color }]} />
            <Text style={styles.engineLabel}>{currentModel.short}</Text>
            <AppIcon name="chevron-down" size={12} color={colors.gray500} />
          </TouchableOpacity>
        )}

        {/* Forward session to another agent in the same project */}
        {activeAgent && activeSessionId && (
          <TouchableOpacity
            style={styles.newButton}
            onPress={() => setShowForward(true)}
            disabled={!canForward}
            accessibilityRole="button"
            accessibilityLabel="Forward session to another agent"
          >
            <AppIcon
              name="arrow-redo-outline"
              size={18}
              color={canForward ? colors.white : colors.gray500}
            />
          </TouchableOpacity>
        )}

        {/* Summarize current session — disabled when no session or mid-request */}
        {activeAgent && (
          <TouchableOpacity
            style={styles.newButton}
            onPress={handleSummarize}
            disabled={!activeSessionId || summarizing}
            accessibilityRole="button"
            accessibilityLabel="Summarize session and copy to clipboard"
          >
            {summarizing ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <AppIcon
                name="document-text-outline"
                size={18}
                color={activeSessionId ? colors.white : colors.gray500}
              />
            )}
          </TouchableOpacity>
        )}

      </View>

      {/* Forward Session Modal */}
      <ForwardSessionModal
        visible={showForward}
        sourceAgent={activeAgent}
        agents={agents || []}
        sessionId={activeSessionId}
        onClose={() => setShowForward(false)}
        onForward={({ targetAgentId, prompt, autoStart }) =>
          api.forwardSession(activeSessionId, { targetAgentId, prompt, autoStart })
        }
        onForwarded={(result) => {
          const session = result?.session;
          if (!session) return;
          // Reuse the handoff-open path: flips activeAgent + activeSession,
          // stashing targetSessionId in pendingSessionIdRef so the sessions
          // loader honors it instead of clobbering with data[0].id.
          if (typeof handleOpenHandoffSession === 'function') {
            handleOpenHandoffSession(session.agent_id, session.id);
          }
        }}
        onError={(msg) =>
          Alert.alert('Forward failed', msg)
        }
      />

      {/* Engine/Model Picker Sheet — per-session; persists via
          api.setSessionEngine / api.setSessionModel inside the context
          handlers and Alerts on failure. */}
      <SessionEngineModelSheet
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        modelConfig={modelConfig}
        engine={sessionEngine}
        model={sessionModel}
        onSelectEngine={handleEngineChange}
        onSelectModel={handleModelChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900 + '80',
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  menuButton: {
    padding: 8,
    marginRight: 4,
  },
  agentInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  agentDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  agentName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
  },
  agentText: {
    flex: 1,
    minWidth: 0,
  },
  sessionIdBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    marginTop: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  sessionIdLabel: {
    flexShrink: 0,
    marginRight: 4,
    fontSize: 10,
    color: colors.gray500,
  },
  sessionIdText: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 10,
    color: colors.gray300,
    fontFamily: 'monospace',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  engineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  engineDotSmall: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  engineLabel: {
    fontSize: 12,
    color: colors.gray300,
  },
  newButton: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    padding: 6,
  },
  // Picker modal styles moved to SessionEngineModelSheet.js.
  // Worktree detection badge (header)
  worktreeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  worktreeBadgeOk: {
    backgroundColor: colors.emerald900_40,
    borderColor: colors.emerald900_50,
  },
  worktreeBadgeWarn: {
    backgroundColor: colors.amber900_40,
    borderColor: colors.amber400,
  },
  worktreeBadgeOff: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray700,
  },
  worktreeBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  worktreeBadgeTextOk: { color: colors.emerald400 },
  worktreeBadgeTextWarn: { color: colors.amber400 },
  worktreeBadgeTextOff: { color: colors.gray500 },
  // Worktree hint (inside modal)
  worktreeHint: {
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginHorizontal: 8,
    marginBottom: 4,
    borderRadius: 4,
  },
  worktreeHintOk: {
    color: colors.emerald400,
    backgroundColor: colors.emerald900_40,
  },
  worktreeHintWarn: {
    color: colors.amber400,
    backgroundColor: colors.amber900_40,
  },
  worktreeHintOff: {
    color: colors.gray500,
    backgroundColor: colors.gray800,
  },
  // Ask-mode badge (header — only shown when read-only mode is on)
  askBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: colors.blue900_40,
    borderColor: colors.blue400,
  },
  askBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.blue400,
  },
});
