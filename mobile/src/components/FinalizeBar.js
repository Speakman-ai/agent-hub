/**
 * FinalizeBar — single chat action row (Summary, View changes, Build, Finalize, Push).
 *
 * Mirrors the web/mobile reference layout: one horizontal strip directly under
 * TopBar. Voice input lives in MessageInput, not here.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Modal,
  Pressable,
  ScrollView,
} from 'react-native';
import AppIcon from './AppIcon';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import SessionModePicker from './SessionModePicker';
import SessionSummarySheet from './SessionSummarySheet';
import {
  FINALIZE_AUTOMATION_OPTIONS,
  finalizeAutomationLabel,
  deriveSessionFinalizeMode,
} from '../utils/finalizeAutomation';
import { deriveFinalizeButton, canPush, isFullyValidated } from '../utils/finalizeView';
import { describeRunPhase } from '../utils/finalizeRun';

const PURPLE = '#7C3AED';

export default function FinalizeBar({
  projectId,
  sessionId,
  cardId,
  session,
  sessionAgents = [],
  hosted = false,
  hasChanges = true,
  showViewChanges = true,
  onViewChanges,
  showFinalize = true,
  status,
  phase,
  phases,
  run,
  onChanged,
  onError,
}) {
  const [showSummary, setShowSummary] = useState(false);
  const [automation, setAutomation] = useState(() => deriveSessionFinalizeMode(session).automation);
  const [askMode, setAskMode] = useState(() => deriveSessionFinalizeMode(session).askMode);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false); // finalize/cancel in flight (optimistic)
  const [pushing, setPushing] = useState(false);
  // Optimistic `session_mode` (chat | design) for the segmented picker, synced
  // from the session row below. The server broadcasts a `session-updated` event
  // on change so the context row (and the design-files panel keyed off it) also
  // updates — the optimistic copy just keeps the toggle snappy.
  const [mode, setMode] = useState(() =>
    session?.session_mode === 'design' ? 'design' : 'chat',
  );

  // Re-sync the dropdown from the session whenever the session changes (the bar
  // is reused across sessions) or these fields change (e.g. session arrived
  // null and loaded later, or another surface updated the mode). Without this,
  // the bar can display and mutate a previous/default mode — and a stale
  // `askMode === false` would skip disabling Ask mode on the server when
  // switching to a non-ask automation, stranding the session in Ask mode.
  useEffect(() => {
    const next = deriveSessionFinalizeMode(session);
    setAutomation(next.automation);
    setAskMode(next.askMode);
    setMode(session?.session_mode === 'design' ? 'design' : 'chat');
    // Keyed on the session id + the fields the bar mirrors; intentionally
    // not the whole session object, so unrelated session updates don't clobber
    // an in-flight optimistic selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.finalize_automation, session?.ask_mode, session?.session_mode]);

  const canDesignMode = !!session?.can_design_mode;
  const [modeBusy, setModeBusy] = useState(false);

  const selectMode = useCallback(
    async (next) => {
      if (!sessionId || modeBusy || next === mode) return;
      const prev = mode;
      setMode(next); // optimistic
      setModeBusy(true);
      try {
        await api.setSessionMode(sessionId, next);
        // The server broadcasts `session-updated`; the context row + the
        // design-files panel update from that. Also nudge the finalize poll.
        onChanged?.();
      } catch (err) {
        setMode(prev); // revert on failure
        reportError(err?.message || 'Failed to switch session mode');
      } finally {
        setModeBusy(false);
      }
    },
    // reportError is defined below; stable via useCallback. Listed to satisfy lint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, mode, modeBusy, onChanged],
  );

  const fullyValidated = isFullyValidated(phases);
  const btn = deriveFinalizeButton({ status, fullyValidated, hasChanges });
  const pushEnabled = canPush({ status, hasChanges }) && !!run?.id;
  const pushLabel = 'Push';

  const dropdownLabel = askMode ? 'Ask' : finalizeAutomationLabel(automation);

  const reportError = useCallback(
    (msg) => {
      if (onError) onError(msg);
      else Alert.alert('Runner', msg);
    },
    [onError],
  );

  const selectAutomation = useCallback(
    async (value) => {
      setMenuOpen(false);
      const current = askMode ? 'ask' : automation;
      if (!sessionId || value === current) return;
      try {
        if (value === 'ask') {
          await api.setSessionAskMode(sessionId, true);
          setAskMode(true);
        } else {
          if (askMode) {
            await api.setSessionAskMode(sessionId, false);
            setAskMode(false);
          }
          await api.updateSession(sessionId, { finalize_automation: value });
          setAutomation(value);
        }
        onChanged?.();
      } catch (err) {
        reportError(err?.message || 'Failed to update session mode');
      }
    },
    [sessionId, automation, askMode, onChanged, reportError],
  );

  const handleFinalize = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (btn.inFlight) {
        if (run?.id) await api.cancelFinalizeRun(projectId, run.id);
      } else if (cardId) {
        await api.startFinalizeRun(projectId, cardId);
      } else {
        await api.startFinalizeRunForSession(projectId, sessionId);
      }
      await onChanged?.();
    } catch (err) {
      reportError(err?.message || 'Failed to start runner');
    } finally {
      setBusy(false);
    }
  }, [busy, btn.inFlight, run?.id, cardId, projectId, sessionId, onChanged, reportError]);

  const doPush = useCallback(
    async (force) => {
      if (!run?.id) return;
      setPushing(true);
      try {
        await api.pushFinalizeRun(projectId, run.id, { force });
        await onChanged?.();
      } catch (err) {
        reportError(err?.message || 'Failed to push');
      } finally {
        setPushing(false);
      }
    },
    [run?.id, projectId, onChanged, reportError],
  );

  const handlePush = useCallback(() => {
    if (!pushEnabled || pushing) return;
    if (fullyValidated) {
      doPush(false);
    } else {
      Alert.alert(
        pushLabel,
        'Review and checks have not both passed. Push the branch and open a PR anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Push anyway', style: 'destructive', onPress: () => doPush(true) },
        ],
      );
    }
  }, [pushEnabled, pushing, fullyValidated, pushLabel, doPush]);

  return (
    <View style={styles.bar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {sessionId ? (
          <SessionModePicker
            mode={mode}
            canDesign={canDesignMode}
            disabled={modeBusy}
            onChange={selectMode}
          />
        ) : null}

        <TouchableOpacity
          style={styles.outlineBtn}
          onPress={() => setShowSummary(true)}
          accessibilityRole="button"
          accessibilityLabel="Open session summary"
        >
          <AppIcon name="information-circle-outline" size={12} color={colors.gray400} />
          <Text style={styles.outlineBtnText}>Summary</Text>
        </TouchableOpacity>

        {showViewChanges && typeof onViewChanges === 'function' && (
          <TouchableOpacity
            style={styles.outlineBtn}
            onPress={onViewChanges}
            accessibilityRole="button"
            accessibilityLabel="View code changes for this session"
          >
            <AppIcon name="git-compare-outline" size={12} color={colors.gray400} />
            <Text style={styles.outlineBtnText}>Changes</Text>
          </TouchableOpacity>
        )}

        {showFinalize && projectId ? (
          <>
            {/* Build dropdown */}
            <TouchableOpacity
              style={styles.dropdown}
              onPress={() => setMenuOpen(true)}
              disabled={!sessionId}
              testID="finalize-automation-select"
            >
              <Text style={styles.dropdownText} numberOfLines={1}>
                {dropdownLabel}
              </Text>
              <AppIcon name="chevron-down" size={12} color={colors.gray400} />
            </TouchableOpacity>

            {/* Finalize / Stop */}
            <TouchableOpacity
              style={[
                styles.finalizeBtn,
                btn.tone === 'busy' && styles.finalizeBtnBusy,
                btn.tone === 'done' && styles.finalizeBtnDone,
                btn.disabled && !btn.inFlight && styles.btnDisabled,
              ]}
              onPress={handleFinalize}
              disabled={btn.disabled && !btn.inFlight}
              testID="finalize-code-changes-button"
            >
              {busy || btn.inFlight ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <AppIcon
                  name={btn.tone === 'done' ? 'checkmark-circle' : 'flask-outline'}
                  size={12}
                  color={colors.white}
                />
              )}
              <Text style={styles.finalizeText}>{busy && !btn.inFlight ? 'Starting' : btn.label}</Text>
            </TouchableOpacity>

            {/* Push */}
            <TouchableOpacity
              style={[styles.pushBtn, (!pushEnabled || pushing) && styles.btnDisabled]}
              onPress={handlePush}
              disabled={!pushEnabled || pushing}
              testID="finalize-push-button"
              accessibilityLabel={hosted ? 'Push to Agent Hub' : 'Push to GitHub'}
            >
              {pushing ? (
                <ActivityIndicator size="small" color={colors.emerald300} />
              ) : (
                <AppIcon name="cloud-upload-outline" size={12} color={colors.emerald300} />
              )}
              <Text style={styles.pushText} numberOfLines={1}>
                {pushLabel}
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
      </ScrollView>

      {/* Live status line while a run is active */}
      {showFinalize && btn.inFlight && (
        <Text style={styles.statusLine}>{describeRunPhase(status, phase)}…</Text>
      )}

      <SessionSummarySheet
        visible={showSummary}
        onClose={() => setShowSummary(false)}
        sessionId={sessionId}
        sessionAgents={sessionAgents}
      />

      {/* Build dropdown menu */}
      {showFinalize && projectId ? (
        <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={styles.menu}>
            <ScrollView>
              {[{ value: 'ask', label: 'Ask', description: 'Read-only planning mode' }, ...FINALIZE_AUTOMATION_OPTIONS].map(
                (opt) => {
                  const active = askMode ? opt.value === 'ask' : opt.value === automation;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.menuItem, active && styles.menuItemActive]}
                      onPress={() => selectAutomation(opt.value)}
                    >
                      <Text style={[styles.menuItemLabel, active && styles.menuItemLabelActive]}>
                        {opt.label}
                      </Text>
                      <Text style={styles.menuItemDesc}>{opt.description}</Text>
                    </TouchableOpacity>
                  );
                },
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray950,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingRight: 4,
  },
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  outlineBtnText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray200,
  },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  dropdownText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray200,
    maxWidth: 64,
  },
  finalizeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: PURPLE,
    minHeight: 28,
  },
  finalizeBtnBusy: {
    backgroundColor: colors.red500 || '#ef4444',
  },
  finalizeBtnDone: {
    backgroundColor: colors.emerald600 || '#059669',
  },
  finalizeText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '600',
  },
  pushBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.emerald700 || 'rgba(4,120,87,0.6)',
    backgroundColor: 'rgba(6,78,59,0.4)',
    flexShrink: 1,
    maxWidth: 118,
  },
  pushText: {
    color: colors.emerald300 || '#6ee7b7',
    fontSize: 10,
    fontWeight: '600',
    flexShrink: 1,
  },
  btnDisabled: {
    opacity: 0.45,
  },
  statusLine: {
    marginTop: 6,
    fontSize: 11,
    color: colors.amber400,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  menu: {
    backgroundColor: colors.gray900,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray700,
    maxHeight: 360,
    overflow: 'hidden',
  },
  menuItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  menuItemActive: {
    backgroundColor: 'rgba(99,102,241,0.18)',
  },
  menuItemLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
  },
  menuItemLabelActive: {
    color: colors.indigo300 || '#a5b4fc',
  },
  menuItemDesc: {
    fontSize: 11,
    color: colors.gray500,
    marginTop: 2,
  },
});
