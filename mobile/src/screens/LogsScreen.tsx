/**
 * Project Logs module (LOG-QUERY UI) — mobile parity for the web `LogsPage`.
 *
 * A single project surface with three tabs:
 *   - Live    — the raw committed-log tail (`LiveLogsView`).
 *   - Issues  — grouped, deduplicated error issues (`IssuesView`).
 *   - Sources — write-only ingest-credential management (`LogSourcesPanel`).
 *
 * SECURITY (LOG-TRUST): every log/issue field originates from an untrusted
 * ingested record. It is rendered exclusively as React Native <Text> — never
 * interpolated into markup — so embedded payloads can never execute. Bodies and
 * stack traces keep their newlines via scrollable monospace blocks so large
 * traces and attribute maps stay usable on small screens.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import { useApp } from '../context/AppContext';
import { LogSourcesPanel } from './LogSourcesScreen';
import { useLogTail, type LogTailStatus } from '../hooks/useLogTail';
import {
  SEVERITY_BUCKETS,
  TIME_RANGES,
  DEFAULT_TIME_RANGE_MS,
  resolveSinceUnixNano,
  severityLabel,
  severityToneKey,
  nanoToMillis,
  parseAttributes,
  extractStackTrace,
  recordHasDetail,
  mergeTailRecords,
  buildOlderPageParams,
  filterLogRecords,
  distinctValues,
  isNearTop,
  toNewestFirst,
  type SeverityTone,
  type LogRecord,
  type LogFilter,
} from '../utils/logStream';
import {
  STATUS_TABS,
  issueDisplayTitle,
  mergeIssuePage,
  applyIssueUpdate,
  applyTransitionToList,
  transitionRemovesFromTab,
  availableActions,
  type LogIssue,
  type IssueAction,
} from '../utils/logIssues';
import {
  logIssueActionKey,
  logIssueActionLinks,
  logIssueActionEventIsStale,
  logIssueActionEventIsOutOfOrder,
  logIssueActionLabel,
  type LogIssueAction,
  type LogIssueActionEvent,
  type LogIssueActionLinks,
} from '@shared/utils/logIssueActions';

type LogsTab = 'live' | 'issues' | 'sources';

const OLDER_PAGE_LIMIT = 100;

/** User-facing result copy for a "Clear logs" purge of `purged` records. */
export function clearedLogsMessage(purged: number): string {
  const n = Number.isFinite(purged) && purged > 0 ? Math.floor(purged) : 0;
  if (n === 0) return 'No logs to clear.';
  return `Cleared ${n.toLocaleString()} ${n === 1 ? 'log' : 'logs'}.`;
}

/** Injected dependencies for the destructive clear action (test seam). */
export interface LogClearDeps {
  projectId: string;
  clearLogs: (projectId: string) => Promise<{ purged?: number } | undefined>;
  /** Purge barrier on the live tail hook (detaches socket + rewinds cursor). */
  reset: () => void;
  /** Discard any loaded older-history pages so the view reflects the purge. */
  clearHistory: () => void;
  showToast?: (message: string, kind?: string) => void;
}

/**
 * Execute a "Clear logs" purge: DELETE the records, drop the live tail buffer
 * and loaded history, then toast the outcome. Extracted from the component so
 * the destructive wiring is unit-testable without a native runtime (mobile's
 * test env has no RN event dispatch). On failure nothing is reset and the error
 * is surfaced — a failed purge must not blank the view as if it succeeded.
 */
export async function runLogClear(deps: LogClearDeps): Promise<void> {
  const { projectId, clearLogs, reset, clearHistory, showToast } = deps;
  try {
    const res = await clearLogs(projectId);
    reset();
    clearHistory();
    showToast?.(clearedLogsMessage(typeof res?.purged === 'number' ? res.purged : 0), 'success');
  } catch (err: any) {
    showToast?.(err?.message || 'Failed to clear logs', 'error');
  }
}

/** Alert config for the destructive clear confirmation (title/message/buttons). */
export function buildClearConfirm(onConfirm: () => void): {
  title: string;
  message: string;
  buttons: Array<{ text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }>;
} {
  return {
    title: 'Clear all logs?',
    message:
      'This permanently deletes every ingested log record for this project. This cannot be undone.',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear logs', style: 'destructive', onPress: onConfirm },
    ],
  };
}

/** Semantic severity tone → concrete text colour. */
const TONE_COLOR: Record<SeverityTone, string> = {
  error: colors.red400,
  warn: colors.amber400,
  info: colors.blue400,
  muted: colors.gray400,
};

/** Absolute local timestamp for a millisecond epoch. */
function fmtAbs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

// ── Severity chip ────────────────────────────────────────────────────────────
function SeverityChip({ severityNumber, text }: { severityNumber: number; text: string | null }) {
  const tone = severityToneKey(severityNumber);
  return (
    <Text style={[styles.sevChip, { color: TONE_COLOR[tone], borderColor: TONE_COLOR[tone] }]}>
      {severityLabel(severityNumber, text)}
    </Text>
  );
}

// ── One log record row ───────────────────────────────────────────────────────
export function LogRecordRow({ record }: { record: LogRecord }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = recordHasDetail(record);
  const attributes = expanded ? parseAttributes(record.attributesJson) : [];
  const resource = expanded ? parseAttributes(record.resourceJson) : [];
  const stack = expanded ? extractStackTrace(record.attributesJson) : null;

  return (
    <View style={styles.row} testID="log-record-row">
      <TouchableOpacity
        activeOpacity={hasDetail ? 0.6 : 1}
        onPress={() => hasDetail && setExpanded((v) => !v)}
        style={styles.rowHead}
      >
        <Text style={styles.rowCaret}>{hasDetail ? (expanded ? '▾' : '▸') : ' '}</Text>
        <View style={styles.rowMain}>
          <View style={styles.rowMetaLine}>
            <Text style={styles.rowTime}>{fmtAbs(nanoToMillis(record.timeUnixNano))}</Text>
            <SeverityChip severityNumber={record.severityNumber} text={record.severityText} />
            {record.serviceName ? (
              <Text style={styles.rowService} numberOfLines={1}>
                {record.serviceName}
              </Text>
            ) : null}
            {record.environment ? <Text style={styles.rowEnv}>{record.environment}</Text> : null}
          </View>
          <Text style={styles.rowBody}>{record.body ?? ''}</Text>
        </View>
      </TouchableOpacity>

      {expanded ? (
        <View style={styles.detail}>
          {record.traceId || record.spanId ? (
            <View style={styles.detailKvWrap}>
              {record.traceId ? (
                <Text style={styles.detailMeta}>
                  trace_id: <Text style={styles.detailMetaVal}>{record.traceId}</Text>
                </Text>
              ) : null}
              {record.spanId ? (
                <Text style={styles.detailMeta}>
                  span_id: <Text style={styles.detailMetaVal}>{record.spanId}</Text>
                </Text>
              ) : null}
              <Text style={styles.detailMeta}>
                source: <Text style={styles.detailMetaVal}>{record.sourceId}</Text>
              </Text>
            </View>
          ) : null}

          {stack ? (
            <View>
              <Text style={styles.detailLabel}>Stack trace</Text>
              {/* Horizontal + vertical scroll keeps a wide/tall trace usable on
                  a phone without truncating any frame. */}
              <ScrollView
                style={styles.stackBox}
                horizontal
                showsHorizontalScrollIndicator
                nestedScrollEnabled
              >
                <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
                  <Text style={styles.stackText} selectable>
                    {stack}
                  </Text>
                </ScrollView>
              </ScrollView>
            </View>
          ) : null}

          {attributes.length > 0 ? (
            <KeyValueBlock title="Attributes" rows={attributes} />
          ) : null}
          {resource.length > 0 ? <KeyValueBlock title="Resource" rows={resource} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function KeyValueBlock({ title, rows }: { title: string; rows: Array<{ key: string; value: string }> }) {
  return (
    <View>
      <Text style={styles.detailLabel}>{title}</Text>
      {rows.map((a) => (
        <View key={a.key} style={styles.kvRow}>
          <Text style={styles.kvKey} numberOfLines={1}>
            {a.key}
          </Text>
          <Text style={styles.kvVal} selectable>
            {a.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── Reusable horizontal chip selector (severity / source / environment) ──────
function ChipRow<T extends string | number>({
  options,
  value,
  onChange,
  testID,
}: {
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
  onChange: (v: T) => void;
  testID?: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipScroll}
      contentContainerStyle={styles.chipScrollContent}
      testID={testID}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <TouchableOpacity
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ── Reconnect-status badge ───────────────────────────────────────────────────
function StatusBadge({ status }: { status: LogTailStatus }) {
  if (status === 'open') {
    return <Text style={[styles.statusBadge, { color: colors.emerald400 }]}>● Live</Text>;
  }
  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <Text style={[styles.statusBadge, { color: colors.amber400 }]}>
        ◌ {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
      </Text>
    );
  }
  return <Text style={[styles.statusBadge, { color: colors.gray500 }]}>○ Disconnected</Text>;
}

// ── Live tail view ───────────────────────────────────────────────────────────
export function LiveLogsView({
  projectId,
  showToast,
}: {
  projectId: string;
  showToast?: (message: string, kind?: string) => void;
}) {
  const [rangeMs, setRangeMs] = useState(DEFAULT_TIME_RANGE_MS);
  // Anchor the window's lower bound to when the range was last chosen. Recomputes
  // only when `rangeMs` changes, so live re-renders don't churn the subscription.
  const sinceUnixNano = useMemo(() => resolveSinceUnixNano(rangeMs, Date.now()), [rangeMs]);

  const {
    records,
    status,
    dropped,
    clearDropped,
    paused,
    setPaused,
    pendingCount,
    resume,
    reset,
    error,
  } = useLogTail(projectId, { sinceUnixNano });

  const [minSeverityNumber, setMinSeverityNumber] = useState(0);
  const [sourceId, setSourceId] = useState('');
  const [environment, setEnvironment] = useState('');
  const [text, setText] = useState('');
  const [older, setOlder] = useState<LogRecord[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const filter: LogFilter = useMemo(
    () => ({ minSeverityNumber, sourceId, environment, text }),
    [minSeverityNumber, sourceId, environment, text],
  );

  // Older-history paging is scoped to the active filter. Changing any facet
  // discards prior pages and clears the "exhausted" flag; a generation counter
  // fences an in-flight `loadOlder` so a response for the previous filter is
  // dropped rather than polluting the new filter's pages.
  const filterGenRef = useRef(0);
  useEffect(() => {
    filterGenRef.current += 1;
    setOlder([]);
    setOlderExhausted(false);
    setOlderError(null);
    setLoadingOlder(false);
  }, [minSeverityNumber, sourceId, environment, text, sinceUnixNano]);

  const combined = useMemo(
    () => mergeTailRecords(older, records, records.length + older.length + 1),
    [older, records],
  );
  // `visible` stays ascending because the "Load older" keyset and the cap are
  // defined on that order; only the render flips (see `rendered`).
  const visible = useMemo(() => filterLogRecords(combined, filter), [combined, filter]);
  // One flat list, strictly newest-first: the record that just arrived is the
  // first row, and scrolling down walks steadily back in time to the pager.
  const rendered = useMemo(() => toNewestFirst(visible), [visible]);

  // Auto-scroll stickiness: hold the newest record on screen while the user is
  // pinned to the top, but never yank the viewport when they've scrolled down to
  // read history.
  const listRef = useRef<FlatList<LogRecord>>(null);
  const stickToTopRef = useRef(true);
  const onListScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    stickToTopRef.current = isNearTop({ offsetY: e.nativeEvent.contentOffset.y });
  }, []);
  const onListContentSizeChange = useCallback(() => {
    if (stickToTopRef.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  const sources = useMemo(() => distinctValues(combined, 'sourceId'), [combined]);
  const environments = useMemo(() => distinctValues(combined, 'environment'), [combined]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || olderExhausted) return;
    const gen = filterGenRef.current;
    setLoadingOlder(true);
    setOlderError(null);
    // Keyset + facets come from the same place, so the pager walks the filtered
    // stream it is querying. `visible`, never `combined`: see the helper.
    try {
      const params = buildOlderPageParams({
        visible,
        filter,
        limit: OLDER_PAGE_LIMIT,
        sinceUnixNano,
      });
      const page = (await api.queryLogs(projectId, params)) as {
        records: LogRecord[];
        nextCursor: number | null;
      };
      if (gen !== filterGenRef.current) return; // filter changed mid-flight — drop
      const fetched = Array.isArray(page.records) ? page.records : [];
      if (fetched.length === 0 || page.nextCursor == null) setOlderExhausted(true);
      setOlder((prev) => mergeTailRecords(prev, fetched, prev.length + fetched.length + 1));
    } catch (err: any) {
      if (gen !== filterGenRef.current) return;
      setOlderError(err?.message || 'Failed to load older logs');
    } finally {
      if (gen === filterGenRef.current) setLoadingOlder(false);
    }
  }, [loadingOlder, olderExhausted, visible, filter, projectId, sinceUnixNano]);

  const runClear = useCallback(async () => {
    setClearing(true);
    try {
      await runLogClear({
        projectId,
        clearLogs: api.clearLogs,
        reset,
        // Drop any loaded older-history pages so the view reflects the purge.
        clearHistory: () => {
          setOlder([]);
          setOlderExhausted(true);
          setOlderError(null);
        },
        showToast,
      });
    } finally {
      setClearing(false);
    }
  }, [projectId, reset, showToast]);

  const confirmClear = useCallback(() => {
    if (clearing) return;
    const { title, message, buttons } = buildClearConfirm(() => void runClear());
    Alert.alert(title, message, buttons);
  }, [clearing, runClear]);

  const sourceOptions = useMemo(
    () => [{ label: 'All sources', value: '' }, ...sources.map((s) => ({ label: s, value: s }))],
    [sources],
  );
  const envOptions = useMemo(
    () => [
      { label: 'All environments', value: '' },
      ...environments.map((e) => ({ label: e, value: e })),
    ],
    [environments],
  );

  return (
    <View style={styles.tabBody}>
      {/* Controls */}
      <View style={styles.controls}>
        <View style={styles.controlsTop}>
          <StatusBadge status={status} />
          <TouchableOpacity
            onPress={() => (paused ? resume() : setPaused(true))}
            style={styles.pauseBtn}
            testID="logs-pause-btn"
          >
            <Text style={styles.pauseBtnText}>{paused ? '▶ Resume' : '⏸ Pause'}</Text>
          </TouchableOpacity>
          {paused && pendingCount > 0 ? (
            <TouchableOpacity onPress={resume} style={styles.pendingBtn} testID="logs-pending-btn">
              <Text style={styles.pendingBtnText}>
                {pendingCount} new {pendingCount === 1 ? 'log' : 'logs'}
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={confirmClear}
            disabled={clearing}
            style={[styles.clearBtn, clearing && styles.btnDisabled]}
            testID="logs-clear-btn"
          >
            {clearing ? <ActivityIndicator size="small" color={colors.red400} /> : null}
            <Text style={styles.clearBtnText}>🗑 Clear</Text>
          </TouchableOpacity>
        </View>

        <ChipRow
          options={TIME_RANGES}
          value={rangeMs}
          onChange={setRangeMs}
          testID="logs-range-chips"
        />
        <ChipRow
          options={SEVERITY_BUCKETS}
          value={minSeverityNumber}
          onChange={setMinSeverityNumber}
          testID="logs-severity-chips"
        />
        {sourceOptions.length > 1 ? (
          <ChipRow options={sourceOptions} value={sourceId} onChange={setSourceId} testID="logs-source-chips" />
        ) : null}
        {envOptions.length > 1 ? (
          <ChipRow options={envOptions} value={environment} onChange={setEnvironment} testID="logs-env-chips" />
        ) : null}
        <TextInput
          style={styles.search}
          value={text}
          onChangeText={setText}
          placeholder="Filter text…"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
          autoCorrect={false}
          testID="logs-search"
        />
      </View>

      {/* Dropped-count warning — dismissable one-time notice. */}
      {dropped > 0 ? (
        <View style={styles.droppedBanner} testID="logs-dropped-banner">
          <Text style={styles.droppedText}>
            ⚠ {dropped} {dropped === 1 ? 'record was' : 'records were'} dropped during a live-tail
            burst. Reconnected and backfilled; use “Load older” to inspect the gap.
          </Text>
          <TouchableOpacity onPress={clearDropped} testID="logs-dropped-dismiss">
            <Text style={styles.droppedDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠ {error}</Text>
        </View>
      ) : null}

      {/* Stream — newest first; older history is paged in below it. */}
      {rendered.length === 0 ? (
        <Text style={styles.emptyState}>
          {combined.length === 0
            ? 'No logs yet. Records appear here as your sources ingest them.'
            : 'No logs match the current filters.'}
        </Text>
      ) : (
        <FlatList
          ref={listRef}
          data={rendered}
          keyExtractor={(r) => String(r.id)}
          renderItem={({ item }) => <LogRecordRow record={item} />}
          style={styles.stream}
          contentContainerStyle={styles.streamContent}
          onScroll={onListScroll}
          scrollEventThrottle={16}
          onContentSizeChange={onListContentSizeChange}
          // Keep the viewport anchored when live records are inserted above, so
          // the row the user is reading doesn't slide away.
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        />
      )}

      {/* Older-history pager — at the foot of the stream, where the oldest rows
          are, so paging in history extends the list downwards. */}
      <View style={styles.olderRow}>
        {olderExhausted ? (
          <Text style={styles.olderExhausted}>Beginning of retained history.</Text>
        ) : (
          <TouchableOpacity
            onPress={loadOlder}
            disabled={loadingOlder}
            style={[styles.olderBtn, loadingOlder && styles.btnDisabled]}
            testID="logs-load-older"
          >
            {loadingOlder ? <ActivityIndicator size="small" color={colors.gray400} /> : null}
            <Text style={styles.olderBtnText}>Load older</Text>
          </TouchableOpacity>
        )}
        {olderError ? <Text style={styles.olderError}>{olderError}</Text> : null}
      </View>
    </View>
  );
}

// ── Issues view ──────────────────────────────────────────────────────────────
const ACTION_LABEL: Record<IssueAction, string> = {
  resolve: 'Resolve',
  ignore: 'Ignore',
  reopen: 'Reopen',
};

function IssueStatusChip({ status }: { status: LogIssue['status'] }) {
  const tone =
    status === 'open' ? colors.red400 : status === 'resolved' ? colors.emerald400 : colors.gray400;
  return <Text style={[styles.issueStatus, { color: tone, borderColor: tone }]}>{status}</Text>;
}

export function IssuesView({
  projectId,
  showToast,
  onOpenSession,
  actionEvent,
}: {
  projectId: string;
  showToast?: (message: string, kind?: string) => void;
  onOpenSession?: (target: { sessionId: string; agentId: string }) => void;
  actionEvent?: LogIssueActionEvent | null;
}) {
  const [status, setStatus] = useState('open');
  const [issues, setIssues] = useState<LogIssue[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogIssue | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [actionEvents, setActionEvents] = useState<Record<string, LogIssueActionEvent>>({});
  const actionInFlightRef = useRef(new Set<string>());
  const actionFallbackLinksRef = useRef<Record<string, LogIssueActionLinks>>({});
  const actionEventRef = useRef<Record<string, LogIssueActionEvent>>({});

  // Monotonic request id. Each load captures its seq; a response whose seq is no
  // longer current (the status tab or project changed before it resolved) is
  // dropped so a slow 'open' page can never commit under the 'ignored' tab.
  const loadSeqRef = useRef(0);
  // Same guard for the per-issue detail fetch: tapping another issue or a
  // project/status change bumps this, so a slow `getLogIssue` can never commit
  // its detail into the newly-expanded (or collapsed) issue.
  const detailSeqRef = useRef(0);

  const load = useCallback(
    async (opts: { append: boolean; cursor?: number | null } = { append: false }) => {
      const seq = ++loadSeqRef.current;
      if (opts.append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setLoadingMore(false);
      }
      setError(null);
      try {
        const params: Record<string, unknown> = { limit: 50 };
        if (status) params.status = status;
        if (opts.append && opts.cursor != null) params.cursor = opts.cursor;
        const page = (await api.listLogIssues(projectId, params)) as {
          issues: LogIssue[];
          nextCursor: number | null;
        };
        if (seq !== loadSeqRef.current) return; // superseded — drop the stale page
        setIssues((prev) => mergeIssuePage(prev, page.issues, opts.append));
        setCursor(page.nextCursor ?? null);
      } catch (err: any) {
        if (seq !== loadSeqRef.current) return;
        setError(err?.message || 'Failed to load issues');
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [projectId, status],
  );

  useEffect(() => {
    // A project/status change collapses any open row and invalidates an
    // in-flight detail fetch so its late response can't reopen a stale issue.
    detailSeqRef.current += 1;
    setExpandedId(null);
    setDetail(null);
    setDetailLoading(false);
    void load({ append: false });
  }, [load]);

  // AppContext owns the main WebSocket on mobile and supplies the latest
  // project-scoped Logs action event. Reconcile it into the same state used by
  // the local REST action so another device/tab is visible immediately.
  useEffect(() => {
    const data = actionEvent;
    if (!data || data.projectId !== projectId || !data.issueId) return;
    const key = logIssueActionKey(data.issueId, data.action);
    const previousEvent = actionEventRef.current[key];
    if (logIssueActionEventIsOutOfOrder(previousEvent, data)) return;
    actionEventRef.current[key] = data;
    const reconcile = (
      issue: LogIssue,
      fallbackLinks = actionFallbackLinksRef.current[key],
    ): LogIssue => {
      const links = logIssueActionLinks(issue, data.action);
      if (logIssueActionEventIsStale(links, data)) return issue;
      if (data.status === 'failed') {
        if (fallbackLinks) {
          return data.action === 'analyze'
            ? { ...issue, analyzeSessionId: fallbackLinks.sessionId }
            : { ...issue, fixSessionId: fallbackLinks.sessionId, fixCardId: fallbackLinks.cardId };
        }
        return data.action === 'analyze'
          ? { ...issue, analyzeSessionId: null }
          : { ...issue, fixSessionId: null, fixCardId: null };
      }
      return data.action === 'analyze'
        ? { ...issue, analyzeSessionId: data.sessionId || issue.analyzeSessionId }
        : {
            ...issue,
            fixSessionId: data.sessionId || issue.fixSessionId,
            fixCardId: data.cardId || issue.fixCardId,
          };
    };
    const captureFallback = (issue: LogIssue): void => {
      const links = logIssueActionLinks(issue, data.action);
      const replacesExisting =
        (data.sessionId && links.sessionId && data.sessionId !== links.sessionId) ||
        (data.cardId && links.cardId && data.cardId !== links.cardId);
      if (
        data.status === 'in_flight' &&
        replacesExisting &&
        (links.sessionId || links.cardId) &&
        !actionFallbackLinksRef.current[key]
      ) {
        actionFallbackLinksRef.current[key] = links;
      }
    };
    setActionEvents((prev) => ({ ...prev, [key]: data }));
    if (data.status === 'failed') {
      setActionErrors((prev) => ({ ...prev, [key]: data.error || 'Action failed' }));
      setIssues((prev) => prev.map((issue) => (issue.id === data.issueId ? reconcile(issue) : issue)));
      setDetail((prev) => (prev?.id === data.issueId ? reconcile(prev) : prev));
    } else if (data.status === 'in_flight') {
      setActionErrors((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setIssues((prev) =>
        prev.map((issue) => {
          if (issue.id !== data.issueId) return issue;
          captureFallback(issue);
          return reconcile(issue);
        }),
      );
      setDetail((prev) => {
        if (prev?.id !== data.issueId) return prev;
        captureFallback(prev);
        return reconcile(prev);
      });
    }
    if (data.status === 'completed') {
      delete actionFallbackLinksRef.current[key];
      setIssues((prev) => prev.map((issue) => (issue.id === data.issueId ? reconcile(issue) : issue)));
      setDetail((prev) => (prev?.id === data.issueId ? reconcile(prev) : prev));
    }
  }, [actionEvent, projectId]);

  const openDetail = useCallback(
    async (issue: LogIssue) => {
      if (expandedId === issue.id) {
        detailSeqRef.current += 1; // collapsing — drop any in-flight fetch
        setExpandedId(null);
        setDetailLoading(false);
        return;
      }
      const seq = ++detailSeqRef.current;
      setExpandedId(issue.id);
      setDetail(null);
      setDetailLoading(true);
      try {
        const full = (await api.getLogIssue(projectId, issue.id)) as LogIssue;
        if (seq !== detailSeqRef.current) return; // superseded — drop stale detail
        setDetail(full);
      } catch (err: any) {
        if (seq !== detailSeqRef.current) return;
        setError(err?.message || 'Failed to load issue detail');
      } finally {
        if (seq === detailSeqRef.current) setDetailLoading(false);
      }
    },
    [expandedId, projectId],
  );

  const transition = useCallback(
    async (issue: LogIssue, action: IssueAction) => {
      setMutatingId(issue.id);
      try {
        const fn =
          action === 'resolve'
            ? api.resolveLogIssue
            : action === 'ignore'
              ? api.ignoreLogIssue
              : api.reopenLogIssue;
        const updated = (await fn(projectId, issue.id)) as LogIssue;
        const removed = transitionRemovesFromTab(updated, status);
        setIssues((prev) => applyTransitionToList(prev, issue.id, updated, status));
        if (removed) {
          // The row left the current filtered tab — collapse it so a stale
          // detail panel doesn't hang under a now-absent row.
          detailSeqRef.current += 1;
          setExpandedId((cur) => (cur === issue.id ? null : cur));
          setDetail((prev) => (prev && prev.id === issue.id ? null : prev));
        } else {
          setDetail((prev) => (prev && prev.id === issue.id ? { ...prev, ...updated } : prev));
        }
        showToast?.(`Issue ${updated.status}`, 'success');
      } catch (err: any) {
        showToast?.(err?.message || 'Update failed', 'error');
      } finally {
        setMutatingId(null);
      }
    },
    [projectId, showToast, status],
  );

  const runAction = useCallback(
    async (action: LogIssueAction, issue: LogIssue, startAnother = false) => {
      const key = logIssueActionKey(issue.id, action);
      if (actionInFlightRef.current.has(key)) return;
      actionInFlightRef.current.add(key);
      if (startAnother && !actionFallbackLinksRef.current[key]) {
        const links = logIssueActionLinks(issue, action);
        if (links.sessionId || links.cardId) actionFallbackLinksRef.current[key] = links;
      }
      if (action === 'analyze') setAnalyzingId(issue.id);
      else setFixingId(issue.id);
      setActionErrors((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        const result = (await (action === 'analyze'
          ? startAnother
            ? api.analyzeLogIssue(projectId, issue.id, { startAnother: true })
            : api.analyzeLogIssue(projectId, issue.id)
          : startAnother
            ? api.fixLogIssue(projectId, issue.id, { startAnother: true })
            : api.fixLogIssue(projectId, issue.id))) as {
          sessionId: string;
          agentId: string;
          reused: boolean;
          issue: LogIssue;
          cardId?: string;
        };
        setIssues((prev) => applyIssueUpdate(prev, issue.id, result.issue));
        setDetail((prev) => (prev && prev.id === issue.id ? { ...prev, ...result.issue } : prev));
        const completedEvent: LogIssueActionEvent = {
          type: 'log_issue_action',
          projectId,
          issueId: issue.id,
          action,
          status: 'completed',
          sessionId: result.sessionId,
          agentId: result.agentId,
          cardId: result.cardId || result.issue?.fixCardId,
        };
        actionEventRef.current[key] = completedEvent;
        setActionEvents((prev) => ({ ...prev, [key]: completedEvent }));
        delete actionFallbackLinksRef.current[key];
        showToast?.(
          result.reused
            ? `${logIssueActionLabel(action)} ${action === 'analyze' ? 'session' : 'workflow'} reopened`
            : `${logIssueActionLabel(action)} started`,
          'success',
        );
        onOpenSession?.({ sessionId: result.sessionId, agentId: result.agentId });
      } catch (err: any) {
        const message = err?.message || `Failed to start ${action}`;
        const fallbackLinks = actionFallbackLinksRef.current[key];
        if (fallbackLinks) {
          setIssues((prev) =>
            prev.map((current) =>
              current.id !== issue.id
                ? current
                : action === 'analyze'
                  ? { ...current, analyzeSessionId: fallbackLinks.sessionId }
                  : {
                      ...current,
                      fixSessionId: fallbackLinks.sessionId,
                      fixCardId: fallbackLinks.cardId,
                    },
            ),
          );
          setDetail((current) =>
            current?.id !== issue.id
              ? current
              : action === 'analyze'
                ? { ...current, analyzeSessionId: fallbackLinks.sessionId }
                : {
                    ...current,
                    fixSessionId: fallbackLinks.sessionId,
                    fixCardId: fallbackLinks.cardId,
                  },
          );
        }
        setActionErrors((prev) => ({ ...prev, [key]: message }));
        const failedEvent: LogIssueActionEvent = {
          type: 'log_issue_action',
          projectId,
          issueId: issue.id,
          action,
          status: 'failed',
          error: message,
        };
        actionEventRef.current[key] = failedEvent;
        setActionEvents((prev) => ({ ...prev, [key]: failedEvent }));
        showToast?.(message, 'error');
      } finally {
        actionInFlightRef.current.delete(key);
        if (action === 'analyze') setAnalyzingId(null);
        else setFixingId(null);
      }
    },
    [onOpenSession, projectId, showToast],
  );

  const renderIssue = (issue: LogIssue) => {
    const isOpen = expandedId === issue.id;
    return (
      <View key={issue.id} style={styles.issueCard} testID="log-issue-card">
        <TouchableOpacity onPress={() => openDetail(issue)} style={styles.issueHead}>
          <Text style={styles.issueCaret}>{isOpen ? '▾' : '▸'}</Text>
          <View style={styles.issueMain}>
            <Text style={styles.issueTitle} numberOfLines={2}>
              <Text style={styles.issueException}>{issue.exceptionType || 'error'} </Text>
              {issueDisplayTitle(issue)}
            </Text>
            <Text style={styles.issueMeta} numberOfLines={1}>
              {[
                issue.service || null,
                issue.environment || null,
                `${issue.eventCount.toLocaleString()} events`,
                `last ${relativeTime(issue.lastSeen) || 'just now'}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <IssueStatusChip status={issue.status} />
        </TouchableOpacity>

        {isOpen ? (
          <View style={styles.issueDetail}>
            <Text style={styles.actionHint}>
              Analyze is read-only and makes no edits. Fix inherits your project Finalize automation default.
            </Text>
            <View style={styles.issueActions}>
              {(() => {
                const analyzeKey = logIssueActionKey(issue.id, 'analyze');
                const fixKey = logIssueActionKey(issue.id, 'fix');
                const analyzeLinks = logIssueActionLinks(issue, 'analyze');
                const fixLinks = logIssueActionLinks(issue, 'fix');
                const analyzeBusy = analyzingId === issue.id || actionEvents[analyzeKey]?.status === 'in_flight';
                const fixBusy = fixingId === issue.id || actionEvents[fixKey]?.status === 'in_flight';
                const fixCompleted = actionEvents[fixKey]?.status === 'completed';
                const analyzeCompleted = actionEvents[analyzeKey]?.status === 'completed';
                return (
                  <>
              <TouchableOpacity
                disabled={fixBusy}
                onPress={() => void runAction('fix', detail ?? issue)}
                style={[styles.issueActionBtn, fixBusy && styles.btnDisabled]}
                testID="log-issue-fix"
              >
                {fixBusy ? <ActivityIndicator size="small" color={colors.amber400} /> : null}
                <Text style={styles.issueActionText}>{fixBusy ? 'Starting Fix…' : fixLinks.sessionId ? 'Open fix' : 'Fix'}</Text>
              </TouchableOpacity>
              {fixLinks.sessionId ? <TouchableOpacity onPress={() => void runAction('fix', detail ?? issue, true)} style={styles.issueActionBtn} testID="log-issue-start-another-fix"><Text style={styles.issueActionText}>Start another fix</Text></TouchableOpacity> : null}
              <TouchableOpacity
                disabled={analyzeBusy}
                onPress={() => void runAction('analyze', detail ?? issue)}
                style={[styles.issueActionBtn, analyzeBusy && styles.btnDisabled]}
                testID="log-issue-analyze"
              >
                {analyzeBusy ? <ActivityIndicator size="small" color={colors.purple400} /> : null}
                <Text style={styles.issueActionText}>{analyzeBusy ? 'Starting Analyze…' : analyzeLinks.sessionId ? 'Open analysis' : 'Analyze'}</Text>
              </TouchableOpacity>
              {analyzeLinks.sessionId ? <TouchableOpacity onPress={() => void runAction('analyze', detail ?? issue, true)} style={styles.issueActionBtn} testID="log-issue-start-another-analysis"><Text style={styles.issueActionText}>Start another analysis</Text></TouchableOpacity> : null}
              {actionErrors[fixKey] ? <Text style={styles.actionError}>Fix failed: {actionErrors[fixKey]}</Text> : null}
              {actionErrors[analyzeKey] ? <Text style={styles.actionError}>Analyze failed: {actionErrors[analyzeKey]}</Text> : null}
              {fixLinks.cardId ? <Text style={styles.actionLinked}>{fixCompleted ? 'Fix completed · ' : 'Fix card linked · '}{fixLinks.cardId.slice(0, 8)}</Text> : null}
              {analyzeLinks.sessionId ? <Text style={styles.actionLinked}>{analyzeCompleted ? 'Analyze completed · ' : 'Analysis session linked · '}{analyzeLinks.sessionId.slice(0, 8)}</Text> : null}
                  </>
                );
              })()}
              {availableActions(issue.status).map((action) => (
                <TouchableOpacity
                  key={action}
                  disabled={mutatingId === issue.id}
                  onPress={() => transition(issue, action)}
                  style={[styles.issueActionBtn, mutatingId === issue.id && styles.btnDisabled]}
                  testID={`log-issue-${action}`}
                >
                  <Text style={styles.issueActionText}>{ACTION_LABEL[action]}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.issueFacts}>
              <Fact label="First seen" value={fmtAbs(issue.firstSeen)} />
              <Fact label="Last seen" value={fmtAbs(issue.lastSeen)} />
              <Fact label="Events" value={issue.eventCount.toLocaleString()} />
              <Fact label="Fingerprint" value={issue.fingerprint.slice(0, 12)} mono />
            </View>

            {detailLoading && !detail ? (
              <View style={styles.inlineLoad}>
                <ActivityIndicator size="small" color={colors.gray400} />
                <Text style={styles.inlineLoadText}>Loading detail…</Text>
              </View>
            ) : null}

            {detail && detail.id === issue.id ? (
              <>
                {detail.releases && detail.releases.length > 0 ? (
                  <View>
                    <Text style={styles.detailLabel}>Affected releases</Text>
                    <View style={styles.releaseWrap}>
                      {detail.releases.map((r, idx) => (
                        <Text
                          key={`${r.release ?? 'none'}-${r.commitSha ?? idx}`}
                          style={styles.releaseChip}
                        >
                          🏷 {r.release || 'unversioned'}
                          {r.commitSha ? ` @${r.commitSha.slice(0, 7)}` : ''} (
                          {r.eventCount.toLocaleString()})
                        </Text>
                      ))}
                    </View>
                  </View>
                ) : null}

                <Text style={styles.detailLabel}>Recent samples</Text>
                <View style={styles.sampleBox}>
                  {detail.samples && detail.samples.length > 0 ? (
                    detail.samples.map((s) => <LogRecordRow key={s.id} record={s} />)
                  ) : (
                    <Text style={styles.hint}>No sample records.</Text>
                  )}
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.tabBody}>
      <ChipRow
        options={STATUS_TABS.map((t) => ({ label: t.label, value: t.key }))}
        value={status}
        onChange={setStatus}
        testID="logs-issue-status-tabs"
      />
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠ {error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.inlineLoad}>
          <ActivityIndicator size="small" color={colors.gray400} />
          <Text style={styles.inlineLoadText}>Loading issues…</Text>
        </View>
      ) : issues.length === 0 ? (
        <Text style={styles.emptyState}>
          No {status || ''} error issues. Grouped errors appear here once an ERROR-level record is
          ingested.
        </Text>
      ) : (
        <ScrollView style={styles.stream} contentContainerStyle={styles.streamContent}>
          {issues.map(renderIssue)}
          {cursor != null ? (
            <TouchableOpacity
              onPress={() => load({ append: true, cursor })}
              disabled={loadingMore}
              style={[styles.olderBtn, loadingMore && styles.btnDisabled]}
              testID="logs-issue-load-more"
            >
              {loadingMore ? <ActivityIndicator size="small" color={colors.gray400} /> : null}
              <Text style={styles.olderBtnText}>Load more</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, mono && styles.mono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

// ── Module shell ─────────────────────────────────────────────────────────────
const TABS: ReadonlyArray<{ key: LogsTab; label: string }> = [
  { key: 'live', label: 'Live' },
  { key: 'issues', label: 'Issues' },
  { key: 'sources', label: 'Sources' },
];

export default function LogsScreen({ route, navigation }: any) {
  const { projectId, project, initialTab } = route.params || {};
  const { setActiveAgentId, setActiveSessionId, lastLogIssueActionEvent } = useApp();
  const [tab, setTab] = useState<LogsTab>(initialTab || 'live');
  const openSession = useCallback(
    ({ sessionId, agentId }: { sessionId: string; agentId: string }) => {
      setActiveAgentId(agentId);
      setActiveSessionId(sessionId);
      navigation.navigate('Chat');
    },
    [navigation, setActiveAgentId, setActiveSessionId],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Logs" project={project} onBack={() => navigation.goBack()} />
      <View style={styles.tabBar} testID="logs-tab-bar">
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]}
            testID={`logs-tab-${t.key}`}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'live' ? (
        <LiveLogsView
          projectId={projectId}
          showToast={(message) => {
            // No global toast on mobile; surface the purge result (and any
            // failure) via an Alert so the destructive action is acknowledged.
            Alert.alert('Logs', message);
          }}
        />
      ) : tab === 'issues' ? (
        <IssuesView
          projectId={projectId}
          actionEvent={lastLogIssueActionEvent}
          onOpenSession={openSession}
          showToast={(message, kind) => {
            // No global toast on mobile; a successful transition is already
            // visible via the status chip, so only surface failures.
            if (kind === 'error') Alert.alert('Logs', message);
          }}
        />
      ) : (
        <LogSourcesPanel projectId={projectId} onOpenSession={openSession} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    paddingHorizontal: 8,
  },
  tabBtn: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: colors.blue500 },
  tabText: { fontSize: 14, color: colors.gray400 },
  tabTextActive: { color: colors.white, fontWeight: '600' },
  tabBody: { flex: 1 },

  controls: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 6,
  },
  controlsTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusBadge: { fontSize: 12, fontWeight: '600' },
  pauseBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pauseBtnText: { fontSize: 12, color: colors.gray200 },
  pendingBtn: { backgroundColor: colors.blue600, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  pendingBtnText: { fontSize: 12, color: colors.white },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  clearBtnText: { fontSize: 12, color: colors.red400 },

  chipScroll: { flexGrow: 0 },
  chipScrollContent: { gap: 6, paddingRight: 12 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipActive: { backgroundColor: colors.gray700, borderColor: colors.gray600 },
  chipText: { fontSize: 12, color: colors.gray400 },
  chipTextActive: { color: colors.white },

  search: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: colors.white,
    fontSize: 13,
  },

  droppedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.amber900_40,
    backgroundColor: colors.yellow900_50,
  },
  droppedText: { flex: 1, fontSize: 12, color: colors.amber400 },
  droppedDismiss: { fontSize: 14, color: colors.amber400, paddingHorizontal: 4 },
  errorBanner: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.red900_50,
    backgroundColor: colors.red900_50,
  },
  errorText: { fontSize: 12, color: colors.red400 },

  olderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  olderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  olderBtnText: { fontSize: 12, color: colors.gray300 },
  olderExhausted: { fontSize: 12, color: colors.gray600 },
  olderError: { fontSize: 12, color: colors.red400 },
  btnDisabled: { opacity: 0.5 },

  emptyState: { padding: 24, textAlign: 'center', color: colors.gray500, fontSize: 13 },
  stream: { flex: 1 },
  streamContent: { paddingBottom: 24 },

  row: { borderBottomWidth: 1, borderBottomColor: colors.gray800 },
  rowHead: { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 6, gap: 6 },
  rowCaret: { color: colors.gray500, fontSize: 12, width: 12, marginTop: 2 },
  rowMain: { flex: 1 },
  rowMetaLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  rowTime: { fontSize: 10, color: colors.gray500, fontFamily: 'monospace' },
  sevChip: {
    fontSize: 9,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 3,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  rowService: { fontSize: 11, color: colors.blue300 },
  rowEnv: {
    fontSize: 9,
    color: colors.gray300,
    backgroundColor: colors.gray700_40,
    paddingHorizontal: 4,
    borderRadius: 3,
    overflow: 'hidden',
  },
  rowBody: { fontSize: 12, color: colors.gray200, fontFamily: 'monospace', marginTop: 2 },

  detail: { backgroundColor: colors.gray900, paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  detailKvWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  detailMeta: { fontSize: 11, color: colors.gray400, fontFamily: 'monospace' },
  detailMetaVal: { color: colors.gray200 },
  detailLabel: { fontSize: 11, fontWeight: '700', color: colors.gray400, marginBottom: 2 },
  stackBox: { maxHeight: 220, backgroundColor: colors.black60, borderRadius: 6, padding: 8 },
  stackText: { fontSize: 11, color: colors.gray200, fontFamily: 'monospace' },
  kvRow: { flexDirection: 'row', gap: 8, marginBottom: 2 },
  kvKey: { width: 120, fontSize: 11, color: colors.gray500, fontFamily: 'monospace' },
  kvVal: { flex: 1, fontSize: 11, color: colors.gray200, fontFamily: 'monospace' },

  issueCard: {
    marginHorizontal: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  issueHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10 },
  issueCaret: { color: colors.gray500, fontSize: 12, marginTop: 2 },
  issueMain: { flex: 1 },
  issueTitle: { fontSize: 13, color: colors.gray100 },
  issueException: { color: colors.red400, fontWeight: '700', fontSize: 11 },
  issueMeta: { fontSize: 11, color: colors.gray500, marginTop: 2 },
  issueStatus: {
    fontSize: 9,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: 'hidden',
    textTransform: 'uppercase',
  },
  issueDetail: { borderTopWidth: 1, borderTopColor: colors.gray800, padding: 10, gap: 8 },
  issueActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionHint: { color: colors.gray400, fontSize: 11, lineHeight: 16 },
  actionError: { color: colors.red400, fontSize: 11, width: '100%' },
  actionLinked: { color: colors.gray400, fontSize: 11, width: '100%' },
  issueActionBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  issueActionText: { fontSize: 12, color: colors.gray200 },
  issueFacts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fact: { minWidth: 80 },
  factLabel: { fontSize: 10, color: colors.gray600 },
  factValue: { fontSize: 12, color: colors.gray200 },
  mono: { fontFamily: 'monospace' },
  releaseWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  releaseChip: {
    fontSize: 11,
    color: colors.gray300,
    backgroundColor: colors.gray800,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  sampleBox: { borderWidth: 1, borderColor: colors.gray800, borderRadius: 6, overflow: 'hidden' },
  hint: { fontSize: 12, color: colors.gray600, padding: 10 },
  inlineLoad: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16 },
  inlineLoadText: { fontSize: 13, color: colors.gray500 },
});
