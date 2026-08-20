import { useState, useEffect, useCallback, useMemo } from 'react';
import { Globe, PenLine, AlertTriangle, RefreshCw, Puzzle } from 'lucide-react';
import { api } from '../utils/api';
import { SkillCard, SkillEditor } from './SkillsPage';

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 flex items-start gap-3"
    >
      <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-red-300">Failed to load global skills</p>
        <p className="text-xs text-red-400/80 mt-1 break-words">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-red-800/40 text-red-200 hover:bg-red-800/60 transition-colors"
        >
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    </div>
  );
}

/**
 * Settings → Global Skills — built-in bundled skills plus user-authored shared
 * skills (`<dataDir>/skills`). Per-project skills live on each project's
 * sidebar Skills page.
 */
export default function GlobalSkillsSection({
  agents = [],
  projects = [],
}: {
  agents?: any[];
  projects?: any[];
}) {
  const [skills, setSkills] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<any>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The agent whose per-agent overrides this page is currently editing. Global/
  // bundled skills apply to every agent in every project, so enable/disable is a
  // per-agent choice — the selector below makes the target explicit (rather than
  // silently writing against one arbitrary agent).
  const [selectedAgentId, setSelectedAgentId] = useState<any>(null);

  // Every active agent, in a stable order, for the override-target selector.
  const selectableAgents = useMemo(
    () => (agents || []).filter((a: any) => a.active !== false),
    [agents],
  );

  // Default target: a non-helper agent, else the first active agent.
  const defaultAgentId = useMemo(() => {
    const dev = selectableAgents.find(
      (a: any) =>
        a.role !== 'skill-builder' &&
        a.role !== 'reviewer' &&
        a.role !== 'docs' &&
        a.role !== 'hub-assistant',
    );
    return (dev || selectableAgents[0] || null)?.id || null;
  }, [selectableAgents]);

  // The effective target: an explicit pick that still exists, else the default.
  const referenceAgentId = useMemo(() => {
    if (selectedAgentId && selectableAgents.some((a: any) => a.id === selectedAgentId)) {
      return selectedAgentId;
    }
    return defaultAgentId;
  }, [selectedAgentId, selectableAgents, defaultAgentId]);

  const projectNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects || []) map[p.id] = p.name || p.id;
    return map;
  }, [projects]);

  // Group the selectable agents by project for the dropdown's <optgroup>s.
  const agentsByProject = useMemo(() => {
    const groups: Array<{ projectId: string; label: string; agents: any[] }> = [];
    const index: Record<string, number> = {};
    for (const a of selectableAgents) {
      const pid = a.projectId || 'unassigned';
      if (index[pid] === undefined) {
        index[pid] = groups.length;
        groups.push({
          projectId: pid,
          label: projectNameById[pid] || (pid === 'unassigned' ? 'Other' : pid),
          agents: [],
        });
      }
      groups[index[pid]].agents.push(a);
    }
    return groups;
  }, [selectableAgents, projectNameById]);

  const skillsBySection = useMemo(() => {
    const groups = { global: [] as any[], default: [] as any[] };
    for (const skill of skills) {
      const key = skill.source === 'global' ? 'global' : 'default';
      groups[key].push(skill);
    }
    return groups;
  }, [skills]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getGlobalSkills()
      .then((rows: any) => {
        setSkills(Array.isArray(rows) ? rows : []);
        setError(null);
      })
      .catch((err: any) => {
        setSkills([]);
        setError(err?.message || 'Unknown error');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Load the selected agent's per-agent overrides so the toggle reflects (and
  // edits) the right agent's enable/disable state.
  useEffect(() => {
    if (!referenceAgentId) {
      setOverrides([]);
      return;
    }
    api
      .getSkillOverrides(referenceAgentId)
      .then(setOverrides)
      .catch(() => setOverrides([]));
  }, [referenceAgentId, skills]);

  useEffect(() => {
    if (!actionError) return undefined;
    const t = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(t);
  }, [actionError]);

  const handleToggle = useCallback(
    async (skillId: string, enabled: boolean) => {
      if (!referenceAgentId) return;
      try {
        await api.toggleSkill(referenceAgentId, skillId, enabled);
        setOverrides((prev: any) => {
          const existing = prev.findIndex((o: any) => o.skill_id === skillId);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = { ...updated[existing], enabled: enabled ? 1 : 0 };
            return updated;
          }
          return [
            ...prev,
            { agent_id: referenceAgentId, skill_id: skillId, enabled: enabled ? 1 : 0 },
          ];
        });
      } catch (err: any) {
        setActionError(`Failed to toggle skill ${skillId}: ${err?.message || 'unknown error'}`);
      }
    },
    [referenceAgentId],
  );

  const handleUninstall = useCallback(async (skillId: string, source?: string) => {
    if (source !== 'global') return;
    const confirmed = window.confirm(
      `Delete the shared skill "${skillId}" for ALL projects?\n\n` +
        'This is a shared (global) skill. Removing it deletes it for every agent ' +
        'in every project — not just one — and cannot be undone.',
    );
    if (!confirmed) return;
    try {
      await api.deleteGlobalSkill(skillId);
      setSkills((prev) => prev.filter((s) => s.id !== skillId));
    } catch (err: any) {
      setActionError(err?.message || `Failed to delete skill ${skillId}`);
    }
  }, []);

  const handleSaved = useCallback(() => {
    setEditorState(null);
    load();
  }, [load]);

  const totalCount = skills.length;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Globe size={22} className="text-sky-400" /> Global Skills
          </h2>
          <p className="text-sm text-gray-500 mt-1 max-w-xl">
            Built-in skills and shared skills available to every agent in every project.
            Project-only skills are managed from each project&apos;s Skills page in the sidebar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditorState({ skill: null })}
          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 transition-colors shrink-0"
        >
          <PenLine size={13} /> New shared skill
        </button>
      </div>

      {actionError ? (
        <div
          role="alert"
          className="mb-4 bg-red-900/30 border border-red-800/60 rounded-lg px-4 py-2.5 text-sm text-red-300"
        >
          {actionError}
        </div>
      ) : null}

      <div className="mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Puzzle size={18} /> Skills
          <span className="text-xs text-gray-500 font-normal">({totalCount} total)</span>
        </h3>
        <p className="text-[11px] text-gray-500 mt-2">
          Author, edit, and delete shared skills and view built-ins here. Enable/disable is a
          per-agent choice — pick the target agent below to edit its overrides.
        </p>
        {referenceAgentId ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="global-skills-agent-select" className="text-[11px] text-gray-500">
              Overrides for:
            </label>
            <select
              id="global-skills-agent-select"
              data-testid="global-skills-agent-select"
              value={referenceAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="text-xs px-2 py-1 rounded-md border border-gray-700 bg-gray-900 text-gray-200 focus:border-indigo-500 focus:outline-none"
            >
              {agentsByProject.map((group) => (
                <optgroup key={group.projectId} label={group.label}>
                  {group.agents.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading global skills…</p>
      ) : error ? (
        <LoadError message={error} onRetry={load} />
      ) : totalCount === 0 ? (
        <div className="bg-gray-800 rounded-xl p-6 text-center">
          <p className="text-gray-500 text-sm">No global skills found</p>
        </div>
      ) : (
        <div className="space-y-6" data-testid="global-skills-library">
          {(
            [
              { key: 'default' as const, title: 'Built-in' },
              { key: 'global' as const, title: 'Shared across projects' },
            ] as const
          ).map(({ key, title }) => {
            const sectionSkills = skillsBySection[key];
            if (sectionSkills.length === 0) return null;
            return (
              <section key={key} data-testid={`global-skills-section-${key}`}>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  {title}
                  <span className="ml-2 font-normal normal-case text-gray-600">
                    ({sectionSkills.length})
                  </span>
                </h4>
                <div className="grid grid-cols-1 gap-2">
                  {sectionSkills.map((skill) => (
                    <SkillCard
                      key={`${key}-${skill.id}`}
                      skill={skill}
                      agentId={referenceAgentId}
                      overrides={overrides}
                      onToggle={referenceAgentId ? handleToggle : undefined}
                      onUninstall={key === 'global' ? handleUninstall : undefined}
                      onEdit={
                        key === 'global' ? (s: any) => setEditorState({ skill: s }) : undefined
                      }
                      isInstalled
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {editorState ? (
        <SkillEditor
          skill={editorState.skill}
          onClose={() => setEditorState(null)}
          onSaved={handleSaved}
          globalOnly
        />
      ) : null}
    </div>
  );
}
