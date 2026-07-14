/**
 * LogSourcesSettingsSection — application-log ingest settings panel
 * (per-project sidebar route `logs:<projectId>`).
 *
 * Manages a project's named **log sources** (decision LOG-AUTH): each source
 * carries an independent write-only `ahlog_` ingest token that identifies
 * exactly one (project, source) pair and grants no read/query/management
 * access. The panel lets an Admin:
 *   - list sources with their credential status + last-ingest time,
 *   - create a source and copy its one-time plaintext token,
 *   - rotate a token (invalidating the old one) or revoke / delete a source,
 *   - copy ready-to-paste ingest endpoint examples,
 * and surfaces the project's storage limits (quota + retention) from the
 * log-store health metrics endpoint.
 *
 * Ingest tokens are SERVER / COLLECTOR credentials, never browser secrets —
 * the panel labels this prominently (direct untrusted browser ingestion is
 * out of scope; browser errors go through the RUM/replay path).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ScrollText,
  Loader2,
  AlertCircle,
  Key,
  Plus,
  Trash2,
  Check,
  Copy,
  ShieldAlert,
  RefreshCw,
  Ban,
  Sparkles,
} from 'lucide-react';
import { api } from '../utils/api';
import { copyToClipboard } from '../utils/export';
import { getServerBase } from '../utils/connection';
import { relativeTime } from '../utils/time';
import { formatBytes } from '../utils/replayFormat';

/** Relative "last ingest" label from an epoch-ms number, or "no logs yet". */
export function formatLastIngest(lastIngestAt: number | null | undefined): string {
  if (!lastIngestAt) return 'no logs yet';
  const rel = relativeTime(lastIngestAt);
  return rel ? `last log ${rel}` : 'no logs yet';
}

/** Absolute ingest base for the copy-ready examples (remote-aware). */
function ingestBase(): string {
  const base = getServerBase();
  if (base) return base;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return 'https://your-hub.example.com';
}

/** A `curl` example that ingests one record with the given token. */
export function buildCurlExample(token: string): string {
  return [
    `curl -X POST ${ingestBase()}/api/logs/ingest \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"records":[{"severityText":"ERROR","body":"boom","service":"api"}]}'`,
  ].join('\n');
}

export default function LogSourcesSettingsSection({
  projects = [],
  showToast,
  onOpenSession,
}: any) {
  const project = projects[0] || null;
  const projectId = project?.id || '';

  // AI setup wizard: spawns a worktree-backed `[Logs Setup]` session that wires
  // an exporter into the app, then focuses that chat session.
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState<any>(null);

  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<any>(null);

  const [metrics, setMetrics] = useState<any>(null);

  // Create form
  const [newName, setNewName] = useState('');
  const [newService, setNewService] = useState('');
  const [newEnv, setNewEnv] = useState('');
  const [creating, setCreating] = useState(false);

  // One-time token reveal (create + rotate share this block).
  const [freshToken, setFreshToken] = useState<any>(null);
  const [freshLabel, setFreshLabel] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Per-row mutation flags.
  const [rotatingId, setRotatingId] = useState<any>(null);
  const [revokingId, setRevokingId] = useState<any>(null);
  const [deletingId, setDeletingId] = useState<any>(null);

  // Guard against a stale async response committing to the wrong project's
  // view (or, worse, revealing another project's one-time token) after the
  // user switches projects. Set synchronously before any load starts.
  const activePidRef = useRef('');

  const reload = useCallback(async (pid: any) => {
    if (!pid) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [srcRes, metricsRes] = await Promise.all([
        api.getLogSources(pid),
        api.getLogsMetrics(pid).catch(() => null),
      ]);
      if (activePidRef.current !== pid) return; // stale — project changed
      setSources(srcRes?.sources || []);
      setMetrics(metricsRes?.storage || null);
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setLoadError(err?.message || 'Failed to load log sources');
      setSources([]);
      setMetrics(null);
    } finally {
      if (activePidRef.current === pid) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    activePidRef.current = projectId;
    // Wipe transient + secret state so a previous project's token / list never
    // lingers while the new project's load is in flight.
    setFreshToken(null);
    setFreshLabel('');
    setCopied(false);
    setCopiedCurl(false);
    setSources([]);
    setMetrics(null);
    setNewName('');
    setNewService('');
    setNewEnv('');
    setCreating(false);
    setRotatingId(null);
    setRevokingId(null);
    setDeletingId(null);
    setWizardError(null);
    // Reset the transient wizard flag too: a still-pending startLogsWizard from
    // the previous project keeps its guarded `finally` from clearing it (the
    // pid guard skips), so without this the new project would inherit a
    // permanently-disabled "Set up with AI" button.
    setWizardStarting(false);
    void reload(projectId);
  }, [projectId, reload]);

  const handleStartWizard = useCallback(async () => {
    if (!project || wizardStarting) return;
    const pid = project.id;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startLogsWizard(pid);
      if (activePidRef.current !== pid) return; // switched projects
      if (!res?.sessionId) {
        setWizardError('Server did not return a wizard session id');
        return;
      }
      if (onOpenSession) onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setWizardError(err?.message || 'Failed to start the logs setup wizard');
    } finally {
      if (activePidRef.current === pid) setWizardStarting(false);
    }
  }, [project, wizardStarting, onOpenSession]);

  const revealToken = useCallback((label: string, token: string) => {
    setFreshLabel(label);
    setFreshToken(token);
    setCopied(false);
    setCopiedCurl(false);
  }, []);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!project || creating || !name) return;
    const pid = project.id;
    setCreating(true);
    setLoadError(null);
    try {
      const body: Record<string, unknown> = { name };
      if (newService.trim()) body.serviceName = newService.trim();
      if (newEnv.trim()) body.environment = newEnv.trim();
      const created = await api.createLogSource(pid, body);
      if (activePidRef.current !== pid) return; // switched projects — drop the secret
      revealToken(created?.name || name, created?.token || '');
      setNewName('');
      setNewService('');
      setNewEnv('');
      await reload(pid);
      if (showToast) {
        showToast('Ingest token created — copy it now. It is not shown again.', 'success', 6000);
      }
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setLoadError(err?.message || 'Failed to create log source');
    } finally {
      if (activePidRef.current === pid) setCreating(false);
    }
  }, [project, creating, newName, newService, newEnv, reload, revealToken, showToast]);

  const handleRotate = useCallback(
    async (source: any) => {
      if (!project || rotatingId) return;
      if (
        !window.confirm(
          `Rotate the token for "${source.name}"? The current token stops working immediately and callers must be updated.`,
        )
      ) {
        return;
      }
      const pid = project.id;
      setRotatingId(source.id);
      setLoadError(null);
      try {
        const rotated = await api.rotateLogSource(pid, source.id);
        if (activePidRef.current !== pid) return; // switched projects — drop the secret
        revealToken(rotated?.name || source.name, rotated?.token || '');
        await reload(pid);
        if (showToast) {
          showToast(
            'Token rotated — copy the new one now. It is not shown again.',
            'success',
            6000,
          );
        }
      } catch (err: any) {
        if (activePidRef.current !== pid) return;
        setLoadError(err?.message || 'Failed to rotate token');
      } finally {
        if (activePidRef.current === pid) setRotatingId(null);
      }
    },
    [project, rotatingId, reload, revealToken, showToast],
  );

  const handleRevoke = useCallback(
    async (source: any) => {
      if (!project || revokingId) return;
      if (
        !window.confirm(
          `Revoke the token for "${source.name}"? Ingest using it will be rejected until you rotate.`,
        )
      ) {
        return;
      }
      const pid = project.id;
      setRevokingId(source.id);
      setLoadError(null);
      try {
        await api.revokeLogSource(pid, source.id);
        if (activePidRef.current !== pid) return;
        await reload(pid);
        if (showToast) showToast('Ingest token revoked.', 'success', 3000);
      } catch (err: any) {
        if (activePidRef.current !== pid) return;
        setLoadError(err?.message || 'Failed to revoke token');
      } finally {
        if (activePidRef.current === pid) setRevokingId(null);
      }
    },
    [project, revokingId, reload, showToast],
  );

  const handleDelete = useCallback(
    async (source: any) => {
      if (!project || deletingId) return;
      if (
        !window.confirm(
          `Delete the source "${source.name}" and its token permanently? This cannot be undone.`,
        )
      ) {
        return;
      }
      const pid = project.id;
      setDeletingId(source.id);
      setLoadError(null);
      try {
        await api.deleteLogSource(pid, source.id);
        if (activePidRef.current !== pid) return;
        await reload(pid);
        if (showToast) showToast('Log source deleted.', 'success', 3000);
      } catch (err: any) {
        if (activePidRef.current !== pid) return;
        setLoadError(err?.message || 'Failed to delete source');
      } finally {
        if (activePidRef.current === pid) setDeletingId(null);
      }
    },
    [project, deletingId, reload, showToast],
  );

  const handleCopyToken = useCallback(async () => {
    if (!freshToken) return;
    await copyToClipboard(freshToken);
    setCopied(true);
    if (showToast) showToast('Token copied to clipboard.', 'success', 2500);
  }, [freshToken, showToast]);

  const handleCopyCurl = useCallback(async () => {
    if (!freshToken) return;
    await copyToClipboard(buildCurlExample(freshToken));
    setCopiedCurl(true);
    if (showToast) showToast('Example command copied to clipboard.', 'success', 2500);
  }, [freshToken, showToast]);

  if (!projects.length) {
    return <p className="text-sm text-gray-500">No projects yet.</p>;
  }

  return (
    <div className="space-y-6 pb-28">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
            <ScrollText size={18} className="text-sky-400" />
            Application logs
          </h3>
          <p className="text-xs text-gray-500 max-w-2xl">
            Register named <strong className="text-gray-300">log sources</strong> for this project.
            Each source mints one write-only ingest token your server or an OpenTelemetry collector
            uses to send application logs to Agent Hub for tailing and AI triage.
          </p>
        </div>
        {onOpenSession && (
          <button
            type="button"
            onClick={handleStartWizard}
            disabled={!project || wizardStarting}
            data-testid="logs-setup-wizard-button"
            title="Let an AI agent wire this project's app logs into Agent Hub on a branch"
            className="flex-shrink-0 inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-xs font-medium text-white"
          >
            {wizardStarting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {wizardStarting ? 'Starting…' : 'Set up with AI'}
          </button>
        )}
      </div>
      {wizardError && (
        <div className="flex items-center gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2">
          <AlertCircle size={14} className="flex-shrink-0" />
          <span>{wizardError}</span>
        </div>
      )}

      {/* ── Write-only credential warning ───────────────────────── */}
      <div
        className="flex items-start gap-2 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3"
        data-testid="logs-writeonly-warning"
      >
        <ShieldAlert size={16} className="flex-shrink-0 mt-0.5 text-amber-400" />
        <div>
          <p className="font-medium text-amber-100">Ingest tokens are write-only server secrets.</p>
          <p className="mt-1 text-amber-200/80">
            An <code className="text-amber-100">ahlog_</code> token can only send logs — it cannot
            read logs or call any Agent Hub API. Put it in your{' '}
            <strong className="text-amber-100">server or collector</strong> config, never in
            browser/client code or a public repo. Direct untrusted browser ingestion is not
            supported; browser errors flow through the RUM/replay path.
          </p>
        </div>
      </div>

      {/* ── Storage limits (from log-store metrics) ─────────────── */}
      <div
        className="bg-gray-800/40 border border-gray-700 rounded-xl p-4"
        data-testid="logs-limits"
      >
        <h4 className="text-sm font-semibold text-gray-300 mb-3">Storage limits (this project)</h4>
        {metrics ? (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-gray-500">Retention</dt>
              <dd className="text-gray-200" data-testid="logs-retention">
                {metrics.retentionDays} days
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Quota</dt>
              <dd className="text-gray-200" data-testid="logs-quota">
                {formatBytes(metrics.quotaBytes)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Stored</dt>
              <dd className="text-gray-200" data-testid="logs-stored">
                {formatBytes(metrics.projectBytes)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Past retention</dt>
              <dd className="text-gray-200" data-testid="logs-retention-lag">
                {metrics.retentionLagRecords} records
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-xs text-gray-600 italic">Storage metrics unavailable.</p>
        )}
      </div>

      {/* ── Create source ───────────────────────────────────────── */}
      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4 space-y-3">
        <h4 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Plus size={14} className="text-sky-400" />
          Create a log source
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e: any) => setNewName(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="Source name (e.g. production-api)"
            maxLength={100}
            data-testid="logs-new-name"
            className="bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-sky-500"
          />
          <input
            type="text"
            value={newService}
            onChange={(e: any) => setNewService(e.target.value)}
            placeholder="Service (optional)"
            maxLength={200}
            data-testid="logs-new-service"
            className="bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-sky-500"
          />
          <input
            type="text"
            value={newEnv}
            onChange={(e: any) => setNewEnv(e.target.value)}
            placeholder="Environment (optional)"
            maxLength={200}
            data-testid="logs-new-env"
            className="bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-sky-500"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleCreate}
            disabled={!project || creating || !newName.trim()}
            data-testid="logs-create-btn"
            className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Key size={12} />}
            Create source &amp; token
          </button>
        </div>
      </div>

      {/* ── One-time token reveal ───────────────────────────────── */}
      {freshToken && (
        <div
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-3 text-xs text-amber-100"
          data-testid="logs-fresh-token"
        >
          <div className="font-medium text-amber-200 mb-1">
            New ingest token for “{freshLabel}” — copy it now
          </div>
          <code
            className="block break-all font-mono text-amber-50/95"
            data-testid="logs-fresh-token-value"
          >
            {freshToken}
          </code>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={handleCopyToken}
              data-testid="logs-copy-token"
              className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <button
              type="button"
              onClick={handleCopyCurl}
              data-testid="logs-copy-curl"
              className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200"
            >
              {copiedCurl ? <Check size={12} /> : <Copy size={12} />}
              {copiedCurl ? 'Copied' : 'Copy curl example'}
            </button>
          </div>
          <pre
            className="mt-2 overflow-x-auto rounded bg-gray-950/70 border border-amber-500/20 p-2 text-[11px] leading-relaxed text-amber-50/90"
            data-testid="logs-curl-example"
          >
            {buildCurlExample(freshToken)}
          </pre>
          <p className="mt-1 text-amber-200/70">
            This token will not be shown again. Store it in your server/collector config.
          </p>
        </div>
      )}

      {/* ── Source list ─────────────────────────────────────────── */}
      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
            <Key size={14} className="text-amber-400" />
            Log sources
          </h4>
          {!loading && projectId && (
            <button
              type="button"
              onClick={() => void reload(projectId)}
              data-testid="logs-refresh"
              title="Reload sources"
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          )}
        </div>

        {loadError && (
          <p className="text-xs text-red-400 flex items-center gap-1" data-testid="logs-error">
            <AlertCircle size={12} />
            {loadError}
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" />
            Loading log sources…
          </div>
        ) : sources.length === 0 ? (
          <p className="text-xs text-gray-600 italic" data-testid="logs-empty">
            No log sources yet.
          </p>
        ) : (
          <ul className="divide-y divide-gray-800/80" data-testid="logs-source-list">
            {sources.map((s: any) => {
              const revoked = s.status === 'revoked';
              const busy = rotatingId === s.id || revokingId === s.id || deletingId === s.id;
              return (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs text-gray-200 truncate flex items-center gap-2">
                      {s.name}
                      <span
                        data-testid="logs-source-status"
                        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          revoked
                            ? 'bg-red-500/15 text-red-300'
                            : 'bg-emerald-500/15 text-emerald-300'
                        }`}
                      >
                        {revoked ? 'revoked' : 'active'}
                      </span>
                    </p>
                    <p className="text-[11px] text-gray-500 font-mono truncate">
                      {s.tokenPrefix ? `${s.tokenPrefix}…` : 'no token'}
                      {s.serviceName ? ` · ${s.serviceName}` : ''}
                      {s.environment ? ` · ${s.environment}` : ''}
                    </p>
                    <p className="text-[11px] text-gray-600 truncate">
                      {formatLastIngest(s.lastIngestAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => handleRotate(s)}
                      disabled={busy}
                      data-testid="logs-rotate"
                      title="Rotate token"
                      className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 disabled:text-gray-600"
                    >
                      {rotatingId === s.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <RefreshCw size={12} />
                      )}
                      Rotate
                    </button>
                    {!revoked && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(s)}
                        disabled={busy}
                        data-testid="logs-revoke"
                        title="Revoke token"
                        className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 disabled:text-gray-600"
                      >
                        {revokingId === s.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Ban size={12} />
                        )}
                        Revoke
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(s)}
                      disabled={busy}
                      data-testid="logs-delete"
                      title="Delete source"
                      className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 disabled:text-gray-600"
                    >
                      {deletingId === s.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Endpoint reference ──────────────────────────────────── */}
      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4 space-y-2">
        <h4 className="text-sm font-semibold text-gray-300">Ingest endpoints</h4>
        <p className="text-xs text-gray-500 max-w-2xl">
          Authenticate with{' '}
          <code className="text-gray-300">Authorization: Bearer &lt;token&gt;</code> (or the{' '}
          <code className="text-gray-300">X-AgentHub-Log-Token</code> header). Identity is derived
          from the token — never from the request body.
        </p>
        <ul className="text-[11px] text-gray-400 font-mono space-y-1">
          <li data-testid="logs-endpoint-otlp">
            <span className="text-emerald-400">POST</span> {ingestBase()}/api/otel/v1/logs{' '}
            <span className="text-gray-600">— OTLP/HTTP (JSON or protobuf, gzip ok)</span>
          </li>
          <li data-testid="logs-endpoint-batch">
            <span className="text-emerald-400">POST</span> {ingestBase()}/api/logs/ingest{' '}
            <span className="text-gray-600">— Agent Hub JSON batch</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
