import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  AlertTriangle,
  ExternalLink,
  Copy,
  ChevronDown,
  ChevronRight,
  MinusCircle,
} from 'lucide-react';
import {
  initialState,
  reduceEvent,
  classifyError,
  phaseTone,
  hasGithubFailure,
  LOG_BUFFER_MAX,
} from '../utils/provisioningStatus';

/**
 * ProvisioningStatus — live phased checklist + streaming log for the
 * New Project → Provisioning flow.
 *
 * Transport-agnostic: the caller subscribes to whatever event source the
 * server exposes (SSE, WebSocket, polling) and hands each event to the
 * `events` array prop. We don't bake fetch/EventSource into the component
 * so tests can drive it with plain arrays.
 *
 * Props:
 *   - events: array of { type: 'phase'|'log'|'done', ... }
 *       Re-rendered whenever this array grows. The component treats the
 *       array as append-only — it replays every event into the pure
 *       reducer on each render (cheap: O(events) per render, and the
 *       caller typically batches events).
 *   - withGithub: bool — whether GitHub phases should be rendered.
 *   - withToolchain: bool — whether wire-tests / wire-lint should be
 *     rendered. Off for the blank (description-first) scaffold.
 *   - onRetry: optional callback — shown on the error card.
 *   - onClose: optional callback — shown on success and error cards.
 *   - onOpenRepo: optional callback fired when the user clicks the repo URL.
 *   - onOpenProject: optional callback — the manual escape shown on the
 *     success/partial card once the first-build handoff times out, so the
 *     user is never stranded on "Opening the first build session…".
 *   - buildHandoffTimedOut: bool — reveals that escape when true.
 */
export default function ProvisioningStatus({
  events = [],
  withGithub = true,
  withToolchain = false,
  onRetry,
  onClose,
  onOpenRepo,
  onOpenProject,
  buildHandoffTimedOut = false,
}: any) {
  const state = useMemo(() => {
    return events.reduce(
      (acc: any, ev: any) => reduceEvent(acc, ev),
      initialState({ withGithub, withToolchain }),
    );
  }, [events, withGithub, withToolchain]);

  return (
    <div
      className="flex flex-col w-full h-full bg-gray-950 text-white"
      data-testid="provisioning-status"
    >
      <Header state={state} />
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <PhaseChecklist state={state} />
          <LogTail logs={state.logs} />
          {state.overall === 'success' && (
            <SuccessCard
              state={state}
              onClose={onClose}
              onOpenRepo={onOpenRepo}
              onOpenProject={onOpenProject}
              buildHandoffTimedOut={buildHandoffTimedOut}
            />
          )}
          {state.overall === 'partial' && (
            <PartialCard
              state={state}
              onClose={onClose}
              onOpenRepo={onOpenRepo}
              onOpenProject={onOpenProject}
              buildHandoffTimedOut={buildHandoffTimedOut}
            />
          )}
          {state.overall === 'failed' && (
            <FailureCard state={state} onRetry={onRetry} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function Header({ state }: any) {
  const label =
    state.overall === 'success'
      ? 'Project ready'
      : state.overall === 'partial'
        ? 'Local scaffold ready — GitHub step failed'
        : state.overall === 'failed'
          ? 'Provisioning failed'
          : state.overall === 'running'
            ? 'Provisioning…'
            : 'Waiting to start';
  const tone =
    state.overall === 'success'
      ? 'bg-emerald-900/60 border-emerald-700 text-emerald-200'
      : state.overall === 'partial'
        ? 'bg-amber-900/60 border-amber-700 text-amber-200'
        : state.overall === 'failed'
          ? 'bg-red-900/60 border-red-700 text-red-200'
          : 'bg-gray-800 border-gray-700 text-gray-200';
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900/90 px-4 py-3">
      <h1 className="min-w-0 flex-1 text-base font-semibold text-white">New Project</h1>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${tone}`}
        data-testid="ps-overall"
      >
        {label}
      </span>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Phase checklist                                                     */
/* ------------------------------------------------------------------ */

function PhaseChecklist({ state }: any) {
  return (
    <section
      aria-label="Provisioning phases"
      data-testid="ps-phases"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <ul className="divide-y divide-gray-800">
        {state.phases.map((p: any) => (
          <PhaseRow key={p.id} phase={p} />
        ))}
      </ul>
    </section>
  );
}

function PhaseRow({ phase }: any) {
  const tone = phaseTone(phase.status);
  return (
    <li
      className="flex items-center gap-3 px-4 py-2.5 text-sm"
      data-testid={`ps-phase-${phase.id}`}
      data-tone={tone}
      data-status={phase.status}
    >
      <PhaseIcon status={phase.status} />
      <div className="flex-1 min-w-0">
        <div className="text-gray-100">{phase.label}</div>
        {phase.message && <div className="text-xs text-gray-500 truncate">{phase.message}</div>}
      </div>
      <Elapsed phase={phase} />
    </li>
  );
}

function PhaseIcon({ status }: any) {
  const common = 'shrink-0';
  switch (status) {
    case 'ok':
      return <CheckCircle2 size={18} className={`${common} text-emerald-400`} aria-label="ok" />;
    case 'started':
      return (
        <Loader2
          size={18}
          className={`${common} text-amber-400 animate-spin`}
          aria-label="running"
        />
      );
    case 'failed':
      return <XCircle size={18} className={`${common} text-red-400`} aria-label="failed" />;
    case 'skipped':
      return <MinusCircle size={18} className={`${common} text-gray-500`} aria-label="skipped" />;
    case 'pending':
    default:
      return <Circle size={18} className={`${common} text-gray-600`} aria-label="pending" />;
  }
}

function Elapsed({ phase }: any) {
  const [, force] = useState(0);
  useEffect(() => {
    if (phase.status !== 'started') return undefined;
    const id = setInterval(() => force((n: any) => n + 1), 1000);
    return () => clearInterval(id);
  }, [phase.status]);

  if (!phase.startedAt) return null;
  const end = phase.finishedAt ? Date.parse(phase.finishedAt) : Date.now();
  const ms = Math.max(0, end - Date.parse(phase.startedAt));
  const s = Math.round(ms / 1000);
  return (
    <span className="text-[11px] text-gray-500 tabular-nums shrink-0">
      {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Streaming log tail                                                  */
/* ------------------------------------------------------------------ */

function LogTail({ logs }: any) {
  const [expanded, setExpanded] = useState(true);
  const containerRef = useRef<any>(null);
  const stickToBottomRef = useRef(true);

  // Auto-scroll to bottom when new lines arrive, unless the user scrolled up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !expanded || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, expanded]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
    stickToBottomRef.current = nearBottom;
  };

  const truncated = logs.length >= LOG_BUFFER_MAX;

  return (
    <section
      aria-label="Provisioning log"
      data-testid="ps-log"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <button
        type="button"
        onClick={() => setExpanded((v: any) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800/50 rounded-t-lg"
        data-testid="ps-log-toggle"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-gray-400 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-gray-400 shrink-0" />
        )}
        <span className="font-medium">Log</span>
        <span className="text-xs text-gray-500">{logs.length} lines</span>
      </button>
      {expanded && (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="px-3 pb-3 pt-1 font-mono text-[11px] leading-snug text-gray-300 max-h-56 overflow-y-auto"
          data-testid="ps-log-body"
        >
          {truncated && (
            <div className="text-[10px] uppercase tracking-wide text-amber-300/80 mb-1">
              … older lines truncated ({LOG_BUFFER_MAX} line buffer) …
            </div>
          )}
          {logs.length === 0 ? (
            <div className="text-gray-600 italic">Waiting for output…</div>
          ) : (
            logs.map((l: any, i: any) => (
              <div key={`${i}-${l.at}`} className="whitespace-pre-wrap break-words">
                {l.line}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal-state cards                                                */
/* ------------------------------------------------------------------ */

function SuccessCard({ state, onClose, onOpenRepo, onOpenProject, buildHandoffTimedOut }: any) {
  return (
    <section
      className="rounded-lg border border-emerald-700 bg-emerald-950/40 px-4 py-4 text-sm"
      data-testid="ps-success"
    >
      <div className="flex items-center gap-2 text-emerald-200 font-medium">
        <CheckCircle2 size={18} /> Repository created
      </div>
      {state.repoUrl && (
        <div className="mt-2 flex items-center gap-2">
          <a
            href={state.repoUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => onOpenRepo?.(state.repoUrl)}
            className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2 break-all inline-flex items-center gap-1"
            data-testid="ps-repo-link"
          >
            {state.repoUrl} <ExternalLink size={12} />
          </a>
          <CopyButton value={state.repoUrl} />
        </div>
      )}
      <div className="mt-3">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors"
            data-testid="ps-success-close"
          >
            Done
          </button>
        ) : buildHandoffTimedOut ? (
          <div className="space-y-2" data-testid="ps-handoff-timeout">
            <p className="text-emerald-200/80 text-[13px]">
              Still preparing the first build session. You can open the project now — the build chat
              will appear as soon as it starts.
            </p>
            <button
              type="button"
              onClick={onOpenProject}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors"
              data-testid="ps-open-project"
            >
              Open project
            </button>
          </div>
        ) : (
          <p className="text-emerald-200/80 text-[13px]" data-testid="ps-opening-build">
            Opening the first build session…
          </p>
        )}
      </div>
    </section>
  );
}

function PartialCard({ state, onClose, onOpenRepo, onOpenProject, buildHandoffTimedOut }: any) {
  const cls = classifyError(state.error);
  return (
    <section
      className="rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-4 text-sm"
      data-testid="ps-partial"
    >
      <div className="flex items-center gap-2 text-amber-200 font-medium">
        <AlertTriangle size={18} /> Local scaffold ready — GitHub step failed
      </div>
      <p className="mt-2 text-amber-100/80 text-[13px]">
        The project tree was generated and committed locally, but publishing to GitHub did not
        succeed. You can keep working locally and push later, or retry after fixing the issue.
      </p>
      {cls && (
        <div className="mt-2 text-xs text-amber-200/90">
          <span className="font-medium">Hint:</span> {cls.hint}
        </div>
      )}
      {hasGithubFailure(state) && state.repoUrl && (
        <div className="mt-2">
          <a
            href={state.repoUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => onOpenRepo?.(state.repoUrl)}
            className="text-amber-300 underline underline-offset-2 inline-flex items-center gap-1"
          >
            {state.repoUrl} <ExternalLink size={12} />
          </a>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="bg-gray-800 hover:bg-gray-700 text-gray-100 font-medium px-4 py-2 rounded-lg text-sm transition-colors"
            data-testid="ps-partial-close"
          >
            Keep local scaffold
          </button>
        )}
        {/* No onClose during the first-build handoff — reveal a manual escape
            once it times out so the user isn't stranded on this card. */}
        {!onClose && buildHandoffTimedOut && (
          <button
            type="button"
            onClick={onOpenProject}
            className="bg-amber-600 hover:bg-amber-500 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors"
            data-testid="ps-open-project"
          >
            Open project
          </button>
        )}
      </div>
    </section>
  );
}

function FailureCard({ state, onRetry, onClose }: any) {
  const cls = classifyError(state.error);
  return (
    <section
      className="rounded-lg border border-red-700 bg-red-950/40 px-4 py-4 text-sm"
      data-testid="ps-failure"
    >
      <div className="flex items-center gap-2 text-red-200 font-medium">
        <XCircle size={18} /> Provisioning failed
      </div>
      {cls && (
        <>
          <div className="mt-2 text-[13px] text-red-100/90 break-words">{cls.message}</div>
          <div className="mt-1 text-xs text-red-200/80">
            <span className="font-medium">Hint:</span> {cls.hint}
          </div>
          {typeof cls.code === 'number' && (
            <div className="mt-1 text-[11px] text-red-300/70 font-mono">exit {cls.code}</div>
          )}
        </>
      )}
      <div className="mt-3 flex gap-2">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="bg-red-600 hover:bg-red-500 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors"
            data-testid="ps-retry"
          >
            Retry
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="bg-gray-800 hover:bg-gray-700 text-gray-100 font-medium px-4 py-2 rounded-lg text-sm transition-colors"
            data-testid="ps-failure-close"
          >
            Close
          </button>
        )}
      </div>
    </section>
  );
}

function CopyButton({ value }: any) {
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore clipboard failures */
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      className="text-gray-400 hover:text-gray-200 text-xs inline-flex items-center gap-1"
      aria-label="Copy repository URL"
      data-testid="ps-copy"
    >
      <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
