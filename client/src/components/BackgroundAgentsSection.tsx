import { useState, useEffect, useMemo, useCallback } from 'react';
import { BookText, Loader2, Plus, Trash2, Bot } from 'lucide-react';
import { api } from '../utils/api';
import { getAuthRecord } from '../utils/auth';
import CronSchedulePicker from './CronSchedulePicker';

/**
 * Project Settings → AI → Background Agents.
 *
 * Background agents are project-scoped scheduled AI jobs that run
 * unattended, distinct from interactive sessions and from the retired
 * per-agent heartbeats. The built-in Wiki agent dispatches the wiki
 * documentation backfill on a cadence (the docs agent reviews undocumented
 * Done cards and refreshes the wiki) — otherwise the wiki is only refreshed on
 * PR merge or via the operator-triggered backfill.
 *
 * Beyond Wiki, operators can add any number of *custom* background agents:
 * each is a named, scheduled, editable prompt that runs unattended as a chosen
 * Hub user through the same one-shot failover runner crons use.
 *
 * Config lives on `project.backgroundAgents` (`.wiki` + `.custom[]`) and is
 * written through `PATCH /api/projects/:id`.
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

type CustomAgentCfg = {
  id: string;
  name: string;
  enabled?: boolean;
  schedule?: string;
  timezone?: string | null;
  ownerUserId?: string | null;
  model?: string | null;
  engine?: string | null;
  prompt: string;
};

function newAgentId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `bg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

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
  const saved: WikiCfg = useMemo(() => project?.backgroundAgents?.wiki || {}, [project]);

  // The logged-in user — the run defaults to acting as them so background
  // work uses credentials the operator configuring it actually has.
  const currentUser = useMemo(() => (getAuthRecord() as any)?.user || null, []);
  const currentUserId: string = currentUser?.id || '';
  const currentUserName: string =
    currentUser?.username || currentUser?.email || (currentUserId ? currentUserId : 'You');

  // `ownerUserId` is only "configured" once the wiki block exists with the
  // key present; a never-touched project defaults to the logged-in user
  // rather than the userless (host-engine) fallback.
  const defaultOwner = useCallback((): string => {
    if (Object.prototype.hasOwnProperty.call(saved, 'ownerUserId')) return saved.ownerUserId || '';
    return currentUserId || '';
  }, [saved, currentUserId]);

  const docsAgent = useMemo(
    () => (project?.agents || []).find((a: any) => (a?.role || '').trim().toLowerCase() === 'docs'),
    [project],
  );
  const docsEngine: string = docsAgent?.engine || 'claude-code';

  const [enabled, setEnabled] = useState<boolean>(!!saved.enabled);
  const [schedule, setSchedule] = useState<string>(saved.schedule || DEFAULT_WIKI_SCHEDULE);
  const [ownerUserId, setOwnerUserId] = useState<string>(defaultOwner);
  const [model, setModel] = useState<string>(saved.model || '');
  const [limit, setLimit] = useState<number>(saved.limit || 10);
  const [saving, setSaving] = useState(false);

  const savedCustom: CustomAgentCfg[] = useMemo(
    () => (Array.isArray(project?.backgroundAgents?.custom) ? project.backgroundAgents.custom : []),
    [project],
  );
  const [customAgents, setCustomAgents] = useState<CustomAgentCfg[]>(savedCustom);

  const [members, setMembers] = useState<Array<{ userId: string; username: string }>>([]);
  const [modelConfig, setModelConfig] = useState<{
    engineValidModels?: Record<string, string[]>;
  } | null>(null);

  // Re-sync local state when switching projects.
  useEffect(() => {
    setEnabled(!!saved.enabled);
    setSchedule(saved.schedule || DEFAULT_WIKI_SCHEDULE);
    setOwnerUserId(defaultOwner());
    setModel(saved.model || '');
    setLimit(saved.limit || 10);
    setCustomAgents(savedCustom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const addCustomAgent = useCallback(() => {
    setCustomAgents((prev) => [
      ...prev,
      {
        id: newAgentId(),
        name: '',
        enabled: false,
        schedule: DEFAULT_WIKI_SCHEDULE,
        ownerUserId: currentUserId || null,
        model: null,
        engine: null,
        prompt: '',
      },
    ]);
  }, [currentUserId]);

  const updateCustomAgent = useCallback((id: string, patch: Partial<CustomAgentCfg>) => {
    setCustomAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const removeCustomAgent = useCallback((id: string) => {
    setCustomAgents((prev) => prev.filter((a) => a.id !== id));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    // Populate "Runs as user" from the org roster, not the per-project
    // visibility ACL: a shared project has no ACL rows, which is why the
    // picker used to render empty. The roster fetch needs Admin+, so we always
    // fold in the logged-in user below to guarantee at least one real option.
    api
      .getOrgUsers()
      .then((r: any) =>
        setMembers(
          (r?.users || [])
            .filter((u: any) => u && u.id)
            .map((u: any) => ({ userId: u.id as string, username: u.username || u.email || u.id })),
        ),
      )
      .catch(() => setMembers([]));
    api
      .getModelConfig()
      .then((r: any) => setModelConfig(r))
      .catch(() => setModelConfig(null));
  }, [projectId]);

  // Merge the logged-in user into the roster (deduped) so the picker is never
  // empty even when the roster fetch is forbidden or the org has no listing.
  const ownerOptions = useMemo(() => {
    const byId = new Map<string, { userId: string; username: string }>();
    if (currentUserId)
      byId.set(currentUserId, { userId: currentUserId, username: currentUserName });
    for (const m of members) byId.set(m.userId, m);
    return Array.from(byId.values());
  }, [members, currentUserId, currentUserName]);

  const models: string[] = modelConfig?.engineValidModels?.[docsEngine] || [];
  // Custom agents run under the default engine chain (claude-code first) unless
  // overridden; offer that engine's models for the optional per-agent override.
  const customModels: string[] = modelConfig?.engineValidModels?.['claude-code'] || [];

  const save = useCallback(async () => {
    if (!projectId) return;
    // A model must be chosen explicitly — no silent fallback to the docs
    // agent's default — but only gate on it when the agent is actually on.
    if (enabled && !model) {
      showToast?.('Pick a model for the Wiki agent before enabling it', 'error');
      return;
    }
    // Every custom agent needs a name and a prompt (the server rejects blanks).
    for (const a of customAgents) {
      if (!a.name.trim()) {
        showToast?.('Give every custom agent a name', 'error');
        return;
      }
      if (!a.prompt.trim()) {
        showToast?.(`Add a prompt for "${a.name.trim() || 'the custom agent'}"`, 'error');
        return;
      }
    }
    setSaving(true);
    try {
      const wiki: WikiCfg = {
        enabled,
        schedule: schedule || DEFAULT_WIKI_SCHEDULE,
        ownerUserId: ownerUserId || null,
        model: model || null,
        limit,
      };
      const custom: CustomAgentCfg[] = customAgents.map((a) => ({
        id: a.id,
        name: a.name.trim(),
        enabled: !!a.enabled,
        schedule: a.schedule || DEFAULT_WIKI_SCHEDULE,
        ownerUserId: a.ownerUserId || null,
        model: a.model || null,
        engine: a.engine || null,
        prompt: a.prompt,
      }));
      const updated = await api.updateProject(projectId, { backgroundAgents: { wiki, custom } });
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
    customAgents,
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
              {ownerOptions.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.username}
                  {m.userId === currentUserId ? ' (you)' : ''}
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
              <option value="" disabled>
                Select a model…
              </option>
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
      </div>

      {/* Custom agents */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-white">Custom agents</h4>
            <p className="text-xs text-gray-500 mt-0.5">
              Named, scheduled prompts that run unattended as a chosen Hub user.
            </p>
          </div>
          <button
            onClick={addCustomAgent}
            data-testid="add-custom-agent"
            className="inline-flex items-center gap-1.5 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-md px-2.5 py-1.5 transition-colors"
          >
            <Plus size={14} />
            Add agent
          </button>
        </div>

        {customAgents.length === 0 && (
          <p className="text-xs text-gray-600" data-testid="custom-agents-empty">
            No custom agents yet. Add one to run your own prompt on a schedule.
          </p>
        )}

        {customAgents.map((agent, idx) => (
          <div
            key={agent.id}
            data-testid="custom-agent"
            className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 flex-1 min-w-0">
                <Bot size={18} className="text-emerald-400 mt-0.5 flex-shrink-0" />
                <input
                  type="text"
                  value={agent.name}
                  placeholder="Agent name"
                  onChange={(e) => updateCustomAgent(agent.id, { name: e.target.value })}
                  data-testid={`custom-agent-name-${idx}`}
                  className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-gray-600"
                />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <label className="inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={!!agent.enabled}
                    onChange={(e) => updateCustomAgent(agent.id, { enabled: e.target.checked })}
                    data-testid={`custom-agent-enabled-${idx}`}
                  />
                  <div className="relative w-9 h-5 bg-gray-700 rounded-full peer peer-checked:bg-emerald-600 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
                </label>
                <button
                  onClick={() => removeCustomAgent(agent.id)}
                  data-testid={`custom-agent-remove-${idx}`}
                  aria-label="Remove agent"
                  className="text-gray-500 hover:text-red-400 transition-colors p-1"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Prompt</label>
              <textarea
                value={agent.prompt}
                placeholder="What should this agent do on each run?"
                onChange={(e) => updateCustomAgent(agent.id, { prompt: e.target.value })}
                data-testid={`custom-agent-prompt-${idx}`}
                rows={3}
                className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600 resize-y"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Frequency</label>
                <CronSchedulePicker
                  value={agent.schedule || DEFAULT_WIKI_SCHEDULE}
                  onChange={(v: string) => updateCustomAgent(agent.id, { schedule: v })}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Runs as user</label>
                <select
                  value={agent.ownerUserId || ''}
                  onChange={(e) =>
                    updateCustomAgent(agent.id, { ownerUserId: e.target.value || null })
                  }
                  data-testid={`custom-agent-owner-${idx}`}
                  className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
                >
                  <option value="">Userless (host engine only)</option>
                  {ownerOptions.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.username}
                      {m.userId === currentUserId ? ' (you)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Model <span className="text-gray-600">(optional)</span>
                </label>
                <select
                  value={agent.model || ''}
                  onChange={(e) => updateCustomAgent(agent.id, { model: e.target.value || null })}
                  data-testid={`custom-agent-model-${idx}`}
                  className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
                >
                  <option value="">Default (engine default)</option>
                  {customModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        ))}
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
  );
}
