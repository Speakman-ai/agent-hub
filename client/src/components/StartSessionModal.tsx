import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, MessageSquarePlus, X } from 'lucide-react';
import { api } from '../utils/api';
import type { ProjectWire, SessionWire } from '@shared/types';
import { agentsForProject, type LinkOption } from '@shared/utils/linkTodo';

/**
 * "Start session with this as context" picker. Emails and cross-project personal
 * todos in the User Module are not bound to an agent, so the user picks a
 * project → agent, reviews the pre-built context block, and starts a new session
 * seeded with it. The seed becomes the session's first user message (server-side
 * `seedMessage`), fed to the CLI by the first-turn history bootstrap.
 */

export default function StartSessionModal({
  contextLabel,
  seedMessage,
  defaultName,
  onClose,
  onStarted,
}: {
  /** Short human label of what the session is about, shown at the top. */
  contextLabel: string;
  /** Pre-built opening user message (from shared/utils/sessionSeed builders). */
  seedMessage: string;
  /** Suggested session name. */
  defaultName?: string;
  onClose: () => void;
  onStarted: (session: SessionWire) => void;
}) {
  const [projects, setProjects] = useState<ProjectWire[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [agents, setAgents] = useState<LinkOption[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [seed, setSeed] = useState<string>(seedMessage);

  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingProjects(true);
    api
      .getProjects()
      .then((list) => {
        if (cancelled) return;
        const rows = Array.isArray(list) ? list : [];
        setProjects(rows);
        if (rows.length) setProjectId(String(rows[0].id));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadAgents = useCallback((pid: string) => {
    let cancelled = false;
    setLoadingAgents(true);
    setAgents([]);
    setAgentId('');
    api
      .getAgents()
      .then((list: any) => {
        if (cancelled) return;
        const scoped = agentsForProject(list, pid);
        setAgents(scoped);
        if (scoped.length) setAgentId(scoped[0].id);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load agents');
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setError(null);
    if (!projectId) return;
    return loadAgents(projectId);
  }, [projectId, loadAgents]);

  const canSubmit = !!agentId && !!seed.trim() && !submitting && !loadingAgents;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await api.createSession(agentId, defaultName, { seedMessage: seed.trim() });
      onStarted(session);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to start session');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="start-session-modal"
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Start session with context</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
          {error && (
            <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="text-sm text-gray-300">
            <span className="text-gray-500">Context:</span> {contextLabel}
          </div>

          <div>
            <label
              htmlFor="start-session-project"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Project
            </label>
            <select
              id="start-session-project"
              data-testid="start-session-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={loadingProjects || !projects.length}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              {loadingProjects ? (
                <option value="">Loading projects…</option>
              ) : !projects.length ? (
                <option value="">No projects available</option>
              ) : (
                projects.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {p.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div>
            <label
              htmlFor="start-session-agent"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Agent
            </label>
            <select
              id="start-session-agent"
              data-testid="start-session-agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={loadingAgents || !agents.length}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              <option value="">
                {loadingAgents
                  ? 'Loading agents…'
                  : agents.length
                    ? 'Select an agent…'
                    : 'No agents'}
              </option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="start-session-seed"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Opening message
            </label>
            <textarea
              id="start-session-seed"
              data-testid="start-session-seed"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              rows={8}
              className="w-full resize-y rounded border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            data-testid="start-session-submit"
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <MessageSquarePlus size={14} />
            )}
            Start session
          </button>
        </div>
      </div>
    </div>
  );
}
