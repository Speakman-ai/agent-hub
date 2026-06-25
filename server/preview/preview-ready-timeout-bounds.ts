/**
 * Single source of truth for the compose-preview health-check ("ready")
 * timeout bounds. Both the global config clamp (`server/config.ts`,
 * `previewComposeReadyTimeoutMs` / `AGENT_HUB_PREVIEW_READY_TIMEOUT_MS`) and
 * the per-project validation (`server/routes/projects.ts`,
 * `prEnv.preview.compose.readyTimeoutMs`) import these so the two layers can
 * never drift.
 *
 * The ceiling exists so a genuinely-hung first boot eventually surfaces a
 * `preview_failed` instead of pinning a session forever. It was raised from
 * 30 min to 60 min once real previews (e.g. restoring a multi-GB production
 * `pg_dump` and then doing a cold frontend compile) were observed to need
 * more than half an hour on a constrained box. The default stays at 10 min —
 * raising the ceiling only widens the opt-in range, it does not change what a
 * project that sets nothing gets.
 */

/** Floor: a few seconds, enough to be a meaningful health window. */
export const PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS = 5_000;

/** Ceiling: 60 minutes — covers a multi-GB DB restore + cold first compile. */
export const PREVIEW_COMPOSE_READY_TIMEOUT_MAX_MS = 3_600_000;

/** Default when neither the global config nor a per-project override is set. */
export const DEFAULT_PREVIEW_COMPOSE_READY_TIMEOUT_MS = 600_000; // 10 min
