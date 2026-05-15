import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, Loader2, Save } from 'lucide-react';
import { api } from '../utils/api.js';

const ENGINE_LABELS = {
  'claude-code': 'Claude Code',
  'cursor-agent': 'Cursor Agent',
  'gemini-cli': 'Gemini CLI',
  'codex-cli': 'Codex CLI',
};

/**
 * Lets each authenticated Hub user set default CLI models per engine. These win
 * over shared agent roster defaults when spawning sessions they own — see `/api/auth/me/engine-default-models`.
 */
export default function MyEngineDefaultModelsSection() {
  const [modelConfig, setModelConfig] = useState(null);
  const [savedDefaults, setSavedDefaults] = useState({});
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const [cfg, prefs] = await Promise.all([
        api.getModelConfig(),
        api.getMyEngineDefaultModels(),
      ]);
      setModelConfig(cfg);
      const em =
        prefs?.engineDefaultModels && typeof prefs.engineDefaultModels === 'object'
          ? prefs.engineDefaultModels
          : {};
      setSavedDefaults({ ...em });
      setDraft({ ...em });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const engines = useMemo(() => {
    const ev = modelConfig?.engineValidModels;
    if (!ev || typeof ev !== 'object') return [];
    return Object.entries(ev).filter(([, ids]) => Array.isArray(ids) && ids.length > 0);
  }, [modelConfig]);

  const normalizedSaved = JSON.stringify(savedDefaults ?? {});
  const normalizedDraft = JSON.stringify(draft ?? {});
  const dirty = normalizedSaved !== normalizedDraft;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const cleaned = {};
      for (const [k, v] of Object.entries(draft)) {
        const key = typeof k === 'string' ? k.trim() : '';
        if (!key || typeof v !== 'string') continue;
        const m = v.trim();
        if (m) cleaned[key] = m;
      }
      const body = await api.putMyEngineDefaultModels({ engineDefaultModels: cleaned });
      const em =
        body?.engineDefaultModels && typeof body.engineDefaultModels === 'object'
          ? body.engineDefaultModels
          : cleaned;
      setSavedDefaults({ ...em });
      setDraft({ ...em });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Loading defaults…
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Cpu size={14} className="text-emerald-400" />
        <h4 className="text-sm font-medium text-gray-300">My default models</h4>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">
        Per-engine defaults apply to <span className="text-gray-300">new sessions</span> you own
        before the shared roster model on each agent. Clear a row and save to fall back through the
        roster to the hub engine default.
      </p>

      {msg && <div className="text-xs text-amber-300">{msg}</div>}

      {engines.length === 0 ? (
        <div className="text-xs text-gray-500">
          Server model catalogue is unavailable. Check `/api/config/models` or retry after reload.
        </div>
      ) : (
        <div className="space-y-2">
          {engines.map(([engine, models]) => (
            <div key={engine} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <label
                className="text-xs text-gray-400 w-44 shrink-0"
                htmlFor={`engine-default-${engine}`}
              >
                {ENGINE_LABELS[engine] ?? engine}
              </label>
              <select
                id={`engine-default-${engine}`}
                value={draft[engine] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft((d) => {
                    const next = { ...d };
                    if (!v) delete next[engine];
                    else next[engine] = v;
                    return next;
                  });
                }}
                className="flex-1 text-sm bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100"
              >
                <option value="">(follow roster / hub)</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {modelConfig?.engineDefaultModels?.[engine] === m ? ' · hub fallback' : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        disabled={saving || !dirty}
        onClick={() => void save()}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
        Save defaults
      </button>
    </div>
  );
}
