// Shared engine-picker constants for the mobile app.
//
// Lives in utils/ (not inside a component) so the invariants — which engines
// are exposed, which models each engine allows, and what the default model is
// per engine — can be asserted by plain Vitest tests without needing a React
// Native renderer. TopBar.js and AppContext.js both import from here so the
// UI and the engine-change handler stay in sync automatically.
export const ENGINE_OPTIONS = [
    { id: 'claude-code', label: 'Claude Code', color: '#8B5CF6' },
    { id: 'cursor-agent', label: 'Cursor Agent', color: '#10B981' },
    { id: 'codex-cli', label: 'Codex', color: '#10A37F' },
    { id: 'grok-cli', label: 'Grok', color: '#1D9BF0' },
];
export const ENGINE_MODELS: Record<string, any> = {
    'claude-code': [
        { id: 'claude-fable-5', label: 'Fable 5', short: 'Fable' },
        { id: 'claude-opus-4-8', label: 'Opus 4.8', short: 'Opus' },
        { id: 'claude-opus-4-7', label: 'Opus 4.7', short: 'Opus 4.7' },
        { id: 'claude-opus-4-6', label: 'Opus 4.6', short: 'Opus 4.6' },
        { id: 'claude-sonnet-5', label: 'Sonnet', short: 'Sonnet' },
    ],
    'cursor-agent': [{ id: 'composer-2.5', label: 'Composer 2.5', short: 'Composer 2.5' }],
    // Codex — only models accepted under ChatGPT OAuth. Older IDs (gpt-5,
    // gpt-5-mini, gpt-5-codex, gpt-5.2-codex, gpt-5.1-codex-max) are rejected
    // with HTTP 400 by the ChatGPT backend. Keep in sync with server/config.ts
    // and client/src/components/TopBar.jsx.
    'codex-cli': [
        { id: 'gpt-5.6', label: 'GPT-5.6', short: '5.6' },
        { id: 'gpt-5.5', label: 'GPT-5.5', short: '5.5' },
        { id: 'gpt-5.4', label: 'GPT-5.4', short: '5.4' },
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', short: '5.4 Mini' },
        { id: 'gpt-5.2', label: 'GPT-5.2', short: '5.2' },
    ],
    // Grok Build CLI — xAI. Keep in sync with server/config.ts and
    // client/src/components/TopBar.jsx.
    'grok-cli': [
        { id: 'grok-composer-2.5-fast', label: 'Composer 2.5 Fast', short: 'Composer' },
        { id: 'grok-build', label: 'Grok Build', short: 'Build' },
    ],
};
export const ENGINE_DEFAULT_MODELS: Record<string, any> = {
    'claude-code': 'claude-opus-4-8',
    'cursor-agent': 'composer-2.5',
    'codex-cli': 'gpt-5.6',
    'grok-cli': 'grok-composer-2.5-fast',
};
// Display labels for models that are no longer selectable but may still appear
// on historical sessions/crons. Kept OUT of ENGINE_MODELS so the picker never
// offers a retired model (the server allowlist rejects it), while modelDisplay
// still renders a clean label instead of a title-cased id. Mirrors the web
// client's split between MODEL_LABELS (display) and fallbackModelsForEngine
// (selectable) in client/src/components/TopBar.tsx.
export const HISTORICAL_MODEL_LABELS: Record<string, { label: string; short: string }> = {
    'claude-sonnet-4-6': { label: 'Sonnet 4.6', short: 'Sonnet 4.6' },
};
export function modelDisplay(id: any) {
    const known = Object.values(ENGINE_MODELS)
        .flat()
        .find((m: any) => m.id === id);
    if (known)
        return known;
    const historical = HISTORICAL_MODEL_LABELS[id];
    if (historical)
        return { id, ...historical };
    const label = String(id || '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c: any) => c.toUpperCase());
    return { id, label: label || 'Unknown model', short: label || 'Unknown' };
}
export function engineOptionsFromConfig(modelConfig: any) {
    if (!modelConfig?.engineValidModels)
        return ENGINE_OPTIONS;
    const filtered = ENGINE_OPTIONS.filter((opt: any) => (modelConfig.engineValidModels[opt.id]?.length ?? 0) > 0);
    return filtered.length > 0 ? filtered : ENGINE_OPTIONS;
}
export function modelsForEngine(engine: any, modelConfig: any) {
    const ids = modelConfig?.engineValidModels?.[engine];
    if (Array.isArray(ids))
        return ids.map((id: any) => modelDisplay(id));
    return (ENGINE_MODELS[engine] || ENGINE_MODELS['claude-code']).map((m: any) => ({ ...m }));
}
