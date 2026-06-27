/**
 * FinalizeBar — single chat action row (Summary, View changes, Build, Finalize, Push).
 *
 * Mirrors the web/mobile reference layout: one horizontal strip directly under
 * TopBar. Voice input lives in MessageInput, not here.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Alert, Modal, Pressable, ScrollView, } from 'react-native';
import AppIcon from './AppIcon';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import SessionSummarySheet from './SessionSummarySheet';
import { sessionControlLabel, sessionControlPatch, deriveSessionFinalizeMode, sessionControlOptionsForProject, sessionControlValueForProject, } from '../utils/finalizeAutomation';
import { sessionControlAppIcon } from '../utils/sessionControlIcons';
import { deriveFinalizeButton, canPush, isFullyValidated } from '../utils/finalizeView';
import { describeRunPhase } from '../utils/finalizeRun';
const PURPLE = '#7C3AED';

function resolveSessionModeFromRow(session: any) {
    const m = session?.session_mode;
    if (m === 'design' || m === 'scoping' || m === 'skill-builder' || m === 'consult')
        return m;
    return 'chat';
}

export default function FinalizeBar({ projectId, sessionId, cardId, session, sessionAgents = [], project = null, hosted = false, hasChanges = true, showViewChanges = true, onViewChanges, showFinalize = true, status, phase, phases, run, onChanged, onError, }: any) {
    const [showSummary, setShowSummary] = useState(false);
    const [automation, setAutomation] = useState(() => deriveSessionFinalizeMode(session).automation);
    const [askMode, setAskMode] = useState(() => deriveSessionFinalizeMode(session).askMode);
    const [menuOpen, setMenuOpen] = useState(false);
    const [busy, setBusy] = useState(false); // finalize/cancel in flight (optimistic)
    const [pushing, setPushing] = useState(false);
    const [mode, setMode] = useState(() => resolveSessionModeFromRow(session));
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
        setMode(resolveSessionModeFromRow(session));
        // Keyed on the session id + the fields the bar mirrors; intentionally
        // not the whole session object, so unrelated session updates don't clobber
        // an in-flight optimistic selection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, session?.finalize_automation, session?.ask_mode, session?.session_mode]);
    const canDesignMode = !!session?.can_design_mode;
    // Skill Builder is a dev-agent mode; hide it from the picker when this
    // session's agent is a helper (the server rejects it for those roles too).
    const workflowProject = project?.mode === 'workflow';
    const sessionAgent = (sessionAgents || []).find((a: any) => a.id === session?.agent_id) || (sessionAgents || [])[0] || null;
    const controlOptions = sessionControlOptionsForProject(project, sessionAgent);
    const fullyValidated = isFullyValidated(phases);
    const btn = deriveFinalizeButton({ status, fullyValidated, hasChanges });
    const pushEnabled = canPush({ status, hasChanges }) && !!run?.id;
    const pushLabel = 'Push';
    const selectedValue = sessionControlValueForProject(project, { sessionMode: mode, askMode, automation });
    const consultActive = selectedValue === 'consult';
    const dropdownLabel = sessionControlLabel(selectedValue);
    const reportError = useCallback((msg: any) => {
        if (onError)
            onError(msg);
        else
            Alert.alert('Runner', msg);
    }, [onError]);
    const selectAutomation = useCallback(async (value: any) => {
        setMenuOpen(false);
        if (value === 'design' && !canDesignMode)
            return;
        // Collapse the (possibly multi-axis) change into ONE atomic PATCH. Applying
        // the axes as separate calls risked a partial commit — e.g. clearing ship
        // intent succeeds but the mode switch then fails its worktree check — and
        // the old per-step revert could even desync local state from a server that
        // already changed one axis. A single transactional call is all-or-nothing.
        const patch = sessionControlPatch({ sessionMode: mode, askMode, automation }, value);
        if (!sessionId || patch === null)
            return;
        // Snapshot for revert; the server applies the patch atomically, so on
        // failure nothing changed server-side and we restore every local axis.
        const prev = { mode, askMode, automation };
        if (patch.session_mode !== undefined)
            setMode(patch.session_mode); // optimistic
        if (patch.ask_mode !== undefined)
            setAskMode(patch.ask_mode);
        if (patch.finalize_automation !== undefined)
            setAutomation(patch.finalize_automation);
        try {
            await api.updateSession(sessionId, patch);
            onChanged?.();
        }
        catch (err: any) {
            setMode(prev.mode);
            setAskMode(prev.askMode);
            setAutomation(prev.automation);
            reportError(err?.message || 'Failed to update session mode');
        }
    }, [sessionId, mode, automation, askMode, canDesignMode, onChanged, reportError]);
    const handleFinalize = useCallback(async () => {
        if (busy)
            return;
        setBusy(true);
        try {
            if (btn.inFlight) {
                if (run?.id)
                    await api.cancelFinalizeRun(projectId, run.id);
            }
            else if (cardId) {
                await api.startFinalizeRun(projectId, cardId);
            }
            else {
                await api.startFinalizeRunForSession(projectId, sessionId);
            }
            await onChanged?.();
        }
        catch (err: any) {
            reportError(err?.message || 'Failed to start runner');
        }
        finally {
            setBusy(false);
        }
    }, [busy, btn.inFlight, run?.id, cardId, projectId, sessionId, onChanged, reportError]);
    const doPush = useCallback(async (force: any) => {
        if (!run?.id)
            return;
        setPushing(true);
        try {
            await api.pushFinalizeRun(projectId, run.id, { force });
            await onChanged?.();
        }
        catch (err: any) {
            reportError(err?.message || 'Failed to push');
        }
        finally {
            setPushing(false);
        }
    }, [run?.id, projectId, onChanged, reportError]);
    const handlePush = useCallback(() => {
        if (!pushEnabled || pushing)
            return;
        if (fullyValidated) {
            doPush(false);
        }
        else {
            Alert.alert(pushLabel, 'Review and checks have not both passed. Push the branch and open a PR anyway?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Push anyway', style: 'destructive', onPress: () => doPush(true) },
            ]);
        }
    }, [pushEnabled, pushing, fullyValidated, pushLabel, doPush]);
    return (<View style={styles.bar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={styles.outlineBtn} onPress={() => setShowSummary(true)} accessibilityRole="button" accessibilityLabel="Open session summary">
          <AppIcon name="information-circle-outline" size={12} color={colors.gray400}/>
          <Text style={styles.outlineBtnText}>Summary</Text>
        </TouchableOpacity>

        {showViewChanges && !workflowProject && !consultActive && typeof onViewChanges === 'function' && (<TouchableOpacity style={styles.outlineBtn} onPress={onViewChanges} accessibilityRole="button" accessibilityLabel="View code changes for this session">
            <AppIcon name="git-compare-outline" size={12} color={colors.gray400}/>
            <Text style={styles.outlineBtnText}>Changes</Text>
          </TouchableOpacity>)}

        {showFinalize && projectId ? (<>
            {/* Session mode dropdown — always shown; ship controls hidden on workflow projects. */}
            <TouchableOpacity style={styles.dropdown} onPress={() => setMenuOpen(true)} disabled={!sessionId} testID="finalize-automation-select">
              <AppIcon name={sessionControlAppIcon(selectedValue)} size={12} color={colors.gray400}/>
              <Text style={styles.dropdownText} numberOfLines={1}>
                {dropdownLabel}
              </Text>
              <AppIcon name="chevron-down" size={12} color={colors.gray400}/>
            </TouchableOpacity>

            {!workflowProject && !consultActive ? (<>
            {/* Finalize / Stop */}
            <TouchableOpacity style={[
                styles.finalizeBtn,
                btn.tone === 'busy' && styles.finalizeBtnBusy,
                btn.tone === 'done' && styles.finalizeBtnDone,
                btn.disabled && !btn.inFlight && styles.btnDisabled,
            ]} onPress={handleFinalize} disabled={btn.disabled && !btn.inFlight} testID="finalize-code-changes-button">
              {busy || btn.inFlight ? (<ActivityIndicator size="small" color={colors.white}/>) : (<AppIcon name={btn.tone === 'done' ? 'checkmark-circle' : 'flask-outline'} size={12} color={colors.white}/>)}
              <Text style={styles.finalizeText}>{busy && !btn.inFlight ? 'Starting' : btn.label}</Text>
            </TouchableOpacity>

            {/* Push */}
            <TouchableOpacity style={[styles.pushBtn, (!pushEnabled || pushing) && styles.btnDisabled]} onPress={handlePush} disabled={!pushEnabled || pushing} testID="finalize-push-button" accessibilityLabel={hosted ? 'Push to Agent Hub' : 'Push to GitHub'}>
              {pushing ? (<ActivityIndicator size="small" color={colors.emerald300}/>) : (<AppIcon name="cloud-upload-outline" size={12} color={colors.emerald300}/>)}
              <Text style={styles.pushText} numberOfLines={1}>
                {pushLabel}
              </Text>
            </TouchableOpacity>
            </>) : null}
          </>) : null}
      </ScrollView>

      {/* Live status line while a run is active */}
      {showFinalize && !workflowProject && !consultActive && btn.inFlight && (<Text style={styles.statusLine}>{describeRunPhase(status, phase)}…</Text>)}

      <SessionSummarySheet visible={showSummary} onClose={() => setShowSummary(false)} sessionId={sessionId} sessionAgents={sessionAgents}/>

      {/* Build dropdown menu */}
      {showFinalize && projectId ? (<Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={styles.menu}>
            <ScrollView>
              {controlOptions.map((opt: any) => {
                const active = opt.value === selectedValue;
                const optDisabled = opt.value === 'design' && !canDesignMode;
                return (<TouchableOpacity key={opt.value} style={[
                        styles.menuItem,
                        active && styles.menuItemActive,
                        optDisabled && styles.menuItemDisabled,
                    ]} disabled={optDisabled} onPress={() => selectAutomation(opt.value)}>
                    <View style={styles.menuItemRow}>
                      <AppIcon
                        name={sessionControlAppIcon(opt.value)}
                        size={16}
                        color={active ? colors.indigo300 : colors.gray400}
                        style={styles.menuItemIcon}
                      />
                      <View style={styles.menuItemText}>
                        <Text style={[styles.menuItemLabel, active && styles.menuItemLabelActive]}>
                          {opt.label}
                        </Text>
                        <Text style={styles.menuItemDesc}>
                          {optDisabled ? 'Needs a session with an isolated worktree' : opt.description}
                        </Text>
                      </View>
                    </View>
                  </TouchableOpacity>);
            })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>) : null}
    </View>);
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
    menuItemRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    menuItemIcon: {
        marginTop: 1,
    },
    menuItemText: {
        flex: 1,
        minWidth: 0,
    },
    menuItemActive: {
        backgroundColor: 'rgba(99,102,241,0.18)',
    },
    menuItemDisabled: {
        opacity: 0.4,
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
