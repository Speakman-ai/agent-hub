import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { needsInputLabel, sessionStateMeta } from '@shared/utils/sessionState';
import {
  SESSION_FORWARD_BUILD_MODES,
  SESSION_FORWARD_MODE_OPTIONS,
  parseSessionForwardMode,
  sessionForwardModeLabel,
} from '@shared/utils/extractForwardBlocks';
import { Archive, ArrowLeft, RotateCcw, X } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import { useApp } from '../context/AppContext';
import { deriveSessionState, sessionNeedsInputKind } from '../utils/deriveSessionState';
import { daysUntilPurge } from '../utils/time';
import {
  setOrchestrateLaunchSettings,
  useOrchestrateLaunchSettings,
} from '../context/orchestrateLaunchSettings';
import {
  applySpawnedSessionEvent,
  reconcileSpawnedSnapshot,
  type SpawnedListState,
} from '@shared/utils/spawnedSessionEvents';
import SessionStateIcon from './SessionStateIcon';

export interface SpawnedSessionRow {
  id: string;
  name: string;
  agent_id: string;
  state?: string | null;
  updated_at?: string;
  finalize_status?: string | null;
  needs_input?: string | null;
  needs_input_at?: number | null;
  last_turn_error?: string | null;
  spawned_from_session_id?: string | null;
  session_mode?: string | null;
}

export interface ArchivedSpawnedSession {
  id: string;
  name: string;
  agent_id: string;
  deleted_at: string;
}

interface ParentRow {
  id: string;
  name: string;
  agent_id: string;
  /** Set when this Orchestrate chat is itself a worker: the chat that started it. */
  up?: { id: string; name: string; agent_id: string } | null;
}

const EMPTY_LIST: SpawnedListState<SpawnedSessionRow> = { sessions: [], archived: [] };

interface ScopedSpawnedList extends SpawnedListState<SpawnedSessionRow> {
  parentId: string;
  parent: ParentRow | null;
}

function emptyScope(parentId: string): ScopedSpawnedList {
  return { parentId, parent: null, sessions: [], archived: [] };
}

function asSpawnedRow(session: any, parentId: string): SpawnedSessionRow | null {
  if (!session?.id || session.spawned_from_session_id !== parentId) return null;
  return {
    id: session.id,
    name: session.name || 'New session',
    agent_id: session.agent_id,
    state: session.state ?? null,
    updated_at: session.updated_at,
    finalize_status: session.finalize_status ?? null,
    needs_input: session.needs_input ?? null,
    needs_input_at: session.needs_input_at ?? null,
    last_turn_error: session.last_turn_error ?? null,
    spawned_from_session_id: session.spawned_from_session_id,
    // Only a mode the event actually carried; never a guess.
    ...(session.session_mode ? { session_mode: session.session_mode } : {}),
  };
}

/**
 * Mobile counterpart of the web spawned-sessions rail. A sheet, because the
 * phone has no side column: the same list, statuses, archive, default build
 * mode, and auto start.
 */
export default function SpawnedSessionsSheet({
  visible,
  parentSessionId,
  activeSessionId,
  onClose,
}: {
  visible: boolean;
  parentSessionId: string;
  activeSessionId: string | null;
  onClose: () => void;
}) {
  const {
    agents,
    activeTasks,
    finalizeStatusBySession,
    needsInputBySession,
    subscribeSpawnedSessionEvents,
    openSpawnedSession,
  } = useApp() as any;
  const launch = useOrchestrateLaunchSettings(parentSessionId);
  // Everything loaded is tagged with the parent it belongs to. A different
  // parent renders empty until its own GET lands, and late writes for the old
  // parent (GET, archive, restore) are dropped.
  const [scoped, setScoped] = useState<ScopedSpawnedList>(() => emptyScope(parentSessionId));
  const current = scoped.parentId === parentSessionId ? scoped : emptyScope(parentSessionId);
  const { parent, sessions, archived } = current;
  const parentIdRef = useRef(parentSessionId);
  parentIdRef.current = parentSessionId;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const updateScope = (parentId: string, update: (prev: ScopedSpawnedList) => ScopedSpawnedList) =>
    setScoped((prev) => (prev.parentId === parentId ? update(prev) : prev));
  // Events seen while the GET is in flight, replayed on its snapshot.
  const bufferedEventsRef = useRef<unknown[] | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    bufferedEventsRef.current = [];
    const land = (parentRow: ParentRow | null, snapshot: SpawnedListState<SpawnedSessionRow>) => {
      const events = bufferedEventsRef.current ?? [];
      bufferedEventsRef.current = null;
      setScoped({
        parentId: parentSessionId,
        parent: parentRow,
        ...reconcileSpawnedSnapshot<SpawnedSessionRow>(
          snapshot,
          events,
          parentSessionId,
          asSpawnedRow,
        ),
      });
    };
    api
      .getSpawnedSessions(parentSessionId)
      .then((body: any) => {
        if (cancelled) return;
        land(body.parent, { sessions: body.sessions ?? [], archived: body.archived ?? [] });
      })
      .catch(() => {
        if (cancelled) return;
        land(null, EMPTY_LIST);
      });
    return () => {
      cancelled = true;
      bufferedEventsRef.current = null;
    };
  }, [visible, parentSessionId]);

  useEffect(() => {
    if (!visible || typeof subscribeSpawnedSessionEvents !== 'function') return undefined;
    return subscribeSpawnedSessionEvents((data: any) => {
      bufferedEventsRef.current?.push(data);
      updateScope(parentSessionId, (prev) => ({
        ...prev,
        ...applySpawnedSessionEvent(prev, data, parentSessionId, asSpawnedRow),
      }));
    });
  }, [visible, parentSessionId, subscribeSpawnedSessionEvents]);

  const openSession = (row: SpawnedSessionRow) => {
    if (typeof openSpawnedSession === 'function') openSpawnedSession(row);
    onClose();
  };

  const deleteSession = async (session: SpawnedSessionRow) => {
    if (deletingId) return;
    const parentId = parentSessionId;
    const parentRow = parent;
    setDeletingId(session.id);
    try {
      await api.deleteSession(session.id);
      updateScope(parentId, (prev) => ({
        ...prev,
        ...applySpawnedSessionEvent(
          prev,
          { type: 'session_deleted', sessionId: session.id },
          parentId,
          asSpawnedRow,
        ),
      }));
      // Only step back to the parent when the user is still on this worker
      // under this parent; they may have moved on while the archive ran.
      if (
        parentRow &&
        parentIdRef.current === parentId &&
        activeSessionIdRef.current === session.id
      ) {
        openSession({
          id: parentRow.id,
          name: parentRow.name,
          agent_id: parentRow.agent_id,
        });
      }
    } catch {
      /* keep the row; the request failed */
    } finally {
      setDeletingId(null);
    }
  };

  const restoreSession = async (session: ArchivedSpawnedSession) => {
    if (restoringId) return;
    const parentId = parentSessionId;
    setRestoringId(session.id);
    try {
      await api.restoreSession(session.id);
      updateScope(parentId, (prev) => ({
        ...prev,
        archived: prev.archived.filter((row) => row.id !== session.id),
        sessions: prev.sessions.some((row) => row.id === session.id)
          ? prev.sessions
          : [
              {
                id: session.id,
                name: session.name,
                agent_id: session.agent_id,
                state: 'waiting_for_user_input',
                spawned_from_session_id: parentId,
              },
              ...prev.sessions,
            ],
      }));
    } catch {
      /* leave it archived */
    } finally {
      setRestoringId(null);
    }
  };

  const viewingWorker = activeSessionId != null && activeSessionId !== parentSessionId;
  // On a worker, step back to this list's chat. On the list's own chat, step up
  // to the chat that started it when it is a nested Orchestrate chat.
  const backTarget = viewingWorker ? parent : (parent?.up ?? null);
  const agentName = (agentId: string) => {
    if (!parent || agentId === parent.agent_id) return null;
    return agents?.find((agent: any) => agent.id === agentId)?.name || agentId;
  };
  const buildLabel = sessionForwardModeLabel(launch.mode === 'consult' ? 'manual' : launch.mode);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} testID="spawned-sessions-sheet">
        <View style={styles.header}>
          <Text style={styles.title}>Sessions</Text>
          <Pressable accessibilityLabel="Close sessions" onPress={onClose} hitSlop={8}>
            <X size={18} color={colors.gray300} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.kicker}>Default build</Text>
          <Pressable
            testID="orchestrate-default-build"
            accessibilityLabel="Default build mode"
            accessibilityRole="button"
            onPress={() => setBuildOpen((open) => !open)}
            style={styles.select}
          >
            <Text style={styles.selectText}>{buildLabel}</Text>
          </Pressable>
          {buildOpen
            ? SESSION_FORWARD_MODE_OPTIONS.filter((option) =>
                SESSION_FORWARD_BUILD_MODES.includes(option.value),
              ).map((option) => (
                <Pressable
                  key={option.value}
                  testID={`orchestrate-build-${option.value}`}
                  accessibilityRole="button"
                  onPress={() => {
                    setOrchestrateLaunchSettings(parentSessionId, {
                      mode: parseSessionForwardMode(option.value),
                    });
                    setBuildOpen(false);
                  }}
                  style={styles.option}
                >
                  <Text style={styles.optionText}>{option.label}</Text>
                </Pressable>
              ))
            : null}
          <Pressable
            testID="orchestrate-auto-start"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: launch.autoStart }}
            onPress={() =>
              setOrchestrateLaunchSettings(parentSessionId, { autoStart: !launch.autoStart })
            }
            style={styles.checkRow}
          >
            <View style={[styles.box, launch.autoStart && styles.boxOn]}>
              {launch.autoStart ? <Text style={styles.boxMark}>✓</Text> : null}
            </View>
            <Text style={styles.checkLabel}>Auto start</Text>
          </Pressable>
          {backTarget ? (
            <Pressable
              testID="spawned-sessions-back"
              accessibilityRole="button"
              onPress={() =>
                openSession({
                  id: backTarget.id,
                  name: backTarget.name,
                  agent_id: backTarget.agent_id,
                })
              }
              style={styles.back}
            >
              <ArrowLeft size={14} color={colors.sky300} />
              <Text style={styles.backText} numberOfLines={1}>
                {backTarget.name || 'Back to chat'}
              </Text>
            </Pressable>
          ) : null}
          {sessions.length === 0 ? (
            <Text style={styles.empty}>Spawned sessions will show up here.</Text>
          ) : (
            sessions.map((session) => {
              const signals = {
                activeTaskSessionIds: activeTasks,
                finalizeStatusBySession,
                needsInputBySession,
              };
              const sessionState = deriveSessionState(session, signals);
              const statusLabel =
                sessionState === 'needs_input'
                  ? needsInputLabel(sessionNeedsInputKind(session, signals))
                  : sessionStateMeta(sessionState).label;
              const otherAgent = agentName(session.agent_id);
              const selected = session.id === activeSessionId;
              return (
                <View key={session.id} style={[styles.row, selected && styles.rowSelected]}>
                  <Pressable
                    testID={`spawned-session-${session.id}`}
                    accessibilityRole="button"
                    onPress={() =>
                      openSession({ ...session, spawned_from_session_id: parentSessionId })
                    }
                    style={styles.rowMain}
                  >
                    <SessionStateIcon state={sessionState} size={14} />
                    <View style={styles.rowText}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {session.name || 'New session'}
                      </Text>
                      <Text
                        testID={`spawned-session-status-${session.id}`}
                        style={styles.rowStatus}
                        numberOfLines={1}
                      >
                        {statusLabel}
                        {otherAgent ? ` · ${otherAgent}` : ''}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    testID={`spawned-session-delete-${session.id}`}
                    accessibilityLabel={`Delete ${session.name || 'session'}`}
                    accessibilityRole="button"
                    disabled={deletingId === session.id}
                    onPress={() => void deleteSession(session)}
                    style={styles.delete}
                  >
                    <Text style={styles.deleteText}>{deletingId === session.id ? '…' : '✕'}</Text>
                  </Pressable>
                </View>
              );
            })
          )}
          {archived.length > 0 ? (
            <View testID="spawned-archived-section" style={styles.archived}>
              <Pressable
                testID="spawned-archived-toggle"
                accessibilityRole="button"
                onPress={() => setArchivedOpen((open) => !open)}
                style={styles.archivedToggle}
              >
                <Archive size={12} color={colors.gray500} />
                <Text style={styles.archivedLabel}>Archived ({archived.length})</Text>
              </Pressable>
              {archivedOpen
                ? archived.map((session) => {
                    const purge = daysUntilPurge(session.deleted_at, 1);
                    return (
                      <View
                        key={session.id}
                        testID={`spawned-archived-${session.id}`}
                        style={styles.archivedRow}
                      >
                        <View style={styles.rowText}>
                          <Text style={styles.rowStatus} numberOfLines={1}>
                            {session.name || 'New session'}
                          </Text>
                          {purge ? <Text style={styles.purge}>{purge.label}</Text> : null}
                        </View>
                        <Pressable
                          testID={`spawned-session-restore-${session.id}`}
                          accessibilityRole="button"
                          accessibilityLabel="Restore session"
                          disabled={restoringId === session.id}
                          onPress={() => void restoreSession(session)}
                          style={styles.restore}
                        >
                          <RotateCcw size={12} color={colors.emerald400} />
                          <Text style={styles.restoreText}>
                            {restoringId === session.id ? '…' : 'Restore'}
                          </Text>
                        </Pressable>
                      </View>
                    );
                  })
                : null}
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  title: {
    color: colors.gray400,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  body: { padding: 16, gap: 8 },
  kicker: {
    color: colors.gray500,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  select: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  selectText: { color: colors.gray100, fontSize: 14 },
  option: { paddingVertical: 8, paddingHorizontal: 8 },
  optionText: { color: colors.gray100, fontSize: 14 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  box: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.gray600,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.sky500_15, borderColor: colors.sky300 },
  boxMark: { color: colors.sky300, fontSize: 12, fontWeight: '700' },
  checkLabel: { color: colors.gray200, fontSize: 14 },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  backText: { color: colors.sky300, fontSize: 13, flex: 1 },
  empty: { color: colors.gray500, fontSize: 13, marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
  },
  rowSelected: { backgroundColor: colors.gray900 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 8 },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { color: colors.gray200, fontSize: 14 },
  rowStatus: { color: colors.gray500, fontSize: 12, marginTop: 2 },
  delete: { padding: 8 },
  deleteText: { color: colors.gray500, fontSize: 14 },
  archived: {
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray800,
    paddingTop: 8,
  },
  archivedToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  archivedLabel: {
    color: colors.gray500,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  purge: { color: colors.gray600, fontSize: 10, marginTop: 2 },
  restore: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6 },
  restoreText: { color: colors.emerald400, fontSize: 12 },
});
