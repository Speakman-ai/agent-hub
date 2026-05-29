/**
 * FinalizeSettingsSection — Settings → Finalize panel.
 *
 * Mirrors the PreviewSection adoption path: a single project picker,
 * a "Set up Finalize" button that spawns the wizard session, and a
 * short prose explanation of what the wizard authors. The wizard
 * itself is a chat session loaded with the `finalize-setup` skill;
 * this panel is the entry point, not the editor.
 *
 * Re-running the wizard overwrites the existing `.agent-hub/ci.yaml`
 * (the apply endpoint commits the file in one shot). A "Reset Finalize
 * config" affordance is intentionally not provided at v0 — re-running
 * the wizard is the reset path.
 */
import { useState, useEffect, useCallback } from 'react';
import { ClipboardCheck, Loader2, AlertCircle, Sparkles } from 'lucide-react';
import { api } from '../utils/api.js';

export default function FinalizeSettingsSection({
  projects = [],
  onProjectsChange,
  onOpenSession,
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState(null);
  const [lastSessionId, setLastSessionId] = useState(null);

  // Keep the picker in sync when the project list mutates underneath us
  // (e.g. a new project is created elsewhere).
  useEffect(() => {
    if (!projects.length) {
      setProjectId('');
      return;
    }
    if (!projects.find((p) => p.id === projectId)) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  // When the wizard skill posts its final wizard-complete, refresh the
  // project list so any caller relying on `ci.yaml` presence sees fresh
  // data on the next render.
  useEffect(() => {
    const handler = (e) => {
      const pid = e?.detail?.projectId;
      if (pid && projectId === pid && typeof onProjectsChange === 'function') {
        onProjectsChange();
      }
    };
    window.addEventListener('agenthub:finalize_wizard_complete', handler);
    return () => window.removeEventListener('agenthub:finalize_wizard_complete', handler);
  }, [projectId, onProjectsChange]);

  const project = projects.find((p) => p.id === projectId) || null;

  const handleStartWalkthrough = useCallback(async () => {
    if (!project || wizardStarting) return;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startFinalizeWizard(project.id);
      if (!res?.sessionId) {
        setWizardError('Server did not return a wizard session id');
        return;
      }
      setLastSessionId(res.sessionId);
      if (typeof onOpenSession === 'function') {
        onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
      } else {
        setWizardError(
          `Walkthrough started (session ${res.sessionId}) — open it from the agent session list.`,
        );
      }
    } catch (err) {
      setWizardError(err?.message || 'Failed to start setup walkthrough');
    } finally {
      setWizardStarting(false);
    }
  }, [project, wizardStarting, onOpenSession]);

  if (!projects.length) {
    return <p className="text-sm text-gray-500">No projects yet.</p>;
  }

  return (
    <div className="space-y-6 pb-28">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <ClipboardCheck size={18} className="text-emerald-400" />
          Finalize Code Changes
        </h3>
        <p className="text-xs text-gray-500 max-w-2xl">
          Author <code className="text-gray-300">.agent-hub/ci.yaml</code> — the v1 config that
          drives the Finalize Code Changes pre-PR pipeline (lint, typecheck, tests, fixture data,
          etc.). Click <strong className="text-gray-300">Set up Finalize</strong> to scan the repo
          and walk through a proposed config in chat. The wizard commits the file to the current
          session’s worktree on approval.
        </p>
        <label className="flex items-center gap-2 text-sm mt-4">
          <span className="text-gray-400">Project:</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-gray-200 mb-1 flex items-center gap-2">
              <Sparkles size={14} className="text-emerald-400" />
              Guided setup walkthrough
            </h4>
            <p className="text-xs text-gray-500 max-w-xl">
              Spawns a chat session loaded with the{' '}
              <code className="text-gray-300">finalize-setup</code> skill. The wizard reads{' '}
              <code className="text-gray-300">README.md</code>, package manifests, existing CI
              workflows, and proposes a v1 <code className="text-gray-300">.agent-hub/ci.yaml</code>
              . You review, edit, and commit it in a single click.
            </p>
            {lastSessionId && (
              <p className="text-xs text-emerald-400 mt-2">
                Last wizard session: <code className="text-emerald-300">{lastSessionId}</code>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleStartWalkthrough}
            disabled={!project || wizardStarting}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {wizardStarting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {wizardStarting ? 'Starting…' : 'Set up Finalize'}
          </button>
        </div>
        {wizardError && (
          <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{wizardError}</span>
          </div>
        )}
      </div>

      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4">
        <h4 className="text-sm font-semibold text-gray-300 mb-2">What lands in your repo</h4>
        <ul className="text-xs text-gray-500 space-y-1.5 list-disc list-inside">
          <li>
            A single file at <code className="text-gray-300">.agent-hub/ci.yaml</code>
          </li>
          <li>
            Committed to your active session’s worktree branch (you can keep iterating in the same
            session)
          </li>
          <li>
            One step per check you want to run before pushing — install, typecheck, lint, test, etc.
            Hard cap: 60 minutes of active time.
          </li>
          <li>
            Re-run the wizard any time to propose a fresh config — it overwrites the existing file.
          </li>
        </ul>
      </div>
    </div>
  );
}
