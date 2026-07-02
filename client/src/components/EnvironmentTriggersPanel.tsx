import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Plus, Power, PowerOff, Trash2, Zap } from 'lucide-react';
import { api } from '../utils/api';
import {
  DEPLOY_TRIGGER_EVENTS,
  describeTrigger,
  sortTriggers,
  triggerEventLabel,
  validateTriggerDraft,
  type DeployTrigger,
  type DeployTriggerEvent,
} from '../utils/deployTriggers';

/**
 * Per-environment deploy-triggers editor. Rendered inline under an environment
 * row in EnvironmentsManagementSection. Lists the environment's git-event
 * triggers and lets an operator add / enable / disable / delete them without
 * touching deploy.yaml.
 */
export default function EnvironmentTriggersPanel({
  projectId,
  environmentName,
  showToast,
}: {
  projectId: string;
  environmentName: string;
  showToast?: (message: string, type?: string) => void;
}) {
  const [triggers, setTriggers] = useState<DeployTrigger[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [event, setEvent] = useState<DeployTriggerEvent>('push');
  const [branchPattern, setBranchPattern] = useState('');
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
      const res = await api.listDeployTriggers(projectId, environmentName);
      setTriggers(res?.triggers || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load triggers');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName]);

  useEffect(() => {
    load();
  }, [load]);

  const addTrigger = async () => {
    const draft = { event, branchPattern };
    const validationError = validateTriggerDraft(draft);
    if (validationError) {
      notify(validationError, 'error');
      return;
    }
    setAdding(true);
    try {
      const res = await api.createDeployTrigger(projectId, environmentName, {
        event: draft.event,
        branchPattern: draft.branchPattern.trim(),
      });
      if (res?.trigger) setTriggers((prev) => [...prev, res.trigger]);
      setBranchPattern('');
      setEvent('push');
      notify(`Trigger added to ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to add trigger', 'error');
    } finally {
      setAdding(false);
    }
  };

  const toggleTrigger = async (trigger: DeployTrigger) => {
    const key = `toggle:${trigger.id}`;
    setActionKey(key);
    try {
      const res = await api.updateDeployTrigger(projectId, environmentName, trigger.id, {
        enabled: !trigger.enabled,
      });
      if (res?.trigger) {
        setTriggers((prev) => prev.map((t) => (t.id === trigger.id ? res.trigger : t)));
      }
      notify(`Trigger ${!trigger.enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to update trigger', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const deleteTrigger = async (trigger: DeployTrigger) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Delete the ${trigger.event} trigger for "${trigger.branchPattern}"?`)
    ) {
      return;
    }
    const key = `delete:${trigger.id}`;
    setActionKey(key);
    try {
      await api.deleteDeployTrigger(projectId, environmentName, trigger.id);
      setTriggers((prev) => prev.filter((t) => t.id !== trigger.id));
      notify('Trigger deleted', 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to delete trigger', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const sorted = sortTriggers(triggers);

  return (
    <div
      className="mt-2 rounded-md border border-gray-800 bg-gray-900/60 p-3"
      data-testid={`env-triggers-${environmentName}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Zap size={13} className="text-amber-300" />
        <span className="text-xs font-semibold text-gray-200">Deploy triggers</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
        A matching push or merge auto-deploys <span className="font-mono">{environmentName}</span>.
        Use <span className="font-mono">*</span> to match within a branch segment and{' '}
        <span className="font-mono">**</span> across segments.
      </p>

      {error ? (
        <div className="mb-2 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          <AlertCircle size={13} />
          {error}
        </div>
      ) : null}

      {loading && triggers.length === 0 ? (
        <div className="py-3 text-center text-xs text-gray-500">Loading triggers...</div>
      ) : sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-800 p-3 text-center text-xs text-gray-500">
          No triggers yet. Add one below.
        </div>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((trigger) => {
            const toggleKey = `toggle:${trigger.id}`;
            const deleteKey = `delete:${trigger.id}`;
            return (
              <div
                key={trigger.id}
                data-testid={`trigger-row-${trigger.id}`}
                className={`flex flex-wrap items-center gap-2 rounded border p-2 ${
                  trigger.enabled
                    ? 'border-gray-800 bg-gray-950/70'
                    : 'border-gray-800 bg-gray-950/40 opacity-70'
                }`}
              >
                <span className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-200">
                  {triggerEventLabel(trigger.event)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-200">
                  {trigger.branchPattern}
                </span>
                {!trigger.enabled ? (
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">paused</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleTrigger(trigger)}
                  disabled={actionKey === toggleKey}
                  className="inline-flex items-center gap-1 rounded border border-gray-700 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                  title={trigger.enabled ? 'Disable trigger' : 'Enable trigger'}
                  aria-label={`${trigger.enabled ? 'Disable' : 'Enable'} ${describeTrigger(trigger)}`}
                >
                  {actionKey === toggleKey ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : trigger.enabled ? (
                    <PowerOff size={11} />
                  ) : (
                    <Power size={11} />
                  )}
                  {trigger.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  onClick={() => deleteTrigger(trigger)}
                  disabled={actionKey === deleteKey}
                  className="inline-flex items-center rounded border border-gray-700 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                  title="Delete trigger"
                  aria-label={`Delete ${describeTrigger(trigger)}`}
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

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-800 pt-3">
        <select
          value={event}
          onChange={(e) => setEvent(e.target.value as DeployTriggerEvent)}
          aria-label="Trigger event"
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-gray-200"
        >
          {DEPLOY_TRIGGER_EVENTS.map((ev) => (
            <option key={ev} value={ev}>
              {triggerEventLabel(ev)}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={branchPattern}
          onChange={(e) => setBranchPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !adding) {
              e.preventDefault();
              addTrigger();
            }
          }}
          placeholder="branch pattern (e.g. main, release/*)"
          aria-label="Branch pattern"
          className="min-w-[10rem] flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-xs text-gray-200 placeholder:text-gray-600"
        />
        <button
          type="button"
          onClick={addTrigger}
          disabled={adding || !branchPattern.trim()}
          className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Add trigger
        </button>
      </div>
    </div>
  );
}
