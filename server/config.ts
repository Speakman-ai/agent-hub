import { readFileSync, copyFileSync, cpSync, existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppConfig } from './types.js';
import { CURSOR_AGENT_HUB_MODEL_ALLOWLIST } from './cursor-agent-allowlist.js';
import { resolveSpawnPath, refreshShellPath, getCachedShellPath } from './shell-path.js';
import { getActualPort } from './server-port.js';
import { ensurePerUserHome } from './per-user-home.js';
import { ensureHostCliHome } from './host-cli-home.js';
import {
  hasPopulatedCodexDeviceAuth,
  perUserCodexHomePath,
} from './per-user-codex-device-login.js';
import { readSpawnCredsFile } from './spawn-creds-file.js';
import { ensureSpawnCredsForSession } from './spawn-creds-mint.js';

export { refreshShellPath, getCachedShellPath };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// ─── Data directory ─────────────────────────────────────────────
const DEFAULT_DATA_DIR = path.join(HOME, '.agent-hub', 'data');
const DATA_DIR = process.env.AGENT_HUB_DATA_DIR || DEFAULT_DATA_DIR;

// Hard safety rail: refuse to boot in test mode pointing at the production
// data dir. This caught us once already — `server/designs-store.test.ts`'s
// bulk-wipe beforeEach deleted production design rows because
// AGENT_HUB_DATA_DIR was being set inside setup.ts instead of vitest.config.ts
// `test.env`, leaving a window where config.ts loaded with the default path.
// See PR adding `feature/designs-wipe-guard`.
if (process.env.AGENT_HUB_TEST_MODE === '1' && DATA_DIR === DEFAULT_DATA_DIR) {
  throw new Error(
    `[config] AGENT_HUB_TEST_MODE=1 but AGENT_HUB_DATA_DIR resolves to the production default (${DEFAULT_DATA_DIR}). ` +
      'Refusing to initialize — set AGENT_HUB_DATA_DIR to a tmp path in vitest.config.ts test.env.',
  );
}

mkdirSync(DATA_DIR, { recursive: true });

// ─── Load optional config.json ───────────────────────────────────
export const CONFIG_PATH: string = path.join(DATA_DIR, 'config.json');
const LEGACY_CONFIG_PATH: string = path.join(__dirname, 'config.json');

if (!existsSync(CONFIG_PATH) && existsSync(LEGACY_CONFIG_PATH)) {
  try {
    copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    console.log(`[config] Migrated config.json → ${CONFIG_PATH}`);
  } catch {
    // Non-fatal — we'll still read from the legacy path below.
  }
}

export let fileConfig: Record<string, unknown> = {};
try {
  fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
} catch {
  try {
    fileConfig = JSON.parse(readFileSync(LEGACY_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    // No config.json anywhere — defaults will be used.
  }
}

/** Strip legacy Cursor-IDE / Codex IDs from cursor-agent — Hub only spawns composer-2.5. */
function normalizeCursorAgentEngineModels(map: Record<string, string[]>): Record<string, string[]> {
  const next = { ...map };
  const hub = new Set<string>(CURSOR_AGENT_HUB_MODEL_ALLOWLIST);
  const cur = next['cursor-agent'];
  if (!Array.isArray(cur) || cur.length === 0) {
    next['cursor-agent'] = [...CURSOR_AGENT_HUB_MODEL_ALLOWLIST];
    return next;
  }
  const filtered = cur.filter((id) => hub.has(id));
  next['cursor-agent'] = filtered.length > 0 ? filtered : [...CURSOR_AGENT_HUB_MODEL_ALLOWLIST];
  return next;
}

function resolve(
  envKey: string | null,
  fileKey: string | null,
  fallback: string | null,
): string | null {
  if (envKey && process.env[envKey] !== undefined) return process.env[envKey]!;
  if (fileKey && fileConfig[fileKey] !== undefined) return fileConfig[fileKey] as string;
  return fallback;
}

function resolveInt(envKey: string | null, fileKey: string | null, fallback: number): number {
  const val = resolve(envKey, fileKey, String(fallback));
  const n = parseInt(val as string, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Parse `raw` when numeric; clamp into `[lo, hi]` (fallback when non-finite). */
function clampFiniteInt(raw: unknown, fallback: number, lo: number, hi: number): number {
  let n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : Math.trunc(fallback);
  if (!Number.isFinite(n)) n = Math.trunc(fallback);
  return Math.min(Math.max(n, lo), hi);
}

function envMeansTrue(key: keyof NodeJS.ProcessEnv): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envMeansFalse(key: keyof NodeJS.ProcessEnv): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/**
 * Booleans in config.json — accept strict `true`/`false` plus common string forms
 * when configs are generated or hand-edited inconsistently.
 */
export function coerceConfigBooleanLoose(raw: unknown, defaultValue: boolean): boolean {
  if (raw === true) return true;
  if (raw === false || raw === null) return false;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === '') return false;
  }
  return defaultValue;
}

// ─── Auto-migrate legacy projects directory ─────────────────────
const DEFAULT_PROJECTS_DIR = path.join(HOME, '.agent-hub', 'projects');
const LEGACY_PROJECTS_DIR = path.join(HOME, '.openclaw', 'projects');

if (!existsSync(DEFAULT_PROJECTS_DIR) && existsSync(LEGACY_PROJECTS_DIR)) {
  try {
    cpSync(LEGACY_PROJECTS_DIR, DEFAULT_PROJECTS_DIR, { recursive: true });
    console.log(`[config] Migrated projects dir → ${DEFAULT_PROJECTS_DIR}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[config] Failed to migrate projects dir: ${message}`);
  }
}

// ─── Exported config object ──────────────────────────────────────

const DEFAULT_ENGINE_VALID_MODELS: Record<string, string[]> = {
  // claude-fable-5: Anthropic's flagship generally-available Mythos-class model
  // (API id `claude-fable-5`, released 2026-06-09). Listed first as the most
  // capable Claude Code option. Keep in sync with client TopBar.jsx MODEL_LABELS,
  // shared systemBannerModel.js MODEL_KNOWN_LABELS, and mobile engineOptions.js.
  'claude-code': [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-6',
  ],
  // cursor-agent: only IDs the Hub passes through to `agent --model` (see
  // CURSOR_AGENT_HUB_MODEL_ALLOWLIST). Codex/GPT variants belong on codex-cli.
  'cursor-agent': [...CURSOR_AGENT_HUB_MODEL_ALLOWLIST],
  // Gemini model IDs per https://geminicli.com/docs/cli/cli-reference (--model flag).
  // `auto` lets the CLI pick; other IDs are the first-party Google models the CLI
  // currently accepts. We only list stable IDs — experimental/preview aliases are
  // left out of the allowlist so sessions don't stream with an unsupported name.
  'gemini-cli': ['auto', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  // Codex model IDs per https://developers.openai.com/codex/models.
  // IMPORTANT: the list below is the intersection of models accepted under
  // BOTH auth modes (ChatGPT OAuth and API-key). Under ChatGPT OAuth the
  // codex backend rejects older/API-only IDs with:
  //   "The '<model>' model is not supported when using Codex with a
  //   ChatGPT account." (HTTP 400, surfaced as a `turn.failed` JSONL event).
  // Empirically the following fail under ChatGPT:
  //   gpt-5, gpt-5-mini, gpt-5-codex, gpt-5.2-codex, gpt-5.1-codex-max,
  //   gpt-5.3-codex-spark (Pro-only research preview), and — as of June 2026 —
  //   gpt-5.3-codex itself (no longer accepted under ChatGPT OAuth; removed
  //   from the selectable list, though its display label is retained for
  //   historical sessions in TopBar.jsx / systemBannerModel.js).
  // These currently succeed under ChatGPT OAuth and are the only IDs we
  // allow the UI to select. Keep in sync with client/src/components/TopBar.jsx
  // and mobile/src/utils/engineOptions.js. Runtime guard in chat.ts will
  // drop --model when an unsupported/stale ID is still persisted on a
  // session (so resumes from old DBs don't spin forever).
  'codex-cli': ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'],
  // Grok Build CLI model slug per xAI docs (https://docs.x.ai/build/cli).
  // The headless CLI model id aligns with the Responses API early-access slug
  // `grok-build-0.1` (replaces the retired grok-code-fast-1). Keep in sync with
  // client TopBar.jsx and mobile engineOptions.js.
  'grok-cli': ['grok-build-0.1'],
};

const mergedEngineValidModelsRaw =
  (fileConfig.engineValidModels as Record<string, string[]>) || DEFAULT_ENGINE_VALID_MODELS;
const mergedEngineValidModels = normalizeCursorAgentEngineModels(mergedEngineValidModelsRaw);

const DEFAULT_ENGINE_DEFAULT_MODELS: Record<string, string> = {
  'claude-code': 'claude-opus-4-8',
  'cursor-agent': 'composer-2.5',
  'gemini-cli': 'gemini-2.5-pro',
  // Codex: default is gpt-5.5, OpenAI's recommended frontier model and the
  // strongest general coding model, accepted under BOTH auth modes (ChatGPT
  // OAuth and API-key). The prior default gpt-5.3-codex is no longer accepted
  // under ChatGPT OAuth and was removed from the selectable list. Older IDs
  // like gpt-5.2-codex / gpt-5-codex / gpt-5.1-codex-max get rejected with
  // HTTP 400 under ChatGPT OAuth — see diagnosis in AGENTS' kanban card
  // "Codex not working (round 2)".
  'codex-cli': 'gpt-5.5',
  'grok-cli': 'grok-build-0.1',
};

const mergedEngineDefaultModelsRaw =
  (fileConfig.engineDefaultModels as Record<string, string>) || DEFAULT_ENGINE_DEFAULT_MODELS;
const mergedEngineDefaultModels = { ...mergedEngineDefaultModelsRaw };

/**
 * Common install directories used as the last-resort search list when a binary
 * is not on $PATH. Covers the typical landing spots for per-user installers
 * (pip/npm/bun), Homebrew (Apple Silicon and Intel), and legacy /usr/local.
 */
const COMMON_BIN_DIRS: string[] = [
  path.join(HOME, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(HOME, '.bun', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
];

/**
 * Walk `dirs` in order and return the first `path.join(dir, name)` that exists
 * on disk. Exported for unit tests.
 */
export function findBinaryInDirs(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a CLI binary path with auto-detection.
 *
 * Priority:
 *   1. Environment variable (`envKey`) if set and the path exists
 *   2. `config.json` value (`fileKey`) if set and the path exists
 *   3. PATH walk — every dir in the merged spawn PATH (login-shell + process)
 *   4. Common install directories (~/.local/bin, /opt/homebrew/bin, etc.)
 *   5. `staticFallback` — the historical default; what we hand back even if
 *      nothing exists, so downstream code surfaces a meaningful "not found"
 *      error instead of an empty string.
 *
 * A configured-but-missing env/config value emits a warning and continues with
 * the search instead of returning the broken path. This is important on fresh
 * machines where the user's existing config.json points at a path that no
 * longer exists (e.g. /usr/local/bin/claude vs the new ~/.local/bin/claude).
 *
 * Exported for unit tests (the production call sites are all in this file).
 */
export function pickBin(
  binaryName: string,
  envKey: string,
  fileKey: string,
  staticFallback: string,
): string {
  const envBin = process.env[envKey]?.trim();
  const rawFileBin = fileConfig[fileKey];
  const fileBin = typeof rawFileBin === 'string' ? rawFileBin.trim() : '';
  const candidate = envBin || fileBin || '';
  if (candidate && existsSync(candidate)) return candidate;
  if (candidate) {
    console.warn(
      `[config] ${fileKey} "${candidate}" not found — searching PATH and common dirs for "${binaryName}"`,
    );
  }
  // PATH walk — covers anything reachable via the merged spawn PATH, which
  // already includes the login-shell PATH (so newly installed CLIs like a
  // freshly `npm i -g @google/gemini-cli` are visible without a server
  // restart, modulo the shell-path cache).
  const pathDirs = resolveSpawnPath(process.env.PATH).split(path.delimiter);
  const onPath = findBinaryInDirs(binaryName, pathDirs);
  if (onPath) return onPath;
  // Common install dirs — last-ditch probe in case PATH is unusually sparse
  // (minimal Docker images, systemd units with empty PATH, etc.).
  const onCommon = findBinaryInDirs(binaryName, COMMON_BIN_DIRS);
  if (onCommon) return onCommon;
  return staticFallback;
}
const cursorAllowed = mergedEngineValidModels['cursor-agent'] || [];
if (!cursorAllowed.includes(mergedEngineDefaultModels['cursor-agent'])) {
  mergedEngineDefaultModels['cursor-agent'] = cursorAllowed[0] || 'composer-2.5';
}

const config: AppConfig = {
  // ── Server ─────────────────────────────────────────────────────
  port: resolveInt('AGENT_HUB_PORT', 'port', 3051),
  host: resolve('AGENT_HUB_HOST', 'host', '0.0.0.0') as string,

  // ── CLI binary paths ───────────────────────────────────────────
  // All four engines auto-detect via `pickBin`: env override → config.json →
  // PATH walk → common install dirs → static fallback. The static fallbacks
  // below match the historical defaults so existing config.json files keep
  // working unchanged.
  //
  // cursorBin uses the binary name "agent" (not "cursor") because Cursor's
  // official per-user installer (https://cursor.com/install) drops a symlink
  // at $HOME/.local/bin/agent. The static fallback also tracks that path so
  // a fresh box with just the installer run works out of the box — no sudo
  // symlink into /usr/local/bin required.
  claudeBin: pickBin(
    'claude',
    'CLAUDE_BIN',
    'claudeBin',
    path.join(HOME, '.local', 'bin', 'claude'),
  ),
  cursorBin: pickBin('agent', 'CURSOR_BIN', 'cursorBin', path.join(HOME, '.local', 'bin', 'agent')),
  geminiBin: pickBin('gemini', 'GEMINI_BIN', 'geminiBin', '/usr/local/bin/gemini'),
  codexBin: pickBin('codex', 'CODEX_BIN', 'codexBin', '/usr/local/bin/codex'),
  grokBin: pickBin('grok', 'GROK_BIN', 'grokBin', path.join(HOME, '.local', 'bin', 'grok')),

  // ── Directories ────────────────────────────────────────────────
  defaultCwd: resolve('AGENT_HUB_DEFAULT_CWD', 'defaultCwd', HOME) as string,
  dataDir: resolve('AGENT_HUB_DATA_DIR', 'dataDir', DEFAULT_DATA_DIR) as string,
  projectsDir: resolve(
    'AGENT_HUB_PROJECTS_DIR',
    'projectsDir',
    path.join(HOME, '.agent-hub', 'projects'),
  ) as string,

  // ── Models ─────────────────────────────────────────────────────
  defaultModel: resolve(null, 'defaultModel', 'claude-opus-4-8') as string,

  engineDefaultModels: mergedEngineDefaultModels,

  engineValidModels: mergedEngineValidModels,

  // ── Timeouts ───────────────────────────────────────────────────
  defaultTimeoutMs: resolveInt(null, 'defaultTimeoutMs', 15 * 60 * 1000),
  docsTimeoutMs: resolveInt(null, 'docsTimeoutMs', 10 * 60 * 1000),
  slackTimeoutMs: resolveInt(null, 'slackTimeoutMs', 5 * 60 * 1000),
  conferenceTimeoutMs: resolveInt(null, 'conferenceTimeoutMs', 10 * 60 * 1000),
  // Webhook-dispatched Claude runs default to a longer ceiling than other
  // call sites because review/CI handlers often run a full PR analysis
  // (gh pr view + diff fetch + multi-file reasoning) that legitimately
  // exceeds defaultTimeoutMs. Override per-event via webhookEventTimeoutMs.
  webhookTimeoutMs: resolveInt(null, 'webhookTimeoutMs', 20 * 60 * 1000),
  webhookEventTimeoutMs: (fileConfig.webhookEventTimeoutMs as
    | Record<string, number>
    | undefined) ?? {
    // Review handlers run the full PR review prompt (gh diff + analysis).
    // 20 min covers the median; the worker will still kill at this bound.
    'pull_request_review.submitted': 20 * 60 * 1000,
  },
  // Compose preview health poll — how long `PreviewComposeRuntime` waits for
  // 2xx on the entry service before marking the group failed. Override via
  // `AGENT_HUB_PREVIEW_READY_TIMEOUT_MS` or `previewComposeReadyTimeoutMs`
  // in config.json. Per-project override: `prEnv.preview.compose.readyTimeoutMs`.
  previewComposeReadyTimeoutMs: clampFiniteInt(
    resolveInt('AGENT_HUB_PREVIEW_READY_TIMEOUT_MS', 'previewComposeReadyTimeoutMs', 600_000),
    600_000,
    5_000,
    1_800_000,
  ),

  // Wildcard subdomain base for "subdomain preview" mode. When set
  // (e.g. `preview.agenthub.dev.surveytracker.io`), the request
  // dispatcher accepts `<sessionId>.<base>` hostnames and rewrites
  // them to the same path-prefix proxy mount, letting apps render at
  // their default base of `/` with zero per-app config. Unset =
  // subdomain mode OFF; only the path-prefix proxy is active. Requires
  // a wildcard ACM cert + Route 53 alias + ALB listener cert
  // attachment in the operator's stack; see the session-previews RFC.
  previewSubdomainBase: resolve('AGENT_HUB_PREVIEW_SUBDOMAIN_BASE', 'previewSubdomainBase', null),

  // ── GitHub ─────────────────────────────────────────────────────
  publicUrl: resolve('AGENT_HUB_PUBLIC_URL', 'publicUrl', null),
  defaultReviewer: resolve('AGENT_HUB_DEFAULT_REVIEWER', 'defaultReviewer', null),
  botGithubToken: resolve('AGENT_HUB_BOT_GITHUB_TOKEN', 'botGithubToken', null),
  githubApp: (fileConfig.githubApp as AppConfig['githubApp']) || null,
  personalOAuth: (fileConfig.personalOAuth as AppConfig['personalOAuth']) || null,

  // ── Auth ───────────────────────────────────────────────────────
  apiKey: resolve('AGENT_HUB_API_KEY', 'apiKey', null),
  // AI provider credentials for Claude / Cursor / Codex are strictly
  // per-account — they live encrypted in `orgs.db` `users` and are managed
  // via `/api/auth/me/*-auth` (see server/users-store.ts). There is
  // intentionally NO host-wide key for these engines: every spawn must use
  // the acting user's own login.
  //
  // OpenAI, Gemini, and xAI stay host-configured. `openaiApiKey` powers
  // Whisper transcription + LLM session titles; `geminiApiKey` backs wiki
  // embeddings + the Gemini CLI; `xaiApiKey` backs Grok transcription and the
  // Grok CLI when the host has not run `grok login`.
  openaiApiKey: resolve('OPENAI_API_KEY', 'openaiApiKey', null),
  geminiApiKey: resolve('GEMINI_API_KEY', 'geminiApiKey', null),
  xaiApiKey: resolve('XAI_API_KEY', 'xaiApiKey', null),
  // Which provider /api/transcribe uses. Recognized values are 'xai' (default),
  // 'openai', and 'gemini'. Anything unknown falls back to the default so a typo
  // never disables transcription silently.
  transcriptionProvider: ((): 'xai' | 'openai' | 'gemini' => {
    const v = String(resolve('TRANSCRIPTION_PROVIDER', 'transcriptionProvider', 'xai'))
      .trim()
      .toLowerCase();
    return v === 'openai' ? 'openai' : v === 'gemini' ? 'gemini' : 'xai';
  })(),
  // Optional Codex CLI profile name — when set, every `codex exec` spawn
  // gets `--profile <name>` appended so the CLI loads the matching profile
  // from `~/.codex/config.toml`. Empty / whitespace is treated as unset by
  // the spawn site. See https://developers.openai.com/codex/cli/reference.
  codexProfile: (() => {
    const raw = resolve('CODEX_PROFILE', 'codexProfile', null);
    if (raw == null) return null;
    const trimmed = String(raw).trim();
    return trimmed.length > 0 ? trimmed : null;
  })(),

  // ── Slack ──────────────────────────────────────────────────────
  slackWebhookUrl:
    (process.env.SLACK_WEBHOOK_URL as string) || (fileConfig.slackWebhookUrl as string) || null,

  // Default true: Codex's Linux bubblewrap sandbox fails in typical containers
  // (no unprivileged user namespaces). Opt out with AGENT_HUB_CODEX_DANGER_BYPASS=false
  // or `"codexDangerBypass": false` in config.json.
  codexDangerBypass: (() => {
    const k = 'AGENT_HUB_CODEX_DANGER_BYPASS' as const;
    if (process.env[k] !== undefined) {
      if (envMeansFalse(k)) return false;
      if (envMeansTrue(k)) return true;
      return coerceConfigBooleanLoose(process.env[k], true);
    }
    return coerceConfigBooleanLoose(fileConfig.codexDangerBypass, true);
  })(),

  // LAN mode: skip webhook auto-registration, lean on the existing 3-minute
  // reconciliation poller for PR state, and let the poller dispatch reviewers
  // on freshly-opened PRs in place of the `pull_request.opened` webhook.
  // Default false; opt in with AGENT_HUB_LAN_MODE=true or `"lanMode": true`
  // in config.json (or PATCH /api/config { lanMode: true }).
  lanMode: (() => {
    const k = 'AGENT_HUB_LAN_MODE' as const;
    if (process.env[k] !== undefined) {
      if (envMeansFalse(k)) return false;
      if (envMeansTrue(k)) return true;
      return coerceConfigBooleanLoose(process.env[k], false);
    }
    return coerceConfigBooleanLoose(fileConfig.lanMode, false);
  })(),

  // Card → Done on push. Default true: a successful GitHub push moves the
  // linked kanban card to Done immediately rather than parking it in Review
  // until the PR-merge webhook. Opt out (restore the §15 push → Review →
  // merge → Done flow) with AGENT_HUB_CARD_DONE_ON_PUSH=false or
  // `"cardDoneOnPush": false` in config.json.
  cardDoneOnPush: (() => {
    const k = 'AGENT_HUB_CARD_DONE_ON_PUSH' as const;
    if (process.env[k] !== undefined) {
      if (envMeansFalse(k)) return false;
      if (envMeansTrue(k)) return true;
      return coerceConfigBooleanLoose(process.env[k], true);
    }
    return coerceConfigBooleanLoose(fileConfig.cardDoneOnPush, true);
  })(),

  // ── Host browser sessions (Stagehand / Playwright Chromium) ──
  browserMaxConcurrentContexts: clampFiniteInt(
    resolveInt('AGENT_HUB_BROWSER_MAX_CONTEXTS', 'browserMaxConcurrentContexts', 3),
    3,
    1,
    32,
  ),
  browserIdleTimeoutMs: clampFiniteInt(
    resolveInt('AGENT_HUB_BROWSER_IDLE_MS', 'browserIdleTimeoutMs', 5 * 60 * 1000),
    300_000,
    30_000,
    3_600_000,
  ),
  browserAllowDownloads:
    envMeansTrue('AGENT_HUB_BROWSER_ALLOW_DOWNLOADS') ||
    coerceConfigBooleanLoose(fileConfig.browserAllowDownloads, false),
  browserBlockAdsTrackers: envMeansFalse('AGENT_HUB_BROWSER_BLOCK_ADS')
    ? false
    : fileConfig.browserBlockAdsTrackers !== false,

  // ── Session artifacts (agent-generated documents) ──────────────
  // When `artifactsBucket` is set, artifacts upload to S3 and downloads
  // stream from it; otherwise the Hub stores them locally under
  // `<dataDir>/artifacts` (see server/artifacts/artifact-store.ts).
  artifactsBucket: resolve('AGENT_HUB_ARTIFACTS_BUCKET', 'artifactsBucket', null),
  artifactsBucketRegion: resolve(
    'AGENT_HUB_ARTIFACTS_BUCKET_REGION',
    'artifactsBucketRegion',
    null,
  ),

  // ── Derived / helpers ──────────────────────────────────────────
  get allValidModels(): string[] {
    return Object.values(this.engineValidModels).flat();
  },
};

export function defaultModelForEngine(engine: string): string {
  return config.engineDefaultModels[engine] || config.defaultModel;
}

/**
 * `claude setup-token` is one logical string; terminal wrapping / copy-paste often inserts
 * newlines in the middle. Anthropic expects a single Bearer value — embedded whitespace breaks auth.
 */
export function normalizeClaudeSetupToken(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, '');
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Per-spawn override applied on top of the host-wide `AppConfig`. Used
 * to inject a session owner's personal Claude credentials so each user
 * spawns `claude` under their own identity. Any present field wins over
 * the host config; absent fields fall through.
 */
export interface SpawnEnvOverride {
  /** Anthropic API key (raw `sk-ant-api03-…`). Empty / whitespace = no override. */
  anthropicApiKey?: string | null;
  /** `claude setup-token` OAuth bearer. Empty / whitespace = no override. */
  claudeCodeOAuthToken?: string | null;
  /** Cursor Agent CLI key — exported as CURSOR_API_KEY. */
  cursorApiKey?: string | null;
  /** Gemini CLI key — exported as GEMINI_API_KEY. */
  geminiApiKey?: string | null;
  /** Codex CLI key — fanned out to OPENAI_API_KEY and CODEX_API_KEY. */
  codexApiKey?: string | null;
}

export interface BuildSpawnEnvOptions {
  /** Per-user override; takes precedence over `cfg` for the matching fields. */
  userOverride?: SpawnEnvOverride | null;
  /**
   * Chat session id. When set (with `spawnCredsUserId` or `userId`) and the
   * deployment has no global `cfg.apiKey`, mints a per-session `ahub_*` token
   * into `<dataDir>/spawn-creds/<sessionId>.token` for `ah-api.sh`.
   */
  sessionId?: string | null;
  /**
   * User id for spawn-creds minting. Defaults to `userId` when omitted.
   * Chat passes `credsOwnerId ?? ownerId` so reviewer sessions (NULL owner)
   * still get org-owner API access without stamping session ownership.
   */
  spawnCredsUserId?: string | null;
  /**
   * Owning user id. When set, the spawn runs with HOME pinned to
   * `<dataDir>/per-user-creds/<userId>/home` so CLI engines that
   * authenticate via HOME (`cursor-agent`, `codex`, Gemini OAuth) write
   * their caches to a per-user subtree instead of the shared operator
   * HOME. See `server/per-user-home.ts` for the directory contract.
   *
   * Filesystem errors creating the directory are swallowed — the spawn
   * falls back to the host HOME so a transient FS error cannot block a
   * chat. When `userId` is null / undefined the spawn keeps the host
   * HOME inherited from `process.env`, preserving today's behavior for
   * the legacy global-apiKey path.
   */
  userId?: string | null;
  /**
   * Engine about to receive this env. Host-wide provider keys that are only
   * safe for a specific CLI are injected exclusively through this gate.
   */
  engine?: string | null;
}

/** Treat null / undefined / empty / whitespace-only as "not provided". */
function presentString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildSpawnEnv(
  cfg: AppConfig = config,
  opts: BuildSpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Merge the login-shell PATH into the spawn env so newly-installed CLIs
  // (aws, gh, etc.) are visible without restarting the server. See
  // server/shell-path.ts for the full rationale.
  env.PATH = resolveSpawnPath(process.env.PATH);
  // Hub config must win over the server process env: spreading `process.env` would keep a stale
  // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN after the user clears keys in Settings or switches
  // to OAuth-only — Anthropic then prefers the API key and breaks Bearer/OAuth with 401.
  //
  // Precedence for the two Claude credential vars (per-user → host →
  // unset). Each field is resolved independently so a user that has
  // only an API key still inherits the host's OAuth token, and vice
  // versa.
  const override = opts.userOverride ?? null;
  const ownerUserId = presentString(opts.userId);
  // Claude / Cursor / Codex credentials are strictly per-account: they come
  // ONLY from the acting user's `userOverride`. There is no host fallback —
  // a spawn with no per-user key for these engines simply gets none of these
  // vars set (and the session spawn path hard-fails before reaching here; see
  // `resolveSessionCliSpawnEnv`). This guarantees it is never ambiguous whose
  // keys a CLI is using: always the session owner's own login.
  const anthropicApiKey = presentString(override?.anthropicApiKey);
  if (anthropicApiKey) {
    env.ANTHROPIC_API_KEY = anthropicApiKey;
  } else {
    delete env.ANTHROPIC_API_KEY;
  }
  const rawOauth = presentString(override?.claudeCodeOAuthToken);
  const oauthToken = rawOauth ? normalizeClaudeSetupToken(rawOauth) : null;
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  } else {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const cursorApiKey = presentString(override?.cursorApiKey);
  if (cursorApiKey) {
    // Cursor Agent CLI (binary name `agent`) reads CURSOR_API_KEY when no
    // cached OAuth token is present. See
    // https://docs.cursor.com/en/cli/reference/authentication.
    env.CURSOR_API_KEY = cursorApiKey;
  } else {
    delete env.CURSOR_API_KEY;
  }
  // Gemini is the one host-configured engine: per-user override → host config.
  const geminiApiKey = presentString(override?.geminiApiKey) ?? presentString(cfg.geminiApiKey);
  if (geminiApiKey) {
    // The Gemini CLI reads GEMINI_API_KEY from the environment when no cached
    // OAuth token is present. See https://geminicli.com/docs/cli/cli-reference.
    env.GEMINI_API_KEY = geminiApiKey;
  } else {
    delete env.GEMINI_API_KEY;
  }
  // Recent Gemini CLI versions gate execution behind a "trusted folders" prompt
  // that cannot render in our headless spawns, so every non-interactive run
  // (chat, one-shot, cron, heartbeat, finalize) dies with
  // "Gemini CLI is not running in a trusted directory". Auto-approve the
  // workspace for the spawn the same way `--skip-trust` would. Only the gemini
  // binary reads this var; other engines ignore it. See
  // https://geminicli.com/docs/cli/trusted-folders/#headless-and-automated-environments
  env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  // XAI_API_KEY must never leak into non-Grok sessions. The engine-scoped
  // helper strips inherited values and adds the host xAI key back only for
  // grok-cli.
  applyEngineScopedSpawnEnv(env, cfg, opts.engine);
  const codexApiKey = presentString(override?.codexApiKey);
  if (codexApiKey) {
    // The Codex CLI reads OPENAI_API_KEY (preferred) or CODEX_API_KEY from the
    // environment when no ChatGPT OAuth token is cached. See
    // https://developers.openai.com/codex/noninteractive. We set both so either
    // variable name works regardless of which the installed CLI version prefers.
    env.OPENAI_API_KEY = codexApiKey;
    env.CODEX_API_KEY = codexApiKey;
  } else {
    // Don't leak a stale host-process OPENAI_API_KEY into the Codex spawn when
    // the user has explicitly cleared their key but the server process still
    // carries the env var inherited at startup.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }

  // Hub API access for shell wrappers under the agent-hub skill (scripts/*.sh).
  // Reads `cfg.apiKey` at every call so a config rotation propagates to every
  // *new* spawn (heartbeat, cron, delegation, room-chat, slack, design-chat,
  // one-shot, …) without a server restart. Long-running chat sessions whose
  // env was frozen pre-rotation recover via the per-session spawn-creds file
  // (see `server/spawn-creds-file.ts`); this var is the env-first path that
  // `ah-api.sh:ah_resolve_key` consults before the file fallback.
  //
  // We explicitly delete when `cfg.apiKey` is empty so a stale value inherited
  // from `process.env` (set at server start, then cleared in Settings) can't
  // shadow the current config.
  if (cfg.apiKey) {
    env.AGENT_HUB_API_KEY = cfg.apiKey;
  } else {
    delete env.AGENT_HUB_API_KEY;
  }
  // Pin the data dir so the spawn-creds file fallback in `ah-api.sh` reads
  // the same directory the server writes to. Without this, deploys that
  // override `dataDir` (vs the default `~/.agent-hub/data`) silently fall
  // back to the home-dir path and miss the per-session creds file written by
  // `/api/auth/setup` recovery.
  env.AGENT_HUB_DATA_DIR = cfg.dataDir;

  // Per-user HOME — isolates `.cursor`, `.codex`, etc. CLI caches per
  // Hub user so each user's "Sign in with browser" / device-auth flow
  // writes tokens under their own subtree, and every downstream spawn
  // owned by that user reads the same cache. When `userId` is unset we
  // pin HOME to `<dataDir>/host-creds/home` so operator OAuth survives
  // container/instance restarts (Docker `/data` volume).
  if (ownerUserId) {
    try {
      env.HOME = ensurePerUserHome(ownerUserId, cfg.dataDir);
    } catch {
      // Best-effort: a transient FS error must never block a spawn.
      // Fall through to the host HOME inherited via process.env.
    }

    // Per-user CODEX_HOME — see per-user-codex-device-login.ts.
    //
    // We set CODEX_HOME (engine-isolated, separate from the per-user
    // HOME above) ONLY when the user has actually completed a per-user
    // device login. Setting it eagerly for every user would point the
    // codex CLI at an empty directory and break the API-key fallback
    // path (no cached chatgpt auth + no apikey on disk → codex prompts
    // for login, which never works headless).
    //
    // Note: there is a deliberate small window where a user has finished
    // logging in to per-user CODEX_HOME but `buildSpawnEnv` runs before
    // the on-disk `auth.json` is durable — in that case the spawn falls
    // back to the per-user HOME's `.codex` (which is empty), and the
    // next spawn picks up CODEX_HOME normally. Acceptable: the user
    // re-issues their request and it works.
    if (hasPopulatedCodexDeviceAuth(ownerUserId, cfg.dataDir)) {
      try {
        env.CODEX_HOME = perUserCodexHomePath(ownerUserId, cfg.dataDir);
      } catch {
        // Invalid userId — leave CODEX_HOME alone. The HOME pin above
        // already gave us a useful fallback.
      }
    } else {
      // Defence-in-depth: a server started with CODEX_HOME in its env
      // would otherwise leak that value into spawns owned by users
      // who have not signed in per-user. Drop it so codex falls back
      // to `<HOME>/.codex` under the per-user HOME pin instead.
      delete env.CODEX_HOME;
    }
  } else {
    try {
      env.HOME = ensureHostCliHome(cfg.dataDir);
      // Codex reads CODEX_HOME when set; drop a stale server-process value
      // so host spawns use `<persistent HOME>/.codex` (same tree as
      // `/api/config/codex-auth` device login).
      delete env.CODEX_HOME;
    } catch {
      /* fall through to process.env.HOME */
    }
  }

  const sessionId = presentString(opts.sessionId);
  const spawnCredsUserId = presentString(opts.spawnCredsUserId) ?? ownerUserId;
  if (sessionId && spawnCredsUserId) {
    ensureSpawnCredsForSession({ sessionId, ownerUserId: spawnCredsUserId, cfg });
  }

  // JWT-only deployments mint a per-session `ahub_*` token on disk but leave
  // `cfg.apiKey` empty. Without this, spawned agents inherit an empty
  // `AGENT_HUB_API_KEY` and every hand-rolled curl (or skill doc that omits
  // auth headers) hits 401 — kanban card creation silently fails. Inject the
  // freshly minted token here; `ah-api.sh` still re-reads the file on every
  // call for mid-flight `/api/auth/setup` recovery.
  if (!cfg.apiKey && sessionId) {
    try {
      const spawnTok = readSpawnCredsFile(sessionId, cfg.dataDir);
      if (spawnTok) {
        env.AGENT_HUB_API_KEY = spawnTok;
      }
    } catch {
      /* best-effort — spawn proceeds; ah-api.sh may still read the file */
    }
  }

  return env;
}

export function applyEngineScopedSpawnEnv(
  env: NodeJS.ProcessEnv,
  cfg: AppConfig = config,
  engine?: string | null,
): NodeJS.ProcessEnv {
  delete env.XAI_API_KEY;
  if (engine !== 'grok-cli') return env;
  // Grok Build CLI is host-configured like Gemini for now: it reads XAI_API_KEY
  // from the environment when no `grok login` cached token is present. Scope it
  // to Grok only because other agent CLIs can execute shell commands and should
  // not be able to read the host xAI key from their environment.
  const xaiApiKey = presentString(cfg.xaiApiKey) ?? presentString(process.env.XAI_API_KEY);
  if (xaiApiKey) {
    env.XAI_API_KEY = xaiApiKey;
  }
  return env;
}

/**
 * Normalize an operator-supplied Hub API base URL to `http(s)://host[:port]`
 * (origin only; paths are discarded). Invalid URLs / non-http(s) schemes
 * yield null — callers fall back to loopback when every layer is unusable.
 */
export function normalizedHttpOriginForAgentHub(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  try {
    const u = new URL(withoutTrailingSlash);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Normalize a configured HTTP(S) URL to the REST base used for
 * `AGENT_HUB_URL` on spawned CLIs. Matches the `base` construction in
 * `getRedirectUri` (`server/routes/github-oauth.ts`): trim, strip trailing
 * slashes from the **full** string (so pathname is preserved), parse as URL,
 * require `http:` / `https:`.
 */
export function normalizedHttpSpawnBaseForAgentHub(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const base = trimmed.replace(/\/+$/, '');
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return base;
  } catch {
    return null;
  }
}

/**
 * Base URL injected as `AGENT_HUB_URL` for spawned CLI processes (skills,
 * kanban helpers, reviewer curl templates, etc.).
 *
 * Remote tool sandboxes may not share loopback with the Hub process —
 * configuring `AGENT_HUB_AGENT_URL`, `agentHubUrl` in config.json, or
 * `AGENT_HUB_PUBLIC_URL` / `publicUrl` gives them a reachable address.
 *
 * Precedence:
 *   1. `AGENT_HUB_AGENT_URL` env or `agentHubUrl` in config.json
 *   2. Normalized `publicUrl` (same path rules as GitHub OAuth redirect base)
 *   3. `http://127.0.0.1:${getActualPort()}`
 */
export function resolveAgentHubApiBaseForSpawn(cfg: AppConfig): string {
  const explicit = normalizedHttpSpawnBaseForAgentHub(
    resolve('AGENT_HUB_AGENT_URL', 'agentHubUrl', null),
  );
  if (explicit) return explicit;
  const pub = normalizedHttpSpawnBaseForAgentHub(cfg.publicUrl);
  if (pub) return pub;
  return `http://127.0.0.1:${getActualPort()}`;
}

export default config;
