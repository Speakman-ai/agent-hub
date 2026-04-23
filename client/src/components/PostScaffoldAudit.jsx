import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import AuditReport from './AuditReport.jsx';
import AgentRosterPicker from './AgentRosterPicker.jsx';
import { normalizeReport } from '../utils/auditReport.js';
import {
  suggestRoster,
  initialRoster,
  rosterToPayload,
  hasAnyAssignment,
  DEFAULT_TRACKS,
} from '../utils/rosterSuggest.js';
import {
  fetchAuditReport as defaultFetchAudit,
  refreshAuditReport as defaultRefresh,
  fetchRosterSuggestions as defaultFetchSuggestions,
  saveRoster as defaultSaveRoster,
  fetchAgents as defaultFetchAgents,
} from '../utils/auditClient.js';

/**
 * PostScaffoldAudit — Act IV of the New Project storyboard.
 *
 * Orchestration:
 *   1. On mount, kick off three parallel loads: audit report, roster
 *      suggestions, and the org agent list.
 *   2. If suggestions are unavailable, fall back to a local keyword match
 *      (see utils/rosterSuggest.js) so the user can still pick a team.
 *   3. User edits the roster; "Confirm & continue" POSTs the payload and
 *      fires onConfirmed with the persisted response.
 *
 * All transport deps are injectable so tests can drive the flow without a
 * live server.
 *
 * Props:
 *   - projectId:  string (required)
 *   - onConfirmed: (savedRoster) => void
 *   - onSkip:     optional — fired when user wants to finish without a roster
 *   - fetchAudit, refresh, fetchSuggestions, saveRoster, fetchAgents:
 *       transport overrides.
 */
export default function PostScaffoldAudit({
  projectId,
  onConfirmed,
  onSkip,
  fetchAudit = defaultFetchAudit,
  refresh = defaultRefresh,
  fetchSuggestions = defaultFetchSuggestions,
  saveRoster = defaultSaveRoster,
  fetchAgents = defaultFetchAgents,
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [report, setReport] = useState(null);
  const [agents, setAgents] = useState([]);
  const [roster, setRoster] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initial load — fires on mount + when projectId changes.
  useEffect(() => {
    let cancelled = false;
    if (!projectId) return undefined;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const [rawReport, agentList, suggestionsResult] = await Promise.all([
          fetchAudit(projectId).catch((err) => ({ __error: err })),
          fetchAgents().catch(() => []),
          fetchSuggestions(projectId).catch(() => null),
        ]);
        if (cancelled || !mountedRef.current) return;
        if (rawReport && rawReport.__error) {
          setLoadError(rawReport.__error.message || 'Audit load failed');
          setReport(null);
        } else {
          setReport(normalizeReport(rawReport));
        }
        const agentArray = Array.isArray(agentList) ? agentList : [];
        setAgents(agentArray);
        const tracks =
          suggestionsResult && Array.isArray(suggestionsResult.tracks)
            ? suggestionsResult.tracks
            : suggestRoster({ tracks: DEFAULT_TRACKS, agents: agentArray });
        setRoster(initialRoster(tracks));
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setLoadError(err?.message || String(err));
        }
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, fetchAudit, fetchAgents, fetchSuggestions]);

  const handleRefresh = useCallback(async () => {
    if (!projectId || refreshing) return;
    setRefreshing(true);
    try {
      const result = await refresh(projectId);
      if (!mountedRef.current) return;
      // Backend may return a fresh report inline (200) or a jobId (202). In
      // the jobId case, fall back to a re-fetch.
      if (result && typeof result === 'object' && 'jobId' in result && !result.categories) {
        const fresh = await fetchAudit(projectId);
        if (mountedRef.current) setReport(normalizeReport(fresh));
      } else {
        setReport(normalizeReport(result));
      }
    } catch (err) {
      if (mountedRef.current) setLoadError(err?.message || String(err));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [projectId, refresh, fetchAudit, refreshing]);

  const handleConfirm = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = rosterToPayload(roster);
      const saved = await saveRoster(projectId, payload);
      if (mountedRef.current) {
        // Surface the rendered audit report + agent list alongside the
        // persisted roster so the downstream landing view can render
        // summary chips and per-row "Chat" actions without an extra fetch.
        onConfirmed?.(saved, { report, agents, roster });
      }
    } catch (err) {
      if (mountedRef.current) setSaveError(err?.message || String(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [roster, saving, saveRoster, projectId, onConfirmed, report, agents]);

  const canConfirm = useMemo(() => hasAnyAssignment(roster) && !saving, [roster, saving]);

  return (
    <div
      className="flex flex-col w-full h-full bg-gray-950 text-white"
      data-testid="post-scaffold-audit"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900/90 px-4 py-3">
        <h1 className="min-w-0 flex-1 text-base font-semibold text-white">Readiness & roster</h1>
        {refreshing && (
          <span
            className="inline-flex items-center gap-1 text-xs text-gray-400"
            data-testid="psa-refreshing"
          >
            <Loader2 size={12} className="animate-spin" /> refreshing
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-2xl space-y-4">
          {loading ? (
            <LoadingCard />
          ) : loadError ? (
            <ErrorCard message={loadError} />
          ) : (
            <AuditReport report={report} onRefresh={handleRefresh} />
          )}

          <AgentRosterPicker
            roster={roster}
            agents={agents}
            onChange={setRoster}
            disabled={saving}
          />

          {saveError && (
            <div
              className="rounded-md border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-200"
              data-testid="psa-save-error"
            >
              Failed to save roster: {saveError}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="psa-confirm"
            >
              {saving ? 'Saving…' : 'Confirm & continue'}
            </button>
            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                disabled={saving}
                className="bg-gray-800 hover:bg-gray-700 text-gray-100 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50"
                data-testid="psa-skip"
              >
                Skip for now
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div
      className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-6 text-sm text-gray-400 flex items-center gap-2"
      data-testid="psa-loading"
    >
      <Loader2 size={16} className="animate-spin" /> Loading audit…
    </div>
  );
}

function ErrorCard({ message }) {
  return (
    <div
      className="rounded-lg border border-red-700 bg-red-950/40 px-4 py-4 text-sm text-red-200"
      data-testid="psa-load-error"
    >
      <div className="font-medium">Audit failed to load</div>
      <div className="mt-1 text-xs text-red-300/80 break-words">{message}</div>
    </div>
  );
}
