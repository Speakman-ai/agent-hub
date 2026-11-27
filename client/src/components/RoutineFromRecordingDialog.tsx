import { useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Wand2, X } from 'lucide-react';
import {
  routineSkillCreateBody,
  routineSkillProblems,
  type RoutineDraftWire,
} from '@shared/utils/routineFromRecording';
import { api } from '../utils/api';

export interface RoutineDialogApi {
  draftRoutineFromRecording: (
    sessionId: string,
    body: { artifactId: string; goal?: string },
  ) => Promise<RoutineDraftWire>;
  createProjectSkill: (projectId: string, body: unknown) => Promise<unknown>;
}

type Step = 'goal' | 'drafting' | 'edit' | 'saving' | 'done';

const inputClass =
  'w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-sky-600';

/**
 * Make routine (SPEC-7): the session agent drafts a project skill from a
 * browser demo recording, and the human edits and saves it. The flow ends once
 * the skill is saved.
 */
export default function RoutineFromRecordingDialog({
  sessionId,
  artifactId,
  onClose,
  client = api as unknown as RoutineDialogApi,
}: {
  sessionId: string;
  artifactId: string;
  onClose: () => void;
  client?: RoutineDialogApi;
}) {
  const [step, setStep] = useState<Step>('goal');
  const [error, setError] = useState('');
  const [goal, setGoal] = useState('');
  const [meta, setMeta] = useState<RoutineDraftWire | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [savedName, setSavedName] = useState('');

  const busy = step === 'drafting' || step === 'saving';
  const problems = routineSkillProblems({ name, description, body });

  const requestDraft = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    setStep('drafting');
    try {
      const res = await client.draftRoutineFromRecording(sessionId, {
        artifactId,
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      });
      setMeta(res);
      setName(res.draft.name);
      setDescription(res.draft.description);
      setBody(res.draft.body);
      setStep('edit');
    } catch (err) {
      setError((err as Error).message || 'Drafting failed');
      setStep('goal');
    }
  };

  const saveSkill = async (e: FormEvent) => {
    e.preventDefault();
    if (!meta || problems.length > 0) return;
    setError('');
    setStep('saving');
    try {
      await client.createProjectSkill(
        meta.projectId,
        routineSkillCreateBody({ name, description, body }),
      );
      setSavedName(name.trim());
      setStep('done');
    } catch (err) {
      setError((err as Error).message || 'Saving the skill failed');
      setStep('edit');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/60"
      onClick={() => (busy ? null : onClose())}
      data-testid="routine-dialog-backdrop"
    >
      <div
        className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[84vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Make routine"
        data-testid="routine-dialog"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Wand2 size={16} className="text-sky-300" />
            <h3 className="text-sm font-semibold text-gray-100">Make routine</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-3 text-sm text-gray-300">
          {error && (
            <p
              className="text-xs text-red-300 bg-red-950/40 border border-red-900 rounded px-2 py-1.5"
              role="alert"
            >
              {error}
            </p>
          )}

          {(step === 'goal' || step === 'drafting') && (
            <form onSubmit={requestDraft} className="space-y-3">
              <p className="text-xs text-gray-400">
                The agent turns your recording into a skill with steps and success checks. You
                review and edit it before anything is saved.
              </p>
              <label className="block text-xs text-gray-400">
                What does this routine do? (optional)
                <input
                  className={`${inputClass} mt-1`}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  maxLength={500}
                  placeholder="Export the weekly sales report"
                  disabled={busy}
                  data-testid="routine-goal"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 text-white text-xs font-medium disabled:opacity-50"
                data-testid="routine-draft"
              >
                {step === 'drafting' ? <Loader2 size={13} className="animate-spin" /> : null}
                {step === 'drafting' ? 'Asking the agent to draft…' : 'Draft skill'}
              </button>
            </form>
          )}

          {(step === 'edit' || step === 'saving') && meta && (
            <form onSubmit={saveSkill} className="space-y-3">
              <p className="text-xs text-gray-400">
                {meta.agentName} drafted this from {meta.steps} recorded step
                {meta.steps === 1 ? '' : 's'}. Edit anything, then save it as a project skill.
              </p>
              <label className="block text-xs text-gray-400">
                Name
                <input
                  className={`${inputClass} mt-1 font-mono`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  data-testid="routine-name"
                />
              </label>
              <label className="block text-xs text-gray-400">
                Description
                <input
                  className={`${inputClass} mt-1`}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={busy}
                  data-testid="routine-description"
                />
              </label>
              <label className="block text-xs text-gray-400">
                Steps (SKILL.md)
                <textarea
                  className={`${inputClass} mt-1 font-mono text-xs leading-relaxed`}
                  rows={14}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={busy}
                  data-testid="routine-body"
                />
              </label>
              {problems.length > 0 && (
                <p className="text-xs text-amber-300">{problems.join('. ')}.</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy || problems.length > 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 text-white text-xs font-medium disabled:opacity-50"
                  data-testid="routine-save"
                >
                  {step === 'saving' ? <Loader2 size={13} className="animate-spin" /> : null}
                  Save skill
                </button>
                <button
                  type="button"
                  onClick={() => requestDraft()}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                >
                  Draft again
                </button>
              </div>
            </form>
          )}

          {step === 'done' && (
            <div className="space-y-3" data-testid="routine-done">
              <p className="text-xs text-emerald-300" data-testid="routine-saved">
                Saved skill <span className="font-mono">{savedName}</span>.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs text-gray-100"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
