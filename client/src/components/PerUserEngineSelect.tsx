import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Per-user, per-agent **engine** override (controlled).
 *
 * Lets the current user run their own sessions for an agent under a different
 * CLI engine than the shared `agent.engine` row — without changing it for
 * anyone else. Persistence lives in the parent
 * (`/api/auth/me/agent-engine-overrides`); this component only renders the
 * `<select>` and calls `onSelect(engine)` (with `''` meaning "follow the
 * shared agent engine").
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
  label = 'Engine (only for me)',
  selectClassName,
}: any) {
  const engines = useMemo(() => {
    const ev = modelConfig?.engineValidModels;
    if (!ev || typeof ev !== 'object') return [];
    return Object.keys(ev).filter((e: any) => (ev[e]?.length ?? 0) > 0);
  }, [modelConfig]);

  // Only render a value the catalog still knows about, else show "(shared)".
  const safeValue = value && engines.includes(value) ? value : '';

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
        <option value="">Shared default ({agentEngine})</option>
        {engines.map((e: any) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-gray-500">Only changes the engine for your sessions.</p>
    </div>
  );
}
