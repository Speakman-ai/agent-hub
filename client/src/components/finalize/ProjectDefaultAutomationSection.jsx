/**
 * ProjectDefaultAutomationSection — per-user, project-scoped default Finalize
 * automation level.
 *
 * Each user picks their own default automation level (Build / Build and Review
 * / Build and Push / Auto Merge) for a project. New ad-hoc sessions that user
 * creates in the project inherit it. "No preference" clears it, so new sessions
 * fall back to the global default (Build). This is scoped to the signed-in
 * user — it never changes anyone else's default.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, GitMerge } from 'lucide-react';
import { api } from '../../utils/api.js';
import { FINALIZE_AUTOMATION_OPTIONS } from '../../utils/finalizeAutomation.js';

const NO_PREFERENCE = '__none__';

export default function ProjectDefaultAutomationSection({ projectId }) {
  const [value, setValue] = useState(NO_PREFERENCE);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setValue(NO_PREFERENCE);
      return undefined;
    }
    setLoading(true);
    setError(null);
    api
      .getProjectUserSettings(projectId)
      .then((res) => {
        if (cancelled) return;
        setValue(res?.defaultFinalizeAutomation || NO_PREFERENCE);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load your default.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleChange = useCallback(
    async (next) => {
      if (!projectId || next === value) return;
      const prev = value;
      setValue(next);
      setSaving(true);
      setError(null);
      try {
        const payload = {
          defaultFinalizeAutomation: next === NO_PREFERENCE ? null : next,
        };
        const res = await api.updateProjectUserSettings(projectId, payload);
        setValue(res?.defaultFinalizeAutomation || NO_PREFERENCE);
      } catch (err) {
        setValue(prev);
        setError(err?.message || 'Failed to save your default.');
      } finally {
        setSaving(false);
      }
    },
    [projectId, value],
  );

  return (
    <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <GitMerge size={16} className="text-emerald-400" />
        <h4 className="text-sm font-semibold text-gray-200">Your default automation</h4>
        {(loading || saving) && <Loader2 size={14} className="animate-spin text-gray-400" />}
      </div>
      <p className="text-xs text-gray-500 mb-3 max-w-2xl">
        New sessions <strong className="text-gray-300">you</strong> start in this project begin at
        this Finalize automation level. This is your personal default — it doesn&apos;t change
        anyone else&apos;s. Board-assigned and autonomous sessions keep their own escalation rules.
      </p>

      <div className="space-y-2 max-w-xl">
        {[
          {
            value: NO_PREFERENCE,
            label: 'No preference',
            description: 'New sessions use the global default (Build).',
          },
          ...FINALIZE_AUTOMATION_OPTIONS,
        ].map((opt) => (
          <label
            key={opt.value}
            className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
              value === opt.value
                ? 'border-emerald-500/60 bg-emerald-500/10'
                : 'border-gray-700 hover:border-gray-600'
            } ${saving ? 'opacity-60 pointer-events-none' : ''}`}
          >
            <input
              type="radio"
              name="project-default-automation"
              className="mt-1 accent-emerald-500"
              value={opt.value}
              checked={value === opt.value}
              disabled={loading || saving || !projectId}
              onChange={() => handleChange(opt.value)}
            />
            <span>
              <span className="block text-sm text-gray-200">{opt.label}</span>
              <span className="block text-xs text-gray-500">{opt.description}</span>
            </span>
          </label>
        ))}
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
