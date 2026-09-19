import { partitionAttachmentFiles } from '../utils/attachmentValidation';
import { useMemo, useRef, useState } from 'react';
import { Paperclip, Rocket, X } from 'lucide-react';
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
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function addFiles(incoming: File[]) {
    if (saving) return;
    const { accepted, rejected } = partitionAttachmentFiles(incoming);
    setFiles((current) => [...current, ...accepted]);
    setError(rejected.map((item) => item.reason).join('\n'));
  }

  async function handleSubmit() {
    if (!preview.ok || saving) return;
    setSaving(true);
    setError('');
    try {
      const images = await Promise.all(files.map((file) => api.uploadFile(file)));
      const updated = await api.startSessionAutopilot(sessionId, {
        ...preview.value,
        ...(images.length ? { images } : {}),
      });
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
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
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
            onPaste={(event) => {
              if (!event.clipboardData.files.length) return;
              event.preventDefault();
              addFiles(Array.from(event.clipboardData.files));
            }}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={saving}
            rows={3}
            className="w-full rounded-md border border-emerald-800/70 bg-gray-950/80 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          />
        </label>

        <div className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label="Attach files"
            className="hidden"
            disabled={saving}
            onChange={(event) => {
              addFiles(Array.from(event.target.files || []));
              event.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 text-xs text-emerald-200 disabled:opacity-50"
          >
            <Paperclip size={14} /> Attach files
          </button>
          <p className="text-xs text-emerald-100/60">
            Add reference images or files. You can also paste or drop them here.
          </p>
          {files.map((file, index) => (
            <div key={index} className="flex items-center gap-2 text-xs text-emerald-100">
              <span className="truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                disabled={saving}
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                className="shrink-0 p-1 disabled:opacity-50"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

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
