import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { isTerminalStatus, isFinalizeBlocked, describeRunPhase } from '../utils/finalizeRun';
import { hasCommittableChangesFromReady } from '../utils/changesReady';
import { colors } from '../theme/colors';

const WORKTREE_POLL_MS = 15_000;

/**
 * Mobile counterpart of the web `<FinalizeButton />` (card 2bce78c2).
 *
 * Renders the "Finalize Code Changes" affordance for a card-linked session.
 * - Idle / no active run → enabled purple button. Tap → `startFinalizeRun`.
 * - In-flight (queued/rebasing/running/reviewing/dispatching/pushing) →
 *   disabled spinner button labeled "Finalizing: <phase>" + inline cancel.
 * - Terminal (pushed/failed/timed_out/infra_error/cancelled/stalled_no_response)
 *   → re-enabled, label returns to "Finalize Code Changes".
 *
 * The component only renders when both `projectId` and `cardId` are present;
 * sessions without a linked card never see this button.
 *
 * Live-state tracking: the web client subscribes to `finalize_run_*`
 * WebSocket events via `useFinalizeRun`. There is no equivalent bridge on
 * mobile today, so this component falls back to polling
 * `GET /api/sessions/:sessionId/finalize-runs/latest` every 2s while a
 * non-terminal run is active. The poll is cancelled when the run reaches a
 * terminal status, when `sessionId` changes, or when the component unmounts.
 *
 * TODO follow-up card: subscribe to `finalize_run_*` WS events on mobile
 * once the bridge supports them — that lets us drop the poll loop and
 * react instantly to phase / step / completed events.
 */
export default function FinalizeButton({
  projectId,
  cardId,
  sessionId,
  prefetchedRun,
  branchLabel,
  pendingChanges = null,
  onError,
  variant = 'default',
}) {
  const { startFinalizeRun, startFinalizeRunForSession, cancelFinalizeRun } = useApp();

  // `prefetchedRun === undefined` → fetch on mount.
  // `prefetchedRun === null`      → "no run yet" (skip fetch, idle button).
  // `prefetchedRun === FinalizeRunRow` → use as starting state.
  const [run, setRun] = useState(prefetchedRun !== undefined ? prefetchedRun : null);
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(prefetchedRun !== undefined);
  const [worktreeCommittable, setWorktreeCommittable] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initial fetch when sessionId changes (and the caller didn't pre-warm).
  useEffect(() => {
    if (prefetchedRun !== undefined) {
      setRun(prefetchedRun);
      setLoadedOnce(true);
      return undefined;
    }
    if (!sessionId) {
      setRun(null);
      setLoadedOnce(true);
      return undefined;
    }
    let cancelled = false;
    setLoadedOnce(false);
    api
      .getLatestFinalizeRunForSession(sessionId)
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        setRun(data?.run ?? null);
        setLoadedOnce(true);
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        // Initial-fetch failures shouldn't block the idle button. Surface
        // through onError if the caller wired one; otherwise stay quiet.
        setLoadedOnce(true);
      });
    return () => {
      cancelled = true;
    };
    // prefetchedRun intentionally not in deps — it's a snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setWorktreeCommittable(false);
      return undefined;
    }
    let cancelled = false;
    const poll = () => {
      api
        .getSessionWorktreeChanges(sessionId)
        .then((data) => {
          if (!cancelled && mountedRef.current) setWorktreeCommittable(Boolean(data?.committable));
        })
        .catch(() => {
          if (!cancelled && mountedRef.current) setWorktreeCommittable(false);
        });
    };
    poll();
    const timer = setInterval(poll, WORKTREE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  const status = run?.status ?? null;
  const phase = run?.phase ?? null;
  const blocked = isFinalizeBlocked(status);
  const terminal = isTerminalStatus(status);
  const readyToPush = status === 'ready_to_push';
  const hasCommittableChanges =
    worktreeCommittable || hasCommittableChangesFromReady(pendingChanges);
  const canShip = hasCommittableChanges || readyToPush;

  // Polling fallback: while a run is non-terminal, refetch every 2s so the
  // UI tracks phase transitions and terminal flips without WS events.
  useEffect(() => {
    if (!sessionId) return undefined;
    if (!run || terminal) return undefined;
    let cancelled = false;
    const tick = () => {
      api
        .getLatestFinalizeRunForSession(sessionId)
        .then((data) => {
          if (cancelled || !mountedRef.current) return;
          setRun(data?.run ?? null);
        })
        .catch(() => {
          // Transient network blips while polling are non-fatal — the next
          // tick will retry. We deliberately don't toast.
        });
    };
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, run?.id, terminal]);

  const handleStart = useCallback(async () => {
    if (!projectId || !sessionId) return;
    if (blocked || optimisticPending || !canShip) return;
    setOptimisticPending(true);
    try {
      const result = cardId
        ? await startFinalizeRun(projectId, cardId)
        : await startFinalizeRunForSession(projectId, sessionId);
      if (!mountedRef.current) return;
      // Refetch the row so we move into the in-flight render path
      // immediately (the server returns just `{ run_id, status, reused }`,
      // not the full row).
      if (sessionId) {
        try {
          const data = await api.getLatestFinalizeRunForSession(sessionId);
          if (mountedRef.current) setRun(data?.run ?? null);
        } catch {
          // ignore — optimistic state below covers the gap.
        }
      } else if (result?.run_id) {
        // No session id to refetch by; synthesize a minimal placeholder so
        // the button shows the disabled state until the next refresh.
        setRun((prev) => ({
          ...(prev || {}),
          id: result.run_id,
          status: result.status || 'queued',
          phase: null,
        }));
      }
    } catch (err) {
      const message = (err && err.message) || 'Failed to start runner';
      if (onError) {
        onError(message);
      } else {
        Alert.alert('Runner', message);
      }
    } finally {
      if (mountedRef.current) setOptimisticPending(false);
    }
  }, [projectId, cardId, sessionId, blocked, optimisticPending, canShip, startFinalizeRun, startFinalizeRunForSession, onError]);

  const handleCancel = useCallback(async () => {
    if (!projectId || !run?.id) return;
    if (cancelPending) return;
    setCancelPending(true);
    try {
      await cancelFinalizeRun(projectId, run.id);
      if (!mountedRef.current) return;
      // Optimistically reflect the cancel — the poll loop will pick up the
      // authoritative row shortly.
      setRun((prev) => (prev ? { ...prev, status: 'cancelled' } : prev));
    } catch (err) {
      const message = (err && err.message) || 'Failed to cancel runner';
      if (onError) {
        onError(message);
      } else {
        Alert.alert('Cancel Runner', message);
      }
    } finally {
      if (mountedRef.current) setCancelPending(false);
    }
  }, [projectId, run?.id, cancelPending, cancelFinalizeRun, onError]);

  // Gate: need a project + session. Card is created server-side on first use.
  if (!projectId || !sessionId) return null;

  // Don't flash an enabled button while the initial fetch is in flight —
  // a tap during that window could double-trigger if the server already
  // has a non-terminal row.
  const initialFetchPending = !loadedOnce && prefetchedRun === undefined;

  const showInFlight = blocked || optimisticPending;
  const compact = variant === 'compact';

  if (showInFlight) {
    const label = optimisticPending && !blocked
      ? 'Running: queued'
      : `Running: ${describeRunPhase(status, phase)}`;
    return (
      <View style={[styles.container, compact && styles.containerCompact]}>
        {!compact && (
          <View style={styles.headerRow}>
            <Text style={styles.icon}>⤴</Text>
            <Text style={styles.title}>Runner</Text>
            {!!branchLabel && (
              <Text style={styles.branch} numberOfLines={1}>
                ({branchLabel})
              </Text>
            )}
          </View>
        )}
        <View style={styles.inFlightRow}>
          <TouchableOpacity
            disabled
            style={[styles.button, styles.buttonDisabled, compact && styles.buttonCompact]}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: true, busy: true }}
            testID="finalize-code-changes-button"
          >
            <View style={styles.creatingRow}>
              <ActivityIndicator color={colors.white} size="small" />
              <Text style={[styles.buttonText, compact && styles.buttonTextCompact]}>{label}</Text>
            </View>
          </TouchableOpacity>
          {run?.id ? (
            <TouchableOpacity
              onPress={handleCancel}
              disabled={cancelPending}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Cancel runner"
              testID="finalize-code-changes-cancel"
              style={styles.cancelButton}
            >
              {cancelPending ? (
                <ActivityIndicator color={colors.gray300} size="small" />
              ) : (
                <Text style={styles.cancelText}>✕</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  const idleLabel = 'Runner';
  const idleDisabled = initialFetchPending || !canShip;
  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      {!compact && (
        <View style={styles.headerRow}>
          <Text style={styles.icon}>⤴</Text>
          <Text style={styles.title}>Runner</Text>
          {!!branchLabel && (
            <Text style={styles.branch} numberOfLines={1}>
              ({branchLabel})
            </Text>
          )}
        </View>
      )}
      <TouchableOpacity
        onPress={handleStart}
        disabled={idleDisabled}
        style={[
          styles.button,
          idleDisabled && styles.buttonDisabled,
          compact && styles.buttonCompact,
        ]}
        accessibilityRole="button"
        accessibilityLabel={idleLabel}
        accessibilityHint={
          canShip
            ? 'Runs rebase, review, tests, and opens a PR when green.'
            : 'No committable changes yet.'
        }
        accessibilityState={{ disabled: idleDisabled }}
        testID="finalize-code-changes-button"
      >
        <Text style={[styles.buttonText, compact && styles.buttonTextCompact]}>{idleLabel}</Text>
      </TouchableOpacity>
      {!compact && (
        <Text style={styles.v0Caveat}>
          UI updates poll every 2s on mobile.
        </Text>
      )}
    </View>
  );
}

// Status helpers (`isTerminalStatus`, `isFinalizeBlocked`,
// `describeRunPhase`) live in `mobile/src/utils/finalizeRun.js` so they
// can be unit-tested and shared. Keep them in sync with
// `client/src/hooks/useFinalizeRun.js`.

const PURPLE = '#7C3AED';

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginVertical: 8,
    padding: 12,
    backgroundColor: 'rgba(31, 41, 55, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(126, 34, 206, 0.6)', // purple-700/60
    borderRadius: 12,
  },
  containerCompact: {
    marginHorizontal: 0,
    marginVertical: 4,
    padding: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 6,
  },
  icon: { fontSize: 14, color: colors.purple400 },
  title: { color: colors.gray300, fontWeight: '600', fontSize: 14 },
  branch: {
    color: colors.gray500,
    fontSize: 11,
    marginLeft: 2,
    flexShrink: 1,
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: PURPLE,
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
    flex: 1,
  },
  buttonCompact: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    minHeight: 28,
  },
  buttonDisabled: {
    opacity: 0.85,
  },
  creatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonTextCompact: {
    fontSize: 11,
  },
  v0Caveat: {
    color: colors.gray500,
    fontSize: 10,
    fontStyle: 'italic',
    marginTop: 6,
    textAlign: 'center',
  },
  inFlightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cancelButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: colors.gray300,
    fontSize: 16,
    fontWeight: '600',
  },
});
