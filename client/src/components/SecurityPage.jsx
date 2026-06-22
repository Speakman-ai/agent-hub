import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  AlertCircle,
  ExternalLink,
  ArrowUpCircle,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { api } from '../utils/api.js';

function relativeTime(ms) {
  if (!ms) return '';
  const diffMs = Date.now() - ms;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(ms).toLocaleDateString();
}

// Severity → sort rank (most urgent first). Mirrors the server's ORDER BY so a
// re-fetch lands rows in the right place.
export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

const SEVERITY_BADGE = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  low: 'bg-gray-600/30 text-gray-300 border-gray-600/50',
  unknown: 'bg-gray-700/30 text-gray-400 border-gray-700/50',
};

// Status → human label + badge tint.
const STATUS_META = {
  open: { label: 'Open', className: 'bg-gray-800 text-gray-300' },
  fixed: { label: 'Fixed', className: 'bg-emerald-500/15 text-emerald-300' },
  dismissed: { label: 'Dismissed', className: 'bg-gray-800/60 text-gray-500' },
};

// Server lifecycle statuses, mapped to the single-value `status` query the
// findings endpoint accepts (omit for "All").
const STATUS_FILTERS = [
  { key: 'open', label: 'Open', status: 'open' },
  { key: 'fixed', label: 'Fixed', status: 'fixed' },
  { key: 'dismissed', label: 'Dismissed', status: 'dismissed' },
  { key: 'all', label: 'All', status: undefined },
];

const SEVERITY_FILTERS = [
  { key: 'all', label: 'All severities' },
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

// Sort findings most-urgent first, then most-recently-seen within a severity.
export function sortFindings(list) {
  return [...list].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 5;
    const sb = SEVERITY_RANK[b.severity] ?? 5;
    if (sa !== sb) return sa - sb;
    return (b.last_seen_at || 0) - (a.last_seen_at || 0);
  });
}

// Total of the open critical + high counts — the number surfaced on the
// sidebar badge (the highest-signal "needs attention now" tally).
export function openCriticalHigh(openCounts) {
  if (!openCounts) return 0;
  return (openCounts.critical || 0) + (openCounts.high || 0);
}

const EMPTY_COUNTS = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

// Two-step dismiss control: the first click arms a Confirm/Cancel pair so a
// single misclick can't suppress an advisory. On success the parent drops the
// row and refreshes the counts (the server emits no event for a dismiss).
function DismissButton({ projectId, finding, onDismissed, onNotify }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleDismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.dismissSecurityFinding(projectId, finding.id);
      onDismissed?.(finding.id);
    } catch (err) {
      // 403 (not an Admin) is the common case — surface it as a toast rather
      // than swallowing it when the control vanishes.
      onNotify?.(err.message || 'Failed to dismiss finding', 'error');
      setBusy(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[11px] text-gray-400">Dismiss?</span>
        <button
          onClick={handleDismiss}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-gray-600/60 text-gray-200 hover:bg-gray-700/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Dismissing…' : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      title="Dismiss and suppress this finding on future re-scans"
      className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 hover:bg-gray-800 transition-colors"
    >
      Dismiss
    </button>
  );
}

function FindingCard({ finding, projectId, onDismissed, onNotify }) {
  const severityClass = SEVERITY_BADGE[finding.severity] || SEVERITY_BADGE.unknown;
  const statusMeta = STATUS_META[finding.status] || STATUS_META.open;
  const advisoryLabel = finding.advisory_id || 'advisory';

  return (
    <div
      data-testid="security-finding-card"
      data-severity={finding.severity}
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityClass}`}
        >
          {finding.severity}
        </span>
        <span data-testid="finding-package" className="text-sm font-mono text-gray-100 break-all">
          {finding.package_name}@{finding.package_version}
        </span>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 uppercase">
          {finding.ecosystem}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${statusMeta.className}`}
          data-testid="finding-status"
        >
          {statusMeta.label}
        </span>
        <span className="text-[11px] text-gray-600 ml-auto">
          {relativeTime(finding.last_seen_at)}
        </span>
      </div>

      {finding.summary ? (
        <div className="text-sm text-gray-300 mt-2 break-words">{finding.summary}</div>
      ) : null}

      <div className="mt-2 flex items-center gap-3 flex-wrap text-xs">
        {finding.advisory_url ? (
          <a
            href={finding.advisory_url}
            target="_blank"
            rel="noreferrer"
            data-testid="advisory-link"
            className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
          >
            <ExternalLink size={12} />
            {advisoryLabel}
          </a>
        ) : (
          <span className="text-gray-500">{advisoryLabel}</span>
        )}
        <span className="text-gray-600">·</span>
        {finding.fixed_version ? (
          <span
            className="inline-flex items-center gap-1 text-emerald-400"
            data-testid="finding-fix"
          >
            <ArrowUpCircle size={12} />
            Fix: upgrade to {finding.fixed_version}
          </span>
        ) : (
          <span className="text-gray-500" data-testid="finding-fix">
            No fix published yet
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-gray-600 font-mono break-all">
          {finding.manifest_path}
        </span>
        {finding.status === 'open' ? (
          <span className="ml-auto">
            <DismissButton
              projectId={projectId}
              finding={finding}
              onDismissed={onDismissed}
              onNotify={onNotify}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Per-project Security view. Renders GET /security-audit/findings: a severity
// ordered, severity-coloured list with package@version, advisory link, suggested
// fix, status, and a Dismiss action on open findings. Re-fetches when
// `refreshNonce` changes (App bumps it on a `kanban_update` WebSocket event —
// the only signal a scan emits). Lifts the server `openCounts` to the parent via
// `onOpenCounts` so the sidebar badge stays in sync.
export default function SecurityPage({ projectId, refreshNonce, onOpenCounts, onNotify }) {
  const [findings, setFindings] = useState([]);
  const [openCounts, setOpenCounts] = useState(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('open');
  const [severityFilter, setSeverityFilter] = useState('all');

  const activeStatus = STATUS_FILTERS.find((f) => f.key === statusFilter) || STATUS_FILTERS[0];

  // Hold the latest onOpenCounts in a ref so `load`'s identity does NOT depend
  // on the parent's callback identity. App passes an inline callback whose
  // identity changes every render; if `load` depended on it, the effect below
  // would re-fire on every parent re-render and refetch in a loop. The ref lets
  // load() always call the freshest handler without re-creating itself.
  const onOpenCountsRef = useRef(onOpenCounts);
  onOpenCountsRef.current = onOpenCounts;

  const load = useCallback(
    async (signal) => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getSecurityFindings(projectId, activeStatus.status);
        if (signal?.cancelled) return;
        const list = Array.isArray(data?.findings) ? data.findings : [];
        setFindings(sortFindings(list));
        const counts = data?.openCounts || EMPTY_COUNTS;
        setOpenCounts(counts);
        onOpenCountsRef.current?.(counts);
      } catch (err) {
        if (!signal?.cancelled) setError(err.message || 'Failed to load security findings');
      } finally {
        if (!signal?.cancelled) setLoading(false);
      }
    },
    [projectId, activeStatus.status],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load, refreshNonce]);

  // Drop a dismissed finding locally (it leaves the Open view), then re-fetch so
  // the status counts + any other view reflect the change — the dismiss endpoint
  // emits no WebSocket event of its own.
  const handleDismissed = (id) => {
    setFindings((prev) => prev.filter((f) => f.id !== id));
    load();
  };

  // Rescan / Autofix share one in-flight flag so the two buttons can't fire
  // concurrently (both POST the same scan endpoint). `scanMode` tracks which is
  // running so each button shows its own pending label.
  const [scanMode, setScanMode] = useState(null); // null | 'rescan' | 'autofix'

  const runScan = async (mode) => {
    if (scanMode) return;
    setScanMode(mode);
    try {
      const result = await api.runSecurityScan(projectId, { autoPr: mode === 'autofix' });
      const opened = result?.autoPr?.opened?.length ?? 0;
      if (mode === 'autofix') {
        onNotify?.(
          opened > 0
            ? `Autofix: opened ${opened} bump PR${opened === 1 ? '' : 's'}`
            : 'Autofix: no fixable findings to open PRs for',
          opened > 0 ? 'success' : 'info',
        );
      } else {
        const next = (result?.newFindings ?? 0) + (result?.reopened ?? 0);
        onNotify?.(
          next > 0 ? `Rescan complete: ${next} new/reopened finding(s)` : 'Rescan complete',
          'success',
        );
      }
      await load();
    } catch (err) {
      onNotify?.(err.message || `Failed to ${mode === 'autofix' ? 'autofix' : 'rescan'}`, 'error');
    } finally {
      setScanMode(null);
    }
  };

  const visible =
    severityFilter === 'all' ? findings : findings.filter((f) => f.severity === severityFilter);

  const totalCriticalHigh = openCriticalHigh(openCounts);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50">
        <ShieldAlert size={16} className="text-amber-400" />
        <h2 className="text-sm font-medium text-gray-200">Security</h2>
        {totalCriticalHigh > 0 ? (
          <span
            data-testid="security-header-badge"
            className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/40"
          >
            {totalCriticalHigh} open critical/high
          </span>
        ) : null}
        <div className="flex items-center gap-1 ml-auto flex-wrap justify-end">
          <button
            onClick={() => runScan('autofix')}
            disabled={!!scanMode}
            data-testid="security-autofix"
            title="Open Dependabot-style bump PRs for every fixable finding"
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Wrench size={12} className={scanMode === 'autofix' ? 'animate-pulse' : ''} />
            {scanMode === 'autofix' ? 'Fixing…' : 'Autofix'}
          </button>
          <button
            onClick={() => runScan('rescan')}
            disabled={!!scanMode}
            data-testid="security-rescan"
            title="Re-run the dependency security scan now"
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded text-gray-300 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={12} className={scanMode === 'rescan' ? 'animate-spin' : ''} />
            {scanMode === 'rescan' ? 'Scanning…' : 'Rescan'}
          </button>
          <span className="w-px h-4 bg-gray-700 mx-1" />
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              data-testid={`status-filter-${f.key}`}
              className={`text-[11px] px-2 py-1 rounded transition-colors ${
                statusFilter === f.key
                  ? 'bg-gray-700 text-gray-200'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-800 bg-gray-900/30 flex-wrap">
        <span className="text-[11px] text-gray-600 mr-1">Severity</span>
        {SEVERITY_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setSeverityFilter(f.key)}
            data-testid={`severity-filter-${f.key}`}
            className={`text-[11px] px-2 py-1 rounded transition-colors ${
              severityFilter === f.key
                ? 'bg-gray-700 text-gray-200'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="animate-spin w-5 h-5 border-2 border-gray-600 border-t-gray-300 rounded-full" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <AlertCircle size={32} className="mx-auto mb-2 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 py-20">
            <ShieldCheck size={36} className="mb-3 text-gray-700" />
            <p className="text-sm">No security findings</p>
            <p className="text-xs text-gray-700 mt-1">
              Vulnerable dependencies appear here, most severe first.
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-2 max-w-5xl mx-auto">
            {visible.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                projectId={projectId}
                onDismissed={handleDismissed}
                onNotify={onNotify}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
