import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Check, X, Loader } from 'lucide-react';

/**
 * ProgressPanel — Cursor-Bugbot-style timed checklist rendered inline at the
 * top of the chat view.
 *
 * Driven by an ordered list of `{ step, status, startedAt, finishedAt }`
 * entries. Each step's elapsed time auto-ticks while `status === 'started'`
 * using a once-per-second clock. When every step is completed/failed (and
 * `sessionRunning === false`), the panel collapses to a one-liner summary.
 *
 * Same data model as the GitHub Check Run that Card 1 ships — one source of
 * truth, two renderers.
 */
export default function ProgressPanel({ steps, sessionRunning, className }) {
  const [expanded, setExpanded] = useState(true);
  // Once-per-second tick used only for elapsed rendering on in-flight steps.
  // Cheap: a single setInterval regardless of how many steps there are.
  const [, setNow] = useState(Date.now());
  const hasRunning = steps.some((s) => s.status === 'started');
  useEffect(() => {
    if (!hasRunning) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const summary = useMemo(() => computeSummary(steps), [steps]);

  // When the session finishes with all steps resolved, auto-collapse to the
  // one-liner summary. User can still re-expand manually.
  useEffect(() => {
    if (!sessionRunning && !hasRunning && steps.length > 0) {
      setExpanded(false);
    }
  }, [sessionRunning, hasRunning, steps.length]);

  if (!steps || steps.length === 0) return null;

  return (
    <div
      className={'border border-gray-800 bg-gray-900/60 rounded-lg text-sm ' + (className || '')}
      data-testid="progress-panel"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors rounded-t-lg"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-gray-400 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-gray-400 shrink-0" />
        )}
        <span className="text-gray-200 font-medium">Progress</span>
        <span className="text-gray-500 text-xs">{summary}</span>
      </button>
      {expanded && (
        <ul className="px-3 pb-2 pt-1 space-y-1">
          {steps.map((s, i) => (
            <li
              key={`${s.step}-${s.startedAt}-${i}`}
              className="flex items-center gap-2 text-gray-300"
              data-testid="progress-step"
            >
              <StatusIcon status={s.status} />
              <span className="truncate">{s.step}</span>
              <span className="ml-auto text-xs text-gray-500 tabular-nums">{formatElapsed(s)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusIcon({ status }) {
  if (status === 'completed') {
    return <Check size={14} className="text-emerald-400 shrink-0" aria-label="completed" />;
  }
  if (status === 'failed') {
    return <X size={14} className="text-rose-400 shrink-0" aria-label="failed" />;
  }
  // started / in-flight
  return (
    <Loader size={14} className="text-sky-400 shrink-0 animate-spin" aria-label="in progress" />
  );
}

/** Format "(Xs)" or "(Xm Ys)" elapsed time for a step. */
export function formatElapsed(step, nowMs = Date.now()) {
  if (!step || typeof step.startedAt !== 'number') return '';
  const end = step.status === 'started' ? nowMs : (step.finishedAt ?? step.startedAt);
  const ms = Math.max(0, end - step.startedAt);
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** One-liner shown in the collapsed header. */
export function computeSummary(steps) {
  const total = steps.length;
  if (total === 0) return '';
  const done = steps.filter((s) => s.status === 'completed').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const running = steps.filter((s) => s.status === 'started').length;
  if (running > 0) return `${done}/${total} done · ${running} running`;
  if (failed > 0) return `${done}/${total} done · ${failed} failed`;
  return `${done}/${total} done`;
}

/**
 * Reducer helper: merge a new progress_step event into an existing ordered
 * list. Exported for tests + the App.jsx reducer. Rules:
 *
 * - `started`: append as a new entry.
 * - `completed`/`failed`: mutate the most recent `started` entry with the
 *   same label. If none exists, append as a standalone entry so the panel
 *   still reflects the outcome.
 */
export function mergeProgressEvent(steps, evt) {
  if (!evt || typeof evt.step !== 'string') return steps;
  if (evt.status === 'started') {
    return [
      ...steps,
      {
        step: evt.step,
        status: 'started',
        startedAt: evt.startedAt ?? Date.now(),
        finishedAt: undefined,
      },
    ];
  }
  // Find the most recent 'started' entry for this label.
  let found = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].step === evt.step && steps[i].status === 'started') {
      found = i;
      break;
    }
  }
  if (found === -1) {
    return [
      ...steps,
      {
        step: evt.step,
        status: evt.status,
        startedAt: evt.startedAt ?? Date.now(),
        finishedAt: evt.finishedAt ?? evt.startedAt ?? Date.now(),
      },
    ];
  }
  const next = steps.slice();
  next[found] = {
    ...next[found],
    status: evt.status,
    finishedAt: evt.finishedAt ?? Date.now(),
  };
  return next;
}
