/**
 * Codex reasoning-effort presets.
 *
 * The Codex CLI (`codex exec`) has no dedicated reasoning flag; the thinking
 * level is set through the generic config override
 * `-c model_reasoning_effort=<level>` (verified against codex-cli 0.140.0,
 * which echoes `reasoning effort: <level>` in its session banner and accepts
 * the key under `--strict-config`). The native effort scale is
 * none / low / medium / high / xhigh.
 *
 * Agent Hub exposes a two-option, user-facing control rather than the raw
 * scale:
 *   - `high` (default) → model_reasoning_effort=high
 *   - `pro`            → model_reasoning_effort=xhigh  (max thinking, same model)
 *
 * Both presets run the selected Codex model. "Pro" only turns the reasoning
 * effort up, it does not switch models.
 */

export const CODEX_REASONING_PRESETS = ['high', 'pro'] as const;
export type CodexReasoningPreset = (typeof CODEX_REASONING_PRESETS)[number];

/** Default preset when a session has no explicit choice (NULL column / new row). */
export const DEFAULT_CODEX_REASONING_PRESET: CodexReasoningPreset = 'high';

/** Native Codex `model_reasoning_effort` value each preset maps to. */
export type CodexReasoningEffort = 'high' | 'xhigh';

const PRESET_TO_EFFORT: Record<CodexReasoningPreset, CodexReasoningEffort> = {
  high: 'high',
  pro: 'xhigh',
};

/**
 * Coerce an arbitrary stored/requested value to a valid preset, falling back
 * to the default for null/unknown input. Keeps the rest of the codebase from
 * having to repeat the validation.
 */
export function normalizeCodexReasoningPreset(
  value: string | null | undefined,
): CodexReasoningPreset {
  return (CODEX_REASONING_PRESETS as readonly string[]).includes(value ?? '')
    ? (value as CodexReasoningPreset)
    : DEFAULT_CODEX_REASONING_PRESET;
}

/** Resolve a preset (or null) to the native Codex effort level. */
export function resolveCodexReasoningEffort(
  preset: string | null | undefined,
): CodexReasoningEffort {
  return PRESET_TO_EFFORT[normalizeCodexReasoningPreset(preset)];
}

/**
 * Build the `-c model_reasoning_effort=<level>` argv pair to append to a
 * `codex exec` invocation. Always returns a two-element array so callers can
 * spread it unconditionally — every Codex spawn gets an explicit effort
 * (default `high`) rather than relying on Codex's built-in default.
 */
export function codexReasoningArgs(preset: string | null | undefined): string[] {
  return ['-c', `model_reasoning_effort=${resolveCodexReasoningEffort(preset)}`];
}
