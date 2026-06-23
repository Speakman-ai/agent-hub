import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Per-user, per-agent **default model** picker (controlled).
 *
 * Selecting a model here only changes the model the *current user's* own
 * sessions with this agent spawn under — it never touches the shared
 * `agent.model` row or any other user. Persistence lives in the parent
 * (`/api/auth/me/agent-model-overrides`); this component just renders the
 * `<select>` and calls `onSelect(model)` (with `''` meaning "use the
 * shared/engine default").
 *
 * The blank option is labeled with the effective fallback model so a user
 * can see what "default" resolves to for the agent's current engine.
 */
export default function PerUserModelSelect({
  engine,
  modelConfig,
  value,
  onSelect,
  saving = false,
  saved = false,
  disabled = false,
  className = '',
  label = 'Model (only for me)',
  selectClassName,
}: any) {
  const models = useMemo(
    () => modelConfig?.engineValidModels?.[engine] || [],
    [modelConfig, engine],
  );
  const defaultModel =
    modelConfig?.engineDefaultModels?.[engine] || modelConfig?.defaultModel || '';

  // Don't render a stale value that isn't valid for the current engine — it
  // would otherwise show as a blank/ghost option. Fall back to "" (default).
  const safeValue = value && models.includes(value) ? value : '';

  return (
    <div className={className}>
      <label className="block text-xs text-gray-400 mb-1 flex items-center gap-1.5">
        {label}
        {saving && <Loader2 size={10} className="animate-spin text-indigo-300" />}
        {saved && !saving && <span className="text-[11px] text-emerald-400">✓ saved</span>}
      </label>
      <select
        data-testid="per-user-model-select"
        value={safeValue}
        disabled={disabled || !modelConfig || saving}
        onChange={(e: any) => onSelect(e.target.value)}
        className={
          selectClassName ||
          'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 disabled:opacity-60'
        }
      >
        <option value="">{defaultModel ? `Default (${defaultModel})` : 'Default'}</option>
        {models.map((m: any) => (
          <option key={m} value={m}>
            {m}
            {m === defaultModel ? ' (default)' : ''}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-gray-500 mt-1">Only changes the model for your sessions.</p>
    </div>
  );
}
