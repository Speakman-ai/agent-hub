import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, UserCog } from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * Inline per-user, per-agent engine (+ optional model) override.
 *
 * Renders as a subsection inside each agent's expanded card on the
 * Agents settings page. Lets the **current user** decide which engine
 * (and optionally which model) their own sessions for this agent will
 * spawn under — independent of the shared `agent.engine` / `agent.model`
 * row that's edited just above by Admins.
 *
 * Storage: `/api/auth/me/agent-engine-overrides`
 *   - GET returns `{ agentEngineOverrides: { [agentId]: { engine, model? } } }`
 *   - PUT replaces the whole map (the server merges around any other
 *     preference sub-maps, so a future per-user preference won't be
 *     clobbered here).
 *
 * Saves are explicit (a "Save" button next to the inputs) so a user
 * can pick engine + model in one go without two round-trips.
 */
export default function MyAgentEngineOverrideInline({ agentId, agentEngine, modelConfig }) {
  const [allOverrides, setAllOverrides] = useState(null);
  const [draftEngine, setDraftEngine] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const loadedFor = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const body = await api.getMyAgentEngineOverrides();
      const map =
        body?.agentEngineOverrides && typeof body.agentEngineOverrides === 'object'
          ? body.agentEngineOverrides
          : {};
      setAllOverrides(map);
      const current = map[agentId];
      setDraftEngine(typeof current?.engine === 'string' ? current.engine : '');
      setDraftModel(typeof current?.model === 'string' ? current.model : '');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (loadedFor.current === agentId) return;
    loadedFor.current = agentId;
    void load();
  }, [agentId, load]);

  const engineChoices = useMemo(() => {
    const ev = modelConfig?.engineValidModels;
    if (!ev || typeof ev !== 'object') return [];
    return Object.keys(ev).filter((e) => (ev[e]?.length ?? 0) > 0);
  }, [modelConfig]);

  const modelsForDraft = useMemo(() => {
    if (!draftEngine) return [];
    return modelConfig?.engineValidModels?.[draftEngine] ?? [];
  }, [draftEngine, modelConfig]);

  const stored = allOverrides?.[agentId];
  const savedEngine = stored?.engine ?? '';
  const savedModel = stored?.model ?? '';
  const dirty = draftEngine !== savedEngine || (draftEngine ? draftModel !== savedModel : false);

  const save = async () => {
    if (!allOverrides) return;
    setSaving(true);
    setMsg(null);
    try {
      const next = { ...allOverrides };
      if (!draftEngine) {
        delete next[agentId];
      } else if (draftModel) {
        next[agentId] = { engine: draftEngine, model: draftModel };
      } else {
        next[agentId] = { engine: draftEngine };
      }
      const body = await api.putMyAgentEngineOverrides({ agentEngineOverrides: next });
      const map =
        body?.agentEngineOverrides && typeof body.agentEngineOverrides === 'object'
          ? body.agentEngineOverrides
          : next;
      setAllOverrides(map);
      const echoed = map[agentId];
      setDraftEngine(typeof echoed?.engine === 'string' ? echoed.engine : '');
      setDraftModel(typeof echoed?.model === 'string' ? echoed.model : '');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mt-2 rounded-lg border border-indigo-900/40 bg-indigo-950/20 p-3"
      data-testid="my-agent-engine-override"
    >
      <div className="flex items-center gap-2 mb-2">
        <UserCog size={12} className="text-indigo-300" />
        <h5 className="text-xs font-medium text-indigo-200">My override (just for me)</h5>
        {loading && <Loader2 size={10} className="animate-spin text-indigo-300" />}
      </div>
      <p className="text-[11px] text-indigo-200/60 leading-relaxed mb-2">
        Pick which engine your own sessions with this agent should use. The shared default above
        stays as it is for other users.
      </p>

      {msg && <div className="text-[11px] text-amber-300 mb-2">{msg}</div>}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[11px] text-indigo-200/70 mb-1">Engine</label>
          <select
            value={draftEngine}
            onChange={(e) => {
              const v = e.target.value;
              setDraftEngine(v);
              setDraftModel(''); // reset model on engine change
            }}
            disabled={loading}
            className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100"
          >
            <option value="">(follow agent default: {agentEngine})</option>
            {engineChoices.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-indigo-200/70 mb-1">Model</label>
          <select
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
            disabled={loading || !draftEngine}
            className="w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100 disabled:opacity-50"
          >
            <option value="">(per-engine default)</option>
            {modelsForDraft.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          disabled={saving || loading || !dirty}
          onClick={() => void save()}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40"
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : null}
          {stored ? 'Update override' : 'Save override'}
        </button>
        {stored && (
          <button
            type="button"
            disabled={saving || loading}
            onClick={() => {
              setDraftEngine('');
              setDraftModel('');
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
          >
            Clear
          </button>
        )}
        {stored && !dirty && (
          <span className="text-[11px] text-emerald-400">
            ✓ active · {stored.engine}
            {stored.model ? ` / ${stored.model}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}
