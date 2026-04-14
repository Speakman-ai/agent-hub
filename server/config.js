/**
 * Centralized configuration for Agent Hub.
 *
 * All machine-specific paths, ports, and tunables live here so the
 * rest of the codebase never hard-codes them.
 *
 * Resolution order (highest wins):
 *   1. Environment variables  (e.g. CLAUDE_BIN, AGENT_HUB_PORT)
 *   2. config.json file       (~/.agent-hub/data/config.json)
 *   3. Built-in defaults      (below)
 *
 * All app state lives under ~/.agent-hub/:
 *   - data/          → agent-hub.db, projects.json, config.json
 *   - projects/      → per-project context files and skills
 *   - workspaces/    → git worktrees (ephemeral)
 *
 * To move Agent Hub to another machine:
 *   1. Copy ~/.agent-hub/ to the new machine
 *   2. Update CLI binary paths in config.json if they differ
 *   3. Sign into Claude Code / Cursor CLI manually
 */

import { readFileSync, copyFileSync, cpSync, existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// ─── Data directory ─────────────────────────────────────────────
// Default to ~/.agent-hub/data — all persistent state lives here.
const DEFAULT_DATA_DIR = path.join(HOME, '.agent-hub', 'data');
const DATA_DIR = process.env.AGENT_HUB_DATA_DIR || DEFAULT_DATA_DIR;

// Ensure the data directory exists on first run.
mkdirSync(DATA_DIR, { recursive: true });

// ─── Load optional config.json ───────────────────────────────────
// Priority: DATA_DIR/config.json → server/config.json (legacy) → defaults.
// If config.json only exists in the legacy location (server/), auto-migrate
// it to DATA_DIR so all state consolidates under ~/.agent-hub/.
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LEGACY_CONFIG_PATH = path.join(__dirname, 'config.json');

// Auto-migrate: copy legacy config.json into the data directory.
if (!existsSync(CONFIG_PATH) && existsSync(LEGACY_CONFIG_PATH)) {
  try {
    copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    console.log(`[config] Migrated config.json → ${CONFIG_PATH}`);
  } catch {
    // Non-fatal — we'll still read from the legacy path below.
  }
}

let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
} catch {
  // Fall back to legacy location (dev setup or failed migration).
  try {
    fileConfig = JSON.parse(readFileSync(LEGACY_CONFIG_PATH, 'utf-8'));
  } catch {
    // No config.json anywhere — defaults will be used.
  }
}

/**
 * Resolve a value: env var → config.json → default.
 */
function resolve(envKey, fileKey, fallback) {
  if (envKey && process.env[envKey] !== undefined) return process.env[envKey];
  if (fileKey && fileConfig[fileKey] !== undefined) return fileConfig[fileKey];
  return fallback;
}

function resolveInt(envKey, fileKey, fallback) {
  const val = resolve(envKey, fileKey, fallback);
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ─── Auto-migrate legacy projects directory ─────────────────────
// If ~/.openclaw/projects exists but ~/.agent-hub/projects doesn't,
// copy the directory so project context files (SOUL.md, skills, etc.)
// aren't silently lost after the rename.
const DEFAULT_PROJECTS_DIR = path.join(HOME, '.agent-hub', 'projects');
const LEGACY_PROJECTS_DIR = path.join(HOME, '.openclaw', 'projects');

if (!existsSync(DEFAULT_PROJECTS_DIR) && existsSync(LEGACY_PROJECTS_DIR)) {
  try {
    cpSync(LEGACY_PROJECTS_DIR, DEFAULT_PROJECTS_DIR, { recursive: true });
    console.log(`[config] Migrated projects dir → ${DEFAULT_PROJECTS_DIR}`);
  } catch (err) {
    console.warn(`[config] Failed to migrate projects dir: ${err.message}`);
  }
}

// ─── Exported config object ──────────────────────────────────────

const config = {
  // ── Server ─────────────────────────────────────────────────────
  port: resolveInt('AGENT_HUB_PORT', 'port', 3051),
  host: resolve('AGENT_HUB_HOST', 'host', '0.0.0.0'),

  // ── CLI binary paths ───────────────────────────────────────────
  claudeBin: resolve('CLAUDE_BIN', 'claudeBin', '/usr/local/bin/claude'),
  cursorBin: resolve('CURSOR_BIN', 'cursorBin', '/usr/local/bin/agent'),

  // ── Directories ────────────────────────────────────────────────
  /** Fallback cwd when an agent has no cwd set */
  defaultCwd: resolve('AGENT_HUB_DEFAULT_CWD', 'defaultCwd', HOME),

  /** Where data files live (projects.json, db, config.json, etc.) */
  dataDir: resolve('AGENT_HUB_DATA_DIR', 'dataDir', DEFAULT_DATA_DIR),

  /** Base directory for project context files (SOUL.md, skills, etc.) */
  projectsDir: resolve(
    'AGENT_HUB_PROJECTS_DIR',
    'projectsDir',
    path.join(HOME, '.agent-hub', 'projects'),
  ),

  // ── Models ─────────────────────────────────────────────────────
  defaultModel: resolve(null, 'defaultModel', 'claude-opus-4-6'),

  engineDefaultModels: fileConfig.engineDefaultModels || {
    'claude-code': 'claude-opus-4-6',
    'cursor-agent': 'gpt-5.3-codex-high',
  },

  engineValidModels: fileConfig.engineValidModels || {
    'claude-code': ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-6'],
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
  },

  // ── Timeouts ───────────────────────────────────────────────────
  /** Default heartbeat / cron timeout (ms) */
  defaultTimeoutMs: resolveInt(null, 'defaultTimeoutMs', 5 * 60 * 1000),
  /** Docs agent heartbeat timeout (ms) — docs agents do more work */
  docsTimeoutMs: resolveInt(null, 'docsTimeoutMs', 10 * 60 * 1000),
  /** Slack response timeout (ms) */
  slackTimeoutMs: resolveInt(null, 'slackTimeoutMs', 5 * 60 * 1000),
  /** Conference room per-agent timeout (ms) */
  conferenceTimeoutMs: resolveInt(null, 'conferenceTimeoutMs', 10 * 60 * 1000),

  // ── GitHub ─────────────────────────────────────────────────────
  /** Public URL for this server (used as the webhook callback URL).
   *  E.g. 'https://my-server.example.com' or 'http://3.22.232.193'.
   *  When set, webhook auto-registration sends this URL to GitHub
   *  instead of relying on the client's window.location. */
  publicUrl: resolve('AGENT_HUB_PUBLIC_URL', 'publicUrl', null),

  /** Fallback PR reviewer when no agent or project reviewer is set */
  defaultReviewer: resolve('AGENT_HUB_DEFAULT_REVIEWER', 'defaultReviewer', null),

  /** GitHub PAT for a dedicated bot account used by the lead reviewer.
   *  When set, formal PR reviews (approve/request-changes) and merges
   *  are executed using this token instead of the default gh CLI auth,
   *  bypassing GitHub's same-account review limitation.
   *  This is the fallback option — prefer GitHub App for one-click setup. */
  botGithubToken: resolve('AGENT_HUB_BOT_GITHUB_TOKEN', 'botGithubToken', null),

  /** GitHub App credentials (set via the App Manifest flow in Settings).
   *  Primary method for formal PR reviews — one-click setup, no separate account needed.
   *  Stored in config.json after the manifest callback completes. */
  githubApp: fileConfig.githubApp || null,
  // Shape: { appId, appSlug, privateKey, webhookSecret, clientId, clientSecret,
  //          installationId,  // legacy single installation (backward compat)
  //          installations: [{ id, account, accountType }]  // all installations
  //        }

  // ── Auth ───────────────────────────────────────────────────────
  /** Optional API key for securing remote access */
  apiKey: resolve('AGENT_HUB_API_KEY', 'apiKey', null),

  /** Optional Anthropic API key for Claude Code sessions.
   *  When set, passed as ANTHROPIC_API_KEY env var to all spawned
   *  CLI processes — an alternative to OAuth-based auth. */
  anthropicApiKey: resolve('ANTHROPIC_API_KEY', 'anthropicApiKey', null),

  // ── Slack ──────────────────────────────────────────────────────
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || fileConfig.slackWebhookUrl || null,

  // ── Derived / helpers ──────────────────────────────────────────
  get allValidModels() {
    return Object.values(this.engineValidModels).flat();
  },
};

export function defaultModelForEngine(engine) {
  return config.engineDefaultModels[engine] || config.defaultModel;
}

/**
 * Build a spawn environment with common env vars injected.
 * Centralises ANTHROPIC_API_KEY injection so every spawn site
 * stays in sync automatically.
 */
export function buildSpawnEnv(cfg = config) {
  const env = { ...process.env };
  if (cfg.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  }
  return env;
}

export default config;
