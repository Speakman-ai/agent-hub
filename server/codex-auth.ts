// Codex CLI auth introspection.
//
// The Codex CLI stores credentials + auth mode in `~/.codex/auth.json`:
//
//   {
//     "auth_mode": "chatgpt" | "apikey",
//     "OPENAI_API_KEY": "sk-..." | null,
//     "tokens": { "access_token": "...", ... } | null,
//     "last_refresh": "..."
//   }
//
// We need to know the mode at session spawn time because the ChatGPT backend
// rejects most `--model <id>` arguments with HTTP 400 ("The '<model>' model
// is not supported when using Codex with a ChatGPT account."), whereas the
// API-key backend accepts the full public model list. When the caller has a
// stale / unsupported model persisted on an old session, we drop the flag
// and let Codex fall back to its built-in default for the active auth mode.
//
// This file is read-only with respect to Codex — we never modify auth.json.
// Reads are wrapped in try/catch so a missing or malformed file doesn't
// crash the server; callers get `null` and can choose to pass --model
// through unchanged (preserves prior behavior).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type CodexAuthMode = 'chatgpt' | 'apikey' | 'unknown';

export interface CodexAuthInfo {
  mode: CodexAuthMode;
  /** Absolute path inspected. Useful for log lines when something is off. */
  path: string;
  /** True if auth.json existed and was parsed. */
  present: boolean;
}

/**
 * Models empirically accepted under `auth_mode: chatgpt` on codex-cli 0.122.
 * Keep in sync with server/config.ts → engineValidModels['codex-cli']. Any
 * model outside this set will be stripped from `--model` to let Codex fall
 * back to its ChatGPT default. API-key mode is permissive and we don't
 * filter there.
 */
export const CODEX_CHATGPT_ALLOWED_MODELS: readonly string[] = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
];

/**
 * Read ~/.codex/auth.json and report the active auth mode. Never throws —
 * missing/unreadable/malformed files collapse to `unknown`.
 *
 * **Profile awareness.** The reading is intentionally NOT profile-scoped.
 * `codex exec --profile <name>` selects a named entry from
 * `$CODEX_HOME/config.toml` that overrides model / provider / sandbox /
 * approval policy — none of which touch auth mode. The auth_mode (chatgpt
 * vs. apikey) is global to the codex install and lives in `auth.json`, set
 * once by the device-login flow or by exporting OPENAI_API_KEY. So a
 * non-default profile does NOT need to be threaded here; the active
 * `auth.json` is correct regardless of which profile is active. Revisit
 * only if a future codex release moves credentials into profile-scoped
 * files.
 */
export function detectCodexAuthMode(codexHome?: string): CodexAuthInfo {
  const root = codexHome ?? join(homedir(), '.codex');
  const path = join(root, 'auth.json');
  if (!existsSync(path)) {
    return { mode: 'unknown', path, present: false };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { auth_mode?: unknown };
    if (parsed.auth_mode === 'chatgpt') return { mode: 'chatgpt', path, present: true };
    if (parsed.auth_mode === 'apikey') return { mode: 'apikey', path, present: true };
    return { mode: 'unknown', path, present: true };
  } catch {
    return { mode: 'unknown', path, present: false };
  }
}

/**
 * Decide whether `--model <id>` should be passed to `codex exec`. Under
 * ChatGPT OAuth, only the curated allowlist is safe; everything else gets
 * rejected with HTTP 400 by the ChatGPT backend. Under apikey/unknown, we
 * pass the model through so existing/legacy configurations keep working.
 */
export function shouldPassModelFlag(
  mode: CodexAuthMode,
  model: string | null | undefined,
): boolean {
  if (!model) return false;
  if (mode !== 'chatgpt') return true;
  return CODEX_CHATGPT_ALLOWED_MODELS.includes(model);
}
