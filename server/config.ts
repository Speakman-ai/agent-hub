import { readFileSync, copyFileSync, cpSync, existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppConfig } from './types.js';
import { resolveSpawnPath, refreshShellPath, getCachedShellPath } from './shell-path.js';

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

const config: AppConfig = {
  // ── Server ─────────────────────────────────────────────────────
  port: resolveInt('AGENT_HUB_PORT', 'port', 3051),
  host: resolve('AGENT_HUB_HOST', 'host', '0.0.0.0') as string,

  // ── CLI binary paths ───────────────────────────────────────────
  // cursorBin default tracks the path used by Cursor's official per-user
  // installer (https://cursor.com/install), which drops a symlink at
  // $HOME/.local/bin/agent. Aligning the default here means a fresh box
  // with just the installer run (and no config.json override) works out
  // of the box — no sudo symlink into /usr/local/bin required.
  claudeBin: resolve('CLAUDE_BIN', 'claudeBin', '/usr/local/bin/claude') as string,
  cursorBin: resolve(
    'CURSOR_BIN',
    'cursorBin',
    path.join(HOME, '.local', 'bin', 'agent'),
  ) as string,
  geminiBin: resolve('GEMINI_BIN', 'geminiBin', '/usr/local/bin/gemini') as string,
  codexBin: resolve('CODEX_BIN', 'codexBin', '/usr/local/bin/codex') as string,

  // ── Directories ────────────────────────────────────────────────
  defaultCwd: resolve('AGENT_HUB_DEFAULT_CWD', 'defaultCwd', HOME) as string,
  dataDir: resolve('AGENT_HUB_DATA_DIR', 'dataDir', DEFAULT_DATA_DIR) as string,
  projectsDir: resolve(
    'AGENT_HUB_PROJECTS_DIR',
    'projectsDir',
    path.join(HOME, '.agent-hub', 'projects'),
  ) as string,

  // ── Models ─────────────────────────────────────────────────────
  defaultModel: resolve(null, 'defaultModel', 'claude-opus-4-7') as string,

  engineDefaultModels: (fileConfig.engineDefaultModels as Record<string, string>) || {
    'claude-code': 'claude-opus-4-7',
    'cursor-agent': 'gpt-5.3-codex-high',
    'gemini-cli': 'gemini-2.5-pro',
    // Codex: default is gpt-5.3-codex, the current flagship Codex-tuned model
    // accepted under BOTH auth modes (ChatGPT OAuth and API-key). Older IDs
    // like gpt-5.2-codex / gpt-5-codex / gpt-5.1-codex-max get rejected with
    // HTTP 400 under ChatGPT OAuth — see diagnosis in AGENTS' kanban card
    // "Codex not working (round 2)".
    'codex-cli': 'gpt-5.3-codex',
  },

  engineValidModels: (fileConfig.engineValidModels as Record<string, string[]>) || {
    'claude-code': ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-6'],
    'cursor-agent': [
      'gpt-5.3-codex-high',
      'gpt-5.3-codex',
      'gpt-5.3-codex-low',
      'gpt-5.3-codex-fast',
      'gpt-5.2-codex-high',
      'gpt-5.2-codex',
      'gpt-5.1-codex-max-high',
      'composer-2',
      'composer-2-fast',
      'auto',
    ],
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
    // Empirically (CLI 0.122, April 2026) the following fail under ChatGPT:
    //   gpt-5, gpt-5-mini, gpt-5-codex, gpt-5.2-codex, gpt-5.1-codex-max,
    //   gpt-5.3-codex-spark.
    // These currently succeed under ChatGPT OAuth and are the only IDs we
    // allow the UI to select. Keep in sync with client/src/components/TopBar.jsx
    // and mobile/src/utils/engineOptions.js. Runtime guard in chat.ts will
    // drop --model when an unsupported/stale ID is still persisted on a
    // session (so resumes from old DBs don't spin forever).
    'codex-cli': ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
  },

  // ── Timeouts ───────────────────────────────────────────────────
  defaultTimeoutMs: resolveInt(null, 'defaultTimeoutMs', 15 * 60 * 1000),
  docsTimeoutMs: resolveInt(null, 'docsTimeoutMs', 10 * 60 * 1000),
  slackTimeoutMs: resolveInt(null, 'slackTimeoutMs', 5 * 60 * 1000),
  conferenceTimeoutMs: resolveInt(null, 'conferenceTimeoutMs', 10 * 60 * 1000),

  // ── GitHub ─────────────────────────────────────────────────────
  publicUrl: resolve('AGENT_HUB_PUBLIC_URL', 'publicUrl', null),
  defaultReviewer: resolve('AGENT_HUB_DEFAULT_REVIEWER', 'defaultReviewer', null),
  botGithubToken: resolve('AGENT_HUB_BOT_GITHUB_TOKEN', 'botGithubToken', null),
  githubApp: (fileConfig.githubApp as AppConfig['githubApp']) || null,

  // ── Auth ───────────────────────────────────────────────────────
  apiKey: resolve('AGENT_HUB_API_KEY', 'apiKey', null),
  anthropicApiKey: resolve('ANTHROPIC_API_KEY', 'anthropicApiKey', null),
  openaiApiKey: resolve('OPENAI_API_KEY', 'openaiApiKey', null),
  geminiApiKey: resolve('GEMINI_API_KEY', 'geminiApiKey', null),
  // Codex CLI reads its API key from either `OPENAI_API_KEY` or `CODEX_API_KEY`
  // (see https://developers.openai.com/codex/noninteractive). We expose
  // `codexApiKey` as a dedicated field so the Codex auth panel can toggle it
  // independently of the existing `openaiApiKey` (which we leave untouched for
  // forward-compat with any future OpenAI SDK integrations).
  codexApiKey: resolve('CODEX_API_KEY', 'codexApiKey', null),

  // ── Slack ──────────────────────────────────────────────────────
  slackWebhookUrl:
    (process.env.SLACK_WEBHOOK_URL as string) || (fileConfig.slackWebhookUrl as string) || null,

  // ── Captures ──────────────────────────────────────────────────
  capturesEnabled: resolve('AGENT_HUB_CAPTURES_ENABLED', 'capturesEnabled', 'false') === 'true',

  // ── Derived / helpers ──────────────────────────────────────────
  get allValidModels(): string[] {
    return Object.values(this.engineValidModels).flat();
  },
};

export function defaultModelForEngine(engine: string): string {
  return config.engineDefaultModels[engine] || config.defaultModel;
}

export function buildSpawnEnv(cfg: AppConfig = config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Merge the login-shell PATH into the spawn env so newly-installed CLIs
  // (aws, gh, etc.) are visible without restarting the server. See
  // server/shell-path.ts for the full rationale.
  env.PATH = resolveSpawnPath(process.env.PATH);
  if (cfg.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  }
  if (cfg.geminiApiKey) {
    // The Gemini CLI reads GEMINI_API_KEY from the environment when no cached
    // OAuth token is present. See https://geminicli.com/docs/cli/cli-reference.
    env.GEMINI_API_KEY = cfg.geminiApiKey;
  }
  if (cfg.codexApiKey) {
    // The Codex CLI reads OPENAI_API_KEY (preferred) or CODEX_API_KEY from the
    // environment when no ChatGPT OAuth token is cached. See
    // https://developers.openai.com/codex/noninteractive. We set both so either
    // variable name works regardless of which the installed CLI version prefers.
    env.OPENAI_API_KEY = cfg.codexApiKey;
    env.CODEX_API_KEY = cfg.codexApiKey;
  }
  return env;
}

export default config;
