/**
 * Centralized configuration for Agent Hub.
 *
 * All machine-specific paths, ports, and tunables live here so the
 * rest of the codebase never hard-codes them.
 *
 * Resolution order (highest wins):
 *   1. Environment variables  (e.g. CLAUDE_BIN, AGENT_HUB_PORT)
 *   2. config.json file       (server/config.json — gitignored, portable)
 *   3. Built-in defaults      (below)
 *
 * To move Agent Hub to another machine:
 *   1. Copy (or export) config.json + agents.json + agent-hub.db
 *   2. Move your agent directories wherever you like
 *   3. Update `agentsDir` / binary paths in config.json
 *   4. Sign into Claude Code / Cursor CLI manually
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/home/' + (process.env.USER || 'user');

// ─── Load optional config.json ───────────────────────────────────
let fileConfig = {};
try {
  const raw = readFileSync(path.join(__dirname, 'config.json'), 'utf-8');
  fileConfig = JSON.parse(raw);
} catch {
  // No config.json — that's fine, defaults will be used.
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

// ─── Exported config object ──────────────────────────────────────

const config = {
  // ── Server ─────────────────────────────────────────────────────
  port:       resolveInt('AGENT_HUB_PORT', 'port', 3051),
  host:       resolve('AGENT_HUB_HOST', 'host', '0.0.0.0'),

  // ── CLI binary paths ───────────────────────────────────────────
  claudeBin:  resolve('CLAUDE_BIN', 'claudeBin', '/usr/local/bin/claude'),
  cursorBin:  resolve('CURSOR_BIN', 'cursorBin', '/usr/local/bin/agent'),

  // ── Directories ────────────────────────────────────────────────
  /** Fallback cwd when an agent has no cwd set */
  defaultCwd: resolve('AGENT_HUB_DEFAULT_CWD', 'defaultCwd', HOME),

  /** Where data files live (projects.json, db, etc.) */
  dataDir:    resolve('AGENT_HUB_DATA_DIR', 'dataDir', __dirname),

  /** Base directory for project ahw directories */
  projectsDir: resolve('AGENT_HUB_PROJECTS_DIR', 'projectsDir',
    path.join(HOME, '.openclaw', 'projects')),

  // ── Models ─────────────────────────────────────────────────────
  defaultModel: resolve(null, 'defaultModel', 'claude-opus-4-6'),

  engineDefaultModels: fileConfig.engineDefaultModels || {
    'claude-code':   'claude-opus-4-6',
    'cursor-agent':  'gpt-5.3-codex-high',
  },

  engineValidModels: fileConfig.engineValidModels || {
    'claude-code': ['claude-opus-4-6', 'claude-sonnet-4-6'],
    'cursor-agent': [
      'gpt-5.3-codex-high', 'gpt-5.3-codex', 'gpt-5.3-codex-low', 'gpt-5.3-codex-fast',
      'gpt-5.2-codex-high', 'gpt-5.2-codex',
      'gpt-5.1-codex-max-high',
      'composer-2', 'composer-2-fast', 'auto',
    ],
  },

  // ── Timeouts ───────────────────────────────────────────────────
  /** Default heartbeat / cron timeout (ms) */
  defaultTimeoutMs:   resolveInt(null, 'defaultTimeoutMs',  5 * 60 * 1000),
  /** Babysit cron timeout (ms) */
  babysitTimeoutMs:   resolveInt(null, 'babysitTimeoutMs',  15 * 60 * 1000),
  /** Slack response timeout (ms) */
  slackTimeoutMs:     resolveInt(null, 'slackTimeoutMs',    5 * 60 * 1000),
  /** Conference room per-agent timeout (ms) */
  conferenceTimeoutMs: resolveInt(null, 'conferenceTimeoutMs', 10 * 60 * 1000),

  // ── Auth ───────────────────────────────────────────────────────
  /** Optional API key for securing remote access */
  apiKey: resolve('AGENT_HUB_API_KEY', 'apiKey', null),

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

export default config;
