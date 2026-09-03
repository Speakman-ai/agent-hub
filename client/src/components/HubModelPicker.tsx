export const ENGINE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'cursor-agent': 'Cursor',
  'codex-cli': 'Codex',
  'grok-cli': 'Grok',
};

const SKIP_ENGINES = new Set(['gemini-cli']);

export function hubSelectableEngines(
  modelConfig: {
    engineValidModels?: Record<string, string[]>;
  } | null,
): string[] {
  const ev = modelConfig?.engineValidModels;
  if (!ev || typeof ev !== 'object') return [];
  return Object.keys(ev).filter(
    (engine) => !SKIP_ENGINES.has(engine) && (ev[engine]?.length ?? 0) > 0,
  );
}

export function hubModelsForEngine(
  modelConfig: { engineValidModels?: Record<string, string[]> } | null,
  engine: string,
): string[] {
  return modelConfig?.engineValidModels?.[engine] || [];
}

export function defaultHubModelForEngine(
  modelConfig: {
    engineValidModels?: Record<string, string[]>;
    engineDefaultModels?: Record<string, string>;
  } | null,
  engine: string,
): string {
  const models = hubModelsForEngine(modelConfig, engine);
  const configured = modelConfig?.engineDefaultModels?.[engine];
  if (configured && models.includes(configured)) return configured;
  return models[0] || '';
}

/**
 * Compact engine + model selects for Hub. The pick is per-user and applies
 * to Hub chat and Hub-level generation (Daily Summary).
 */
export default function HubModelPicker({
  modelConfig,
  engine,
  model,
  onEngineChange,
  onModelChange,
  disabled = false,
}: {
  modelConfig: {
    engineValidModels?: Record<string, string[]>;
    engineDefaultModels?: Record<string, string>;
  } | null;
  engine: string;
  model: string;
  onEngineChange: (engine: string) => void;
  onModelChange: (model: string) => void;
  disabled?: boolean;
}) {
  const engines = hubSelectableEngines(modelConfig);
  const models = hubModelsForEngine(modelConfig, engine);
  const safeEngine = engines.includes(engine) ? engine : engines[0] || '';
  const safeModel = models.includes(model) ? model : models[0] || '';

  return (
    <div className="flex items-center gap-1.5 shrink-0" data-testid="hub-model-picker">
      <label className="sr-only" htmlFor="hub-engine">
        Hub engine
      </label>
      <select
        id="hub-engine"
        data-testid="hub-engine-select"
        value={safeEngine}
        disabled={disabled || !engines.length}
        onChange={(e) => onEngineChange(e.target.value)}
        className="max-w-[8.5rem] bg-gray-900 border border-gray-800 rounded-md px-1.5 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-gray-600 disabled:opacity-50"
      >
        {engines.map((id) => (
          <option key={id} value={id}>
            {ENGINE_LABELS[id] || id}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="hub-model">
        Hub model
      </label>
      <select
        id="hub-model"
        data-testid="hub-model-select"
        value={safeModel}
        disabled={disabled || !models.length}
        onChange={(e) => onModelChange(e.target.value)}
        className="max-w-[9.5rem] bg-gray-900 border border-gray-800 rounded-md px-1.5 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-gray-600 disabled:opacity-50"
      >
        {models.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </div>
  );
}
