// Muse Code (Meta) CLI integration: headless argv, model/effort resolution,
// auth-cache introspection, and `muse login` device-code banner parsing.
//
// Contract verified against muse 1.4.6 (`muse exec --help`, `muse login`):
//   muse exec --json --session-id <uuid> --prompt-file <path> [flags]
//     --json                 JSONL record stream on stdout (see normalizeMuse)
//     --session-id <uuid>    creates the session on first use, resumes it after
//     --prompt-file <path>   prompt from a file, so no argv size cap applies
//     --model <id>           muse-spark-* model id
//     --reasoning-effort <e> none|minimal|low|medium|high|xhigh|max|ultra
//     --yolo                 no approvals, no sandbox, trusted workspace
//     --disable-write / --disable-shell   drop the write and bash tools
//     --user-input-auto-resolve           never block on request_user_input
//   muse login               OAuth device code against auth.meta.com
//   Credentials: $XDG_CONFIG_HOME/muse/auth.json (default ~/.config/muse),
//   sessions under ~/.local/share/muse. META_API_KEY overrides both.
//
// Muse has no system-prompt flag (`instructions` / `developer_instructions`
// are rejected by `-c`), so the Hub rules ride the first turn's prompt file
// and the CLI's own session store carries them on resume, as with Codex.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { stripAnsi } from './ansi-strip.js';
import type { EngineAuthUiStatus } from './cursor-auth-parse.js';
import { normalizeCodexReasoningPreset } from './codex-reasoning.js';

export const MUSE_ENGINE = 'muse-code';

/** Selectable Muse models, newest first. Mirrors the web and mobile pickers. */
export const MUSE_MODELS = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'] as const;
export const MUSE_DEFAULT_MODEL = 'muse-spark-1.3';

/**
 * Model to pass as `--model`, or null to let the CLI pick its default. A
 * stale or unknown id on an old session falls back to the configured default
 * instead of failing the turn on Meta's side.
 */
export function resolveMuseSpawnModel(
  model: string | null | undefined,
  cfg: {
    engineValidModels?: Record<string, string[]>;
    engineDefaultModels?: Record<string, string>;
  },
): string | null {
  const allowed = cfg.engineValidModels?.[MUSE_ENGINE] ?? [...MUSE_MODELS];
  const requested = model?.trim();
  if (requested && allowed.includes(requested)) return requested;
  const fallback = cfg.engineDefaultModels?.[MUSE_ENGINE]?.trim();
  if (fallback && allowed.includes(fallback)) return fallback;
  return allowed[0] ?? null;
}

/**
 * Map the session's reasoning preset onto Muse's effort scale. Shares the
 * Codex preset vocabulary (`high` default, `pro` for maximum thinking).
 */
export function resolveMuseReasoningEffort(preset: string | null | undefined): 'high' | 'xhigh' {
  return normalizeCodexReasoningPreset(preset) === 'pro' ? 'xhigh' : 'high';
}

export interface MuseExecArgsInput {
  /** Muse session UUID. The same id creates the session and resumes it. */
  museSessionId: string;
  /** File holding this turn's prompt. */
  promptFile: string;
  model: string | null;
  reasoningPreset?: string | null;
  /** Ask Mode: read-only tools, no shell, no writes. */
  askMode: boolean;
}

export function buildMuseExecArgs(input: MuseExecArgsInput): string[] {
  const args = [
    'exec',
    '--json',
    '--session-id',
    input.museSessionId,
    '--prompt-file',
    input.promptFile,
    '--reasoning-effort',
    resolveMuseReasoningEffort(input.reasoningPreset),
    '--user-input-auto-resolve',
  ];
  if (input.model) args.push('--model', input.model);
  if (input.askMode) {
    // Trust the workspace so its skills and rules still load, but remove the
    // tools that can change anything.
    args.push('--trust-workspace', '--disable-write', '--disable-shell');
  } else {
    // Agent Hub runs every engine with approvals bypassed outside Ask Mode.
    // Muse's sandbox also needs bwrap, which container hosts usually lack.
    args.push('--yolo');
  }
  return args;
}

/** Env vars a Muse spawn must not inherit from the server process. */
export const MUSE_STRIPPED_ENV = [
  // Takes priority over the per-user login, so a host value would run every
  // user's session on the operator's Meta account.
  'META_API_KEY',
  // Muse resolves its credential and session stores from these. The per-user
  // HOME pin only isolates users when they are unset.
  'MUSE_AUTH_PATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;

/** Apply Muse's spawn-env rules in place. */
export function applyMuseSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of MUSE_STRIPPED_ENV) delete env[key];
  // The install script's launcher self-updates hourly; a pinned server
  // install must not change under a running session.
  env.MUSE_NO_AUTO_UPDATE = '1';
  return env;
}

export type MuseAuthMode = 'oauth' | 'apikey' | 'unknown';

export interface MuseAuthInfo {
  mode: MuseAuthMode;
  /** Absolute path inspected. */
  path: string;
  /** True when auth.json existed and parsed. */
  present: boolean;
}

export function museAuthJsonPath(home: string): string {
  return path.join(home, '.config', 'muse', 'auth.json');
}

/**
 * Read `<home>/.config/muse/auth.json` and report what credential it holds.
 * Never throws. Shapes written by muse 1.4.6:
 *   { providers: { meta: { mechanism: 'oauth', access_token, expires_at, ... } } }
 *   { providers: { meta: { api_key } } }
 */
export function detectMuseAuthMode(home: string): MuseAuthInfo {
  const file = museAuthJsonPath(home);
  if (!existsSync(file)) return { mode: 'unknown', path: file, present: false };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const providers = asRecord(parsed.providers);
    const meta = asRecord(providers?.meta);
    if (!meta) return { mode: 'unknown', path: file, present: true };
    if (nonEmptyString(meta.access_token) || nonEmptyString(meta.refresh_token)) {
      return { mode: 'oauth', path: file, present: true };
    }
    if (nonEmptyString(meta.api_key)) return { mode: 'apikey', path: file, present: true };
    return { mode: 'unknown', path: file, present: true };
  } catch {
    return { mode: 'unknown', path: file, present: false };
  }
}

/** True when `home` holds a usable Muse credential. */
export function homeHasMuseCredential(home: string): boolean {
  const info = detectMuseAuthMode(home);
  return info.present && (info.mode === 'oauth' || info.mode === 'apikey');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** `meta.com` / `meta.ai` apex or subdomain, compared on the parsed hostname. */
function isMetaAuthHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'meta.com' || h.endsWith('.meta.com') || h === 'meta.ai' || h.endsWith('.meta.ai');
}

/**
 * Verification URL from `muse login` output, e.g.
 *   Open this page to sign in:
 *     https://auth.meta.com/oauth/device/?code=ABCD-EFGH
 * Only Meta-hosted https URLs are returned, so a look-alike host can never
 * reach the browser. Null until the banner has arrived.
 */
export function extractMuseDeviceUrl(text: string): string | null {
  const candidates = stripAnsi(text).match(/https:\/\/[^\s)\]]+/gi);
  if (!candidates) return null;
  for (const raw of candidates) {
    const cleaned = raw.replace(/[.,;:]+$/, '');
    try {
      const url = new URL(cleaned);
      if (url.protocol === 'https:' && isMetaAuthHost(url.hostname)) return cleaned;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/**
 * Device code the user confirms on the verification page. Muse prints it on
 * its own line under "Confirm this code matches:" (or "Enter this code:").
 */
export function extractMuseDeviceUserCode(text: string): string | null {
  const plain = stripAnsi(text);
  const labeled = plain.match(/code[^\n]*:\s*\n?\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/i);
  if (labeled) return labeled[1].toUpperCase();
  const fromUrl = plain.match(/[?&]code=([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/i);
  return fromUrl ? fromUrl[1].toUpperCase() : null;
}

export function computeMuseUiStatus(p: {
  binaryPresent: boolean;
  loginInProgress: boolean;
  credentialPresent: boolean;
}): EngineAuthUiStatus {
  if (!p.binaryPresent) return 'missing';
  if (p.loginInProgress) return 'pending';
  return p.credentialPresent ? 'authenticated' : 'missing';
}
