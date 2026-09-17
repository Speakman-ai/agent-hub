import { useMemo, useState } from 'react';
import { Rocket } from 'lucide-react';
import { api } from '../utils/api';
import {
  validateAutopilotSetupInput,
  type AutopilotEscalation,
} from '@shared/utils/sessionAutopilot';

const ESCALATION_OPTIONS: { value: AutopilotEscalation; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'Do not stop until the goal is met or time runs out' },
  { value: 'low', label: 'Low', hint: 'Ask only when blocked' },
  { value: 'medium', label: 'Medium', hint: 'Ask on risky or ambiguous changes' },
  { value: 'high', label: 'High', hint: 'Ask before non-trivial changes' },
];

export default function AutopilotSetupPrompt({
  sessionId,
  onStarted,
  onError,
}: {
  sessionId: string;
  onStarted?: (session: unknown) => void;
  onError?: (message: string) => void;
}) {
  const [durationHours, setDurationHours] = useState('4');
  const [brief, setBrief] = useState('');
  const [goal, setGoal] = useState('');
  const [escalation, setEscalation] = useState<AutopilotEscalation>('medium');
  const [branch, setBranch] = useState('autopilot/');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const parsedDuration = Number(durationHours);
  const preview = useMemo(
    () =>
      validateAutopilotSetupInput({
        durationHours: Number.isFinite(parsedDuration) ? parsedDuration : NaN,
        brief,
        goal,
        escalation,
        branch,
      }),
    [parsedDuration, brief, goal, escalation, branch],
  );

  async function handleSubmit() {
    if (!preview.ok || saving) return;
    setSaving(true);
    setError('');
    try {
      const updated = await api.startSessionAutopilot(sessionId, preview.value);
      onStarted?.(updated);
    } catch (err: any) {
      const message = err?.message || 'Could not start Autopilot.';
      setError(message);
      onError?.(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="autopilot-setup-prompt"
      className="border border-emerald-700/50 bg-emerald-950/20 rounded-lg overflow-hidden text-left"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/30 border-b border-emerald-700/40">
        <Rocket size={15} className="text-emerald-300 shrink-0" />
        <span className="text-xs font-medium text-emerald-100">Autopilot</span>
      </div>
      <div className="p-3 space-y-3">
        <p className="text-xs text-emerald-100/70">
          This session will push a named branch over and over, verify in preview, and stop for a
          human merge. It never ships to main.
        </p>

        <label className="block">
          <span className="block text-xs text-emerald-100/80 mb-1">
            How long (hours; 0 = no limit)
          </span>
          <input
            data-testid="autopilot-setup-duration"
            type="number"
            min={0}
            max={72}
            value={durationHours}
            onChange={(e) => setDurationHours(e.target.value)}
            disabled={saving}
            className="w-full rounded-md border border-emerald-800/70 bg-gray-950/80 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          />
        </label>

        <label className="block">
          <span className="block text-xs text-emerald-100/80 mb-1">What you want it to do</span>
          <textarea
            data-testid="autopilot-setup-brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={saving}
            rows={3}
            className="w-full rounded-md border border-emerald-800/70 bg-gray-950/80 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          />
        </label>

        <label className="block">
          <span className="block text-xs text-emerald-100/80 mb-1">Goal to check for</span>
          <textarea
            data-testid="autopilot-setup-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={saving}
            rows={2}
            className="w-full rounded-md border border-emerald-800/70 bg-gray-950/80 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          />
        </label>

        <fieldset className="space-y-1">
          <legend className="text-xs text-emerald-100/80 mb-1">Escalation sensitivity</legend>
          {ESCALATION_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-start gap-2 text-sm text-emerald-100">
              <input
                type="radio"
                name="autopilot-escalation"
                value={opt.value}
                checked={escalation === opt.value}
                onChange={() => setEscalation(opt.value)}
                disabled={saving}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{opt.label}</span>
                <span className="block text-xs text-emerald-100/60">{opt.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block">
          <span className="block text-xs text-emerald-100/80 mb-1">Branch name</span>
          <input
            data-testid="autopilot-setup-branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={saving}
            placeholder="autopilot/improvements"
            className="w-full rounded-md border border-emerald-800/70 bg-gray-950/80 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          />
        </label>

        {error && (
          <div className="text-xs text-rose-200 bg-rose-950/40 border border-rose-700/50 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        {!preview.ok && preview.errors.length > 0 && (brief || goal || branch !== 'autopilot/') && (
          <div className="text-xs text-amber-200/80">{preview.errors[0]?.message}</div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            data-testid="autopilot-setup-start"
            onClick={handleSubmit}
            disabled={!preview.ok || saving}
            className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
              preview.ok && !saving
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
            }`}
          >
            {saving ? 'Starting…' : 'Start Autopilot'}
          </button>
        </div>
      </div>
    </div>
  );
}
