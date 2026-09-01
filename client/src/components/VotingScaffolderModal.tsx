import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '../utils/api';
import type { AgentWire, ProjectWire } from '@shared/types';

/** Page-name hint cap; matches `MAX_PAGE_NAME_HINT_LEN` on the task pack. */
const MAX_PAGE_NAME_HINT_LEN = 80;

export function isScaffolderEligibleAgent(agent: AgentWire): boolean {
  if (agent.active === false) return false;
  return agent.role !== 'reviewer';
}

export default function VotingScaffolderModal({
  currentProjectId,
  onClose,
  onOpened,
  onNotify,
}: {
  currentProjectId: string;
  onClose: () => void;
  onOpened: (target: { sessionId: string; agentId: string }) => void;
  onNotify?: (message: string, type?: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectWire[]>([]);
  const [agents, setAgents] = useState<AgentWire[]>([]);
  const [projectId, setProjectId] = useState(currentProjectId);
  const [agentId, setAgentId] = useState('');
  const [pageNameHint, setPageNameHint] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.getProjects(), api.getAgents()])
      .then(([projectList, agentList]) => {
        if (cancelled) return;
        const rows = Array.isArray(projectList) ? projectList : [];
        setProjects(rows);
        setAgents(Array.isArray(agentList) ? agentList : []);
        const defaultId = rows.some((p) => String(p.id) === currentProjectId)
          ? currentProjectId
          : rows.length
            ? String(rows[0].id)
            : '';
        if (defaultId) setProjectId(defaultId);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  const eligibleAgents = useMemo(
    () => agents.filter((a) => String(a.projectId) === projectId && isScaffolderEligibleAgent(a)),
    [agents, projectId],
  );

  useEffect(() => {
    if (!eligibleAgents.length) {
      setAgentId('');
      return;
    }
    if (!eligibleAgents.some((a) => a.id === agentId)) {
      setAgentId(eligibleAgents[0].id);
    }
  }, [eligibleAgents, agentId]);

  const canSubmit = Boolean(projectId && agentId) && !submitting && !loading;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const hint = pageNameHint.trim();
      const res = await api.startVotingScaffolder(projectId, {
        agentId,
        pageNameHint: hint || undefined,
      });
      if (!res?.sessionId) {
        throw new Error('Server did not return a session id');
      }
      onOpened({ sessionId: res.sessionId, agentId: res.agentId || agentId });
    } catch (err: any) {
      const message = err?.message || 'Failed to start the voting setup session';
      setError(message);
      onNotify?.(message, 'error');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="voting-setup-modal"
    >
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Set up voting in an app</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <p className="text-sm text-gray-400" data-testid="voting-setup-explainer">
            The agent will inspect the target app, match its existing styling, and ask where the
            voting page should live before generating anything.
          </p>

          {error ? (
            <div
              className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
              data-testid="voting-setup-error"
            >
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              {error}
            </div>
          ) : null}

          <div>
            <label
              htmlFor="voting-setup-project"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Target project
            </label>
            <select
              id="voting-setup-project"
              data-testid="voting-setup-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={loading || !projects.length}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              {loading ? (
                <option value="">Loading projects…</option>
              ) : !projects.length ? (
                <option value="">No projects available</option>
              ) : (
                projects.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {p.name || p.id}
                  </option>
                ))
              )}
            </select>
          </div>

          <div>
            <label
              htmlFor="voting-setup-agent"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Agent / engine
            </label>
            <select
              id="voting-setup-agent"
              data-testid="voting-setup-agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={loading || !eligibleAgents.length}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              {loading ? (
                <option value="">Loading agents…</option>
              ) : !eligibleAgents.length ? (
                <option value="">No agents in this project</option>
              ) : (
                eligibleAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.id}
                    {a.engine ? ` (${a.engine})` : ''}
                  </option>
                ))
              )}
            </select>
          </div>

          <div>
            <label
              htmlFor="voting-setup-page-hint"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Page name / route hint (optional)
            </label>
            <input
              id="voting-setup-page-hint"
              data-testid="voting-setup-page-hint"
              type="text"
              value={pageNameHint}
              onChange={(e) => setPageNameHint(e.target.value)}
              maxLength={MAX_PAGE_NAME_HINT_LEN}
              placeholder="e.g. /ideas or Feature Voting"
              disabled={submitting}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            data-testid="voting-setup-cancel"
            className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="voting-setup-confirm"
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {submitting ? 'Starting…' : 'Start setup'}
          </button>
        </div>
      </div>
    </div>
  );
}
