/**
 * Model IDs Agent Hub passes to the Cursor CLI (`agent --model`) for
 * `engine === "cursor-agent"`. Keep aligned with `buildAuthenticatedModelConfig`
 * and the web/mobile model pickers. These are the slugs reported by
 * `cursor-agent --list-models`.
 */
export const CURSOR_AGENT_HUB_MODEL_ALLOWLIST = ['composer-2.5', 'cursor-grok-4.5-high'] as const;
