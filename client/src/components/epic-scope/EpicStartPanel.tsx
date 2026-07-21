import { useEffect, useState } from 'react';
import { Play, CalendarClock } from 'lucide-react';

/**
 * Epic-level start controls: a "Start epic" button that sweeps the epic's phases
 * left-to-right (honoring each phase's auto-dispatch arming, halting at the first
 * disabled phase), plus an optional scheduled start (node-cron + IANA timezone,
 * interpreted in local/zone time exactly like the deploy scheduler and crons).
 */

const OUTCOME_MESSAGE: Record<string, (phaseName?: string) => string> = {
  started: (p) => `Started — kicked off phase "${p ?? ''}". Later phases advance automatically.`,
  already_running: (p) => `Phase "${p ?? ''}" is already running.`,
  stopped_disabled: (p) =>
    `Stopped at phase "${p ?? ''}" — its auto-dispatch is off. Turn it on to continue the sweep.`,
  all_complete: () => 'Every phase is already complete. Nothing to start.',
  no_phases: () => 'This epic has no phases yet — add a phase first.',
};

export default function EpicStartPanel({
  epic,
  onRunEpic,
  onSaveSchedule,
  onClearSchedule,
}: {
  epic: any;
  onRunEpic: () => Promise<any>;
  onSaveSchedule: (data: {
    cron: string;
    timezone: string | null;
    enabled: boolean;
  }) => Promise<void>;
  onClearSchedule: () => Promise<void>;
}) {
  const [cron, setCron] = useState<string>(epic?.scheduled_start_cron || '');
  const [timezone, setTimezone] = useState<string>(epic?.scheduled_start_timezone || '');
  const [enabled, setEnabled] = useState<boolean>(epic?.scheduled_start_enabled === 1);

  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form when the epic (or its schedule) changes from the server.
  useEffect(() => {
    setCron(epic?.scheduled_start_cron || '');
    setTimezone(epic?.scheduled_start_timezone || '');
    setEnabled(epic?.scheduled_start_enabled === 1);
  }, [
    epic?.id,
    epic?.scheduled_start_cron,
    epic?.scheduled_start_timezone,
    epic?.scheduled_start_enabled,
  ]);

  // Default the timezone field to the browser's zone so the schedule reads in
  // the operator's local time unless they pick another IANA zone.
  const browserTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setRunMessage(null);
    try {
      const res = await onRunEpic();
      const fmt = OUTCOME_MESSAGE[res?.outcome];
      setRunMessage(fmt ? fmt(res?.phaseName) : `Outcome: ${res?.outcome ?? 'unknown'}`);
    } catch (err: any) {
      setError(err?.message || 'Failed to start the epic');
    } finally {
      setRunning(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSaveSchedule({
        cron: cron.trim(),
        timezone: timezone.trim() || null,
        enabled,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to save the schedule');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setError(null);
    try {
      await onClearSchedule();
      setCron('');
      setTimezone('');
      setEnabled(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to clear the schedule');
    } finally {
      setClearing(false);
    }
  };

  const hasSchedule = !!(epic?.scheduled_start_cron || '').trim();

  return (
    <div className="space-y-5">
      {/* Start now */}
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-gray-500 max-w-md">
          Start this epic&apos;s phases left-to-right. Each phase dispatches its tickets, and when
          it completes the next armed phase runs automatically. The sweep stops at the first phase
          whose auto-dispatch is turned off.
        </p>
        <button
          type="button"
          onClick={handleRun}
          disabled={running}
          data-testid="epic-start-button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-emerald-600/40"
        >
          <Play size={12} />
          {running ? 'Starting…' : 'Start epic'}
        </button>
      </div>
      {runMessage ? (
        <div
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
          data-testid="epic-start-outcome"
        >
          {runMessage}
        </div>
      ) : null}

      {/* Scheduled start */}
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-gray-200">
          <CalendarClock size={13} className="text-indigo-300" />
          Scheduled start
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Automatically start the epic at a set time. Uses a cron expression interpreted in the
          timezone below (local time, like the deploy scheduler and crons).
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Cron
            </span>
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1"
              data-testid="epic-schedule-cron"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-gray-100 placeholder:text-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Timezone (IANA)
            </span>
            <input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder={browserTz || 'America/New_York'}
              data-testid="epic-schedule-timezone"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-gray-100 placeholder:text-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="epic-schedule-enabled"
            className="h-3.5 w-3.5 rounded border-white/20 bg-black/30"
          />
          Enabled (a disabled schedule is kept but paused)
        </label>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !cron.trim()}
            data-testid="epic-schedule-save"
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:bg-indigo-600/40"
          >
            {saving ? 'Saving…' : 'Save schedule'}
          </button>
          {hasSchedule ? (
            <button
              type="button"
              onClick={handleClear}
              disabled={clearing}
              data-testid="epic-schedule-clear"
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              {clearing ? 'Clearing…' : 'Clear'}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
