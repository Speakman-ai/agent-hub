import { useState, useEffect, useMemo, useCallback } from 'react';
import { BookText, Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import CronSchedulePicker from './CronSchedulePicker';

/**
 * Project Settings → AI → Background Agents.
 *
 * Background agents are project-scoped scheduled AI jobs that run
 * unattended, distinct from interactive sessions and from the retired
 * per-agent heartbeats. The first built-in agent is Wiki: on a cadence it
 * dispatches the wiki documentation backfill (the docs agent reviews
 * undocumented Done cards and refreshes the wiki) — otherwise the wiki is
 * only refreshed on PR merge or via the operator-triggered backfill.
 *
 * Config lives on `project.backgroundAgents.wiki` and is written through
 * `PATCH /api/projects/:id`. The Wiki agent is shown with defaults even when
 * unconfigured, so activating it is a single toggle.
 */

const DEFAULT_WIKI_SCHEDULE = '0 3 * * *';

type WikiCfg = {
  enabled?: boolean;
  schedule?: string;
  timezone?: string | null;
  ownerUserId?: string | null;
  model?: string | null;
  limit?: number;
};

export default function BackgroundAgentsSection({
  projects = [],
  projectId = null,
  onProjectsChange,
  showToast,
}: any) {
  const project = useMemo(
    () => projects.find((p: any) => p.id === projectId) || null,
    [projects, projectId],
  );
  const saved: WikiCfg = project?.backgroundAgents?.wiki || {};

  const docsAgent = useMemo(
    () => (project?.agents || []).find((a: any) => (a?.role || '').trim().toLowerCase() === 'docs'),
    [project],
  );
  const docsEngine: string = docsAgent?.engine || 'claude-code';

  const [enabled, setEnabled] = useState<boolean>(!!saved.enabled);
  const [schedule, setSchedule] = useState<string>(saved.schedule || DEFAULT_WIKI_SCHEDULE);
  const [ownerUserId, setOwnerUserId] = useState<string>(saved.ownerUserId || '');
  const [model, setModel] = useState<string>(saved.model || '');
  const [limit, setLimit] = useState<number>(saved.limit || 10);
  const [saving, setSaving] = useState(false);

  const [members, setMembers] = useState<Array<{ userId: string; username: string }>>([]);
  const [modelConfig, setModelConfig] = useState<{
    engineValidModels?: Record<string, string[]>;
  } | null>(null);

  // Re-sync local state when switching projects.
  useEffect(() => {
    setEnabled(!!saved.enabled);
    setSchedule(saved.schedule || DEFAULT_WIKI_SCHEDULE);
    setOwnerUserId(saved.ownerUserId || '');
    setModel(saved.model || '');
    setLimit(saved.limit || 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    api
      .getProjectMembers(projectId)
      .then((r: any) => setMembers(r?.members || []))
      .catch(() => setMembers([]));
    api
      .getModelConfig()
      .then((r: any) => setModelConfig(r))
      .catch(() => setModelConfig(null));
  }, [projectId]);

  const models: string[] = modelConfig?.engineValidModels?.[docsEngine] || [];

  const save = useCallback(async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const wiki: WikiCfg = {
        enabled,
        schedule: schedule || DEFAULT_WIKI_SCHEDULE,
        ownerUserId: ownerUserId || null,
        model: model || null,
        limit,
      };
      const updated = await api.updateProject(projectId, { backgroundAgents: { wiki } });
      onProjectsChange?.(projects.map((p: any) => (p.id === projectId ? { ...p, ...updated } : p)));
      showToast?.('Background agents saved', 'success');
    } catch (err: any) {
      showToast?.(err?.message || 'Failed to save background agents', 'error');
    } finally {
      setSaving(false);
    }
  }, [
    projectId,
    enabled,
    schedule,
    ownerUserId,
    model,
    limit,
    projects,
    onProjectsChange,
    showToast,
  ]);

  if (!project) {
    return (
      <div className="text-sm text-gray-400">Select a project to configure background agents.</div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-white">Background Agents</h3>
        <p className="text-xs text-gray-500 mt-1">
          Scheduled, unattended AI jobs for this project. Each runs as a chosen Hub user on a
          cadence you set.
        </p>
      </div>

      {/* Wiki agent */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <BookText size={18} className="text-indigo-400 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-sm font-medium text-white">Wiki</div>
              <p className="text-xs text-gray-500 mt-0.5 max-w-xl">
                Keeps the project wiki current: the docs agent reviews undocumented Done cards and
                writes or updates pages on a schedule.
                {!docsAgent && (
                  <span className="text-amber-400">
                    {' '}
                    Requires an agent with the <code>docs</code> role — none is configured, so runs
                    will skip.
                  </span>
                )}
              </p>
            </div>
          </div>
          <label className="inline-flex items-center cursor-pointer flex-shrink-0">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid="wiki-agent-enabled"
            />
            <div className="relative w-9 h-5 bg-gray-700 rounded-full peer peer-checked:bg-indigo-600 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Frequency</label>
            <CronSchedulePicker value={schedule} onChange={setSchedule} />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Runs as user</label>
            <select
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
              data-testid="wiki-agent-owner"
              className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
            >
              <option value="">Userless (host engine only)</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.username}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-gray-600 mt-1">
              Supplies per-user engine credentials. Userless runs only when a host-global engine is
              available.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Model <span className="text-gray-600">({docsEngine})</span>
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              data-testid="wiki-agent-model"
              className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
            >
              <option value="">Default (docs agent)</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Cards per run</label>
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
              data-testid="wiki-agent-limit"
              className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            data-testid="wiki-agent-save"
            className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-md px-3 py-1.5 transition-colors"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
