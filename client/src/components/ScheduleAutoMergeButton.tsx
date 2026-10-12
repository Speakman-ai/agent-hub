import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Loader2, X } from 'lucide-react';
import { api } from '../utils/api';
import {
  defaultScheduleDate,
  deviceTimeZone,
  formatScheduledAutoMerge,
  isFutureLocalDateTime,
  toLocalDateTimeValue,
} from '@shared/utils/autoMergeSchedule';

interface Props {
  projectId: string;
  prNumber: number;
  /** Stored UTC ISO time from the PR summary, or null. */
  scheduledAt: string | null | undefined;
  onChanged: () => void;
  onToast?: (msg: string, kind?: string, ms?: number) => void;
}

/** Date/time picker that schedules a native PR auto-merge in the browser's local time. */
export default function ScheduleAutoMergeButton({
  projectId,
  prNumber,
  scheduledAt,
  onChanged,
  onToast,
}: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = formatScheduledAutoMerge(scheduledAt);
  const zone = deviceTimeZone();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openPicker = () => {
    const current = scheduledAt ? new Date(scheduledAt) : null;
    setValue(
      toLocalDateTimeValue(
        current && current.getTime() > Date.now() ? current : defaultScheduleDate(),
      ),
    );
    setError(null);
    setOpen((v) => !v);
  };

  const submit = async (localDateTime: string | null) => {
    if (localDateTime !== null && !isFutureLocalDateTime(localDateTime)) {
      setError('Pick a time in the future.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.scheduleNativePrAutoMerge(projectId, prNumber, localDateTime, zone);
      const when = formatScheduledAutoMerge(res?.autoMergeAt);
      onToast?.(
        when
          ? `PR #${prNumber} will auto-merge ${when} (once checks pass).`
          : `Scheduled auto-merge cleared for PR #${prNumber}.`,
        'success',
        4000,
      );
      setOpen(false);
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not schedule auto-merge');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={openPicker}
        disabled={saving}
        data-testid="pr-auto-merge-schedule-toggle"
        title={
          label
            ? `Auto-merge scheduled for ${label} (${zone}). Click to change.`
            : 'Schedule auto-merge for a date and time'
        }
        className={`flex items-center gap-1.5 text-sm transition-colors disabled:opacity-50 ${
          label ? 'text-sky-300 hover:text-sky-100' : 'text-gray-400 hover:text-gray-200'
        }`}
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <CalendarClock size={14} />}
        {label ? `Merges ${label}` : 'Schedule'}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Schedule auto-merge"
          className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-gray-700 bg-gray-900 p-3 shadow-xl"
        >
          <label className="block text-xs text-gray-400 mb-1" htmlFor={`am-schedule-${prNumber}`}>
            Auto-merge at ({zone})
          </label>
          <input
            id={`am-schedule-${prNumber}`}
            type="datetime-local"
            value={value}
            min={toLocalDateTimeValue(new Date())}
            onChange={(e) => setValue(e.target.value)}
            data-testid="pr-auto-merge-schedule-input"
            className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100 [color-scheme:dark]"
          />
          <p className="mt-2 text-xs text-gray-500">
            At this time Agent Hub arms auto-merge. If checks or reviews are still pending, it
            merges as soon as they pass.
          </p>
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-3 flex items-center justify-between gap-2">
            {scheduledAt ? (
              <button
                type="button"
                onClick={() => submit(null)}
                disabled={saving}
                data-testid="pr-auto-merge-schedule-clear"
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-300 disabled:opacity-50"
              >
                <X size={12} /> Clear schedule
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => submit(value)}
              disabled={saving || !value}
              data-testid="pr-auto-merge-schedule-save"
              className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {scheduledAt ? 'Update' : 'Schedule'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
