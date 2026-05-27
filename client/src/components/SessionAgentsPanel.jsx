import { useMemo, useState } from 'react';
import { api } from '../utils/api.js';
import { Users } from 'lucide-react';
import {
  agentProjectLabel,
  filterAgentsForPicker,
  groupAgentsByProject,
} from '../utils/sessionAgentPicker.js';

function AgentChip({ agent, onRemove, busy, showProject }) {
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
      {onRemove ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRemove(agent.id)}
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
  onUpdated,
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addSearch, setAddSearch] = useState('');

  const executor = sessionAgents.find((a) => a.role === 'executor');
  const advisors = sessionAgents.filter((a) => a.role === 'advisor');
  const rosterIds = useMemo(() => new Set(sessionAgents.map((a) => a.id)), [sessionAgents]);
  const executorProjectId = executor?.projectId;

  const availableGroups = useMemo(() => {
    const filtered = filterAgentsForPicker(agents, {
      query: addSearch,
      excludeIds: rosterIds,
    });
    return groupAgentsByProject(filtered);
  }, [agents, addSearch, rosterIds]);

  const refresh = async () => {
    if (!sessionId) return;
    const detail = await api.getSessionDetail(sessionId);
    onUpdated?.(detail);
  };

  const handleAdd = async (agentId) => {
    if (!sessionId || busy) return;
    const agent = agents.find((a) => a.id === agentId);
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
      await api.addSessionAgent(sessionId, agentId);
      await refresh();
    } catch (err) {
      console.error('addSessionAgent failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (agentId) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.removeSessionAgent(sessionId, agentId);
      await refresh();
    } catch (err) {
      console.error('removeSessionAgent failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleMaxTurnsChange = async (value) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.updateSession(sessionId, { max_turns: value });
      await refresh();
    } catch (err) {
      console.error('updateSession max_turns failed:', err);
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId) return null;

  const currentMax = maxTurns ?? 10;
  const totalAvailable = availableGroups.reduce((n, g) => n + g.agents.length, 0);

  return (
    <div className="border-b border-gray-800 flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
            {sessionAgents.slice(0, 6).map((a) => (
              <span
                key={a.id}
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
                {advisors.map((a) => (
                  <AgentChip
                    key={a.id}
                    agent={a}
                    busy={busy}
                    showProject={!!executorProjectId && a.projectId !== executorProjectId}
                    onRemove={handleRemove}
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
                    onChange={(e) => setAddSearch(e.target.value)}
                    placeholder="Search agents or projects…"
                    className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
                  />
                  {totalAvailable === 0 ? (
                    <p className="text-xs text-gray-600">
                      {addSearch.trim()
                        ? 'No matching agents'
                        : 'All visible agents are already on this session'}
                    </p>
                  ) : (
                    <div className="space-y-3 max-h-48 overflow-y-auto pr-1">
                      {availableGroups.map((group) => (
                        <div key={group.projectId}>
                          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                            {group.projectName}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {group.agents.map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                disabled={busy}
                                onClick={() => handleAdd(a.id)}
                                className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-40"
                              >
                                <span
                                  className="w-2.5 h-2.5 rounded-full"
                                  style={{ backgroundColor: a.color }}
                                />
                                <span className="text-gray-300">+ {a.name}</span>
                              </button>
                            ))}
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
                  {[10, 25, 50, 100, 0].map((value) => {
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
