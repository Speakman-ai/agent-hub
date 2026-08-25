import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Modal,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { getServerBaseUrl } from '../utils/config';
import {
  formatReplayDuration,
  formatBytes,
  formatPageUrl,
  formatSessionStart,
  formatCaptureDate,
} from '../utils/replayFormat';
import ReplayWebViewPlayer from '../components/ReplayWebViewPlayer';
import { ReplayPlaylistsView, AddToPlaylistModal } from '../components/ReplayPlaylistsView';
import {
  TIME_RANGES,
  DEFAULT_RANGE_ID,
  rangeMsFor,
  TEXT_FACETS,
  COUNT_FACETS,
  SESSIONS_PAGE_SIZE,
  REPLAYS_PAGE_SIZE,
  REPLAY_KIND_FILTERS,
  buildRumSessionParams,
  sameFilters,
  hasActiveFilters,
  visibleReplayLinkFilters,
  type FilterDraft,
} from '../utils/rumSessionFilters';

// Mobile Replays / RUM dashboard — 1:1 parity port of the web
// ReplaysDashboardPage (client/src/components/ReplaysDashboardPage.tsx) and its
// two tabs: the session-grain Datadog Explorer (RumSessionsExplorer) and the
// capture-grain table (ReplayCaptureTable). Filter/query logic lives in the
// pure `rumSessionFilters` + `replayFormat` utils so it stays testable and
// identical to web.

const VIEWS: { id: 'sessions' | 'replays' | 'playlists'; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'replays', label: 'Replays' },
  { id: 'playlists', label: 'Playlists' },
];

/** Deep link to the web app's Replays dashboard for a project — the handoff
 *  target for playback (no mobile rrweb player yet) and ticket-linking (no
 *  mobile picker yet). Returns '' when the server base or project is unknown so
 *  callers can hide the control. */
export function buildWebReplaysUrl(projectId: string, base: string = getServerBaseUrl()): string {
  return base && projectId ? `${base}/replays/${encodeURIComponent(projectId)}` : '';
}

/** Detach a replay from its ticket, then reload the list. Swallows transient
 *  failures (the row is left as-is). Extracted so the unlink → reload path is
 *  unit-testable without driving RN touch events. */
export async function unlinkReplayCapture({ api: apiClient, projectId, replayId, reload }: any) {
  try {
    await apiClient.unlinkReplay(projectId, replayId);
    await reload();
  } catch {
    /* transient — leave the row as-is */
  }
}

// ── Extended-retention flag ─────────────────────────────────────────
// Flag / unflag a monolithic capture for extended retention (up to 15 months;
// the clock starts now). Returns the new `retainedUntil` — the server's echoed
// value, or a SQLite-UTC (`YYYY-MM-DD HH:MM:SS`) truthiness sentinel matching
// what the server stores when the response omitted it (null when unflagging).
// `nowIso` is injected so the fallback is deterministic in tests. Extracted from
// the modal so the toggle path is unit-testable without RN touch events. Mirrors
// the web ReplayPlayerModal toggle.
export async function setReplayRetentionFlag({
  api: apiClient,
  replayId,
  extend,
  nowIso,
}: any): Promise<string | null> {
  const updated = await apiClient.setReplayRetention(replayId, extend);
  const stamp = (nowIso || new Date().toISOString()).slice(0, 19).replace('T', ' ');
  return updated?.retainedUntil ?? (extend ? stamp : null);
}

// ── Session player ──────────────────────────────────────────────────
// Full-screen in-app rrweb player. Embeds ReplayWebViewPlayer, which streams the
// session's segments (or a monolithic capture's paginated events) into an
// opaque-origin WebView and renders playback + view-chapter seek. For a
// monolithic capture (a `session_replays` row) the footer also exposes the
// Keep control that flags the capture for extended retention. Segmented session
// playback has no `session_replays` row, so retention flagging is not offered
// there. The web-app handoff stays as a secondary action.
export function ReplayPlayerModal({ target, projectId, onClose }: any) {
  // Only monolithic captures (mode 'replay') carry a session_replays row that
  // can be retention-flagged. Segmented sessions expose no Keep control.
  const replayId = target?.mode === 'replay' ? target?.replayId : null;
  const [retainedUntil, setRetainedUntil] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  useEffect(() => {
    if (!replayId) {
      setRetainedUntil(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const meta = await api.getReplay(replayId);
        if (!cancelled) setRetainedUntil(meta?.retainedUntil ?? null);
      } catch {
        /* metadata is best-effort; the player still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replayId]);

  const toggleKeep = async () => {
    if (!replayId || flagBusy) return;
    setFlagBusy(true);
    try {
      const next = await setReplayRetentionFlag({ api, replayId, extend: !retainedUntil });
      setRetainedUntil(next);
    } catch {
      /* leave the prior state; the button re-enables for a retry */
    } finally {
      setFlagBusy(false);
    }
  };

  if (!target) return null;
  const webUrl = buildWebReplaysUrl(projectId);
  const kept = Boolean(retainedUntil);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.playerBackdrop}>
        <View style={styles.playerCard} testID="replay-player-modal">
          <View style={styles.playerHeader}>
            <Text style={styles.playerTitle} numberOfLines={1}>
              {target.title || 'Session replay'}
            </Text>
            <TouchableOpacity
              testID="replay-player-close"
              onPress={onClose}
              style={styles.playerClose}
            >
              <Text style={styles.playerCloseText}>✕</Text>
            </TouchableOpacity>
          </View>
          {(target.meta || []).length > 0 ? (
            <View style={styles.metaStrip}>
              {(target.meta || []).map((m: any) => (
                <Text key={m.label} style={styles.metaStripItem}>
                  <Text style={styles.metaLabel}>{m.label}: </Text>
                  {m.value}
                </Text>
              ))}
            </View>
          ) : null}
          <ReplayWebViewPlayer
            target={{ mode: target.mode, sessionId: target.sessionId, replayId: target.replayId }}
          />
          <View style={styles.playerFooter}>
            {replayId ? (
              <TouchableOpacity
                testID="replay-retention-toggle"
                accessibilityRole="switch"
                accessibilityState={{ checked: kept }}
                accessibilityLabel="Toggle extended retention for this session"
                disabled={flagBusy}
                onPress={toggleKeep}
                style={[
                  styles.playerFooterBtn,
                  styles.keepBtn,
                  kept && styles.keepBtnActive,
                  flagBusy && styles.keepBtnBusy,
                ]}
              >
                <Text style={[styles.playerFooterText, kept && styles.keepTextActive]}>
                  {kept ? '★ Kept' : '☆ Keep'}
                </Text>
              </TouchableOpacity>
            ) : null}
            {webUrl ? (
              <TouchableOpacity
                testID="replay-open-web"
                onPress={() => Linking.openURL(webUrl).catch(() => {})}
                style={styles.playerFooterBtn}
              >
                <Text style={styles.playerFooterText}>Open in web app</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Session row ─────────────────────────────────────────────────────
export function RumSessionRow({ session, onPlay }: any) {
  const s = session;
  const user = s.usrEmail || s.usrName || s.usrId;
  return (
    <TouchableOpacity
      testID="rum-session-row"
      onPress={() => onPlay?.(s)}
      style={styles.card}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeaderRow}>
        <Text style={styles.cardUser} numberOfLines={1}>
          {user || 'Anonymous'}
        </Text>
        <Text style={styles.playBadge}>▶</Text>
      </View>
      <Text style={styles.cardSub}>{formatSessionStart(s.startedAt)}</Text>
      <View style={styles.statRow}>
        <Stat label="Duration" value={formatReplayDuration(s.timeSpent)} />
        <Stat label="Views" value={String(s.viewCount ?? 0)} />
        <Stat label="Actions" value={String(s.actionCount ?? 0)} />
        <Stat label="Errors" value={String(s.errorCount ?? 0)} danger={(s.errorCount ?? 0) > 0} />
        <Stat
          label="Frustrations"
          value={String(s.frustrationCount ?? 0)}
          warn={(s.frustrationCount ?? 0) > 0}
        />
      </View>
      <View style={styles.tagRow}>
        {[s.deviceType, s.browser, s.os, s.geoCountry].filter(Boolean).map((t: any, i: number) => (
          <Text key={`${t}-${i}`} style={styles.tag}>
            {t}
          </Text>
        ))}
      </View>
    </TouchableOpacity>
  );
}

// ── Capture row ─────────────────────────────────────────────────────
export function ReplayCaptureRow({ replay, onWatch, onLink, onUnlink, onAddToPlaylist }: any) {
  const r = replay;
  return (
    <View testID="replay-capture-row" style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <Text style={styles.cardUser} numberOfLines={1}>
          {formatPageUrl(r.pageUrl)}
        </Text>
        {r.live ? (
          <Text style={[styles.chip, styles.chipLive]}>LIVE</Text>
        ) : r.captureKind === 'continuous' ? (
          <Text style={[styles.chip, styles.chipContinuous]}>continuous</Text>
        ) : null}
        {r.orphaned ? <Text style={[styles.chip, styles.chipOrphan]}>orphaned</Text> : null}
      </View>
      <Text style={styles.cardSub}>{formatCaptureDate(r.createdAt)}</Text>
      {r.errorMessage ? (
        <Text style={styles.errorLine} numberOfLines={1}>
          {r.errorMessage}
        </Text>
      ) : null}
      <View style={styles.statRow}>
        <Stat label="Time" value={formatReplayDuration(r.durationMs)} />
        <Stat label="Events" value={String(r.eventCount ?? 0)} />
        <Stat label="Size" value={formatBytes(r.size)} />
      </View>
      {r.ticket ? (
        <Text style={styles.ticketLine} numberOfLines={1}>
          🔗 {r.ticket.subject || r.ticket.id}
        </Text>
      ) : null}
      <View style={styles.actionRow}>
        <TouchableOpacity
          testID="replay-watch"
          onPress={() => onWatch?.(r)}
          style={styles.actionBtn}
        >
          <Text style={styles.actionText}>▶ Watch</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="replay-add-playlist"
          onPress={() => onAddToPlaylist?.(r)}
          style={styles.actionBtn}
        >
          <Text style={styles.actionText}>Playlist</Text>
        </TouchableOpacity>
        {r.ticket ? (
          <TouchableOpacity onPress={() => onUnlink?.(r)} style={styles.actionBtn}>
            <Text style={styles.actionText}>Unlink</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => onLink?.(r)}
            style={[styles.actionBtn, styles.actionBtnPrimary]}
          >
            <Text style={styles.actionTextPrimary}>Link</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function Stat({ label, value, danger, warn }: any) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, danger && styles.statDanger, warn && styles.statWarn]}>
        {value}
      </Text>
    </View>
  );
}

// ── Sessions tab ────────────────────────────────────────────────────
export function RumSessionsList({ sessions, loading, error, active, onPlay }: any) {
  if (error) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }
  if (loading && sessions.length === 0) {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator size="small" color={colors.gray400} />
      </View>
    );
  }
  if (sessions.length === 0) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.emptyTitle}>No sessions</Text>
        <Text style={styles.emptyDesc}>
          {active
            ? 'No sessions match the current filters. Widen the time range or clear a facet.'
            : 'Sessions show up here once continuous capture is enabled and the recorder sends segments.'}
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      data={sessions}
      keyExtractor={(item: any) => item.sessionId}
      contentContainerStyle={styles.listPad}
      renderItem={({ item }: any) => <RumSessionRow session={item} onPlay={onPlay} />}
    />
  );
}

// ── Replays tab ─────────────────────────────────────────────────────
export function ReplayCaptureList({
  replays,
  loading,
  error,
  filter,
  kind,
  onWatch,
  onLink,
  onUnlink,
  onAddToPlaylist,
}: any) {
  if (error) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }
  if (loading && replays.length === 0) {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator size="small" color={colors.gray400} />
      </View>
    );
  }
  if (replays.length === 0) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.emptyTitle}>No replays</Text>
        <Text style={styles.emptyDesc}>
          {filter === 'orphans'
            ? 'No orphaned replays. Attributed captures appear under the other filters.'
            : kind === 'continuous'
              ? 'No continuous replays. They appear once a project opts into continuous capture.'
              : kind === 'on-error'
                ? 'No on-error replays match this view.'
                : 'Replays show up here when the in-app recorder captures a session.'}
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      data={replays}
      keyExtractor={(item: any) => item.id}
      contentContainerStyle={styles.listPad}
      renderItem={({ item }: any) => (
        <ReplayCaptureRow
          replay={item}
          onWatch={onWatch}
          onLink={onLink}
          onUnlink={onUnlink}
          onAddToPlaylist={onAddToPlaylist}
        />
      )}
    />
  );
}

function Pager({ offset, count, total, hasMore, loading, onPrev, onNext }: any) {
  if (count === 0) return null;
  return (
    <View style={styles.pager}>
      <Text style={styles.pagerText}>
        {offset + 1}–{offset + count} of {total}
      </Text>
      <View style={styles.pagerBtns}>
        <TouchableOpacity
          testID="pager-prev"
          disabled={offset === 0 || loading}
          onPress={onPrev}
          style={[styles.pagerBtn, (offset === 0 || loading) && styles.pagerBtnDisabled]}
        >
          <Text style={styles.pagerBtnText}>Prev</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="pager-next"
          disabled={!hasMore || loading}
          onPress={onNext}
          style={[styles.pagerBtn, (!hasMore || loading) && styles.pagerBtnDisabled]}
        >
          <Text style={styles.pagerBtnText}>Next</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ReplaysScreen({ route }: any) {
  const { projects } = useApp();
  const { openSidebar } = useContext(SidebarContext);
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p: any) => p.id === projectId);

  const [view, setView] = useState<'sessions' | 'replays' | 'playlists'>('sessions');
  const [player, setPlayer] = useState<any>(null);
  const [addToPlaylist, setAddToPlaylist] = useState<any>(null); // capture row being added to a playlist

  // Playlist actions surface errors via Alert; successes stay silent to avoid
  // an alert on every add/rename/keep (matches the low-friction mobile flow).
  const notify = useCallback((message: string, type?: string) => {
    if (type === 'error') Alert.alert('Playlists', message);
  }, []);

  // ── Sessions tab state ──
  const [draft, setDraft] = useState<FilterDraft>({});
  const [applied, setApplied] = useState<FilterDraft>({});
  const [rangeId, setRangeId] = useState(DEFAULT_RANGE_ID);
  const [showFilters, setShowFilters] = useState(false);
  const [sPage, setSPage] = useState<any>(null);
  const [sLoading, setSLoading] = useState(false);
  const [sError, setSError] = useState<string | null>(null);
  const [sOffset, setSOffset] = useState(0);
  const sSeq = useRef(0);

  const rangeMs = useMemo(() => rangeMsFor(rangeId), [rangeId]);

  const loadSessions = useCallback(
    async (opts: { offset?: number } = {}) => {
      if (!projectId) return;
      const o = opts.offset ?? sOffset;
      const params = buildRumSessionParams(applied, rangeMs, Date.now(), SESSIONS_PAGE_SIZE, o);
      const seq = ++sSeq.current;
      setSLoading(true);
      setSError(null);
      try {
        const res = await api.listRumSessions(projectId, params);
        if (seq !== sSeq.current) return;
        setSPage(res);
      } catch (e: any) {
        if (seq !== sSeq.current) return;
        setSError(e?.message || 'Failed to load sessions');
        setSPage(null);
      } finally {
        if (seq === sSeq.current) setSLoading(false);
      }
    },
    [projectId, applied, rangeMs, sOffset],
  );

  useEffect(() => {
    setSOffset(0);
    loadSessions({ offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, applied, rangeId]);

  const sessions = sPage?.sessions ?? [];
  const sTotal = sPage?.total ?? 0;
  const sHasMore = Boolean(sPage?.hasMore);
  const activeFilters = hasActiveFilters(applied);

  const applyFilters = () => {
    if (!sameFilters(applied, draft)) setApplied({ ...draft });
    setShowFilters(false);
  };
  const clearFilters = () => {
    setDraft({});
    if (activeFilters) setApplied({});
  };
  const changeSessionsPage = (nextOffset: number) => {
    setSOffset(nextOffset);
    loadSessions({ offset: nextOffset });
  };
  const setField = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const playSession = (s: any) =>
    setPlayer({
      mode: 'session',
      sessionId: s.sessionId,
      title: s.usrEmail || s.usrName || s.usrId || `Session ${s.sessionId}`,
      meta: [
        { label: 'Started', value: formatSessionStart(s.startedAt) },
        { label: 'Duration', value: formatReplayDuration(s.timeSpent) },
        { label: 'Views', value: String(s.viewCount ?? 0) },
        { label: 'Errors', value: String(s.errorCount ?? 0) },
      ],
    });

  // ── Replays tab state ──
  const [rFilter, setRFilter] = useState('all');
  const [rKind, setRKind] = useState('all');
  const [rPage, setRPage] = useState<any>(null);
  const [rLoading, setRLoading] = useState(false);
  const [rError, setRError] = useState<string | null>(null);
  const [rOffset, setROffset] = useState(0);
  const rSeq = useRef(0);

  const loadReplays = useCallback(
    async (opts: { offset?: number } = {}) => {
      if (!projectId) return;
      const o = opts.offset ?? rOffset;
      const seq = ++rSeq.current;
      setRLoading(true);
      setRError(null);
      try {
        const res = await api.listReplays(projectId, {
          filter: rFilter,
          kind: rKind,
          limit: REPLAYS_PAGE_SIZE,
          offset: o,
        });
        if (seq !== rSeq.current) return;
        setRPage(res);
      } catch (e: any) {
        if (seq !== rSeq.current) return;
        setRError(e?.message || 'Failed to load replays');
        setRPage(null);
      } finally {
        if (seq === rSeq.current) setRLoading(false);
      }
    },
    [projectId, rFilter, rKind, rOffset],
  );

  useEffect(() => {
    if (view !== 'replays') return;
    setROffset(0);
    loadReplays({ offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, rFilter, rKind, view]);

  const replays = rPage?.replays ?? [];
  const rTotal = rPage?.total ?? 0;
  const rHasMore = Boolean(rPage?.hasMore);
  const canViewOrphans = rPage?.canViewOrphans ?? false;
  const linkFilters = useMemo(() => visibleReplayLinkFilters(canViewOrphans), [canViewOrphans]);

  const changeReplaysPage = (nextOffset: number) => {
    setROffset(nextOffset);
    loadReplays({ offset: nextOffset });
  };
  const watchReplay = (r: any) =>
    setPlayer({
      mode: 'replay',
      replayId: r.id,
      title: formatPageUrl(r.pageUrl),
      meta: [
        { label: 'Captured', value: formatCaptureDate(r.createdAt) },
        { label: 'Duration', value: formatReplayDuration(r.durationMs) },
        { label: 'Events', value: String(r.eventCount ?? 0) },
        { label: 'Size', value: formatBytes(r.size) },
      ],
    });
  const unlinkReplay = (r: any) =>
    unlinkReplayCapture({ api, projectId, replayId: r.id, reload: loadReplays });
  // Launch the player for a playlist item (shape: PlaylistItemView — replayId +
  // capture summary columns) — same monolithic-capture player as a Replays row.
  const watchPlaylistItem = (it: any) =>
    setPlayer({
      mode: 'replay',
      replayId: it.replayId,
      title: `Capture ${it.replayId}`,
      meta: [
        { label: 'Captured', value: formatCaptureDate(it.createdAt) },
        { label: 'Duration', value: formatReplayDuration(it.durationMs) },
        { label: 'Events', value: String(it.eventCount ?? 0) },
        { label: 'Size', value: formatBytes(it.size) },
      ],
    });
  // The ticket picker isn't ported to mobile yet (follow-up #1392). The Link
  // action opens the web Replays dashboard — where a capture can be linked to a
  // support ticket — rather than the playback modal. Falls back to a no-op when
  // the server base/project is unknown.
  const linkReplay = (_r: any) => {
    const url = buildWebReplaysUrl(projectId);
    if (url) Linking.openURL(url).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'☰'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Replays</Text>
        {project ? (
          <Text style={styles.projectLabel} numberOfLines={1}>
            {project.name}
          </Text>
        ) : null}
      </View>

      <View style={styles.viewToggle}>
        {VIEWS.map((v) => (
          <TouchableOpacity
            key={v.id}
            testID={`view-toggle-${v.id}`}
            onPress={() => setView(v.id)}
            style={[styles.toggleBtn, view === v.id && styles.toggleBtnActive]}
          >
            <Text style={[styles.toggleText, view === v.id && styles.toggleTextActive]}>
              {v.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {view === 'sessions' ? (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rangeRow}
          >
            {TIME_RANGES.map((r) => (
              <TouchableOpacity
                key={r.id}
                testID={`range-${r.id}`}
                onPress={() => setRangeId(r.id)}
                style={[styles.filterButton, rangeId === r.id && styles.filterButtonActive]}
              >
                <Text style={[styles.filterText, rangeId === r.id && styles.filterTextActive]}>
                  {r.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View style={styles.filterBarRow}>
            <TouchableOpacity
              testID="toggle-filters"
              onPress={() => setShowFilters((v) => !v)}
              style={styles.filterButton}
            >
              <Text style={styles.filterText}>{showFilters ? 'Hide filters' : 'Filters'}</Text>
            </TouchableOpacity>
            {activeFilters ? (
              <TouchableOpacity
                testID="clear-filters"
                onPress={clearFilters}
                style={styles.filterButton}
              >
                <Text style={styles.filterText}>Clear</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.countLabel}>
              {sTotal} session{sTotal === 1 ? '' : 's'}
            </Text>
          </View>

          {showFilters ? (
            <ScrollView style={styles.filterPanel} keyboardShouldPersistTaps="handled">
              {TEXT_FACETS.map((f) => (
                <View key={f.key} style={styles.field}>
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                  <TextInput
                    testID={`facet-${f.key}`}
                    value={draft[f.key] ?? ''}
                    onChangeText={(t: string) => setField(f.key, t)}
                    placeholder={f.placeholder}
                    placeholderTextColor={colors.gray600}
                    autoCapitalize="none"
                    style={styles.input}
                  />
                </View>
              ))}
              {COUNT_FACETS.map((f) => (
                <View key={f.key} style={styles.field}>
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                  <TextInput
                    testID={`facet-${f.key}`}
                    value={draft[f.key] ?? ''}
                    onChangeText={(t: string) => setField(f.key, t)}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={colors.gray600}
                    style={styles.input}
                  />
                </View>
              ))}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Min duration (s)</Text>
                <TextInput
                  testID="facet-durationMinS"
                  value={draft.durationMinS ?? ''}
                  onChangeText={(t: string) => setField('durationMinS', t)}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={colors.gray600}
                  style={styles.input}
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Max duration (s)</Text>
                <TextInput
                  testID="facet-durationMaxS"
                  value={draft.durationMaxS ?? ''}
                  onChangeText={(t: string) => setField('durationMaxS', t)}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={colors.gray600}
                  style={styles.input}
                />
              </View>
              <TouchableOpacity
                testID="apply-filters"
                onPress={applyFilters}
                style={styles.applyBtn}
              >
                <Text style={styles.applyText}>Apply filters</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <View style={styles.flex}>
              <RumSessionsList
                sessions={sessions}
                loading={sLoading}
                error={sError}
                active={activeFilters}
                onPlay={playSession}
              />
              <Pager
                offset={sOffset}
                count={sessions.length}
                total={sTotal}
                hasMore={sHasMore}
                loading={sLoading}
                onPrev={() => changeSessionsPage(Math.max(0, sOffset - SESSIONS_PAGE_SIZE))}
                onNext={() => changeSessionsPage(sOffset + SESSIONS_PAGE_SIZE)}
              />
            </View>
          )}
        </>
      ) : view === 'playlists' ? (
        <ReplayPlaylistsView projectId={projectId} onWatch={watchPlaylistItem} onNotify={notify} />
      ) : (
        <>
          <View style={styles.filterRow}>
            {linkFilters.map((f) => (
              <TouchableOpacity
                key={f.id}
                testID={`link-filter-${f.id}`}
                onPress={() => setRFilter(f.id)}
                style={[styles.filterButton, rFilter === f.id && styles.filterButtonActive]}
              >
                <Text style={[styles.filterText, rFilter === f.id && styles.filterTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
            <Text style={styles.countLabel}>
              {rTotal} replay{rTotal === 1 ? '' : 's'}
            </Text>
          </View>
          <View style={styles.filterRow}>
            {REPLAY_KIND_FILTERS.map((k) => (
              <TouchableOpacity
                key={k.id}
                testID={`kind-filter-${k.id}`}
                onPress={() => setRKind(k.id)}
                style={[styles.filterButton, rKind === k.id && styles.filterButtonActive]}
              >
                <Text style={[styles.filterText, rKind === k.id && styles.filterTextActive]}>
                  {k.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.flex}>
            <ReplayCaptureList
              replays={replays}
              loading={rLoading}
              error={rError}
              filter={rFilter}
              kind={rKind}
              onWatch={watchReplay}
              onLink={linkReplay}
              onUnlink={unlinkReplay}
              onAddToPlaylist={setAddToPlaylist}
            />
            <Pager
              offset={rOffset}
              count={replays.length}
              total={rTotal}
              hasMore={rHasMore}
              loading={rLoading}
              onPrev={() => changeReplaysPage(Math.max(0, rOffset - REPLAYS_PAGE_SIZE))}
              onNext={() => changeReplaysPage(rOffset + REPLAYS_PAGE_SIZE)}
            />
          </View>
        </>
      )}

      <ReplayPlayerModal target={player} projectId={projectId} onClose={() => setPlayer(null)} />

      {addToPlaylist ? (
        <AddToPlaylistModal
          projectId={projectId}
          replay={addToPlaylist}
          onClose={() => setAddToPlaylist(null)}
          onAdded={() => setAddToPlaylist(null)}
          onError={(msg: string) => {
            setAddToPlaylist(null);
            notify(msg, 'error');
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  menuButton: { padding: 4 },
  menuIcon: { fontSize: 22, color: colors.gray400 },
  title: { fontSize: 17, fontWeight: '600', color: colors.white, flexShrink: 1 },
  projectLabel: { marginLeft: 'auto', color: colors.gray500, fontSize: 12, maxWidth: 140 },
  viewToggle: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  toggleBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  toggleBtnActive: { backgroundColor: colors.indigo500, borderColor: colors.indigo500 },
  toggleText: { color: colors.gray400, fontSize: 13, fontWeight: '600' },
  toggleTextActive: { color: colors.white },
  rangeRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  filterBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  filterButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  filterButtonActive: { backgroundColor: colors.indigo600, borderColor: colors.indigo500 },
  filterText: { color: colors.gray400, fontSize: 12, fontWeight: '500' },
  filterTextActive: { color: colors.white },
  countLabel: { marginLeft: 'auto', color: colors.gray500, fontSize: 12 },
  filterPanel: { paddingHorizontal: 12 },
  field: { marginBottom: 10 },
  fieldLabel: { color: colors.gray500, fontSize: 11, marginBottom: 4 },
  input: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  applyBtn: {
    backgroundColor: colors.indigo600,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 20,
  },
  applyText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  listPad: { padding: 12, gap: 10 },
  card: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardUser: { color: colors.gray100, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  playBadge: { marginLeft: 'auto', color: colors.indigo400, fontSize: 14 },
  cardSub: { color: colors.gray500, fontSize: 12, marginTop: 2 },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 8 },
  stat: {},
  statLabel: { color: colors.gray600, fontSize: 10, textTransform: 'uppercase' },
  statValue: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  statDanger: { color: colors.rose400 },
  statWarn: { color: colors.amber400 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  tag: {
    color: colors.gray400,
    fontSize: 11,
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  chip: {
    fontSize: 10,
    fontWeight: '600',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  chipLive: { color: colors.rose400, backgroundColor: colors.gray800 },
  chipContinuous: { color: colors.emerald300, backgroundColor: colors.gray800 },
  chipOrphan: { color: colors.amber400, backgroundColor: colors.gray800 },
  errorLine: { color: colors.rose400, fontSize: 11, marginTop: 4 },
  ticketLine: { color: colors.blue300, fontSize: 12, marginTop: 8 },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  actionBtnPrimary: { borderColor: colors.indigo500 },
  actionText: { color: colors.gray200, fontSize: 12 },
  actionTextPrimary: { color: colors.indigo300, fontSize: 12, fontWeight: '600' },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 6 },
  emptyTitle: { color: colors.gray300, fontSize: 15, fontWeight: '600' },
  emptyDesc: { color: colors.gray500, fontSize: 13, textAlign: 'center' },
  errorText: { color: colors.rose400, fontSize: 13, textAlign: 'center' },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  pagerText: { color: colors.gray400, fontSize: 12 },
  pagerBtns: { flexDirection: 'row', gap: 8 },
  pagerBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pagerBtnDisabled: { opacity: 0.4 },
  pagerBtnText: { color: colors.gray300, fontSize: 12 },
  playerBackdrop: {
    flex: 1,
    backgroundColor: colors.black60,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  playerCard: {
    width: '100%',
    maxWidth: 640,
    height: '90%',
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 12,
    overflow: 'hidden',
  },
  playerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  playerTitle: { color: colors.gray100, fontSize: 14, fontWeight: '600', flexShrink: 1, flex: 1 },
  playerClose: { padding: 4 },
  playerCloseText: { color: colors.gray400, fontSize: 16 },
  metaStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  metaStripItem: { color: colors.gray200, fontSize: 12 },
  metaLabel: { color: colors.gray500, fontSize: 12 },
  playerFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  playerFooterBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  playerFooterText: { color: colors.gray300, fontSize: 13 },
  keepBtn: { marginRight: 'auto' },
  keepBtnActive: { borderColor: colors.amber400, backgroundColor: colors.gray800 },
  keepBtnBusy: { opacity: 0.5 },
  keepTextActive: { color: colors.amber400, fontWeight: '600' },
});
