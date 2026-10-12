import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  GMAIL_IMPORTANCE_AUTO_SCAN_OPTIONS,
  createGmailImportanceSync,
  GMAIL_IMPORTANCE_WINDOW_OPTIONS,
  importanceStatusLine,
  senderName,
  type GmailImportanceAutoScan,
  type GmailImportanceState,
  type GmailImportanceSync,
  type GmailImportanceWindowDays,
  type GmailImportantThread,
} from '@shared/utils/gmailImportance';

const NO_PINS: GmailImportantThread[] = [];

/**
 * AI-picked important threads pinned above the Gmail list. Mirrors the web
 * `GmailImportantSection`: on/off toggle, 1/7/30-day window, automated scan
 * cadence, and Scan now.
 */
export default function GmailImportantSection({
  onOpenThread,
  onPinnedChange,
}: {
  onOpenThread: (threadId: string) => void;
  onPinnedChange?: (threads: GmailImportantThread[]) => void;
}) {
  const [state, setState] = useState<GmailImportanceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const onPinnedChangeRef = useRef(onPinnedChange);
  onPinnedChangeRef.current = onPinnedChange;
  // Every fetch, scan, and settings response goes through one scheduler that
  // always books the next fetch (fast while scanning, slow while idle), so
  // automated scans and transient failures never leave the pane stale.
  const syncRef = useRef<GmailImportanceSync | null>(null);
  const loadFailedRef = useRef(false);

  useEffect(() => {
    const sync = createGmailImportanceSync({
      load: () => api.getGmailImportance(),
      onState: (next) => {
        // A recovered fetch clears its own failure, not a scan/settings error.
        if (loadFailedRef.current) {
          loadFailedRef.current = false;
          setError(null);
        }
        setState(next);
      },
      onError: (message) => {
        loadFailedRef.current = true;
        setError(message);
      },
    });
    syncRef.current = sync;
    sync.start();
    return () => {
      sync.stop();
      syncRef.current = null;
    };
  }, []);

  // The parent hides exactly the pins this section is showing, derived from
  // what renders rather than pushed on fetch success. No state yet, a failed
  // load, the feature off, or the section unmounting all mean nothing is
  // shown here, so nothing may be hidden from the regular list either.
  const displayedPins = state?.settings.enabled ? state.threads : NO_PINS;
  useEffect(() => {
    onPinnedChangeRef.current?.(displayedPins);
  }, [displayedPins]);
  useEffect(() => () => onPinnedChangeRef.current?.(NO_PINS), []);

  const accept = (next: GmailImportanceState) => syncRef.current?.accept(next);
  const refresh = () => syncRef.current?.refresh();

  const scan = async (windowDays?: GmailImportanceWindowDays) => {
    setError(null);
    try {
      accept(await api.startGmailImportanceScan(windowDays ? { windowDays } : {}));
    } catch (err: any) {
      if (err.status === 409) await refresh();
      else setError(err.message || 'Failed to start scan');
    }
  };

  const save = async (
    patch: Partial<{
      enabled: boolean;
      windowDays: GmailImportanceWindowDays;
      autoScan: GmailImportanceAutoScan;
    }>,
  ) => {
    // The window is locked while a scan runs: the running scan covers the old
    // window, and switching under it would leave the new range unrated.
    if (patch.windowDays !== undefined && state?.running) return;
    setSaving(true);
    setError(null);
    try {
      const next: GmailImportanceState = await api.updateGmailImportanceSettings(patch);
      accept(next);
      const turnedOn = patch.enabled === true && !next.settings.lastScanAt;
      if ((turnedOn || patch.windowDays !== undefined) && !next.running) {
        await scan(next.settings.windowDays);
      }
    } catch (err: any) {
      // 409: a scan started elsewhere (another client or the auto-scan) before
      // this pane saw it. Pull its state so the window picker locks.
      if (err.status === 409) await refresh();
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Errors render outside the enabled branch and before state loads: a failed
  // enable leaves enabled=false, and a failed first load leaves no state, and
  // both must still say why.
  const errorText = error ? (
    <Text style={styles.errorText} testID="gmail-important-error">
      {error}
    </Text>
  ) : null;

  if (!state) {
    return errorText ? (
      <View style={styles.card} testID="gmail-important-section">
        {errorText}
      </View>
    ) : null;
  }
  const { settings, running, threads } = state;

  return (
    <View style={styles.card} testID="gmail-important-section">
      <View style={styles.header}>
        <Text style={styles.title}>
          ★ Important{settings.enabled && threads.length ? ` (${threads.length})` : ''}
        </Text>
        <Text style={styles.toggleLabel}>Show first</Text>
        <Switch
          value={settings.enabled}
          disabled={saving}
          onValueChange={(next) => save({ enabled: next })}
          testID="gmail-important-toggle"
        />
      </View>

      {errorText}
      {!settings.enabled ? (
        <Text style={styles.muted}>
          Your AI engine reads sender, subject, and preview of recent inbox mail and pins what needs
          your attention here. It runs on your own AI subscription.
        </Text>
      ) : (
        <>
          <View style={styles.chipRow}>
            {GMAIL_IMPORTANCE_WINDOW_OPTIONS.map((opt) => {
              const active = settings.windowDays === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  disabled={saving || running}
                  onPress={() => !active && save({ windowDays: opt.value })}
                  style={[styles.chip, active && styles.chipActive]}
                  accessibilityState={{ selected: active }}
                  testID={`gmail-important-window-${opt.value}`}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              disabled={running || saving}
              onPress={() => scan()}
              style={[styles.scanButton, (running || saving) && styles.disabled]}
              testID="gmail-important-scan"
            >
              {running ? <ActivityIndicator size="small" color={colors.gray300} /> : null}
              <Text style={styles.chipText}>Scan now</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.subLabel}>Auto-scan</Text>
          <View style={styles.chipRow}>
            {GMAIL_IMPORTANCE_AUTO_SCAN_OPTIONS.map((opt) => {
              const active = settings.autoScan === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  disabled={saving}
                  onPress={() => !active && save({ autoScan: opt.value })}
                  style={[styles.chip, active && styles.chipActive]}
                  accessibilityState={{ selected: active }}
                  testID={`gmail-important-auto-${opt.value}`}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text
            style={[
              styles.muted,
              settings.lastScanStatus === 'error' && !running && styles.errorText,
            ]}
          >
            {importanceStatusLine(state)}
          </Text>
          {settings.lastScanFailover && !running ? (
            <Text style={styles.failover}>{settings.lastScanFailover}.</Text>
          ) : null}
          {threads.map((t) => (
            <TouchableOpacity
              key={t.threadId}
              onPress={() => onOpenThread(t.threadId)}
              style={styles.thread}
              testID={`gmail-important-thread-${t.threadId}`}
            >
              <Text style={styles.sender} numberOfLines={1}>
                {senderName(t.from)}
              </Text>
              <Text style={styles.subject} numberOfLines={1}>
                {t.subject || '(no subject)'}
              </Text>
              {t.reason ? <Text style={styles.reason}>{t.reason}</Text> : null}
            </TouchableOpacity>
          ))}
          {!threads.length && settings.lastScanAt && !running ? (
            <Text style={styles.muted}>
              Nothing important in the last{' '}
              {settings.windowDays === 1 ? 'day' : `${settings.windowDays} days`}.
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.amber900_40,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: colors.white, fontSize: 15, fontWeight: '700' },
  toggleLabel: { color: colors.gray400, fontSize: 12 },
  muted: { color: colors.gray400, fontSize: 12, lineHeight: 17 },
  subLabel: { color: colors.gray400, fontSize: 11, textTransform: 'uppercase' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipActive: { borderColor: colors.amber400, backgroundColor: colors.amber900_40 },
  chipText: { color: colors.gray300, fontSize: 12 },
  chipTextActive: { color: colors.white, fontWeight: '600' },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginLeft: 'auto',
  },
  disabled: { opacity: 0.5 },
  errorText: { color: colors.red400, fontSize: 12 },
  failover: { color: colors.amber400, fontSize: 12 },
  thread: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 8,
  },
  sender: { color: colors.gray200, fontSize: 13, fontWeight: '700' },
  subject: { color: colors.gray300, fontSize: 13 },
  reason: { color: colors.amber400, fontSize: 12, marginTop: 2 },
});
