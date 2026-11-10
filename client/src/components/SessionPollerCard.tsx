import { useCallback, useEffect, useMemo, useState } from 'react';
import { BellRing, Repeat, Square } from 'lucide-react';
import { api } from '../utils/api';
import {
  expectedPollerRuns,
  formatPollerMinutes,
  SESSION_POLLER_REFRESH_MS,
  parsePollerAnchor,
  planPollerSchedule,
  pollerStartDurationMinutes,
  shouldReconcilePoller,
  type PollerProposal,
  type SessionPoller,
} from '@shared/utils/sessionPoller';
import {
  SESSION_POLLER_WS_EVENT,
  checkPollerForm,
  formatPollerClock,
} from '../utils/sessionPollers';

const inputClass =
  'w-full rounded-md border border-sky-800/70 bg-gray-950/80 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-sky-500 disabled:opacity-50';

function statusLine(poller: SessionPoller): string {
  const runs = `${poller.runCount} run${poller.runCount === 1 ? '' : 's'}`;
  if (poller.status === 'completed') return `Finished after ${runs}`;
  if (poller.status === 'cancelled') return `Stopped after ${runs}`;
  return `Running · ${runs} so far`;
}

export default function SessionPollerCard({
  sessionId,
  proposal,
  proposedAt,
}: {
  sessionId: string;
  proposal: PollerProposal;
  /** `created_at` of the message carrying the block; anchors relative end times. */
  proposedAt?: string | null;
}) {
  // The end time the user named is fixed by when they asked, not by when this
  // card renders, so a reopened session still targets the same moment.
  const [schedule] = useState(() =>
    planPollerSchedule(proposal, {
      anchor: parsePollerAnchor(proposedAt) ?? new Date(),
      now: new Date(),
    }),
  );
  const { deadline } = schedule;
  const [task, setTask] = useState(proposal.task);
  const [interval, setIntervalText] = useState(
    proposal.intervalMinutes ? String(proposal.intervalMinutes) : '',
  );
  const [duration, setDuration] = useState(() =>
    schedule.initialDurationMinutes ? String(schedule.initialDurationMinutes) : '',
  );
  const [durationEdited, setDurationEdited] = useState(false);
  const [notifyEachRun, setNotifyEachRun] = useState(proposal.notifyEachRun);
  const [notifyOnComplete, setNotifyOnComplete] = useState(proposal.notifyOnComplete);
  const [poller, setPoller] = useState<SessionPoller | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    if (!sessionId) return;
    api
      .listSessionPollers(sessionId)
      .then((body) => {
        const match = body?.pollers?.find((p) => p.pollerId === proposal.pollerId) ?? null;
        setPoller(match);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [sessionId, proposal.pollerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // WS updates are the fast path, but a dropped socket loses them. Re-read
  // while the poller is unfinished, and whenever the tab comes back.
  const reconcile = shouldReconcilePoller(poller);
  useEffect(() => {
    if (!reconcile) return;
    const timer = window.setInterval(refresh, SESSION_POLLER_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reconcile, refresh]);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        sessionId?: string;
        poller?: SessionPoller;
      };
      if (detail?.sessionId !== sessionId || detail.poller?.pollerId !== proposal.pollerId) return;
      setPoller(detail.poller);
    };
    window.addEventListener(SESSION_POLLER_WS_EVENT, onUpdate);
    return () => window.removeEventListener(SESSION_POLLER_WS_EVENT, onUpdate);
  }, [sessionId, proposal.pollerId]);

  const check = useMemo(
    () => checkPollerForm({ task, interval, duration }),
    [task, interval, duration],
  );
  const canStart = loaded && !poller && Object.keys(check.errors).length === 0 && !saving;

  async function handleStart() {
    if (!canStart || check.intervalMinutes === null || check.durationMinutes === null) return;
    const durationMinutes = pollerStartDurationMinutes({
      deadline,
      durationEdited,
      formMinutes: check.durationMinutes,
      now: new Date(),
    });
    if (durationMinutes === null) {
      setError('That end time has passed. Set a duration to start.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = await api.startSessionPoller(sessionId, {
        pollerId: proposal.pollerId,
        task: task.trim(),
        intervalMinutes: check.intervalMinutes,
        durationMinutes,
        notifyEachRun,
        notifyOnComplete,
      });
      setPoller(body.poller);
    } catch (err: any) {
      setError(err?.message || 'Could not start the poller.');
    } finally {
      setSaving(false);
    }
  }

  async function handleStop() {
    if (!poller) return;
    setSaving(true);
    setError('');
    try {
      const body = await api.stopSessionPoller(sessionId, poller.id);
      setPoller(body.poller);
    } catch (err: any) {
      setError(err?.message || 'Could not stop the poller.');
    } finally {
      setSaving(false);
    }
  }

  const header = poller ? statusLine(poller) : 'Set up a poller';
  const deadlineMissed = schedule.deadlinePassed && !durationEdited && deadline !== null;
  const endsPreview =
    deadline && !durationEdited
      ? formatPollerClock(deadline)
      : check.durationMinutes !== null
        ? formatPollerClock(new Date(Date.now() + check.durationMinutes * 60_000))
        : null;

  return (
    <div
      data-poller-id={proposal.pollerId}
      className="border border-sky-700/50 bg-sky-950/20 rounded-lg overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-sky-900/30 border-b border-sky-700/40">
        <Repeat size={15} className="text-sky-300 shrink-0" />
        <span className="text-xs font-medium text-sky-100">{header}</span>
      </div>

      {poller ? (
        <div className="p-3 space-y-2 text-sm text-sky-100">
          <p className="whitespace-pre-wrap">{poller.task}</p>
          <p className="text-xs text-sky-100/70">
            Every {formatPollerMinutes(poller.intervalMinutes)} for{' '}
            {formatPollerMinutes(poller.durationMinutes)}
            {poller.status === 'active' && poller.nextRunAt
              ? ` · next check ${formatPollerClock(new Date(poller.nextRunAt))}`
              : ''}
            {poller.status === 'active'
              ? ` · ends ${formatPollerClock(new Date(poller.endsAt))}`
              : ''}
          </p>
          {(poller.notifyEachRun || poller.notifyOnComplete) && (
            <p className="text-xs text-sky-100/70 flex items-center gap-1.5">
              <BellRing size={12} className="text-sky-300" />
              {poller.notifyEachRun && poller.notifyOnComplete
                ? 'Notifies after every run and when it finishes'
                : poller.notifyEachRun
                  ? 'Notifies after every run'
                  : 'Notifies when it finishes'}
            </p>
          )}
          {error && <p className="text-xs text-rose-200">{error}</p>}
          {poller.status === 'active' && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleStop}
                disabled={saving}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-sky-700/60 text-sky-100 hover:bg-sky-900/40 disabled:opacity-50"
              >
                <Square size={12} />
                {saving ? 'Stopping...' : 'Stop'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="p-3 space-y-3">
          <label className="block">
            <span className="block text-xs text-sky-100/80 mb-1">Task</span>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={2}
              disabled={saving}
              className={`${inputClass} resize-y`}
            />
            {check.errors.task && (
              <span className="text-[11px] text-rose-300">{check.errors.task}</span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-sky-100/80 mb-1">Interval (minutes)</span>
              <input
                aria-label="Interval in minutes"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={interval}
                onChange={(e) => setIntervalText(e.target.value)}
                disabled={saving}
                className={inputClass}
              />
              {check.errors.interval && (
                <span className="text-[11px] text-rose-300">{check.errors.interval}</span>
              )}
            </label>
            <label className="block">
              <span className="block text-xs text-sky-100/80 mb-1">Duration (minutes)</span>
              <input
                aria-label="Duration in minutes"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={duration}
                onChange={(e) => {
                  setDuration(e.target.value);
                  setDurationEdited(true);
                }}
                disabled={saving}
                className={inputClass}
              />
              {deadlineMissed ? (
                <span className="text-[11px] text-rose-300">
                  The requested end ({formatPollerClock(deadline)}) has passed. Set a duration.
                </span>
              ) : check.errors.duration ? (
                <span className="text-[11px] text-rose-300">{check.errors.duration}</span>
              ) : (
                endsPreview && (
                  <span className="text-[11px] text-sky-100/60">Ends around {endsPreview}</span>
                )
              )}
            </label>
          </div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-sky-100/90">
              <input
                type="checkbox"
                checked={notifyEachRun}
                onChange={(e) => setNotifyEachRun(e.target.checked)}
                disabled={saving}
              />
              Notify me after every run
            </label>
            <label className="flex items-center gap-2 text-xs text-sky-100/90">
              <input
                type="checkbox"
                checked={notifyOnComplete}
                onChange={(e) => setNotifyOnComplete(e.target.checked)}
                disabled={saving}
              />
              Notify me when it finishes
            </label>
          </div>
          {error && (
            <div className="text-xs text-rose-200 bg-rose-950/40 border border-rose-700/50 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-sky-100/60">
              {check.intervalMinutes && check.durationMinutes
                ? `About ${expectedPollerRuns(check.intervalMinutes, check.durationMinutes)} checks, first one now`
                : ''}
            </span>
            <button
              type="button"
              onClick={handleStart}
              disabled={!canStart}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                canStart
                  ? 'bg-sky-600 hover:bg-sky-500 text-white'
                  : 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
              }`}
            >
              {saving ? 'Starting...' : 'Start'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
