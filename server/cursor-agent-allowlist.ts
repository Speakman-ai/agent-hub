/**
 * Model IDs Agent Hub passes to the Cursor CLI (`agent --model`) for
 * `engine === "cursor-agent"`. Keep aligned with `buildAuthenticatedModelConfig`
 * and the web/mobile model pickers. These are the slugs reported by
 * `cursor-agent --list-models`.
 */
export const CURSOR_AGENT_HUB_MODEL_ALLOWLIST = [
  // Cursor Grok 4.6 (shipped 2026-08-07, xAI's successor to 4.5 — 4 effort
  // levels with `high` the default, hence the `-high` slug suffix). Listed
  // first so it is both the Hub default and the top of every picker.
  'cursor-grok-4.6-high',
  'composer-2.5',
  'cursor-grok-4.5-high',
] as const;
