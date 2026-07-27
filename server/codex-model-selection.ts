import { detectCodexAuthMode, shouldPassModelFlag, type CodexAuthMode } from './codex-auth.js';
import { advertisedCapabilityModelsForHome, codexHomeFromEnv } from './codex-model-capability.js';

export interface CodexModelSelection {
  /** Whether the model should be forwarded as `--model`. */
  passModel: boolean;
  /** Auth mode detected in the same Codex home the child process will use. */
  authMode: CodexAuthMode;
  /** Codex home inspected for auth and model capability. */
  codexHome: string;
}

/**
 * Resolve the Codex model forwarding decision for a spawn environment.
 *
 * Codex auth and its models cache are both home-scoped. Keeping this decision
 * together prevents a per-user spawn from accidentally inspecting the server
 * process's `~/.codex` while the child reads a different `CODEX_HOME`.
 */
export function resolveCodexModelSelection(
  model: string | null | undefined,
  env: NodeJS.ProcessEnv,
  resolvedCodexHome?: string,
): CodexModelSelection {
  // Callers that already resolved the exact home used for a probe (for
  // example, the one-shot path's persistent host home) must win over HOME.
  // HOME is normally set in process.env, so treating this as a fallback would
  // silently discard the caller's resolved data-dir path.
  const codexHome = resolvedCodexHome?.trim() || codexHomeFromEnv(env);
  const authMode = detectCodexAuthMode(codexHome).mode;
  const capabilityModels = advertisedCapabilityModelsForHome(codexHome);

  return {
    passModel: shouldPassModelFlag(authMode, model, capabilityModels),
    authMode,
    codexHome,
  };
}
