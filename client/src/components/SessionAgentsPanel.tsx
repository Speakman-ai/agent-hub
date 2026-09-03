import { useMemo, useState } from 'react';
import { api } from '../utils/api';
import { Users } from 'lucide-react';
import {
  agentProjectLabel,
  filterAgentsForPicker,
  groupAgentsByProject,
} from '../utils/sessionAgentPicker';
import { ENGINE_LABELS, hubModelsForEngine, hubSelectableEngines } from './HubModelPicker';

function AgentChip({
  agent,
  onRemove,
  onModelChange,
  onEngineChange,
  models = [],
  engines = [],
  busy,
  showProject,
}: any) {
  const project = showProject ? agentProjectLabel(agent) : '';
  return (
    <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-1.5 text-sm max-w-full">
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: agent.color }}
      />
      <span className="truncate">{agent.name}</span>
      {project ? (
        <span className="text-[10px] text-gray-500 truncate" title={project}>
          {project}
        </span>
      ) : null}
      {onEngineChange && engines.length > 0 ? (
        <select
          aria-label={`Engine for ${agent.name}`}
          value={agent.engineOverride || ''}
          disabled={busy}
          onChange={(event: any) => onEngineChange(agent.participantId, event.target.value || null)}
          className="min-w-0 max-w-40 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300 disabled:opacity-40"
        >
          <option value="">Agent engine</option>
          {engines.map((engine: string) => (
            <option key={engine} value={engine}>
              {ENGINE_LABELS[engine] || engine}
            </option>
          ))}
        </select>
      ) : null}
      {onModelChange && models.length > 0 ? (
        <select
          aria-label={`Model for ${agent.name}`}
          value={agent.model || ''}
          disabled={busy}
          onChange={(event: any) => onModelChange(agent.participantId, event.target.value || null)}
          className="min-w-0 max-w-48 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300 disabled:opacity-40"
        >
          <option value="">Agent default</option>
          {models.map((model: string) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRemove(agent.participantId)}
          className="text-gray-500 hover:text-red-400 text-xs ml-1 disabled:opacity-40 flex-shrink-0"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/**
 * Collapsible panel for multi-agent session roster: primary executor + read-only advisors.
 * Advisors can be added from any project the user can view.
 */
export default function SessionAgentsPanel({
  sessionId,
  sessionAgents = [],
  maxTurns = 10,
  agents = [],
  modelConfig,
  onUpdated,
}: any) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addModels, setAddModels] = useState<Record<string, string>>({});
  const [addEngines, setAddEngines] = useState<Record<string, string>>({});

  const executor = sessionAgents.find((a: any) => a.role === 'executor');
  const advisors = sessionAgents.filter((a: any) => a.role === 'advisor');
  const executorProjectId = executor?.projectId;

  const availableGroups = useMemo(() => {
    const filtered = filterAgentsForPicker(agents, {
      query: addSearch,
    });
    return groupAgentsByProject(filtered);
  }, [agents, addSearch]);

  const selectableEngines = useMemo(() => hubSelectableEngines(modelConfig), [modelConfig]);

  // Effective engine for an already-added advisor is `engine` (override or the
  // agent's own). For the add row, the pending engine pick wins over the
  // agent's configured engine.
  const modelsForEngine = (engine: string): string[] => hubModelsForEngine(modelConfig, engine);
  const modelsForAgent = (agent: any): string[] => modelsForEngine(agent.engine || 'claude-code');
  const addEngineFor = (agent: any): string =>
    addEngines[agent.id] || agent.engine || 'claude-code';

  const refresh = async () => {
    if (!sessionId) return;
    const detail = await api.getSessionDetail(sessionId);
    onUpdated?.(detail);
  };

  const handleAdd = async (agentId: any) => {
    if (!sessionId || busy) return;
    const agent = agents.find((a: any) => a.id === agentId);
    const execProjectId = executor?.projectId;
    if (
      agent &&
      execProjectId &&
      agent.projectId &&
      agent.projectId !== execProjectId &&
      typeof window !== 'undefined' &&
      !window.confirm(
        `Adding "${agent.name}" from ${agent.projectName || agent.projectId} grants their CLI read access to this session's project workspace and secrets. Continue?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      // The add-row engine select is authoritative: always send the displayed
      // engine explicitly so what the user sees is exactly what gets stored and
      // spawned. Sending null here would let a per-user engine override silently
      // diverge the spawn (and the model validation) from the shown engine.
      const engineOverride = addEngines[agentId] || agent?.engine || 'claude-code';
      await api.addSessionAgent(sessionId, agentId, addModels[agentId] || null, engineOverride);
      await refresh();
    } catch (err: any) {
      console.error('addSessionAgent failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleEngineChange = async (participantId: string, engine: string | null) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.setSessionAgentEngine(sessionId, participantId, engine);
      await refresh();
    } catch (err: any) {
      console.error('setSessionAgentEngine failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleModelChange = async (participantId: string, model: string | null) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.setSessionAgentModel(sessionId, participantId, model);
      await refresh();
    } catch (err: any) {
      console.error('setSessionAgentModel failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (agentId: any) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.removeSessionAgent(sessionId, agentId);
      await refresh();
    } catch (err: any) {
      console.error('removeSessionAgent failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleMaxTurnsChange = async (value: any) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.updateSession(sessionId, { max_turns: value });
      await refresh();
    } catch (err: any) {
      console.error('updateSession max_turns failed:', err);
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId) return null;

  const currentMax = maxTurns ?? 10;
  const totalAvailable = availableGroups.reduce((n: any, g: any) => n + g.agents.length, 0);

  return (
    <div className="border-b border-gray-800 flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v: any) => !v)}
        className="w-full px-3 md:px-6 py-2 flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-900/50 transition-colors"
      >
        <Users size={14} className="flex-shrink-0" />
        <span className="font-medium">
          {sessionAgents.length <= 1
            ? 'Single agent'
            : `${sessionAgents.length} agents (${advisors.length} advisor${advisors.length !== 1 ? 's' : ''})`}
        </span>
        {advisors.length > 0 && (
          <span className="flex items-center gap-1 ml-1">
            {sessionAgents.slice(0, 6).map((a: any) => (
              <span
                key={a.participantId}
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: a.color }}
                title={a.name}
              />
            ))}
          </span>
        )}
        <span className="ml-auto text-gray-600">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-800/80 bg-gray-900/40 px-3 md:px-6 py-3">
          <div className="max-w-4xl mx-auto space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Executor
              </h3>
              {executor ? (
                <AgentChip agent={executor} busy={busy} showProject />
              ) : (
                <span className="text-xs text-gray-600">No executor</span>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Advisors (read-only)
              </h3>
              <div className="flex flex-wrap gap-2 mb-1">
                {advisors.map((a: any) => (
                  <AgentChip
                    key={a.participantId}
                    agent={a}
                    busy={busy}
                    showProject={!!executorProjectId && a.projectId !== executorProjectId}
                    onRemove={handleRemove}
                    onModelChange={handleModelChange}
                    onEngineChange={handleEngineChange}
                    models={modelsForAgent(a)}
                    engines={selectableEngines}
                  />
                ))}
                {advisors.length === 0 && (
                  <span className="text-xs text-gray-600">
                    No advisors — add agents from any project below
                  </span>
                )}
              </div>

              {agents.length > 0 && (
                <div className="mt-3 space-y-2">
                  <input
                    type="search"
                    value={addSearch}
                    onChange={(e: any) => setAddSearch(e.target.value)}
                    placeholder="Search agents or projects…"
                    className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
                  />
                  {totalAvailable === 0 ? (
                    <p className="text-xs text-gray-600">
                      {addSearch.trim() ? 'No matching agents' : 'No visible agents available'}
                    </p>
                  ) : (
                    <div className="space-y-3 max-h-48 overflow-y-auto pr-1">
                      {availableGroups.map((group: any) => (
                        <div key={group.projectId}>
                          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                            {group.projectName}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {group.agents.map((a: any) => {
                              const addEngine = addEngineFor(a);
                              const models = modelsForEngine(addEngine);
                              return (
                                <div
                                  key={a.id}
                                  className="flex items-center gap-2 rounded-lg bg-gray-800 px-2 py-1.5"
                                >
                                  <span
                                    className="w-2.5 h-2.5 rounded-full"
                                    style={{ backgroundColor: a.color }}
                                  />
                                  <span className="text-sm text-gray-300">{a.name}</span>
                                  {selectableEngines.length > 0 ? (
                                    <select
                                      aria-label={`Engine for new ${a.name}`}
                                      value={addEngine}
                                      disabled={busy}
                                      onChange={(event: any) => {
                                        const nextEngine = event.target.value;
                                        // Engine drives the model list; drop a
                                        // stale model pick from the prior engine.
                                        setAddEngines((current) => ({
                                          ...current,
                                          [a.id]: nextEngine,
                                        }));
                                        setAddModels((current) => {
                                          const next = { ...current };
                                          delete next[a.id];
                                          return next;
                                        });
                                      }}
                                      className="min-w-0 max-w-40 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300 disabled:opacity-40"
                                    >
                                      {selectableEngines.map((engine: string) => (
                                        <option key={engine} value={engine}>
                                          {ENGINE_LABELS[engine] || engine}
                                        </option>
                                      ))}
                                    </select>
                                  ) : null}
                                  {models.length > 0 ? (
                                    <select
                                      aria-label={`Model for new ${a.name}`}
                                      value={addModels[a.id] || ''}
                                      disabled={busy}
                                      onChange={(event: any) =>
                                        setAddModels((current) => ({
                                          ...current,
                                          [a.id]: event.target.value,
                                        }))
                                      }
                                      className="min-w-0 max-w-44 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300 disabled:opacity-40"
                                    >
                                      <option value="">Agent default</option>
                                      {models.map((model: string) => (
                                        <option key={model} value={model}>
                                          {model}
                                        </option>
                                      ))}
                                    </select>
                                  ) : null}
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => handleAdd(a.id)}
                                    className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-gray-600 disabled:opacity-40"
                                  >
                                    Add
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {advisors.length > 0 && (
              <div className="pt-3 border-t border-gray-700/50">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Max Agent Replies (per message)
                </h3>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[10, 25, 50, 100, 0].map((value: any) => {
                    const label = value === 0 ? 'Unlimited' : String(value);
                    const isActive = currentMax === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={busy}
                        onClick={() => handleMaxTurnsChange(value)}
                        className={`text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
                          isActive
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-600 mt-1.5">
                  Max advisor-to-executor reply rounds before stopping.
                  {currentMax === 0 && (
                    <span className="text-amber-500 ml-1">
                      Warning: unlimited may run for a long time
                    </span>
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
