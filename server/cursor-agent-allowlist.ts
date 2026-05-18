/**
 * Model IDs Agent Hub passes to the Cursor CLI (`agent --model`) for
 * `engine === "cursor-agent"`. Keep aligned with `buildAuthenticatedModelConfig`
 * and the web/mobile model pickers.
 */
export const CURSOR_AGENT_HUB_MODEL_ALLOWLIST = ['composer-2.5'] as const;
