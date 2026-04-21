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
];

export const ENGINE_MODELS = {
  'claude-code': [
    { id: 'claude-opus-4-7', label: 'Opus 4.7', short: 'Opus' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', short: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet', short: 'Sonnet' },
  ],
  'cursor-agent': [{ id: 'composer-2', label: 'Composer 2', short: 'Composer 2' }],
  'codex-cli': [
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', short: '5.2 Codex' },
    { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', short: '5.1 Max' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', short: '5 Codex' },
    { id: 'gpt-5', label: 'GPT-5', short: 'GPT-5' },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', short: 'Mini' },
  ],
};

export const ENGINE_DEFAULT_MODELS = {
  'claude-code': 'claude-opus-4-7',
  'cursor-agent': 'composer-2',
  'codex-cli': 'gpt-5.2-codex',
};
