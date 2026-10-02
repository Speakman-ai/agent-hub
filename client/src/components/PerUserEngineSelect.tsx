import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Per-user, per-agent **engine** pick (controlled).
 *
 * The engine an agent runs under is always the current user's own choice;
 * there is no shared engine setting to edit. Persistence lives in the parent
 * (`/api/auth/me/agent-engine-overrides`); this component only renders the
 * `<select>` and calls `onSelect(engine)`. With no saved pick the select shows
 * the engine the agent was created with (`agentEngine`), which is what the
 * server falls back to.
 *
 * The model is NOT set here — the per-user model is chosen in
 * `PerUserModelSelect` and composes on top of whichever engine resolves.
 */
export default function PerUserEngineSelect({
  agentEngine,
  modelConfig,
  value,
  onSelect,
  saving = false,
  saved = false,
  disabled = false,
  className = '',
  label = 'Engine',
  selectClassName,
}: any) {
  const engines = useMemo(() => {
    const ev = modelConfig?.engineValidModels;
    if (!ev || typeof ev !== 'object') return [];
    return Object.keys(ev).filter((e: any) => (ev[e]?.length ?? 0) > 0);
  }, [modelConfig]);

  // Display exactly the engine sessions resolve to: the saved pick when one
  // exists, else the agent's creation engine (the server fallback). If that
  // engine is not in the catalog, show it as an unavailable placeholder rather
  // than substituting another engine, so the display never diverges from the
  // persisted state and every real engine stays a selectable change.
  const effectiveEngine = value || agentEngine || '';
  const safeValue = engines.includes(effectiveEngine) ? effectiveEngine : '';

  return (
    <div className={className}>
      <label className="mb-1 flex items-center gap-1.5 text-xs text-gray-400">
        {label}
        {saving && <Loader2 size={10} className="animate-spin text-indigo-300" />}
        {saved && !saving && <span className="text-[11px] text-emerald-400">✓ saved</span>}
      </label>
      <select
        data-testid="per-user-engine-select"
        value={safeValue}
        disabled={disabled || !modelConfig || saving}
        onChange={(e: any) => onSelect(e.target.value)}
        className={
          selectClassName ||
          'w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:border-gray-600 focus:outline-none disabled:opacity-60'
        }
      >
        {safeValue === '' && (
          <option value="" disabled>
            {effectiveEngine
              ? `${effectiveEngine} (unavailable), choose an engine`
              : 'Choose an engine'}
          </option>
        )}
        {engines.map((e: any) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-gray-500">Only changes your sessions.</p>
    </div>
  );
}
