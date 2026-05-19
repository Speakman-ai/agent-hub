import { useState } from 'react';
import { Users, Plus, X } from 'lucide-react';
import {
  setRosterAgent,
  setRosterAgentName,
  addCustomTrack,
  removeRosterTrack,
} from '../utils/rosterSuggest.js';

/**
 * AgentRosterPicker — renders the roster editor for Act IV.
 *
 * Controlled component: the parent owns `roster` and receives updates via
 * `onChange`.
 *
 * Props:
 *   - roster:   [{ trackId, label, rationale, agentId?, agentName?, custom }]
 *   - agents:   [{ id, name, role? }] — only used when createAgents is false
 *   - createAgents: when true, each row names a new agent (post-scaffold flow)
 *   - projectName: used to seed default agent names for custom tracks
 *   - onChange: (nextRoster) => void
 *   - disabled: bool — read-only mode while a save is in flight
 */
export default function AgentRosterPicker({
  roster,
  agents = [],
  createAgents = false,
  projectName = '',
  onChange,
  disabled = false,
}) {
  const [newLabel, setNewLabel] = useState('');

  const handleAssignExisting = (trackId, agentId) => {
    onChange(setRosterAgent(roster, trackId, agentId || null));
  };

  const handleAgentName = (trackId, agentName) => {
    onChange(setRosterAgentName(roster, trackId, agentName));
  };

  const handleRemove = (trackId) => {
    onChange(removeRosterTrack(roster, trackId));
  };

  const handleAdd = () => {
    const label = newLabel.trim();
    if (!label) return;
    const id = `custom-${Date.now()}`;
    onChange(addCustomTrack(roster, { id, label }, projectName));
    setNewLabel('');
  };

  return (
    <section
      aria-label="Agent roster"
      data-testid="roster-picker"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <header className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <Users size={16} className="text-gray-400 shrink-0" />
        <h2 className="text-sm font-semibold text-white">Agent roster</h2>
        <span className="ml-auto text-xs text-gray-500">
          {roster.length} {roster.length === 1 ? 'track' : 'tracks'}
        </span>
      </header>

      {createAgents && (
        <p className="px-4 py-2 text-xs text-gray-500 border-b border-gray-800">
          Name a dedicated agent for each track. New agents are created for this project when you
          confirm — existing org agents are not listed here.
        </p>
      )}

      {roster.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-500" data-testid="roster-empty">
          No tracks suggested. Add a custom track below.
        </div>
      ) : (
        <ul className="divide-y divide-gray-800" data-testid="roster-rows">
          {roster.map((row) => (
            <RosterRow
              key={row.trackId}
              row={row}
              agents={agents}
              createAgents={createAgents}
              disabled={disabled}
              onAssignExisting={handleAssignExisting}
              onAgentName={handleAgentName}
              onRemove={row.custom ? handleRemove : null}
            />
          ))}
        </ul>
      )}

      <div className="border-t border-gray-800 px-4 py-3 flex items-center gap-2">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="Add a custom track (e.g. Docs)"
          className="flex-1 min-w-0 bg-gray-950 border border-gray-800 rounded-md px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-gray-600"
          disabled={disabled}
          data-testid="roster-custom-label"
          aria-label="Custom track label"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={disabled || !newLabel.trim()}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-md border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="roster-custom-add"
        >
          <Plus size={12} /> Add
        </button>
      </div>
    </section>
  );
}

function RosterRow({
  row,
  agents,
  createAgents,
  disabled,
  onAssignExisting,
  onAgentName,
  onRemove,
}) {
  return (
    <li
      className="flex items-center gap-3 px-4 py-2.5 text-sm"
      data-testid={`roster-row-${row.trackId}`}
      data-custom={row.custom ? 'true' : 'false'}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-gray-100 font-medium">{row.label}</span>
          {row.custom && (
            <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1 py-px">
              custom
            </span>
          )}
        </div>
        {row.rationale && <div className="text-xs text-gray-500 truncate">{row.rationale}</div>}
      </div>
      {createAgents ? (
        <input
          type="text"
          value={row.agentName || ''}
          onChange={(e) => onAgentName(row.trackId, e.target.value)}
          disabled={disabled}
          placeholder={`${row.label} agent`}
          className="w-44 min-w-0 bg-gray-950 border border-gray-800 rounded-md px-2 py-1 text-xs text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-gray-600"
          data-testid={`roster-agent-name-${row.trackId}`}
          aria-label={`Agent name for ${row.label}`}
        />
      ) : (
        <select
          value={row.agentId || ''}
          onChange={(e) => onAssignExisting(row.trackId, e.target.value)}
          disabled={disabled}
          className="bg-gray-950 border border-gray-800 rounded-md px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
          data-testid={`roster-agent-${row.trackId}`}
          aria-label={`Agent for ${row.label}`}
        >
          <option value="">— unassigned —</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name || agent.id}
            </option>
          ))}
        </select>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(row.trackId)}
          disabled={disabled}
          className="text-gray-500 hover:text-red-300 disabled:opacity-50"
          aria-label={`Remove ${row.label}`}
          data-testid={`roster-remove-${row.trackId}`}
        >
          <X size={14} />
        </button>
      )}
    </li>
  );
}
