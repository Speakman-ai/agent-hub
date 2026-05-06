import { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitBranch,
  Globe,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Info,
  PlayCircle,
  Copy,
  ExternalLink,
  CircleDot,
  Circle,
  MinusCircle,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { subscribeProvisioningEvents } from '../utils/provisioningClient.js';

/**
 * PR Environments — Provisioning Wizard.
 *
 * Replaces the read-only validator panel. The wizard collects three inputs
 * the operator must specify (`previewHost`, `hostedZoneId`, `repoFullName`)
 * and runs the five-phase orchestrator documented in
 * `docs/architecture/pr-environments-provisioning-wizard-v1-spec.md`:
 *
 *   1. detect-host
 *   2. write-tier3-config
 *   3. issue-cert
 *   4. attach-iam
 *   5. verify   ← only phase allowed to emit RemediationCards
 *
 * The wizard calls:
 *   - POST  /api/settings/pr-env/provision         → { jobId, wsUrl }
 *   - WS    <wsUrl>?since=<seq>                    → phase / log / done events
 *   - GET   /api/settings/pr-env/provision/last    → last terminal summary
 *
 * The legacy `POST /api/settings/pr-env/validate` endpoint is retained
 * server-side as a programmatic hook for crons / monitoring (see
 * `server/routes/pr-env-settings.ts`) but is no longer surfaced in this
 * panel — operators re-run the wizard end-to-end if they want a fresh
 * verification.
 *
 * Resume-on-reload semantics: an in-flight job stashes its `jobId` + `wsUrl`
 * in `localStorage`; on mount we resubscribe with `?since=<lastSeq>` so a
 * page refresh mid-run keeps streaming. Once a `done` arrives we clear the
 * stash and surface a "Last provisioned at …" status row from
 * `/provision/last`.
 */

const PHASES = [
  {
    id: 'detect-host',
    label: 'Detect host',
    description: 'Classify the host as containerized / pm2-on-ec2 / dev.',
  },
  {
    id: 'write-tier3-config',
    label: 'Write Tier-3 config',
    description: 'Merge derived nginx paths into ~/.agent-hub/data/config.json.',
  },
  {
    id: 'issue-cert',
    label: 'Issue wildcard cert',
    description: 'certbot certonly --dns-route53 -d "*.<previewHost>".',
  },
  {
    id: 'attach-iam',
    label: 'Attach IAM policy',
    description: 'iam:PutRolePolicy on the EC2 instance role (or copy-paste).',
  },
  {
    id: 'verify',
    label: 'Verify',
    description: 'Re-run the docker / nginx / cert / github-app / route53 / webhook checks.',
  },
];

const EMPTY_FORM = { previewHost: '', hostedZoneId: '', repoFullName: '' };

const ACTIVE_JOB_LS_KEY = 'prenv-wizard-active-job';

function readActiveJobFromStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_JOB_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.jobId || !parsed?.wsUrl) return null;
    return { jobId: parsed.jobId, wsUrl: parsed.wsUrl };
  } catch {
    return null;
  }
}

function writeActiveJobToStorage(value) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (value) window.localStorage.setItem(ACTIVE_JOB_LS_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(ACTIVE_JOB_LS_KEY);
  } catch {
    /* ignore quota / disabled storage */
  }
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

/** Reduce phase events into a per-phase status map keyed by phase id. */
function phaseReducer(state, event) {
  if (event.type !== 'phase') return state;
  const next = { ...state };
  next[event.phase] = {
    status: event.status, // 'started' | 'ok' | 'failed' | 'skipped'
    message: event.message ?? '',
    at: event.at,
  };
  return next;
}

export default function PrEnvironmentsSection() {
  // ── form ─────────────────────────────────────────────────────────────
  const [form, setForm] = useState(EMPTY_FORM);
  const [formLoading, setFormLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // ── last-run summary ─────────────────────────────────────────────────
  const [lastRun, setLastRun] = useState(null); // { jobId, outcome, finishedAt } | null

  // ── live job state ───────────────────────────────────────────────────
  const [activeJobId, setActiveJobId] = useState(null);
  const [phaseState, setPhaseState] = useState({}); // { [phaseId]: { status, message, at } }
  const [logEvents, setLogEvents] = useState([]); // list of { phase, line, at, seq }
  const [doneEvent, setDoneEvent] = useState(null); // last terminal { outcome, error?, remediations? }
  const [running, setRunning] = useState(false);
  const [startError, setStartError] = useState(null);

  // Refs so the WS subscriber callback always sees current values.
  const subscriptionRef = useRef(null);
  const logScrollRef = useRef(null);
  const lastSeqRef = useRef(-1);

  const setField = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const closeSubscription = useCallback(() => {
    if (subscriptionRef.current) {
      try {
        subscriptionRef.current.close();
      } catch {
        /* ignore */
      }
      subscriptionRef.current = null;
    }
  }, []);

  const handleEvent = useCallback(
    (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (typeof ev.seq === 'number' && ev.seq > lastSeqRef.current) {
        lastSeqRef.current = ev.seq;
      }
      if (ev.type === 'phase') {
        setPhaseState((prev) => phaseReducer(prev, ev));
      } else if (ev.type === 'log') {
        setLogEvents((prev) => {
          // De-duplicate on seq when the server replays after a reconnect.
          if (typeof ev.seq === 'number' && prev.some((p) => p.seq === ev.seq)) return prev;
          return [...prev, ev];
        });
      } else if (ev.type === 'done') {
        setDoneEvent({
          outcome: ev.outcome ?? (ev.error ? 'error' : 'ok'),
          error: ev.error,
          remediations: ev.remediations || [],
          at: ev.at,
        });
        setRunning(false);
        writeActiveJobToStorage(null);
        // Refresh the "Last provisioned at" row from the server's terminal
        // summary so the display matches /provision/last.
        api
          .getLastPrEnvProvision()
          .then((d) => {
            if (d && d.jobId) setLastRun(d);
          })
          .catch(() => {
            /* non-fatal */
          });
      }
    },
    [], // intentionally stable: refs + setters only
  );

  /** Subscribe to a job's WS. `since` enables replay-on-reconnect. */
  const attachToJob = useCallback(
    ({ jobId, wsUrl, since }) => {
      closeSubscription();
      setActiveJobId(jobId);
      setRunning(true);
      setStartError(null);
      setDoneEvent(null);
      // Keep existing phase/log state when reconnecting (since>=0); reset
      // when starting a fresh job.
      if (typeof since !== 'number' || since < 0) {
        setPhaseState({});
        setLogEvents([]);
        lastSeqRef.current = -1;
      }
      const url =
        typeof since === 'number' && since >= 0
          ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}since=${since}`
          : wsUrl;
      subscriptionRef.current = subscribeProvisioningEvents(url, {
        onEvent: handleEvent,
        onClose: () => {
          // The subscriber synthesises a `done` on stall/drop, so we don't
          // need to flip `running` here — handleEvent will when the done
          // arrives. This is just teardown bookkeeping.
        },
        onError: () => {
          /* surfaced via synthesised done */
        },
      });
    },
    [closeSubscription, handleEvent],
  );

  // ── initial load: Tier-1 settings (for previewHost / repo prefill) +
  //    last-run summary + reattach an in-flight job from localStorage. ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, last] = await Promise.allSettled([
          api.getPrEnvSettings(),
          api.getLastPrEnvProvision(),
        ]);
        if (cancelled) return;
        if (settings.status === 'fulfilled' && settings.value) {
          const s = settings.value;
          setForm({
            previewHost: s.previewHost ?? '',
            hostedZoneId: s.route53HostedZoneId ?? '',
            repoFullName: s.repoFullName ?? '',
          });
        } else if (settings.status === 'rejected') {
          setLoadError(settings.reason?.message || 'Failed to load PR-env settings');
        }
        if (last.status === 'fulfilled' && last.value && last.value.jobId) {
          setLastRun(last.value);
        }
        // Resume an in-flight job if localStorage has one. The WS replays
        // events ≥ since so we don't lose the in-progress phases.
        const stash = readActiveJobFromStorage();
        if (stash) {
          attachToJob({ jobId: stash.jobId, wsUrl: stash.wsUrl, since: -1 });
        }
      } finally {
        if (!cancelled) setFormLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // attachToJob is stable; intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tear down the WS on unmount.
  useEffect(() => () => closeSubscription(), [closeSubscription]);

  // Auto-scroll the live event stream to the bottom on append.
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logEvents.length]);

  const formErrors = (() => {
    const out = [];
    if (!form.previewHost.trim()) out.push('previewHost is required');
    if (!form.hostedZoneId.trim()) out.push('Route 53 hostedZoneId is required');
    if (!form.repoFullName.trim()) out.push('repoFullName is required');
    return out;
  })();

  const handleProvision = async () => {
    if (formErrors.length > 0) return;
    setStartError(null);
    setDoneEvent(null);
    setPhaseState({});
    setLogEvents([]);
    lastSeqRef.current = -1;
    setRunning(true);
    try {
      const res = await api.startPrEnvProvision({
        previewHost: form.previewHost.trim(),
        hostedZoneId: form.hostedZoneId.trim(),
        repoFullName: form.repoFullName.trim(),
      });
      if (!res?.jobId || !res?.wsUrl) {
        throw new Error('Server did not return a jobId / wsUrl');
      }
      writeActiveJobToStorage({ jobId: res.jobId, wsUrl: res.wsUrl });
      attachToJob({ jobId: res.jobId, wsUrl: res.wsUrl });
    } catch (err) {
      setRunning(false);
      setStartError(err.message || 'Failed to start provisioning');
      writeActiveJobToStorage(null);
    }
  };

  if (formLoading) {
    return (
      <p className="text-sm text-gray-500 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading PR environment settings…
      </p>
    );
  }

  if (loadError) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <p className="text-red-400 text-sm font-medium mb-1">Failed to load</p>
        <p className="text-xs text-gray-400 mb-3">{loadError}</p>
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
        >
          <RefreshCw size={12} />
          Reload
        </button>
      </div>
    );
  }

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono disabled:opacity-60';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  // Remediation cards only come from the verify phase per spec.
  const remediations = doneEvent?.remediations || [];

  return (
    <div className="space-y-6" data-testid="prenv-wizard">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <GitBranch size={18} className="text-blue-400" />
          PR Environments
        </h3>
        <p className="text-xs text-gray-400 mt-1 max-w-2xl">
          Click <strong>Provision PR Environments</strong> to detect the host, write the nginx
          paths, issue a wildcard cert via certbot + Route 53, attach the IAM policy, and verify
          everything end-to-end. Re-running is safe — every phase is idempotent.
        </p>
      </div>

      {/* Inherited-credentials notice (kept for context). */}
      <div
        className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4"
        data-testid="prenv-inherited-creds-notice"
      >
        <div className="flex items-start gap-3">
          <Info size={18} className="text-blue-400 shrink-0 mt-0.5" />
          <div className="text-xs text-blue-100/90 space-y-1.5">
            <p className="font-medium text-blue-300">Credentials come from infrastructure</p>
            <p>
              GitHub App credentials are inherited from the registered Reviewer App, and Route 53
              access is provided by the EC2 instance role (IMDSv2). Both are managed by Terraform
              and surfaced through the wizard&apos;s <code>attach-iam</code> phase when a manual
              copy-paste is required.
            </p>
          </div>
        </div>
      </div>

      {/* ── Three operator inputs (the only fields the wizard needs) ───── */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-gray-400" />
          <h4 className="text-sm font-medium text-gray-200">Provision inputs</h4>
        </div>

        <div>
          <label className={labelClass} htmlFor="prenv-preview-host">
            Preview host
          </label>
          <input
            id="prenv-preview-host"
            value={form.previewHost}
            onChange={(e) => setField('previewHost', e.target.value)}
            className={inputClass}
            placeholder="preview.example.com"
            disabled={running}
          />
          <p className="text-[11px] text-gray-600 mt-1">
            Used to issue <code>*.&lt;previewHost&gt;</code> via Let&apos;s Encrypt + Route 53.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="prenv-hosted-zone-id">
            Route 53 hosted zone ID
          </label>
          <input
            id="prenv-hosted-zone-id"
            value={form.hostedZoneId}
            onChange={(e) => setField('hostedZoneId', e.target.value)}
            className={inputClass}
            placeholder="Z0123456789ABC"
            disabled={running}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="prenv-repo">
            GitHub repo (owner/name)
          </label>
          <input
            id="prenv-repo"
            value={form.repoFullName}
            onChange={(e) => setField('repoFullName', e.target.value)}
            className={inputClass}
            placeholder="acme/widgets"
            disabled={running}
          />
        </div>

        {formErrors.length > 0 && (
          <div className="text-xs text-amber-400 space-y-0.5" data-testid="prenv-form-errors">
            {formErrors.map((e) => (
              <p key={e} className="flex items-center gap-1.5">
                <AlertTriangle size={12} /> {e}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* ── Last-run status row ────────────────────────────────────────── */}
      {lastRun && (
        <div className="text-xs text-gray-400 flex items-center gap-2" data-testid="prenv-last-run">
          <span className="text-gray-500">Last provisioned:</span>
          <span className="text-gray-300">{formatTimestamp(lastRun.finishedAt)}</span>
          <OutcomeBadge outcome={lastRun.outcome} />
        </div>
      )}

      {/* ── Action buttons ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleProvision}
          disabled={running || formErrors.length > 0}
          data-testid="prenv-provision-button"
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
          {running ? 'Provisioning…' : 'Provision PR Environments'}
        </button>
        {startError && (
          <span className="text-xs text-red-400 flex items-center gap-1">
            <XCircle size={13} /> {startError}
          </span>
        )}
      </div>

      {/* ── Phase rows ─────────────────────────────────────────────────── */}
      {(running || activeJobId || doneEvent) && (
        <PhaseList
          phases={PHASES}
          phaseState={phaseState}
          remediations={remediations}
          done={doneEvent}
        />
      )}

      {/* ── Live event stream ──────────────────────────────────────────── */}
      {(running || logEvents.length > 0) && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl">
          <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
            <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Live event stream
            </h4>
            <span className="text-[10px] text-gray-600">
              {logEvents.length} line{logEvents.length === 1 ? '' : 's'}
            </span>
          </div>
          <div
            ref={logScrollRef}
            data-testid="prenv-event-stream"
            className="font-mono text-[11px] text-gray-300 max-h-64 overflow-auto p-3 space-y-0.5"
          >
            {logEvents.length === 0 && (
              <p className="text-gray-600 italic">Waiting for the first event…</p>
            )}
            {logEvents.map((ev, i) => (
              <div
                key={ev.seq ?? i}
                className="flex items-start gap-2"
                data-testid="prenv-event-line"
              >
                <span className="text-gray-600 shrink-0">[{ev.phase}]</span>
                <span className="break-all">{ev.line}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Render the 5 phase rows + their remediation cards. */
function PhaseList({ phases, phaseState, remediations, done }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-2" data-testid="prenv-phase-list">
      <h4 className="text-sm font-medium text-gray-200 mb-2">Progress</h4>
      <ul className="space-y-2">
        {phases.map((p) => {
          const state = phaseState[p.id]; // undefined → pending
          const status = state?.status ?? 'pending';
          const cardsForPhase = p.id === 'verify' ? remediations : []; // spec: only verify emits remediations
          return (
            <li key={p.id} data-testid={`prenv-phase-${p.id}`} className="space-y-2">
              <div className="flex items-start gap-3 text-sm">
                <PhaseStatusIcon status={status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-200 font-medium">{p.label}</span>
                    <PhaseStatusPill status={status} />
                  </div>
                  <p className="text-[11px] text-gray-500">{p.description}</p>
                  {state?.message && (
                    <p
                      className="text-[11px] text-gray-400 mt-1"
                      data-testid={`prenv-phase-${p.id}-message`}
                    >
                      {state.message}
                    </p>
                  )}
                </div>
              </div>
              {cardsForPhase.length > 0 && (
                <div className="ml-7 space-y-2" data-testid={`prenv-phase-${p.id}-remediations`}>
                  {cardsForPhase.map((card, idx) => (
                    <RemediationCard key={`${card.check}-${idx}`} card={card} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {done && (
        <div
          className="mt-3 pt-3 border-t border-gray-700 text-xs flex items-center gap-2"
          data-testid="prenv-done-banner"
        >
          <OutcomeBadge outcome={done.outcome} />
          {done.error?.message && <span className="text-red-300">{done.error.message}</span>}
        </div>
      )}
    </div>
  );
}

function PhaseStatusIcon({ status }) {
  const cls = 'shrink-0 mt-0.5';
  switch (status) {
    case 'started':
      return <Loader2 size={14} className={`${cls} animate-spin text-blue-400`} />;
    case 'ok':
      return <CheckCircle2 size={14} className={`${cls} text-emerald-400`} />;
    case 'failed':
      return <XCircle size={14} className={`${cls} text-red-400`} />;
    case 'skipped':
      return <MinusCircle size={14} className={`${cls} text-gray-500`} />;
    case 'pending':
    default:
      return <Circle size={14} className={`${cls} text-gray-600`} />;
  }
}

function PhaseStatusPill({ status }) {
  const meta = {
    pending: { label: 'pending', className: 'bg-gray-700 text-gray-400' },
    started: { label: 'running', className: 'bg-blue-500/20 text-blue-300' },
    ok: { label: 'ok', className: 'bg-emerald-500/20 text-emerald-300' },
    failed: { label: 'failed', className: 'bg-red-500/20 text-red-300' },
    skipped: { label: 'skipped', className: 'bg-gray-600/40 text-gray-300' },
  }[status] || { label: status, className: 'bg-gray-700 text-gray-300' };
  return (
    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function OutcomeBadge({ outcome }) {
  if (outcome === 'ok') {
    return (
      <span className="text-emerald-400 flex items-center gap-1">
        <CheckCircle2 size={13} /> all green
      </span>
    );
  }
  if (outcome === 'partial') {
    return (
      <span className="text-amber-400 flex items-center gap-1">
        <AlertTriangle size={13} /> partial — see remediation
      </span>
    );
  }
  if (outcome === 'error') {
    return (
      <span className="text-red-400 flex items-center gap-1">
        <XCircle size={13} /> error
      </span>
    );
  }
  return (
    <span className="text-gray-400 flex items-center gap-1">
      <CircleDot size={13} /> {outcome ?? 'unknown'}
    </span>
  );
}

/**
 * Remediation card surfaced by a verify-phase failure. Spec: each card has
 * a headline, optional detail block, and a list of typed actions
 * (`retry` | `copy` | `link` | `open-settings`).
 */
function RemediationCard({ card }) {
  const [copied, setCopied] = useState(null);
  const severityClass =
    card.severity === 'amber'
      ? 'bg-amber-500/10 border-amber-500/30 text-amber-100'
      : 'bg-red-500/10 border-red-500/30 text-red-100';

  const handleAction = async (action) => {
    if (action.kind === 'copy' && typeof action.payload === 'string') {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(action.payload);
        }
        setCopied(action.label);
        setTimeout(() => setCopied(null), 1500);
      } catch {
        /* clipboard blocked — silent */
      }
    } else if (action.kind === 'link' && action.payload) {
      window.open(action.payload, '_blank', 'noopener,noreferrer');
    } else if (action.kind === 'open-settings' && action.payload) {
      window.location.hash = action.payload;
    } else if (action.kind === 'retry') {
      // V1: a retry button on a verify card is informational — the spec says
      // operators re-run the wizard top-level button. We surface the action
      // but don't auto-trigger; downstream PRs may wire it to a per-phase
      // re-execution endpoint.
    }
  };

  return (
    <div
      className={`border rounded-lg p-3 text-xs ${severityClass}`}
      data-testid={`prenv-remediation-${card.check}`}
    >
      <p className="font-medium flex items-center gap-1.5">
        <AlertTriangle size={13} /> {card.headline}
      </p>
      {card.detail && (
        <pre className="text-[11px] mt-1.5 whitespace-pre-wrap opacity-80">{card.detail}</pre>
      )}
      {card.actions?.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {card.actions.map((action, i) => (
            <button
              key={`${action.kind}-${i}`}
              type="button"
              onClick={() => handleAction(action)}
              data-testid={`prenv-remediation-${card.check}-action-${action.kind}`}
              className="bg-gray-800/60 hover:bg-gray-700 text-gray-100 px-2 py-1 rounded flex items-center gap-1"
            >
              {action.kind === 'copy' && <Copy size={11} />}
              {action.kind === 'link' && <ExternalLink size={11} />}
              {action.kind === 'retry' && <RefreshCw size={11} />}
              {copied === action.label ? 'Copied!' : action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
