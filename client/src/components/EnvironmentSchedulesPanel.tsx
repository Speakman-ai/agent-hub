import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CalendarClock, Loader2, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import humanCron from '@shared/utils/humanCron';
import { api } from '../utils/api';
import CronSchedulePicker from './CronSchedulePicker';
import {
  describeSchedule,
  sortSchedules,
  validateScheduleDraft,
  type DeploySchedule,
} from '../utils/deploySchedules';

/**
 * Per-environment deploy-schedules editor. Rendered inline under an environment
 * row in EnvironmentsManagementSection. Lists the environment's cron deploy
 * schedules and lets an operator add / enable / disable / delete them without
 * touching deploy.yaml. A firing schedule deploys its ref under the creator's
 * identity (deploy-scheduling epic decision).
 */
export default function EnvironmentSchedulesPanel({
  projectId,
  environmentName,
  showToast,
}: {
  projectId: string;
  environmentName: string;
  showToast?: (message: string, type?: string) => void;
}) {
  const [schedules, setSchedules] = useState<DeploySchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState('');
  const [adding, setAdding] = useState(false);

  const notify = useCallback(
    (message: string, type: string = 'info') => showToast?.(message, type),
    [showToast],
  );

  const load = useCallback(async () => {
    if (!projectId || !environmentName) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listDeploySchedules(projectId, environmentName);
      setSchedules(res?.schedules || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName]);

  useEffect(() => {
    load();
  }, [load]);

  const addSchedule = async () => {
    const draft = { ref, cron };
    const validationError = validateScheduleDraft(draft);
    if (validationError) {
      notify(validationError, 'error');
      return;
    }
    setAdding(true);
    try {
      const res = await api.createDeploySchedule(projectId, environmentName, {
        ref: draft.ref.trim(),
        cron: draft.cron.trim(),
        timezone: timezone.trim() || null,
      });
      if (res?.schedule) setSchedules((prev) => [...prev, res.schedule]);
      setRef('');
      setTimezone('');
      notify(`Schedule added to ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to add schedule', 'error');
    } finally {
      setAdding(false);
    }
  };

  const toggleSchedule = async (schedule: DeploySchedule) => {
    const key = `toggle:${schedule.id}`;
    setActionKey(key);
    try {
      const res = await api.updateDeploySchedule(projectId, environmentName, schedule.id, {
        enabled: !schedule.enabled,
      });
      if (res?.schedule) {
        setSchedules((prev) => prev.map((s) => (s.id === schedule.id ? res.schedule : s)));
      }
      notify(`Schedule ${!schedule.enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to update schedule', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const deleteSchedule = async (schedule: DeploySchedule) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Delete the schedule "${describeSchedule(schedule)}"?`)
    ) {
      return;
    }
    const key = `delete:${schedule.id}`;
    setActionKey(key);
    try {
      await api.deleteDeploySchedule(projectId, environmentName, schedule.id);
      setSchedules((prev) => prev.filter((s) => s.id !== schedule.id));
      notify('Schedule deleted', 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to delete schedule', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const sorted = sortSchedules(schedules);

  return (
    <div
      className="mt-2 rounded-md border border-gray-800 bg-gray-900/60 p-3"
      data-testid={`env-schedules-${environmentName}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <CalendarClock size={13} className="text-sky-300" />
        <span className="text-xs font-semibold text-gray-200">Deploy schedules</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
        A schedule deploys a ref to <span className="font-mono">{environmentName}</span> on a cron,
        under your identity. Disabling a schedule pauses it without deleting it.
      </p>

      {error ? (
        <div className="mb-2 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          <AlertCircle size={13} />
          {error}
        </div>
      ) : null}

      {loading && schedules.length === 0 ? (
        <div className="py-3 text-center text-xs text-gray-500">Loading schedules...</div>
      ) : sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-800 p-3 text-center text-xs text-gray-500">
          No schedules yet. Add one below.
        </div>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((schedule) => {
            const toggleKey = `toggle:${schedule.id}`;
            const deleteKey = `delete:${schedule.id}`;
            const human = humanCron(schedule.cron);
            return (
              <div
                key={schedule.id}
                data-testid={`schedule-row-${schedule.id}`}
                className={`flex flex-wrap items-center gap-2 rounded border p-2 ${
                  schedule.enabled
                    ? 'border-gray-800 bg-gray-950/70'
                    : 'border-gray-800 bg-gray-950/40 opacity-70'
                }`}
              >
                <span className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-200">
                  {schedule.ref}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-gray-200">{schedule.cron}</div>
                  <div className="truncate text-[10px] text-gray-500">
                    {human !== schedule.cron ? human : ''}
                    {schedule.timezone ? ` · ${schedule.timezone}` : ''}
                  </div>
                </div>
                {!schedule.enabled ? (
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">paused</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleSchedule(schedule)}
                  disabled={actionKey === toggleKey}
                  className="inline-flex items-center gap-1 rounded border border-gray-700 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                  title={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
                  aria-label={`${schedule.enabled ? 'Disable' : 'Enable'} ${describeSchedule(schedule)}`}
                >
                  {actionKey === toggleKey ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : schedule.enabled ? (
                    <PowerOff size={11} />
                  ) : (
                    <Power size={11} />
                  )}
                  {schedule.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  onClick={() => deleteSchedule(schedule)}
                  disabled={actionKey === deleteKey}
                  className="inline-flex items-center rounded border border-gray-700 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                  title="Delete schedule"
                  aria-label={`Delete ${describeSchedule(schedule)}`}
                >
                  {actionKey === deleteKey ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Trash2 size={11} />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 space-y-2 border-t border-gray-800 pt-3">
        <input
          type="text"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="ref to deploy (e.g. main, release/2.1)"
          aria-label="Ref"
          className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-xs text-gray-200 placeholder:text-gray-600"
        />
        <CronSchedulePicker value={cron} onChange={setCron} />
        <input
          type="text"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="timezone (optional, e.g. America/New_York)"
          aria-label="Timezone"
          className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-xs text-gray-200 placeholder:text-gray-600"
        />
        <button
          type="button"
          onClick={addSchedule}
          disabled={adding || !ref.trim() || !cron.trim()}
          className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Add schedule
        </button>
      </div>
    </div>
  );
}
