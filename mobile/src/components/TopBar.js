import React, { useState, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  Pressable,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { SidebarContext } from '../context/SidebarContext';
import { getApiBaseUrl, getWsUrl } from '../utils/config';
import { getActiveOrg } from '../utils/orgs';
// Worktree toggle + detection-badge imports were removed when Agent Hub
// locked to worktree-only sessions. `isWorkflowProject` no longer
// influences this component.
import { api } from '../utils/api';
import { copyToClipboard } from '../utils/clipboard';
import { engineOptionsFromConfig, modelsForEngine, modelDisplay } from '../utils/engineOptions';
import BugReportButton from './BugReportButton';
import ForwardSessionModal, { filterForwardTargets } from './ForwardSessionModal';
import SessionStateIcon from './SessionStateIcon';

export default function TopBar({ projectId, agentId } = {}) {
  const {
    activeAgent,
    activeAgentId,
    projects,
    connected,
    reconnecting,
    sessionEngine,
    sessionModel,
    modelConfig,
    sessionAskMode,
    handleAskModeChange,
    handleEngineChange,
    handleModelChange,
    handleNewSession,
    activeSessionId,
    activeSessionState,
    agents,
    handleOpenHandoffSession,
  } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  // Prefer explicit props, fall back to the active agent from context.
  const effectiveAgentId = agentId || activeAgentId || activeAgent?.id || '';
  const effectiveProjectId = projectId || activeAgent?.projectId || '';
  const activeProject = projects?.find((p) => p.id === effectiveProjectId);
  // `workflowProject` was used to hide the worktree toggle when the
  // project was in workflow mode; the toggle itself was removed when
  // Agent Hub locked to worktree-only sessions.

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
          <Ionicons name="menu" size={24} color={colors.gray400} />
        </TouchableOpacity>
        <BugReportButton
          projectId={effectiveProjectId}
          agentId={effectiveAgentId}
          sourceUrl={activeAgent?.name ? `agent:${activeAgent.name}` : ''}
        />
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
                    {activeSessionId}
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
            <Ionicons name="chevron-down" size={12} color={colors.gray500} />
          </TouchableOpacity>
        )}

        {/* Connection status — long-press for diagnostics */}
        <Pressable
          onLongPress={() => {
            const org = getActiveOrg();
            const apiUrl = getApiBaseUrl();
            const wsUrl = getWsUrl();
            Alert.alert(
              'Connection Info',
              `Org: ${org?.name || '(none)'}\n` +
              `URL: ${org?.remoteUrl || '(not set)'}\n` +
              `API: ${apiUrl || '(empty)'}\n` +
              `WS: ${wsUrl ? wsUrl.replace(/apiKey=[^&]+/, 'apiKey=***') : '(empty)'}\n` +
              `Key: ${org?.apiKey ? `${org.apiKey.slice(0, 5)}...${org.apiKey.slice(-4)}` : '(none)'}\n` +
              `Status: ${connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Disconnected'}`,
            );
          }}
          style={[
            styles.statusBadge,
            connected
              ? styles.statusConnected
              : reconnecting
              ? styles.statusReconnecting
              : styles.statusDisconnected,
          ]}
        >
          <Text
            style={[
              styles.statusDot,
              connected
                ? styles.statusDotConnected
                : reconnecting
                ? styles.statusDotReconnecting
                : styles.statusDotDisconnected,
            ]}
          >
            ●
          </Text>
        </Pressable>

        {/* Forward session to another agent in the same project */}
        {activeAgent && activeSessionId && (
          <TouchableOpacity
            style={styles.newButton}
            onPress={() => setShowForward(true)}
            disabled={!canForward}
            accessibilityRole="button"
            accessibilityLabel="Forward session to another agent"
          >
            <Ionicons
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
              <Ionicons
                name="document-text-outline"
                size={18}
                color={activeSessionId ? colors.white : colors.gray500}
              />
            )}
          </TouchableOpacity>
        )}

        {/* New session */}
        <TouchableOpacity
          style={styles.newButton}
          onPress={handleNewSession}
          disabled={!activeAgent}
        >
          <Ionicons name="add" size={20} color={colors.white} />
        </TouchableOpacity>
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

      {/* Engine/Model Picker Modal */}
      <Modal
        visible={showPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowPicker(false)}>
          <View style={styles.pickerContainer}>
            {/* Engine section */}
            <Text style={styles.pickerSectionLabel}>ENGINE</Text>
            {engineOptions.map((eng) => (
              <TouchableOpacity
                key={eng.id}
                style={styles.pickerItem}
                onPress={() => {
                  handleEngineChange(eng.id);
                  setShowPicker(false);
                }}
              >
                <View style={styles.pickerItemRow}>
                  <View style={[styles.engineDotSmall, { backgroundColor: eng.color }]} />
                  <Text style={styles.pickerItemLabel}>{eng.label}</Text>
                </View>
                {eng.id === sessionEngine && (
                  <Text style={styles.pickerCheck}>✓</Text>
                )}
              </TouchableOpacity>
            ))}

            <View style={styles.pickerDivider} />

            {/* Mode section — Ask (read-only) vs Agent (full access) */}
            <Text style={styles.pickerSectionLabel}>MODE</Text>
            <TouchableOpacity
              style={styles.pickerItem}
              onPress={() => {
                handleAskModeChange(!sessionAskMode);
                setShowPicker(false);
              }}
              accessibilityRole="switch"
              accessibilityState={{ checked: sessionAskMode }}
              accessibilityLabel={
                sessionAskMode
                  ? 'Ask mode on — toggle to agent (full access)'
                  : 'Ask mode off — toggle to read-only'
              }
            >
              <Text
                style={[
                  styles.pickerItemLabel,
                  sessionAskMode && styles.pickerItemLabelAsk,
                ]}
              >
                {sessionAskMode ? 'Ask (read-only)' : 'Agent (full access)'}
              </Text>
              {sessionAskMode && <Text style={styles.pickerCheckAsk}>✓</Text>}
            </TouchableOpacity>

            <View style={styles.pickerDivider} />

            {/* Model section */}
            <Text style={styles.pickerSectionLabel}>MODEL</Text>
            {engineModels.map((m) => (
              <TouchableOpacity
                key={m.id}
                style={styles.pickerItem}
                onPress={() => {
                  handleModelChange(m.id);
                  setShowPicker(false);
                }}
              >
                <Text
                  style={[
                    styles.pickerItemLabel,
                    m.id === sessionModel && styles.pickerItemLabelActive,
                  ]}
                >
                  {m.label}
                </Text>
                {m.id === sessionModel && (
                  <Text style={styles.pickerCheck}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
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
  statusBadge: {
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusConnected: {
    backgroundColor: colors.emerald900_50,
  },
  statusReconnecting: {
    backgroundColor: colors.yellow900_50,
  },
  statusDisconnected: {
    backgroundColor: colors.red900_50,
  },
  statusDot: {
    fontSize: 10,
  },
  statusDotConnected: {
    color: colors.emerald400,
  },
  statusDotReconnecting: {
    color: colors.yellow400,
  },
  statusDotDisconnected: {
    color: colors.red400,
  },
  newButton: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    padding: 6,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.black50,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 100,
    paddingRight: 16,
  },
  pickerContainer: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 12,
    minWidth: 220,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  pickerSectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray500,
    letterSpacing: 0.5,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pickerItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 44,
  },
  pickerItemLabel: {
    fontSize: 14,
    color: colors.gray400,
  },
  pickerItemLabelActive: {
    color: colors.white,
  },
  pickerItemLabelAsk: {
    color: colors.blue400,
  },
  pickerCheck: {
    fontSize: 12,
    color: colors.emerald400,
  },
  pickerCheckAsk: {
    fontSize: 12,
    color: colors.blue400,
  },
  pickerDivider: {
    height: 1,
    backgroundColor: colors.gray700,
    marginVertical: 4,
  },
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
