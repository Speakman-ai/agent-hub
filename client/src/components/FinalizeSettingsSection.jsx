/**
 * FinalizeSettingsSection — Runner panel (per-project sidebar route).
 *
 * Mirrors the PreviewSection adoption path: a "Set up Runner" button that
 * spawns the wizard session, env-var scan + project secrets editor, and a
 * short prose explanation of what the wizard authors. Secrets stored here
 * are merged into Runner step runs at execution time.
 */
import { useState, useEffect, useCallback } from 'react';
import { ClipboardCheck, Loader2, AlertCircle, Sparkles, Key } from 'lucide-react';
import { api } from '../utils/api.js';
import { envRowsFromDraftAndSecrets } from '../utils/projectEnvRows.js';
import ProjectSecretsEditor from './ProjectSecretsEditor.jsx';
import CiRunsSection from './CiRunsSection.jsx';
import ProjectDefaultAutomationSection from './finalize/ProjectDefaultAutomationSection.jsx';

export default function FinalizeSettingsSection({
  projects = [],
  onProjectsChange,
  onOpenSession,
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState(null);
  const [lastSessionId, setLastSessionId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [envRows, setEnvRows] = useState([]);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draftError, setDraftError] = useState(null);

  useEffect(() => {
    if (!projects.length) {
      setProjectId('');
      return;
    }
    if (!projects.find((p) => p.id === projectId)) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

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

  const reloadDraft = useCallback(async (pid) => {
    if (!pid) return;
    setLoadingDraft(true);
    setDraftError(null);
    try {
      const [draftRes, secretsRes] = await Promise.all([
        api.getFinalizeEnvironmentDraft(pid),
        api.getProjectSecrets(pid).catch(() => ({ secrets: [] })),
      ]);
      const d = draftRes?.draft || null;
      setDraft(d);
      setEnvRows(envRowsFromDraftAndSecrets(d, secretsRes?.secrets || []));
    } catch (err) {
      setDraftError(err?.message || 'Failed to scan project');
      setDraft(null);
      setEnvRows([]);
    } finally {
      setLoadingDraft(false);
    }
  }, []);

  useEffect(() => {
    if (projectId) void reloadDraft(projectId);
  }, [projectId, reloadDraft]);

  const project = projects.find((p) => p.id === projectId) || null;
  const missingSecretCount = envRows.filter((r) => !r.configured).length;

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
          Runner
        </h3>
        <p className="text-xs text-gray-500 max-w-2xl">
          Author <code className="text-gray-300">.agent-hub/ci.yaml</code> — the v1 config that
          drives the Runner pre-PR pipeline (lint, typecheck, tests, fixture data, etc.). Click{' '}
          <strong className="text-gray-300">Set up Runner</strong> to scan the repo and walk through
          a proposed config in chat. Store project secrets below (or in the wizard) so CI steps can
          read AWS keys, database creds, and other env vars at run time.
        </p>
      </div>

      {/* Per-user default Finalize automation level for new sessions in this
          project. Scoped to the signed-in user. */}
      {projectId && <ProjectDefaultAutomationSection projectId={projectId} />}

      {/* Run history + CI-on-push config — GHA-style view of every CI
          execution (Finalize and push-triggered) for this project. */}
      <CiRunsSection project={project} onProjectsChange={onProjectsChange} />

      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-gray-200 mb-1 flex items-center gap-2">
              <Sparkles size={14} className="text-emerald-400" />
              Guided setup walkthrough
            </h4>
            <p className="text-xs text-gray-500 max-w-xl">
              Spawns a normal worktree-backed session loaded with the{' '}
              <code className="text-gray-300">finalize-setup</code> skill. It scans{' '}
              <code className="text-gray-300">README.md</code>, package manifests, and existing CI
              workflows, proposes a <code className="text-gray-300">.agent-hub/ci.yaml</code>, runs
              the configured steps to prove the pipeline, then pushes and opens a PR for review. It
              can also collect missing secrets and persist them alongside the config commit.
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
            {wizardStarting ? 'Starting…' : 'Set up Runner'}
          </button>
        </div>
        {wizardError && (
          <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{wizardError}</span>
          </div>
        )}
      </div>

      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-gray-300 mb-1 flex items-center gap-2">
            <Key size={14} className="text-amber-400" />
            Project secrets for Runner
          </h4>
          <p className="text-xs text-gray-500 max-w-2xl">
            Runner steps run as shell commands in the session worktree. v1 ci.yaml has no{' '}
            <code className="text-gray-300">env:</code> block — store values here and they are
            injected when steps run (same store as Preview and chat spawns).
          </p>
        </div>

        {loadingDraft && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" />
            Scanning repo for env vars…
          </div>
        )}
        {draftError && (
          <p className="text-xs text-red-400 flex items-center gap-1">
            <AlertCircle size={12} />
            {draftError}
          </p>
        )}
        {!loadingDraft && draft && envRows.length > 0 && (
          <div
            className="rounded-lg border border-gray-700/80 bg-gray-900/40 p-3"
            data-testid="finalize-env-scan-summary"
          >
            <p className="text-xs text-gray-400 mb-2">
              {envRows.length} env var(s) detected in source / README
              {missingSecretCount > 0 ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="text-amber-300">
                    {missingSecretCount} not yet stored as project secrets
                  </span>
                </>
              ) : (
                <span className="text-emerald-400"> · all detected keys have saved values</span>
              )}
            </p>
            <ul className="text-xs font-mono text-gray-500 max-h-32 overflow-y-auto space-y-0.5">
              {envRows.slice(0, 24).map((row) => (
                <li
                  key={row.key}
                  className={row.configured ? 'text-gray-400' : 'text-amber-300/90'}
                >
                  {row.key}
                  {row.configured ? ' ✓' : ' — missing'}
                </li>
              ))}
              {envRows.length > 24 && (
                <li className="text-gray-600 italic">…and {envRows.length - 24} more</li>
              )}
            </ul>
          </div>
        )}

        {projectId && (
          <ProjectSecretsEditor
            projectId={projectId}
            hint="Encrypted key/value pairs merged into Runner step runs, chat spawns, heartbeats, crons, and preview for this project. Leave secret values blank when editing to keep the stored value."
          />
        )}
      </div>

      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4">
        <h4 className="text-sm font-semibold text-gray-300 mb-2">What lands in your repo</h4>
        <ul className="text-xs text-gray-500 space-y-1.5 list-disc list-inside">
          <li>
            A single file at <code className="text-gray-300">.agent-hub/ci.yaml</code>
          </li>
          <li>
            Committed on a fresh branch in the setup session&apos;s own worktree, verified locally,
            then pushed and opened as a PR for review — like any code change.
          </li>
          <li>
            One step per check you want to run before pushing — install, typecheck, lint, test, etc.
            Hard cap: 4 hours of active time.
          </li>
          <li>
            Re-run the wizard any time to propose a fresh config — it overwrites the existing file.
          </li>
        </ul>
      </div>
    </div>
  );
}
