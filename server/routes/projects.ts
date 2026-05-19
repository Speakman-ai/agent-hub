import { Router, Request, Response } from 'express';
import { execSync, execFileSync, spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { createStreamParser } from '../stream-parser.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { buildSpawnEnv } from '../config.js';
import {
  classifyCloneUrl,
  buildAuthenticatedUrl,
  redactToken,
  SSH_NOT_SUPPORTED_MESSAGE,
} from '../clone-url-auth.js';
import { getActiveAccessToken } from '../github-connections-store.js';
import { invalidateCursorAuthCache } from '../cursor-auth-cache.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from '../engine-resolver.js';
import { runOneShotPrompt } from '../one-shot-spawn.js';
import { getUserByUsername, getUserById, createUser } from '../users-store.js';
import { isAuthConfigured } from '../auth-store.js';
import { detectPreviewDefaults } from '../scaffolding/detect-preview-defaults.js';
import { runPreviewTest } from '../preview/preview-test.js';
import { getOrCreateBoard } from './board.js';
import { getEngineAuthStatus } from '../engine-auth-status.js';
import type { AuthenticatedRequest } from '../auth.js';
import {
  canViewProject,
  canDeleteProject,
  filterVisibleProjects,
  getVisibility,
  canChangeVisibility,
  classifyVisibilityTransition,
} from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { deleteProjectScopedRows } from '../project-owner-cascade.js';
import {
  registerWebhookOnGitHub,
  tryGetInstallationToken,
  callGitHubApiWithToken,
} from './webhooks.js';
import type { WebhookConfigRow } from '../types.js';

const execAsync = promisify(exec);
import type {
  RouteDeps,
  Agent,
  Project,
  ProjectMode,
  StreamEvent,
  GithubWorkflowSettings,
} from '../types.js';
import { sanitizeOrchestrationBudgetsPartial } from '../orchestration-budgets.js';

const ANALYZE_SYSTEM_PROMPT = `You are a project analyzer for Agent Hub, an AI-powered workspace manager. Analyze the code repository at your current working directory and return structured JSON.

Your response MUST be a single valid JSON object wrapped in a \`\`\`json code fence. No other text outside the fence.

JSON schema:
{
  "techStack": {
    "languages": ["string"],
    "frameworks": ["string"],
    "tools": ["string"],
    "packageManager": "string or null"
  },
  "description": "1-2 sentence project summary",
  "agents": [
    {
      "name": "Human-readable agent name",
      "id": "kebab-case-id",
      "role": "dev",
      "specialty": "Brief description of what this agent focuses on",
      "systemPrompt": "Full system prompt for this agent. Be specific about the project's tech stack, conventions, and what this agent should focus on. 2-4 paragraphs."
    }
  ],
  "commands": {
    "install": "string or null — command to install dependencies (e.g. 'npm ci', 'pip install -r requirements.txt', 'cargo build')",
    "build": "string or null — command to build the project (e.g. 'npm run build', 'cargo build --release')",
    "test": "string or null — command to run tests (e.g. 'npm test', 'pytest', 'cargo test')",
    "lint": "string or null — command to run linting (e.g. 'npm run lint', 'ruff check .', 'cargo clippy')"
  },
  "contextFiles": {
    "SOUL.md": "Content describing the project's philosophy, coding standards, and architectural principles.",
    "AGENTS.md": "Content describing the team of agents and their roles.",
    "USER.md": "Placeholder for user preferences with reasonable defaults.",
    "TOOLS.md": "Key tools, scripts, and commands found in this project.",
    "MEMORY.md": "Key architectural decisions, important file locations, and project structure."
  }
}

Guidelines for agents — SINGLE FLAT DEV AGENT:
- Return EXACTLY ONE agent in the array. Sub-agent hierarchies (lead + frontend + backend, etc.) are deprecated — Agent Hub uses a flat agent model. The user can add additional dev agents from the UI later if they want a multi-specialist setup.
- The agent's role MUST be "dev".
- The agent's name should be "[Project] Dev" (e.g. "MyApp Dev") — short and human-readable.
- The agent's systemPrompt should be a comprehensive, full-stack-capable persona that owns the entire codebase: architecture, frontend, backend, tests, deploy. 3-5 paragraphs that bake in the project's tech stack, conventions, and notable directories so a fresh chat session has the context it needs to ship work without delegating.
- The agent's id should be descriptive kebab-case (e.g. "myapp-dev").
- Do NOT emit roles "lead" or "sub". Do NOT split work across multiple agents.

Guidelines for commands:
- Detect the install command by checking lock files: bun.lockb/bun.lock -> "bun install", pnpm-lock.yaml -> "pnpm install", yarn.lock -> "yarn install", package-lock.json -> "npm ci", package.json -> "npm install", requirements.txt -> "pip install -r requirements.txt", Cargo.toml -> "cargo build"
- Detect the build command from package.json "scripts.build", Makefile "build" target, Cargo.toml, etc.
- Detect the test command from package.json "scripts.test", Makefile "test" target, pytest.ini, Cargo.toml, etc.
- Detect the lint command from package.json "scripts.lint", .eslintrc*, ruff.toml, Cargo.toml (clippy), etc.
- Return null for any command that cannot be detected

Guidelines for contextFiles:
- SOUL.md: capture actual coding style (indentation, naming conventions, patterns observed)
- AGENTS.md: describe the single dev agent and the kinds of work they own. The flat-agent model means there is no team to coordinate — write this from the perspective of one full-stack developer agent.
- TOOLS.md: list actual commands from package.json scripts, Makefile targets, etc.
- MEMORY.md: note the project structure and key directories
- All content must be specific to this project, not generic`;

const ANALYZE_USER_PROMPT = `Analyze the repository at the current working directory.

Read these files if they exist to understand the project:
- package.json, package-lock.json (Node.js)
- Cargo.toml (Rust)
- pyproject.toml, setup.py, requirements.txt (Python)
- go.mod (Go)
- Makefile, Justfile
- README.md, CLAUDE.md
- .github/workflows/ (CI)
- tsconfig.json, .eslintrc*, .prettierrc*
- docker-compose.yml, Dockerfile

Also examine the top-level directory structure and a sampling of source files to understand conventions.

Return your analysis as the JSON structure described in your instructions.`;

interface AnalysisResult {
  techStack?: {
    languages?: string[];
    frameworks?: string[];
    tools?: string[];
    packageManager?: string | null;
  };
  description?: string;
  agents?: Array<{
    id: string;
    name?: string;
    role?: string;
    engine?: string;
    systemPrompt?: string;
    color?: string;
    specialty?: string;
    identity?: string;
  }>;
  commands?: {
    install?: string | null;
    build?: string | null;
    test?: string | null;
    lint?: string | null;
  };
  contextFiles?: Record<string, string>;
}

interface OnboardBody {
  project: {
    id: string;
    name?: string;
    cwd?: string;
    color?: string;
    githubRepo?: { owner: string; repo: string };
    preCommitCommands?: unknown;
    checkHealCommands?: unknown;
    checkHealMaxRounds?: unknown;
  };
  agents?: Array<{
    id: string;
    name?: string;
    role?: string;
    engine?: string;
    systemPrompt?: string;
    color?: string;
    identity?: string;
  }>;
  contextFiles?: Record<string, string>;
  commands?: {
    install?: string | null;
    build?: string | null;
    test?: string | null;
    lint?: string | null;
  };
}

interface ProjectCommands {
  install: string | null;
  build: string | null;
  test: string | null;
  lint: string | null;
}

/** Normalize `preCommitCommands` from JSON bodies (POST/PATCH/onboard). */
function normalizePreCommitCommands(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Persisted 1–5; invalid values yield `undefined` (caller returns 400 when the field was explicit). */
function normalizeCheckHealMaxRounds(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 1 && n <= 5) return n;
    return undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = parseInt(value.trim(), 10);
    if (n >= 1 && n <= 5) return n;
  }
  return undefined;
}

const CHECK_HEAL_MAX_ROUNDS_INVALID =
  'checkHealMaxRounds must be an integer between 1 and 5 (inclusive), or null or empty string to clear';

function patchProjectOptionalBrowserDimension(
  project: Project,
  body: Record<string, unknown>,
  key: 'browserViewportWidth' | 'browserViewportHeight',
  min: number,
  max: number,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
  const v = body[key];
  if (v === null) {
    delete (project as Record<string, unknown>)[key];
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return `${key} must be a finite number or null`;
  }
  const i = Math.floor(v);
  if (i < min || i > max) {
    return `${key} must be between ${min} and ${max}`;
  }
  (project as Record<string, unknown>)[key] = i;
  return undefined;
}

function patchProjectBrowserPageLoadTimeout(
  project: Project,
  body: Record<string, unknown>,
): string | undefined {
  const key = 'browserPageLoadTimeoutMs';
  if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
  const v = body[key];
  if (v === null) {
    delete (project as Record<string, unknown>)[key];
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return `${key} must be a finite number or null`;
  }
  const i = Math.floor(v);
  if (i < 1000 || i > 120_000) {
    return `${key} must be between 1000 and 120000`;
  }
  (project as Record<string, unknown>)[key] = i;
  return undefined;
}

/**
 * Validate + normalize a `prEnv` PATCH payload.
 *
 * Mirrors the client-side `validateForm` in
 * `client/src/utils/prEnvProjectPayload.js` so the wizard and the
 * server agree on the contract:
 *
 *   - `enabled: false` is a valid standalone payload (clears the rest)
 *   - when enabled, `startScript` (string) and `internalPort` (1..65535)
 *     are required
 *   - optional `setupCommand`, `healthPath` (must start with `/`),
 *     `dockerfilePath` are passed through trimmed; empty strings are
 *     stripped so absence is the on-disk representation
 *
 * Returns `{ ok: true, value }` on success, or `{ ok: false, error }`
 * on the first failed field — caller responds with 400 + the message.
 */
export interface ValidatedPrEnvConfig {
  enabled: boolean;
  startScript?: string;
  internalPort?: number;
  setupCommand?: string;
  healthPath?: string;
  dockerfilePath?: string;
  env?: Record<string, string>;
  preview?: ValidatedPrEnvPreviewConfig;
}

export interface ValidatedPrEnvPreviewConfig {
  enabled: boolean;
  startScript?: string;
  port?: number;
  captureRoutes?: string[];
  idleTTL?: number;
  compose?: ValidatedPreviewComposeConfig;
}

/**
 * Validated shape of the optional `preview.compose` sub-block.
 * Mirrors {@link PreviewComposeConfig} on the type side with the same
 * defaulting semantics — defaults are NOT filled in here so the stored
 * config round-trips exactly what the user supplied.
 */
export interface ValidatedPreviewComposeConfig {
  file?: string;
  entryService: string;
  entryPort: number;
  envFile?: string;
  healthPath?: string;
  hostPortRange?: { min: number; max: number };
  readyTimeoutMs?: number;
}

// Caps for the `env` map. The builder ultimately translates these into
// `docker run --env K=V` arg pairs, so an unbounded payload could blow
// past the kernel's ARG_MAX. Numbers are deliberately generous for the
// expected use case (a handful of AWS creds + feature flags) but small
// enough to surface user error early instead of at dispatch time.
const PR_ENV_MAX_VARS = 64;
const PR_ENV_MAX_KEY_LEN = 128;
const PR_ENV_MAX_VALUE_LEN = 4096;
// POSIX env var name: leading [A-Za-z_], rest [A-Za-z0-9_]. Keep this
// strict — Docker accepts arbitrary names but the in-container shell
// (`sh -c`) cannot dereference names with dots/dashes/spaces, which is
// almost always a user mistake we should reject up front.
const PR_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// PORT is reserved — the runner derives it from `internalPort` and
// passes `PORT=<internalPort>` itself. Letting users override it would
// silently break the host-port → internal-port mapping.
const PR_ENV_RESERVED_KEYS = new Set(['PORT']);

// SSM Parameter Store reference syntax — operators can put
// `${ssm:/path/to/param}` in a value and the pr-env-builder resolves it
// at build time via `server/ssm-resolver.ts`. The pattern is anchored
// (^...$) so the *entire* value must be a single reference token.
//
// Mixed strings like `prefix-${ssm:/x}` are deliberately out of scope:
// concatenation invites quoting / escaping surprises, and the common
// secret use cases (AWS keys, DB passwords) want the full value from
// SSM anyway. Reject mixed strings here so users see a clear error
// instead of a half-substituted value reaching the container.
const SSM_REF_RE = /^\$\{ssm:\/[A-Za-z0-9_./-]+\}$/;
// A loose check used purely to distinguish "looks like an attempted
// SSM ref" from "plain literal value" so we can return a more
// targeted error message for mixed-token attempts.
const SSM_LIKE_RE = /\$\{ssm:/;

/**
 * Validate the optional `env` map on a per-project PR-env config.
 * Returns the normalized map on success (or `undefined` when the input
 * is empty / absent), or an error string on the first failure.
 */
function validatePrEnvVars(
  raw: unknown,
): { ok: true; value: Record<string, string> | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'prEnv.env must be an object of string→string entries' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: true, value: undefined };
  if (entries.length > PR_ENV_MAX_VARS) {
    return {
      ok: false,
      error: `prEnv.env supports at most ${PR_ENV_MAX_VARS} entries (got ${entries.length})`,
    };
  }
  const out: Record<string, string> = {};
  for (const [key, val] of entries) {
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'prEnv.env keys must be non-empty strings' };
    }
    if (key.length > PR_ENV_MAX_KEY_LEN) {
      return {
        ok: false,
        error: `prEnv.env key "${key.slice(0, 32)}…" exceeds ${PR_ENV_MAX_KEY_LEN} chars`,
      };
    }
    if (!PR_ENV_NAME_RE.test(key)) {
      return {
        ok: false,
        error: `prEnv.env key "${key}" must match [A-Za-z_][A-Za-z0-9_]* (POSIX env var name)`,
      };
    }
    if (PR_ENV_RESERVED_KEYS.has(key)) {
      return {
        ok: false,
        error: `prEnv.env key "${key}" is reserved (set by the runner from internalPort)`,
      };
    }
    if (typeof val !== 'string') {
      return {
        ok: false,
        error: `prEnv.env["${key}"] must be a string (got ${typeof val})`,
      };
    }
    if (val.length > PR_ENV_MAX_VALUE_LEN) {
      return {
        ok: false,
        error: `prEnv.env["${key}"] exceeds ${PR_ENV_MAX_VALUE_LEN} chars`,
      };
    }
    // If the value looks like an SSM reference, require it to be a
    // *full-token* reference. This catches both malformed paths and
    // mixed literal+ref values up front — both produce a clear error
    // instead of slipping through and failing later in the resolver.
    if (SSM_LIKE_RE.test(val) && !SSM_REF_RE.test(val)) {
      return {
        ok: false,
        error:
          `prEnv.env["${key}"] looks like an SSM reference but is not a ` +
          `full-token match for \${ssm:/path/to/param}. Mixed literal+ref ` +
          `values (e.g. "prefix-\${ssm:/x}") are not supported — put the ` +
          `entire value in SSM, or use a plain literal here.`,
      };
    }
    out[key] = val;
  }
  return { ok: true, value: out };
}

// Preview sub-config caps. Mirrors `PrEnvPreviewConfig` in `server/types.ts`.
// The wizard / future client-side mirror should re-export the same numbers
// (Wizard UI work is tracked in card 4 — out of scope here).
const PR_ENV_PREVIEW_MAX_ROUTES = 10;
const PR_ENV_PREVIEW_PORT_MIN = 1024;
const PR_ENV_PREVIEW_PORT_MAX = 65535;
const PR_ENV_PREVIEW_IDLE_TTL_MIN = 60;
const PR_ENV_PREVIEW_IDLE_TTL_MAX = 86400;

// Compose sub-config caps — see PreviewComposeConfig in server/types.ts.
// The compose service-name pattern matches Docker's own
// `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` rule, transcribed here so a misconfigured
// service-name surfaces at save time instead of when `docker compose`
// rejects it minutes into a build.
const PREVIEW_COMPOSE_SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS = 5_000;
const PREVIEW_COMPOSE_READY_TIMEOUT_MAX_MS = 1_800_000;
const PREVIEW_COMPOSE_FILE_MAX_LEN = 256;
// Path-traversal guard for `file` / `envFile`. These resolve relative to
// the worktree root at runtime; a `..` segment could escape the worktree
// and let a misconfigured project mount the host filesystem. We refuse
// at save time so an operator can't accidentally publish such a config.
const PREVIEW_COMPOSE_TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;

/**
 * Validate the optional `preview.compose` sub-block. Returns the
 * normalised value on success, `undefined` on absent input, or an error
 * string on the first failure. Defaults are NOT applied here — the
 * runtime fills them in at start time so an operator's stored config
 * round-trips exactly what they typed.
 *
 * Cross-field exclusivity (compose vs. `processes[]` vs. non-default
 * `startScript`) is checked by the caller in `validatePrEnvPreview` so
 * the error message can point at all three fields at once.
 */
function validatePreviewCompose(
  raw: unknown,
): { ok: true; value: ValidatedPreviewComposeConfig | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'prEnv.preview.compose must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  // entryService — required, non-empty, matches the compose service-name rule.
  if (typeof obj.entryService !== 'string') {
    return { ok: false, error: 'prEnv.preview.compose.entryService is required' };
  }
  const entryService = obj.entryService.trim();
  if (!entryService) {
    return { ok: false, error: 'prEnv.preview.compose.entryService is required' };
  }
  if (!PREVIEW_COMPOSE_SERVICE_NAME_RE.test(entryService)) {
    return {
      ok: false,
      error:
        'prEnv.preview.compose.entryService must match [a-zA-Z0-9][a-zA-Z0-9_.-]* ' +
        '(Docker compose service-name rule)',
    };
  }

  // entryPort — required, integer in [1, 65535].
  let entryPort: number | null = null;
  if (typeof obj.entryPort === 'number' && Number.isFinite(obj.entryPort)) {
    entryPort = Math.floor(obj.entryPort);
  } else if (typeof obj.entryPort === 'string' && /^\d+$/.test(obj.entryPort.trim())) {
    entryPort = parseInt(obj.entryPort.trim(), 10);
  }
  if (
    entryPort === null ||
    !Number.isInteger(entryPort) ||
    entryPort < 1 ||
    entryPort > PR_ENV_PREVIEW_PORT_MAX
  ) {
    return {
      ok: false,
      error: `prEnv.preview.compose.entryPort must be an integer between 1 and ${PR_ENV_PREVIEW_PORT_MAX}`,
    };
  }

  // file / envFile — optional relative paths, no traversal, length-capped.
  const validatePath = (
    field: 'file' | 'envFile',
    val: unknown,
  ): { ok: true; value: string | undefined } | { ok: false; error: string } => {
    if (val === undefined || val === null || val === '') return { ok: true, value: undefined };
    if (typeof val !== 'string') {
      return { ok: false, error: `prEnv.preview.compose.${field} must be a string` };
    }
    const t = val.trim();
    if (!t) return { ok: true, value: undefined };
    if (t.length > PREVIEW_COMPOSE_FILE_MAX_LEN) {
      return {
        ok: false,
        error: `prEnv.preview.compose.${field} exceeds ${PREVIEW_COMPOSE_FILE_MAX_LEN} chars`,
      };
    }
    if (t.startsWith('/')) {
      return {
        ok: false,
        error: `prEnv.preview.compose.${field} must be relative to the worktree root (got absolute path)`,
      };
    }
    if (PREVIEW_COMPOSE_TRAVERSAL_RE.test(t)) {
      return {
        ok: false,
        error: `prEnv.preview.compose.${field} must not contain '..' path segments`,
      };
    }
    return { ok: true, value: t };
  };

  const fileResult = validatePath('file', obj.file);
  if (!fileResult.ok) return fileResult;
  const envFileResult = validatePath('envFile', obj.envFile);
  if (!envFileResult.ok) return envFileResult;

  // healthPath — optional, must start with `/`.
  let healthPath: string | undefined;
  if (obj.healthPath !== undefined && obj.healthPath !== null && obj.healthPath !== '') {
    if (typeof obj.healthPath !== 'string') {
      return { ok: false, error: 'prEnv.preview.compose.healthPath must be a string' };
    }
    const hp = obj.healthPath.trim();
    if (hp && !hp.startsWith('/')) {
      return { ok: false, error: 'prEnv.preview.compose.healthPath must start with `/`' };
    }
    if (hp) healthPath = hp;
  }

  // hostPortRange — optional `{min, max}` pair. Both must be integers,
  // 1..65535, and min <= max. We don't enforce overlap with the legacy
  // 4100–4999 range here — operators may intentionally pick a disjoint
  // range to keep compose and spawn previews on separate port windows.
  let hostPortRange: { min: number; max: number } | undefined;
  if (obj.hostPortRange !== undefined && obj.hostPortRange !== null) {
    if (typeof obj.hostPortRange !== 'object' || Array.isArray(obj.hostPortRange)) {
      return {
        ok: false,
        error: 'prEnv.preview.compose.hostPortRange must be an object {min, max}',
      };
    }
    const range = obj.hostPortRange as Record<string, unknown>;
    const parsePort = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
      return null;
    };
    const min = parsePort(range.min);
    const max = parsePort(range.max);
    if (min === null || max === null || min < 1 || max < 1 || min > 65535 || max > 65535) {
      return {
        ok: false,
        error: 'prEnv.preview.compose.hostPortRange.{min,max} must be integers between 1 and 65535',
      };
    }
    if (min > max) {
      return {
        ok: false,
        error: 'prEnv.preview.compose.hostPortRange.min must be ≤ max',
      };
    }
    hostPortRange = { min, max };
  }

  // readyTimeoutMs — optional integer in bounds.
  let readyTimeoutMs: number | undefined;
  if (
    obj.readyTimeoutMs !== undefined &&
    obj.readyTimeoutMs !== null &&
    obj.readyTimeoutMs !== ''
  ) {
    let parsed: number | null = null;
    if (typeof obj.readyTimeoutMs === 'number' && Number.isFinite(obj.readyTimeoutMs)) {
      parsed = Math.floor(obj.readyTimeoutMs);
    } else if (typeof obj.readyTimeoutMs === 'string' && /^\d+$/.test(obj.readyTimeoutMs.trim())) {
      parsed = parseInt(obj.readyTimeoutMs.trim(), 10);
    }
    if (
      parsed === null ||
      parsed < PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS ||
      parsed > PREVIEW_COMPOSE_READY_TIMEOUT_MAX_MS
    ) {
      return {
        ok: false,
        error:
          `prEnv.preview.compose.readyTimeoutMs must be an integer between ` +
          `${PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS} and ${PREVIEW_COMPOSE_READY_TIMEOUT_MAX_MS} ms`,
      };
    }
    readyTimeoutMs = parsed;
  }

  const value: ValidatedPreviewComposeConfig = { entryService, entryPort };
  if (fileResult.value) value.file = fileResult.value;
  if (envFileResult.value) value.envFile = envFileResult.value;
  if (healthPath) value.healthPath = healthPath;
  if (hostPortRange) value.hostPortRange = hostPortRange;
  if (readyTimeoutMs !== undefined) value.readyTimeoutMs = readyTimeoutMs;
  return { ok: true, value };
}

/**
 * Validate the optional `preview` sub-object on a per-project PR-env
 * config. Returns the normalized value on success (or `undefined` when
 * the input is absent), or an error string on the first failure.
 *
 * Note: the parent-`enabled` cross-field check (preview requires the
 * project's PR-env feature on) lives in `validatePrEnvProjectConfig`,
 * not here — this helper only validates the sub-object's own fields.
 */
function validatePrEnvPreview(
  raw: unknown,
): { ok: true; value: ValidatedPrEnvPreviewConfig | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'prEnv.preview must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = !!obj.enabled;
  if (!enabled) {
    // Mirror the parent: keep the slot for round-tripping when toggled off.
    return { ok: true, value: { enabled: false } };
  }

  const trimStr = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };

  const startScript = trimStr(obj.startScript);

  // Port: accept number or numeric string (mirrors `internalPort`).
  let port: number | undefined;
  if (obj.port !== undefined && obj.port !== null && obj.port !== '') {
    if (typeof obj.port === 'number' && Number.isFinite(obj.port)) {
      port = Math.floor(obj.port);
    } else if (typeof obj.port === 'string' && /^\d+$/.test(obj.port.trim())) {
      port = parseInt(obj.port.trim(), 10);
    } else {
      return {
        ok: false,
        error: `prEnv.preview.port must be an integer between ${PR_ENV_PREVIEW_PORT_MIN} and ${PR_ENV_PREVIEW_PORT_MAX}`,
      };
    }
    if (
      !Number.isInteger(port) ||
      port < PR_ENV_PREVIEW_PORT_MIN ||
      port > PR_ENV_PREVIEW_PORT_MAX
    ) {
      return {
        ok: false,
        error: `prEnv.preview.port must be an integer between ${PR_ENV_PREVIEW_PORT_MIN} and ${PR_ENV_PREVIEW_PORT_MAX}`,
      };
    }
  }

  // captureRoutes: array of leading-`/` strings, max 10 entries.
  let captureRoutes: string[] | undefined;
  if (obj.captureRoutes !== undefined && obj.captureRoutes !== null) {
    if (!Array.isArray(obj.captureRoutes)) {
      return { ok: false, error: 'prEnv.preview.captureRoutes must be an array of strings' };
    }
    if (obj.captureRoutes.length > PR_ENV_PREVIEW_MAX_ROUTES) {
      return {
        ok: false,
        error: `prEnv.preview.captureRoutes supports at most ${PR_ENV_PREVIEW_MAX_ROUTES} entries (got ${obj.captureRoutes.length})`,
      };
    }
    const out: string[] = [];
    for (let i = 0; i < obj.captureRoutes.length; i++) {
      const route = obj.captureRoutes[i];
      if (typeof route !== 'string') {
        return {
          ok: false,
          error: `prEnv.preview.captureRoutes[${i}] must be a string`,
        };
      }
      const t = route.trim();
      if (!t.startsWith('/')) {
        return {
          ok: false,
          error: `prEnv.preview.captureRoutes[${i}] must start with \`/\``,
        };
      }
      out.push(t);
    }
    if (out.length > 0) captureRoutes = out;
  }

  // idleTTL: integer seconds in [60, 86400].
  let idleTTL: number | undefined;
  if (obj.idleTTL !== undefined && obj.idleTTL !== null && obj.idleTTL !== '') {
    if (typeof obj.idleTTL === 'number' && Number.isFinite(obj.idleTTL)) {
      idleTTL = Math.floor(obj.idleTTL);
    } else if (typeof obj.idleTTL === 'string' && /^\d+$/.test(obj.idleTTL.trim())) {
      idleTTL = parseInt(obj.idleTTL.trim(), 10);
    } else {
      return {
        ok: false,
        error: `prEnv.preview.idleTTL must be an integer between ${PR_ENV_PREVIEW_IDLE_TTL_MIN} and ${PR_ENV_PREVIEW_IDLE_TTL_MAX} seconds`,
      };
    }
    if (
      !Number.isInteger(idleTTL) ||
      idleTTL < PR_ENV_PREVIEW_IDLE_TTL_MIN ||
      idleTTL > PR_ENV_PREVIEW_IDLE_TTL_MAX
    ) {
      return {
        ok: false,
        error: `prEnv.preview.idleTTL must be an integer between ${PR_ENV_PREVIEW_IDLE_TTL_MIN} and ${PR_ENV_PREVIEW_IDLE_TTL_MAX} seconds`,
      };
    }
  }

  // Compose sub-block. When present, it's mutually exclusive with the
  // spawn-mode fields (`startScript`, `processes[]`) — picking both is
  // almost certainly a typo and the runtime would silently pick one.
  // We surface the conflict at save time so the operator can pick.
  const composeResult = validatePreviewCompose(obj.compose);
  if (!composeResult.ok) return { ok: false, error: composeResult.error };
  if (composeResult.value) {
    if (startScript) {
      return {
        ok: false,
        error:
          'prEnv.preview.compose and prEnv.preview.startScript are mutually exclusive ' +
          "— compose runs the project's docker-compose stack and has no startScript hook",
      };
    }
    if (Array.isArray(obj.processes) && obj.processes.length > 0) {
      return {
        ok: false,
        error:
          'prEnv.preview.compose and prEnv.preview.processes[] are mutually exclusive ' +
          "— compose owns the full multi-service graph via the project's compose file",
      };
    }
  }

  const value: ValidatedPrEnvPreviewConfig = { enabled: true };
  if (startScript) value.startScript = startScript;
  if (port !== undefined) value.port = port;
  if (captureRoutes && captureRoutes.length > 0) value.captureRoutes = captureRoutes;
  if (idleTTL !== undefined) value.idleTTL = idleTTL;
  if (composeResult.value) value.compose = composeResult.value;
  return { ok: true, value };
}

export function validatePrEnvProjectConfig(
  raw: unknown,
): { ok: true; value: ValidatedPrEnvConfig } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: false, error: 'prEnv must be an object' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'prEnv must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = !!obj.enabled;
  if (!enabled) {
    // PR-environments were stripped in the "Strip PR Environments" epic;
    // `prEnv.enabled` is now a no-op for that subsystem. The parent slot is
    // still the home of the worktree-preview config (`prEnv.preview`) and
    // the shared `prEnv.healthPath`, both of which the in-session
    // PreviewRuntime reads regardless of the parent flag. So when parent
    // is disabled we still validate and round-trip those two fields, while
    // dropping anything PR-env-only (startScript, internalPort,
    // setupCommand, dockerfilePath, env) — those are meaningless without
    // the PR-env runner.
    const value: ValidatedPrEnvConfig = { enabled: false };
    if (obj.healthPath !== undefined && obj.healthPath !== null && obj.healthPath !== '') {
      if (typeof obj.healthPath !== 'string') {
        return { ok: false, error: 'prEnv.healthPath must be a string' };
      }
      const hp = obj.healthPath.trim();
      if (hp) {
        if (!hp.startsWith('/')) {
          return { ok: false, error: 'prEnv.healthPath must start with `/`' };
        }
        value.healthPath = hp;
      }
    }
    const previewResult = validatePrEnvPreview(obj.preview);
    if (!previewResult.ok) return { ok: false, error: previewResult.error };
    if (previewResult.value) value.preview = previewResult.value;
    return { ok: true, value };
  }

  const trimStr = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };

  const startScript = trimStr(obj.startScript);
  if (!startScript) {
    return { ok: false, error: 'prEnv.startScript is required when enabled' };
  }

  let internalPort: number | undefined;
  if (typeof obj.internalPort === 'number' && Number.isFinite(obj.internalPort)) {
    internalPort = Math.floor(obj.internalPort);
  } else if (typeof obj.internalPort === 'string' && /^\d+$/.test(obj.internalPort.trim())) {
    internalPort = parseInt(obj.internalPort.trim(), 10);
  }
  if (
    internalPort === undefined ||
    !Number.isInteger(internalPort) ||
    internalPort < 1 ||
    internalPort > 65535
  ) {
    return {
      ok: false,
      error: 'prEnv.internalPort must be an integer between 1 and 65535',
    };
  }

  const setupCommand = trimStr(obj.setupCommand);
  const healthPath = trimStr(obj.healthPath);
  const dockerfilePath = trimStr(obj.dockerfilePath);

  if (healthPath && !healthPath.startsWith('/')) {
    return { ok: false, error: 'prEnv.healthPath must start with `/`' };
  }

  // dockerfilePath must be relative to the checkout dir — `docker build`
  // would just fail otherwise, but a clear field-level error is friendlier
  // than a downstream `invalid reference format` from Docker. Reject
  // absolute paths and any segment that escapes the checkout via `..`.
  if (dockerfilePath) {
    if (dockerfilePath.startsWith('/')) {
      return { ok: false, error: 'prEnv.dockerfilePath must be relative to the repo root' };
    }
    const normalized = dockerfilePath.replace(/\\/g, '/');
    if (normalized.split('/').some((seg) => seg === '..')) {
      return {
        ok: false,
        error: 'prEnv.dockerfilePath must not escape the repo root (no `..` segments)',
      };
    }
  }

  const envResult = validatePrEnvVars(obj.env);
  if (!envResult.ok) return { ok: false, error: envResult.error };

  const previewResult = validatePrEnvPreview(obj.preview);
  if (!previewResult.ok) return { ok: false, error: previewResult.error };

  const value: ValidatedPrEnvConfig = {
    enabled: true,
    startScript,
    internalPort,
  };
  if (setupCommand) value.setupCommand = setupCommand;
  if (healthPath) value.healthPath = healthPath;
  if (dockerfilePath) value.dockerfilePath = dockerfilePath;
  if (envResult.value) value.env = envResult.value;
  if (previewResult.value) value.preview = previewResult.value;
  return { ok: true, value };
}

/**
 * Resolve the user id whose GitHub credentials should be used for a
 * clone. Mirrors `resolveOAuthUserId` in routes/github-oauth.ts:
 *
 *   1. Real JWT caller → `authUserId` is set, use it directly.
 *   2. Local-mode bypass → synthesize / load the singleton `local-<orgId>`
 *      user so the credentials saved via the local-mode connect-token
 *      flow are reachable from this route too.
 *   3. apiKey path or unauth → null. Public repos still clone fine;
 *      private clones simply fall back to the existing "auth required"
 *      error path. We do NOT use the apiKey as a proxy for any
 *      particular user identity.
 */
function resolveCloneUserId(req: Request): string | null {
  const areq = req as AuthenticatedRequest;
  if (areq.authUserId) return areq.authUserId;
  if (areq.authLocalOrgBypass && areq.authOrgId) {
    const username = `local-${areq.authOrgId}`;
    try {
      const existing = getUserByUsername(username);
      if (existing) return existing.id;
      const created = createUser({ username, passwordHash: '' });
      return created.id;
    } catch {
      return null;
    }
  }
  return null;
}

export default function createProjectRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    broadcast,
    findProject,
    findAgent,
    saveProjects,
    ensureProjectRoom,
    config,
    getProjects,
    getProjectDataDir,
    ensureDocsAgents,
    ensureIntakeAgents,
    ensureReviewerAgents,
    ensureContextFiles,
    getClaudeBin,
    setClaudeBin,
    getCursorBin,
    setCursorBin,
    getCodexBin,
    setCodexBin,
  } = deps;

  /** Remove a partially-created project after disk + `projects.json` were persisted but a later step failed (specialist seeding, workflow scaffolding). */
  const rollbackIncompleteProjectCreation = (project: Project, dataDir: string) => {
    try {
      deleteProjectScopedRows(stmts, project);
    } catch (err) {
      console.error(
        `[rollbackIncompleteProjectCreation] DB cleanup failed for "${project.id}":`,
        (err as Error).message,
      );
    }
    const list = getProjects();
    const idx = list.findIndex((p) => p.id === project.id);
    if (idx !== -1) {
      list.splice(idx, 1);
      try {
        saveProjects();
      } catch (saveErr) {
        console.error(
          `[rollbackIncompleteProjectCreation] saveProjects failed for "${project.id}":`,
          (saveErr as Error).message,
        );
      }
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[rollbackIncompleteProjectCreation] Failed to remove data dir "${dataDir}":`,
        (err as Error).message,
      );
    }
  };

  const router = Router();

  router.post('/api/projects/clone', async (req: Request, res: Response) => {
    const { url, targetDir } = req.body as { url?: string; targetDir?: string };
    if (!url) return res.status(400).json({ error: 'url is required' });

    // ── Classify the URL up front so we can fail fast on SSH ───────
    // SSH cloning needs a known_hosts entry + a registered key, neither
    // of which we can guarantee in Docker-deployed Hubs. Surface a
    // pointed message instead of letting git error with the cryptic
    // `Host key verification failed` line.
    const parsed = classifyCloneUrl(url);
    if (parsed.kind === 'github-ssh') {
      return res.status(400).json({ error: SSH_NOT_SUPPORTED_MESSAGE });
    }

    const repoName =
      url
        .replace(/\.git$/, '')
        .split('/')
        .pop() || 'repo';
    const home = process.env.HOME || '/tmp';
    const resolvedTarget = (targetDir || path.join(home, 'projects')).replace(/^~/, home);

    mkdirSync(resolvedTarget, { recursive: true });

    const clonePath = path.join(resolvedTarget, repoName);
    const cloneId = uuidv4();

    if (existsSync(clonePath)) {
      return res.status(409).json({
        error: `Directory already exists: ${clonePath}`,
        existingPath: clonePath,
        cloneId,
      });
    }

    // ── Resolve a user OAuth/PAT token for github-https URLs ───────
    // The connect-token endpoint stores both OAuth and PAT credentials
    // in the same `users.github_user_token` column, so this single
    // lookup covers both flows. For non-github or already-authenticated
    // URLs we leave `spawnUrl` equal to `url` and skip the rewrite.
    let spawnUrl = url;
    let injectedToken: string | null = null;
    if (parsed.kind === 'github-https') {
      try {
        const userId = resolveCloneUserId(req);
        if (userId) {
          const personal = config.personalOAuth;
          const app = config.githubApp;
          const creds =
            personal?.clientId && personal?.clientSecret
              ? { clientId: personal.clientId, clientSecret: personal.clientSecret }
              : app?.clientId && app?.clientSecret
                ? { clientId: app.clientId, clientSecret: app.clientSecret }
                : null;
          const token = await getActiveAccessToken(userId, creds);
          if (token) {
            spawnUrl = buildAuthenticatedUrl(parsed, token);
            injectedToken = token;
          }
        }
      } catch (err) {
        // Token lookup is best-effort: a missing orgs.db, a dead
        // refresh token, or a transient OAuth failure must not block
        // public-repo clones. Fall through with the original URL and
        // let git surface the auth error if the repo turns out to be
        // private.
        console.warn(
          `[clone] Token lookup failed, falling back to unauthenticated clone: ${
            (err as Error).message?.split('\n')[0]
          }`,
        );
      }
    }

    // Pass the spawn URL via argv. We deliberately keep the `cwd`
    // unchanged from the parent so any GIT_* env vars the operator
    // set continue to apply, and we redact the token from any string
    // that gets broadcast or logged.
    const proc: ChildProcess = spawn('git', ['clone', '--progress', spawnUrl, clonePath], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const safeForBroadcast = (text: string): string => redactToken(text, injectedToken);

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          broadcast({ type: 'clone-progress', cloneId, message: safeForBroadcast(trimmed) });
        }
      }
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) broadcast({ type: 'clone-progress', cloneId, message: safeForBroadcast(text) });
    });

    proc.on('error', (err: Error) => {
      broadcast({
        type: 'clone-error',
        cloneId,
        error: `Failed to start git: ${safeForBroadcast(err.message)}`,
      });
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        // Strip the token from the cloned repo's git config so it
        // doesn't persist on disk. We rewrite back to the user's
        // original URL string verbatim — that round-trip is the
        // promise of the clone wizard.
        if (injectedToken) {
          try {
            // execFileSync (no shell) is required here: both `clonePath`
            // (derived from a request-controlled `targetDir` via
            // `mkdirSync(..., { recursive: true })`, which doesn't
            // filter shell metachars) and `url` reach this call. Running
            // them through `sh -c` — even quoted with JSON.stringify —
            // would still expand `$(...)`, backticks, and `$VAR` because
            // those are evaluated inside double quotes. argv-style
            // execution sidesteps the shell entirely.
            execFileSync('git', ['-C', clonePath, 'remote', 'set-url', 'origin', url], {
              stdio: 'ignore',
            });
          } catch (err) {
            // Non-fatal: the repo is cloned and usable. Worst case
            // the user sees the tokenized URL in `git remote -v`
            // until they re-set it. Log so this is debuggable —
            // redacted in case git echoed the rewritten URL into its
            // error message before failing.
            const raw = (err as Error).message ?? String(err);
            console.warn(
              `[clone] Failed to scrub token from origin remote: ${safeForBroadcast(raw)}`,
            );
          }
        }
        // After the clone lands on disk, sniff the workspace for a
        // recognised stack so the wizard can pre-populate the
        // `prEnv.preview` block. The wizard waits for the
        // `clone-preview-defaults` broadcast (or its absence — we
        // always send one) before deciding whether to show "We
        // detected a Vite project — preview is enabled by default" vs
        // the empty preview form.
        let detected = null;
        try {
          detected = detectPreviewDefaults(clonePath);
        } catch {
          /* unknown error → treat as no detection */
        }
        broadcast({
          type: 'clone-preview-defaults',
          cloneId,
          path: clonePath,
          detected: detected
            ? {
                stack: detected.stack,
                startScript: detected.startScript,
                port: detected.port,
                captureRoutes: detected.captureRoutes,
                idleTTL: detected.idleTTL,
              }
            : null,
        });

        broadcast({ type: 'clone-complete', cloneId, path: clonePath, repoName });
      } else {
        let errorMsg = `git clone exited with code ${code}`;
        const safeStderr = safeForBroadcast(stderrBuf);
        if (stderrBuf.includes('Host key verification failed')) {
          errorMsg = SSH_NOT_SUPPORTED_MESSAGE;
        } else if (stderrBuf.includes('Permission denied') || stderrBuf.includes('publickey')) {
          errorMsg =
            'SSH key authentication failed. Use the HTTPS URL form and connect your GitHub account in Settings → GitHub.';
        } else if (
          stderrBuf.includes('could not read Username') ||
          stderrBuf.includes('Authentication failed') ||
          stderrBuf.includes('403')
        ) {
          errorMsg = injectedToken
            ? 'Authentication failed. Your connected GitHub account may not have access to this repo, or the token has expired — try reconnecting in Settings → GitHub.'
            : 'Authentication required for this repo. Connect your GitHub account in Settings → GitHub and try again.';
        } else if (stderrBuf.includes('not found') || stderrBuf.includes('404')) {
          errorMsg = 'Repository not found. Check the URL and your access permissions.';
        } else if (stderrBuf.includes('already exists')) {
          errorMsg = `Directory already exists: ${clonePath}`;
        }
        broadcast({ type: 'clone-error', cloneId, error: errorMsg, stderr: safeStderr });
      }
    });

    const timeout = setTimeout(
      () => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, 2000);
        broadcast({ type: 'clone-error', cloneId, error: 'Clone timed out after 5 minutes' });
      },
      5 * 60 * 1000,
    );

    proc.on('close', () => clearTimeout(timeout));

    // Echo the original URL back to the caller (never the tokenized
    // form). The client tracks the clone via `cloneId` over the
    // WebSocket from this point.
    res.json({ cloneId, repoName, clonePath });
  });

  /**
   * Report whether this project has at least one enabled webhook config
   * row pointing at its GitHub remote. Drives the missing-webhook nudge
   * on the project settings page — projects with `githubRepo` set but
   * no enabled webhook will never see PR events from GitHub and the
   * reviewer pipeline silently never fires.
   *
   * Returns:
   *   - `null` — project has no `githubRepo` (non-GitHub remote, scratch
   *     project). No webhook is even meaningful; the UI hides the field.
   *   - `true` — at least one `webhook_configs` row with `enabled=1`.
   *   - `false` — `githubRepo` set but no enabled row.
   */
  function computeWebhookConfigured(project: Project): boolean | null {
    const repo = (project as { githubRepo?: string | null }).githubRepo;
    if (!repo || !repo.trim()) return null;
    try {
      const rows = stmts.getWebhookConfigsByProject.all(project.id) as Array<{
        enabled: number | null;
      }>;
      return rows.some((r) => r?.enabled === 1);
    } catch {
      // db not initialised / lookup outage — treat as "unknown"; the UI
      // is free to render "checking…" or just hide the nudge.
      return null;
    }
  }

  router.get('/api/projects', (req: Request, res: Response) => {
    const caller = resolveVisibilityCaller(req);
    // Visibility gate: shared projects always pass; private projects only
    // surface to their owner (and local-bundled / apiKey bypass). Org
    // Owners do NOT get a read bypass — they hit the admin endpoint
    // (`GET /api/admin/projects`) for the kill-switch view.
    const projects = filterVisibleProjects(getProjects(), caller);
    const enriched = projects.map((p) => ({
      ...p,
      webhookConfigured: computeWebhookConfigured(p),
      agents: p.agents.map((a) => {
        const sessions = stmts.getSessions.all(a.id) as Array<{ id: string; updated_at: string }>;
        let lastActivity: string | null = null;
        let lastMessage: { role: string; content: string; created_at: string } | null = null;
        if (sessions.length > 0) {
          lastActivity = sessions[0].updated_at;
          const msg = stmts.getLastMessage.get(sessions[0].id) as
            | {
                role: string;
                content: string;
                created_at: string;
              }
            | undefined;
          if (msg) {
            lastMessage = {
              role: msg.role,
              content: msg.content.substring(0, 100),
              created_at: msg.created_at,
            };
          }
        }
        return {
          ...a,
          projectId: p.id,
          projectName: p.name,
          cwd: p.cwd,
          ahw: p.ahw,
          lastActivity,
          lastMessage,
        };
      }),
    }));
    res.json(enriched);
  });

  /**
   * Reorder the persisted project list. Body shape:
   *   { projectIds: string[] }
   *
   * `projectIds` must be a permutation of the **caller-visible** project ids
   * (the same set GET /api/projects returns for this user). The server
   * splices that subset out, reapplies it in the requested order, and
   * leaves any non-visible projects (private projects belonging to other
   * users, etc.) anchored at their existing positions so we don't
   * accidentally shuffle rows the caller can't see.
   *
   * The route is registered BEFORE every `/api/projects/:projectId`
   * handler so Express doesn't match `projectId="order"`.
   */
  router.put('/api/projects/order', (req: Request, res: Response) => {
    const body = req.body as { projectIds?: unknown };
    if (!Array.isArray(body.projectIds)) {
      return res.status(400).json({ error: 'projectIds must be an array of project ids' });
    }
    const requested = body.projectIds;
    if (!requested.every((id): id is string => typeof id === 'string' && id.length > 0)) {
      return res.status(400).json({ error: 'projectIds must contain non-empty strings' });
    }
    if (new Set(requested).size !== requested.length) {
      return res.status(400).json({ error: 'projectIds must not contain duplicates' });
    }

    const caller = resolveVisibilityCaller(req);
    const all = getProjects();
    const visibleIds = filterVisibleProjects(all, caller).map((p) => p.id);
    const visibleIdSet = new Set(visibleIds);
    const requestedSet = new Set(requested);

    // Every requested id must be one this caller can already see.
    const unknown = requested.find((id) => !visibleIdSet.has(id));
    if (unknown) {
      return res.status(400).json({ error: `Unknown or inaccessible project id: ${unknown}` });
    }
    // Every visible id must be present — partial reorders aren't supported.
    // O(n) via Set lookup; the previous `requested.includes(id)` was O(n²).
    const missing = visibleIds.find((id) => !requestedSet.has(id));
    if (missing) {
      return res.status(400).json({ error: `Missing project id in reorder: ${missing}` });
    }

    // Walk the current array and rebuild it: when we hit a slot that holds
    // a caller-visible project, take the next id from `requested` and emit
    // that project instead. Non-visible projects keep their absolute slot.
    const byId = new Map(all.map((p) => [p.id, p]));
    let cursor = 0;
    const reordered = all.map((p) => {
      if (!visibleIdSet.has(p.id)) return p;
      const nextId = requested[cursor++];
      return byId.get(nextId)!;
    });

    // Mutate in place so other modules holding the same array reference
    // (project-model exports the array, not a copy) keep observing the
    // new order — same pattern delete handlers use with `splice`.
    all.splice(0, all.length, ...reordered);
    saveProjects();

    try {
      broadcast({ type: 'projects_updated', reason: 'projects-reordered' });
    } catch {
      /* best-effort — broadcast failure must not fail the request */
    }

    res.json({ projectIds: filterVisibleProjects(getProjects(), caller).map((p) => p.id) });
  });

  /**
   * Owner-only admin list of every project in the org, including private
   * ones the Owner does not own. Powers the Settings → Projects table
   * whose only action on non-owned private projects is delete (kill
   * switch). Payload is intentionally narrow — id, name, visibility,
   * owner — so we don't accidentally leak the contents of a private
   * project the Owner shouldn't be reading.
   */
  router.get('/api/admin/projects', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    const caller = resolveVisibilityCaller(req);
    // Gate: Owner role required, OR a bypass identity (local-bundled /
    // global apiKey) which the resolver collapses into localBypass.
    if (areq.authRole !== 'Owner' && !caller.localBypass) {
      return res.status(403).json({ error: 'Owner role required.' });
    }
    const rows = getProjects().map((p) => {
      const owner = p.ownerUserId ? getUserById(p.ownerUserId) : null;
      return {
        id: p.id,
        name: p.name,
        color: p.color ?? null,
        visibility: getVisibility(p),
        ownerUserId: p.ownerUserId ?? null,
        ownerUsername: owner?.username ?? null,
        canEnter: canViewProject(p, caller),
        agentCount: p.agents?.length ?? 0,
      };
    });
    res.json(rows);
  });

  router.get('/api/setup/status', async (req: Request, res: Response) => {
    const projects = getProjects();
    let claudeAvailable = false;

    try {
      execSync(`"${getClaudeBin()}" --version`, { timeout: 5000, stdio: 'pipe' });
      claudeAvailable = true;
    } catch {}

    const cursorBinResolved = getCursorBin?.() ?? config.cursorBin;
    let cursorAvailable = false;
    try {
      execSync(`"${cursorBinResolved}" --version`, { timeout: 5000, stdio: 'pipe' });
      cursorAvailable = true;
    } catch {}

    const codexBinResolved = getCodexBin?.() ?? config.codexBin;
    let codexAvailable = false;
    try {
      execSync(`"${codexBinResolved}" --version`, { timeout: 5000, stdio: 'pipe' });
      codexAvailable = true;
    } catch {}

    // `hasAnyAiCredentials` mirrors the auth-resolution that `buildSpawnEnv`
    // applies — per-user Claude credentials win, with host config / env vars
    // / on-disk OAuth as fallback. The client uses this to decide whether to
    // pop the SetupWizard regardless of `firstRun`, so an existing user who
    // hits a freshly-reset instance still sees the AI-credentials walkthrough
    // instead of being dropped into the project picker with no working
    // engine. See `engine-auth-status.ts` for the full contract.
    const authedReq = req as AuthenticatedRequest;
    let engineAuth: { claude: boolean; cursor: boolean; codex: boolean; any: boolean };
    try {
      engineAuth = await getEngineAuthStatus({
        config,
        cursorBin: cursorBinResolved,
        userId: authedReq.authUserId ?? null,
        dataDir: config.dataDir,
      });
    } catch {
      engineAuth = { claude: false, cursor: false, codex: false, any: false };
    }

    // `authConfigured` reflects whether the Agent Hub Owner record exists.
    // It is the authoritative signal for "needs first-run setup wizard" —
    // host-level Claude/Cursor/Codex auth (hasAnyAiCredentials) and the
    // auto-seeded default org (getOrgs() on the client) are both routinely
    // true on a fresh install, so neither tells us whether the wizard has
    // actually been completed. See server/auth-store.ts:isAuthConfigured.
    let authConfigured = false;
    try {
      authConfigured = isAuthConfigured();
    } catch {
      // auth-store may not be initialized in some test contexts; treat as
      // not-configured so the wizard runs in tests by default.
      authConfigured = false;
    }

    res.json({
      firstRun: projects.length === 0,
      authConfigured,
      hasAnyAiCredentials: engineAuth.any,
      engineAuth: {
        'claude-code': engineAuth.claude,
        'cursor-agent': engineAuth.cursor,
        'codex-cli': engineAuth.codex,
      },
      engines: {
        'claude-code': {
          available: claudeAvailable,
          authenticated: engineAuth.claude,
          path: getClaudeBin(),
        },
        'cursor-agent': {
          available: cursorAvailable,
          authenticated: engineAuth.cursor,
          path: cursorBinResolved,
        },
        'codex-cli': {
          available: codexAvailable,
          authenticated: engineAuth.codex,
          path: codexBinResolved,
        },
      },
      dataDir: config.dataDir,
      projectsDir: config.projectsDir,
    });
  });

  router.post('/api/setup/configure', (req: Request, res: Response) => {
    const { claudeBin, cursorBin, codexBin } = req.body as {
      claudeBin?: string;
      cursorBin?: string;
      codexBin?: string;
    };

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {}

    if (claudeBin !== undefined) fileConfig.claudeBin = claudeBin;
    if (cursorBin !== undefined) fileConfig.cursorBin = cursorBin;
    if (codexBin !== undefined) fileConfig.codexBin = codexBin;

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

    if (claudeBin !== undefined) {
      setClaudeBin(claudeBin);
      config.claudeBin = claudeBin;
    }
    if (cursorBin !== undefined && setCursorBin) {
      setCursorBin(cursorBin);
      config.cursorBin = cursorBin;
      // Drop any stale cursor-auth cache so the wizard's post-configure
      // GET /api/config/models check probes a fresh `cursor-agent status`
      // against the new bin instead of returning a stale `false` left over
      // from an earlier poll. Without this, Save & Continue can fail on the
      // happy path until the 60s TTL expires.
      invalidateCursorAuthCache();
    }
    if (codexBin !== undefined && setCodexBin) {
      setCodexBin(codexBin);
      config.codexBin = codexBin;
    }

    res.json({ ok: true, message: 'Configuration updated.' });
  });

  router.get('/api/projects/:projectId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // `webhookConfigured` tells the operator at a glance whether this
    // project will see PR events from GitHub. Projects without a
    // `githubRepo` set (non-GitHub remotes, scratch projects) report
    // `null` — N/A, no webhook is even meaningful. Projects with a
    // `githubRepo` but zero enabled `webhook_configs` rows report
    // `false` — the reviewer pipeline will never fire because GitHub
    // can't reach us. This drives the missing-webhook nudge surfaced
    // in the project settings panel.
    const webhookConfigured = computeWebhookConfigured(project);
    res.json({ ...project, webhookConfigured });
  });

  /**
   * One-click webhook setup for a project that has `githubRepo` set but
   * no enabled `webhook_configs` row. Powered by the existing
   * `registerWebhookOnGitHub` helper — same code path the explicit
   * `POST /api/webhooks` route uses.
   *
   * Behavior:
   *   - Returns 400 if the project has no `githubRepo`.
   *   - Returns 409 if at least one enabled webhook config already
   *     exists (idempotent; UI banner won't show in this case, but
   *     defend in depth so a stale client click doesn't duplicate).
   *   - When a GitHub App installation token resolves for the repo
   *     owner, skips per-repo registration (the App delivers events
   *     directly to `/api/webhooks/github`). Still creates the local
   *     `webhook_configs` row so the missing-webhook banner clears.
   *   - Otherwise resolves a token via `registerWebhookOnGitHub`'s
   *     gh-CLI fallback. When that fails (no `GH_TOKEN`, no host gh
   *     auth, no installation, no PAT) we return a structured error
   *     instead of 500 so the UI can render a "configure manually"
   *     link rather than a generic crash.
   *
   * Mirrors the events / allowlist defaults of the existing onboard
   * path in this file so a freshly-onboarded project and an existing
   * project that backfilled via this endpoint have the same shape.
   */
  router.post(
    '/api/projects/:projectId/webhook/auto-configure',
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const githubRepo = (project as { githubRepo?: string | null }).githubRepo;
      if (!githubRepo || !githubRepo.trim()) {
        return res.status(400).json({
          error:
            'Project has no GitHub repo configured. Set `githubRepo` (owner/repo) in project settings before configuring a webhook.',
        });
      }

      // Idempotency: if any enabled row already exists, do nothing.
      try {
        const existing = stmts.getWebhookConfigsByProject.all(project.id) as Array<{
          id: number;
          enabled: number | null;
        }>;
        const enabledRow = existing.find((r) => r?.enabled === 1);
        if (enabledRow) {
          return res.status(409).json({
            error: 'A webhook config is already enabled for this project.',
            existingConfigId: enabledRow.id,
          });
        }
      } catch (err: unknown) {
        // db lookup blew up — surface so the UI doesn't keep retrying.
        return res.status(500).json({
          error: `Failed to read existing webhook configs: ${(err as Error).message}`,
        });
      }

      // Canonical https://github.com/<owner>/<repo> form (no `.git`
      // suffix) — matches the existing two production rows so the
      // missing-webhook predicate clears immediately on success.
      const cleanedRepo = githubRepo.trim().replace(/\.git$/, '');
      const repoUrl = `https://github.com/${cleanedRepo}`;
      const secret = crypto.randomBytes(32).toString('hex');
      const defaultEvents = JSON.stringify({
        'pull_request.opened': { enabled: true },
        'pull_request.synchronize': { enabled: true },
        'pull_request_review_comment.created': { enabled: true },
        'pull_request.closed': { enabled: false },
        'pull_request_review.submitted': { enabled: false },
        'check_suite.completed': { enabled: false },
        'check_run.completed': { enabled: false },
      });

      let created: WebhookConfigRow;
      try {
        const result = stmts.createWebhookConfig.run(
          project.id,
          repoUrl,
          secret,
          defaultEvents,
          1,
          '[]',
        );
        created = stmts.getWebhookConfig.get(result.lastInsertRowid) as WebhookConfigRow;
      } catch (err: unknown) {
        return res
          .status(500)
          .json({ error: `Failed to create webhook config: ${(err as Error).message}` });
      }

      // Seed reviewer agents now that the project has GitHub integration.
      try {
        const reviewersChanged = ensureReviewerAgents();
        if (reviewersChanged) {
          broadcast({ type: 'projects_updated', reason: 'webhook-auto-configured' });
        }
      } catch (err: unknown) {
        console.warn(`[Webhooks] ensureReviewerAgents failed: ${(err as Error).message}`);
      }

      // Path A: GitHub App installation already covers this OWNER and
      // grants access to THIS REPO — no per-repo webhook needed. The App
      // delivers events to `/api/webhooks/github` signed with
      // `config.githubApp.webhookSecret`.
      //
      // We must probe repo access, not just owner-level installation:
      // GitHub Apps can be installed with "selected repositories" scope,
      // in which case `tryGetInstallationToken(owner)` happily returns a
      // token but the App is NOT granted access to this specific repo
      // and will silently never deliver its events. Without the probe
      // the route would happily return `skipped: true`, the local row
      // would clear the banner, and the reviewer pipeline would silently
      // fail for the repo — the exact failure mode this PR set out to
      // close.
      try {
        const owner = cleanedRepo.split('/')[0];
        const installToken = config.githubApp?.appId ? await tryGetInstallationToken(owner) : null;
        if (installToken) {
          let repoAccessible = false;
          try {
            await callGitHubApiWithToken<unknown>(`repos/${cleanedRepo}`, installToken);
            repoAccessible = true;
          } catch (probeErr: unknown) {
            console.warn(
              `[Webhooks] App-install repo access probe failed for ${cleanedRepo}, falling back to per-repo registration: ${(probeErr as Error).message.split('\n')[0]}`,
            );
          }
          if (repoAccessible) {
            return res.json({
              config: created,
              registration: {
                ok: true,
                skipped: true,
                reason: 'github_app_installed',
                message: `The GitHub App is installed on ${owner} and has access to ${cleanedRepo}; PR events will reach Agent Hub automatically.`,
              },
            });
          }
          // Owner-installed but this repo isn't in the App's selected
          // set — fall through. `registerWebhookOnGitHub`'s own
          // install-token-then-gh-CLI ladder handles the per-repo
          // registration correctly (and will 404 with a clean error if
          // the gh CLI also lacks the scope).
        }
      } catch (parseErr: unknown) {
        // Token lookup blew up — fall through to per-repo registration.
        console.warn(
          `[Webhooks] App-install check failed for ${repoUrl}, falling back to per-repo registration: ${(parseErr as Error).message}`,
        );
      }

      // Path B: per-repo webhook registration via `gh` / installation
      // token. Returns a structured error envelope on failure so the UI
      // banner can render a "configure manually" hint.
      try {
        const regResult = await registerWebhookOnGitHub(created);
        return res.json({ config: created, registration: regResult });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.json({
          config: created,
          registration: { ok: false, error: msg },
        });
      }
    },
  );

  // ─── Re-detect preview defaults from the project's checkout ──────
  //
  // The Settings → Preview panel exposes a "Re-detect from repo" action so
  // users can re-run the same workspace sniff that the new-project /
  // clone-from-GitHub flows do, without having to clone again. We hand
  // back the raw `DetectedPreviewDefaults` so the client can show a diff
  // and let the user accept-overwrite or dismiss. Pure read — no
  // mutation of `projects.json` happens server-side; the client follows
  // up with a normal `PATCH /api/projects/:id` if the user accepts.
  router.post('/api/projects/:projectId/preview/detect', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const cwd = (project as { cwd?: string }).cwd;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Project has no cwd configured' });
    }
    let detected: ReturnType<typeof detectPreviewDefaults> = null;
    try {
      detected = detectPreviewDefaults(cwd);
    } catch {
      // Treat any unexpected fs error as "no signal" — same contract
      // as the clone path's wrapper.
      detected = null;
    }
    res.json({
      detected: detected
        ? {
            stack: detected.stack,
            startScript: detected.startScript,
            port: detected.port,
            captureRoutes: detected.captureRoutes,
            idleTTL: detected.idleTTL,
          }
        : null,
    });
  });

  // ─── One-shot preview test ────────────────────────────────────────
  //
  // Settings → Preview's "Test preview" button calls this endpoint. It
  // runs the configured startScript inside `project.cwd/client`,
  // allocates a port, polls `healthPath` with a 120s timeout (matches
  // `PreviewRuntime`), captures a single screenshot on success, and
  // tears down the spawned process in a `finally` so no orphaned dev
  // server is left behind. Pure read of `projects.json` — no session,
  // no worktree, no DB row written.
  //
  // Response shape:
  //   { ok, ports: { allocated }, durationMs, logTail, screenshotUrl?, error? }
  //
  // Errors are always `200 OK` with `ok:false` + `error` so the panel can
  // render them inline (this isn't a server fault, it's user config).
  router.post(
    '/api/projects/:projectId/preview/test',
    async (req: Request, res: Response): Promise<void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      // `serverDir/uploads` matches the static-file mount in `index.ts`.
      const uploadsDir = path.join(deps.serverDir, 'uploads');
      try {
        const result = await runPreviewTest({
          project,
          uploadsDir,
          publicUrl: config.publicUrl,
        });
        res.json(result);
      } catch (err) {
        // runPreviewTest is designed to swallow all operational failures
        // and return ok:false. A throw here is unexpected — surface it
        // verbatim so we can debug rather than papering over the bug.
        res.status(500).json({
          ok: false,
          ports: { allocated: null },
          durationMs: 0,
          error: `Unexpected preview-test error: ${(err as Error).message}`,
          logTail: [],
        });
      }
    },
  );

  // ─── Branch listing for the PR base-branch picker ─────────────────
  //
  // Cards can override the PR base branch (via `pr_base_branch`). The card
  // configuration UI needs to list every branch the project's git remote
  // knows about — including feature branches that don't exist locally — so
  // users can target stacked / dependent PRs.
  //
  // Strategy: shell out to `git ls-remote --heads origin` from the project
  // cwd. This works for any GitHub-connected project whose repo is checked
  // out at `project.cwd`, regardless of whether the GitHub App is installed.
  // The result is cached briefly per-project to avoid hammering the remote
  // when the picker re-opens.
  interface BranchListEntry {
    name: string;
    isDefault: boolean;
  }
  interface BranchCacheEntry {
    branches: BranchListEntry[];
    fetchedAt: number;
  }
  const BRANCH_CACHE_TTL_MS = 30_000;
  const branchCache = new Map<string, BranchCacheEntry>();

  router.get(
    '/api/projects/:projectId/branches',
    async (req: Request, res: Response): Promise<void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      if (!project.cwd || !existsSync(project.cwd)) {
        res.status(400).json({ error: 'Project cwd is missing or does not exist on disk' });
        return;
      }

      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      const cached = branchCache.get(project.id);
      if (!force && cached && Date.now() - cached.fetchedAt < BRANCH_CACHE_TTL_MS) {
        res.json({ branches: cached.branches, cached: true });
        return;
      }

      try {
        // Confirm there's a git remote first so we return a clean error
        // instead of letting `ls-remote` produce a cryptic stderr.
        try {
          await execAsync('git remote get-url origin', {
            cwd: project.cwd,
            timeout: 5000,
          });
        } catch {
          res.status(400).json({
            error: 'Project has no `origin` git remote configured',
            branches: [],
          });
          return;
        }

        const { stdout } = await execAsync('git ls-remote --heads origin', {
          cwd: project.cwd,
          timeout: 15_000,
          maxBuffer: 5 * 1024 * 1024,
        });

        // Lines look like: "<sha>\trefs/heads/<branch-name>"
        const branchNames: string[] = [];
        for (const line of stdout.split('\n')) {
          const match = line.match(/^[0-9a-f]{40,}\trefs\/heads\/(.+)$/);
          if (match) branchNames.push(match[1].trim());
        }
        branchNames.sort((a, b) => a.localeCompare(b));

        // Resolve the default branch so the UI can flag it. Reuse the same
        // ordering as `auto-git.ts#resolveDefaultBranch`: origin/HEAD, then
        // local main / master.
        let defaultBranch: string | null = null;
        try {
          const { stdout: headOut } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
            cwd: project.cwd,
            timeout: 5000,
          });
          defaultBranch = headOut.trim().replace('refs/remotes/origin/', '') || null;
        } catch {
          for (const candidate of ['main', 'master']) {
            if (branchNames.includes(candidate)) {
              defaultBranch = candidate;
              break;
            }
          }
        }

        const branches: BranchListEntry[] = branchNames.map((name) => ({
          name,
          isDefault: name === defaultBranch,
        }));
        branchCache.set(project.id, { branches, fetchedAt: Date.now() });
        res.json({ branches, defaultBranch, cached: false });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[projects] branch listing failed for ${project.id}: ${msg}`);
        res.status(500).json({ error: `Failed to list branches: ${msg}`, branches: [] });
      }
    },
  );

  router.post('/api/projects', (req: Request, res: Response) => {
    const projects = getProjects();
    const {
      id,
      name,
      cwd,
      color,
      commands,
      preCommitCommands,
      checkHealCommands,
      checkHealMaxRounds,
      mode,
      visibility: requestedVisibility,
      engine: requestedEngine,
    } = req.body as {
      id?: string;
      name?: string;
      cwd?: string;
      color?: string;
      commands?: ProjectCommands;
      preCommitCommands?: unknown;
      checkHealCommands?: unknown;
      checkHealMaxRounds?: unknown;
      mode?: unknown;
      visibility?: unknown;
      engine?: unknown;
    };
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: 'id is required and must be alphanumeric+hyphens' });
    }
    if (findProject(id)) {
      return res.status(409).json({ error: 'Project id already exists' });
    }
    // Optional `mode` lets callers create a tasks-only project up front
    // (`mode: 'workflow'` + no `githubRepo`) without a follow-up PATCH.
    let createMode: ProjectMode | undefined;
    if (mode !== undefined && mode !== null && mode !== '') {
      if (mode === 'dev' || mode === 'workflow') {
        createMode = mode;
      } else {
        return res.status(400).json({ error: 'mode must be "dev", "workflow", or null' });
      }
    }
    // Optional `engine` lets workflow callers (Cursor-only installs, etc.)
    // override the seeded lead agent's engine without a follow-up PATCH.
    // Currently only consulted in workflow scaffolding below; ignored for
    // dev mode (the onboard route owns dev agent rosters). Validation is
    // permissive — the per-engine binary check happens at spawn time.
    const VALID_ENGINES = ['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli'] as const;
    let resolvedEngine: (typeof VALID_ENGINES)[number] = 'claude-code';
    if (requestedEngine !== undefined && requestedEngine !== null && requestedEngine !== '') {
      if (
        typeof requestedEngine === 'string' &&
        (VALID_ENGINES as readonly string[]).includes(requestedEngine)
      ) {
        resolvedEngine = requestedEngine as (typeof VALID_ENGINES)[number];
      } else {
        return res
          .status(400)
          .json({ error: `engine must be one of: ${VALID_ENGINES.join(', ')}` });
      }
    }
    // Visibility — default `'shared'` so existing wizards that omit the
    // field keep the pre-feature behavior. Anything else (`'private'`)
    // must be explicit. Invalid strings hard-fail rather than silently
    // collapsing to a default — a typo here would silently expose a
    // project the user thought was private.
    let createVisibility: 'shared' | 'private' = 'shared';
    if (
      requestedVisibility !== undefined &&
      requestedVisibility !== null &&
      requestedVisibility !== ''
    ) {
      if (requestedVisibility === 'shared' || requestedVisibility === 'private') {
        createVisibility = requestedVisibility;
      } else {
        return res.status(400).json({ error: 'visibility must be "shared" or "private"' });
      }
    }
    // Stamp the creator from the authenticated identity. Per-user JWTs and
    // `ahub_*` keys both populate `authUserId`. The global apiKey path,
    // single-tenant local mode, and no-auth-configured installs leave it
    // `null` — those callers see every project via the bypass branches
    // in `resolveVisibilityCaller`, so a null-owner private project is
    // still reachable to them.
    //
    // In a real multi-user deployment (auth configured, no bypass active)
    // a `private` project with no owner would be unreachable forever, so
    // we refuse that combination explicitly to avoid bricking the row.
    const ownerUserId = (req as AuthenticatedRequest).authUserId ?? null;
    const visibilityCallerCtx = resolveVisibilityCaller(req);
    if (createVisibility === 'private' && !ownerUserId && !visibilityCallerCtx.localBypass) {
      return res.status(400).json({
        error: 'Private projects require an authenticated user (JWT or per-user API key).',
      });
    }
    const dataDir = getProjectDataDir(id);
    const project: Project = {
      id,
      name: name || id,
      cwd: cwd || config.defaultCwd,
      ahw: dataDir,
      color: color || '#6b7280',
      visibility: createVisibility,
      ownerUserId,
      agents: [],
    };
    if (createMode) (project as Record<string, unknown>).mode = createMode;
    if (commands && typeof commands === 'object') {
      (project as Record<string, unknown>).commands = {
        install: commands.install || null,
        build: commands.build || null,
        test: commands.test || null,
        lint: commands.lint || null,
      };
    }
    const pcCreate = normalizePreCommitCommands(preCommitCommands);
    if (pcCreate.length) (project as Record<string, unknown>).preCommitCommands = pcCreate;
    const healCreate = normalizePreCommitCommands(checkHealCommands);
    if (healCreate.length) (project as Record<string, unknown>).checkHealCommands = healCreate;
    if ((req.body as Record<string, unknown>).checkHealMaxRounds !== undefined) {
      const healRoundsCreate = normalizeCheckHealMaxRounds(checkHealMaxRounds);
      if (healRoundsCreate == null) {
        return res.status(400).json({ error: CHECK_HEAL_MAX_ROUNDS_INVALID });
      }
      (project as Record<string, unknown>).checkHealMaxRounds = healRoundsCreate;
    }
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
    mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

    projects.push(project);
    saveProjects();

    // Workflow-mode scaffolding — match the shell a dev project gets minus
    // the GitHub/PR-specific bits. Without this, the wizard lands the user
    // on a blank page: no kanban columns until they visit /board, no default
    // agent (so `ensureProjectRoom` early-returns), and no conference room.
    // We seed the minimum so the project is immediately usable as a
    // tasks-only workspace.
    //
    // Roster on a fresh workflow project:
    //   1. A single primary "Agent" — workflow projects have no git repo,
    //      so we call them "<Project> Agent" rather than "<Project> Dev".
    //   2. A Docs agent (`ensureDocsAgents()`), enabled for all projects.
    //   3. An Intake agent (`ensureIntakeAgents()`), enabled for all projects.
    //   4. A Reviewer agent is NOT seeded here — Reviewer is GitHub-only
    //      (`ensureReviewerAgents()` gates on `githubRepo` / webhooks).
    if (createMode === 'workflow') {
      try {
        // 1. Pre-create the kanban board with default columns so the user
        //    lands on a structured To Do → Done view.
        getOrCreateBoard(stmts, project.id);

        // 2. Seed the primary agent so subsequent helpers
        //    (`ensureProjectRoom`, `ensureDocsAgents`, `ensureIntakeAgents`)
        //    have an anchor — those helpers early-return on
        //    `project.agents.length === 0`. Engine defaults to claude-code
        //    but is overridable via the optional `engine` POST field for
        //    Cursor-only installs.
        const primaryAgentId = `${project.id}-agent`;
        if (!findAgent(primaryAgentId)) {
          const primaryAgent: Agent = {
            id: primaryAgentId,
            name: `${project.name} Agent`,
            engine: resolvedEngine,
            role: 'dev',
            color: project.color,
            systemPrompt: `You are the primary agent for the ${project.name} workspace — a non-coding (workflow-mode) project on Agent Hub.

You own:
- The kanban board (To Do → Done) at /api/projects/${project.id}/board
- The wiki at /api/projects/${project.id}/wiki
- Conversations with collaborators in this workspace's conference room
- Triaging and routing user requests through the board

This workspace has no git repo and no PR automation — your job is planning, organizing, and synthesizing, not shipping code. Use the kanban board to track work, the wiki to capture decisions and reference material, and chat sessions to drive the work forward.`,
            heartbeat: { enabled: false, interval: '', prompt: '' },
          };
          mkdirSync(path.join(dataDir, 'agents', primaryAgentId), { recursive: true });
          writeFileSync(
            path.join(dataDir, 'agents', primaryAgentId, 'IDENTITY.md'),
            `# ${project.name} Agent\n\nYou are the primary agent for the ${project.name} workspace. You own the kanban board, the wiki, and routing user requests into actionable work. This is a non-coding workspace — no git repo, no PRs.\n`,
            'utf-8',
          );
          project.agents.push(primaryAgent);
        }

        // 3. Persist the seeded primary agent before invoking the
        //    docs/intake helpers — they pick the project up via the
        //    in-memory `projects` array and call `saveProjects()`
        //    themselves once they add their own rows.
        saveProjects();

        // 4. Seed Docs and Intake for every project (Reviewer is GitHub-only
        //    and skipped here intentionally — `ensureReviewerAgents()` gates
        //    on `githubRepo` / webhook configs).
        ensureDocsAgents();
        ensureIntakeAgents();

        // 5. Create the project's conference room now that we have an
        //    anchor agent.
        ensureProjectRoom(project);

        // 6. Seed the workspace's top-level context files (SOUL.md, AGENTS.md,
        //    USER.md, TOOLS.md, MEMORY.md). Without this, a freshly-scaffolded
        //    workflow project's data dir has empty `agents/`, `skills/`,
        //    `memory/` subdirs but no top-level context files until the next
        //    server restart — `ensureContextFiles()` is otherwise only
        //    invoked at startup (`server/index.ts:302`).
        ensureContextFiles();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[POST /api/projects] Workflow scaffolding failed for "${project.id}": ${message}`,
        );
        rollbackIncompleteProjectCreation(project, dataDir);
        return res.status(500).json({
          error: 'workflow_scaffolding_failed',
          message,
        });
      }
    }

    // Notify connected clients so sidebars / project lists refresh without
    // a full reload — matches the broadcast already done by the richer
    // /api/projects/onboard path.
    try {
      broadcast({ type: 'projects_updated', reason: 'project-created' });
    } catch {
      /* best-effort — broadcast failure must not fail the request */
    }
    res.status(201).json(project);
  });

  router.patch('/api/projects/:projectId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const allowed = ['name', 'cwd', 'color', 'defaultReviewer', 'githubRepo'] as const;
    for (const key of allowed) {
      if ((req.body as Record<string, unknown>)[key] !== undefined)
        (project as Record<string, unknown>)[key] = (req.body as Record<string, unknown>)[key];
    }
    if (
      (req.body as Record<string, unknown>).commands &&
      typeof (req.body as Record<string, unknown>).commands === 'object'
    ) {
      if (!(project as Record<string, unknown>).commands)
        (project as Record<string, unknown>).commands = {};
      const projectCommands = (project as Record<string, unknown>).commands as Record<
        string,
        unknown
      >;
      const bodyCommands = (req.body as Record<string, unknown>).commands as Record<
        string,
        unknown
      >;
      for (const cmd of ['install', 'build', 'test', 'lint']) {
        if (bodyCommands[cmd] !== undefined) {
          projectCommands[cmd] = bodyCommands[cmd] || null;
        }
      }
    }
    if (
      (req.body as Record<string, unknown>).githubWorkflow &&
      typeof (req.body as Record<string, unknown>).githubWorkflow === 'object'
    ) {
      if (!(project as Record<string, unknown>).githubWorkflow)
        (project as Record<string, unknown>).githubWorkflow = {};
      const projectGhw = (project as Record<string, unknown>).githubWorkflow as Record<
        string,
        unknown
      >;
      const bodyGhw = (req.body as Record<string, unknown>)
        .githubWorkflow as GithubWorkflowSettings;
      for (const key of [
        'autoMerge',
        'autoReview',
        'waitForCI',
        'waitForResolvedComments',
      ] as const) {
        if (bodyGhw[key] !== undefined) {
          projectGhw[key] = !!bodyGhw[key];
        }
      }
      if (bodyGhw.reviewerModel !== undefined) {
        if (bodyGhw.reviewerModel === null || bodyGhw.reviewerModel === '') {
          delete projectGhw.reviewerModel;
        } else if (typeof bodyGhw.reviewerModel === 'string') {
          const trimmed = bodyGhw.reviewerModel.trim();
          if (trimmed) projectGhw.reviewerModel = trimmed;
          else delete projectGhw.reviewerModel;
        }
      }
    }
    if ((req.body as Record<string, unknown>).preCommitCommands !== undefined) {
      const rawPc = (req.body as Record<string, unknown>).preCommitCommands;
      const pc = normalizePreCommitCommands(rawPc);
      if (pc.length) (project as Record<string, unknown>).preCommitCommands = pc;
      else delete (project as Record<string, unknown>).preCommitCommands;
    }
    if ((req.body as Record<string, unknown>).checkHealCommands !== undefined) {
      const rawH = (req.body as Record<string, unknown>).checkHealCommands;
      const h = normalizePreCommitCommands(rawH);
      if (h.length) (project as Record<string, unknown>).checkHealCommands = h;
      else delete (project as Record<string, unknown>).checkHealCommands;
    }
    if ((req.body as Record<string, unknown>).checkHealMaxRounds !== undefined) {
      const rawR = (req.body as Record<string, unknown>).checkHealMaxRounds;
      if (rawR === null || rawR === '') {
        delete (project as Record<string, unknown>).checkHealMaxRounds;
      } else {
        const n = normalizeCheckHealMaxRounds(rawR);
        if (n == null) {
          return res.status(400).json({ error: CHECK_HEAL_MAX_ROUNDS_INVALID });
        }
        (project as Record<string, unknown>).checkHealMaxRounds = n;
      }
    }
    if ((req.body as Record<string, unknown>).orchestrationBudgets !== undefined) {
      const rawOb = (req.body as Record<string, unknown>).orchestrationBudgets;
      if (rawOb === null) {
        delete (project as Record<string, unknown>).orchestrationBudgets;
      } else if (typeof rawOb === 'object' && rawOb !== null && !Array.isArray(rawOb)) {
        const sanitized = sanitizeOrchestrationBudgetsPartial(rawOb);
        if (sanitized && Object.keys(sanitized).length > 0) {
          (project as Record<string, unknown>).orchestrationBudgets = sanitized as Record<
            string,
            unknown
          >;
        } else {
          delete (project as Record<string, unknown>).orchestrationBudgets;
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'prEnv')) {
      const rawPrEnv = (req.body as Record<string, unknown>).prEnv;
      if (rawPrEnv === null) {
        delete (project as Record<string, unknown>).prEnv;
      } else {
        const result = validatePrEnvProjectConfig(rawPrEnv);
        if (!result.ok) {
          return res.status(400).json({ error: result.error });
        }
        (project as Record<string, unknown>).prEnv = result.value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'repoUrl')) {
      // Accept null / empty string → clear the field. Otherwise must be a
      // recognised github-https URL. SSH URLs and other hosts are rejected
      // here so a misconfigured project can't try to auto-clone using a
      // form we can't authenticate. Reuses `classifyCloneUrl` so the
      // accepted URL shapes stay in lockstep with `POST /api/projects/clone`.
      const rawRepoUrl = (req.body as Record<string, unknown>).repoUrl;
      if (rawRepoUrl === null || rawRepoUrl === '') {
        delete (project as Record<string, unknown>).repoUrl;
      } else if (typeof rawRepoUrl !== 'string') {
        return res.status(400).json({ error: 'repoUrl must be a string, null, or empty' });
      } else {
        const trimmed = rawRepoUrl.trim();
        if (!trimmed) {
          delete (project as Record<string, unknown>).repoUrl;
        } else {
          const parsedRepo = classifyCloneUrl(trimmed);
          if (parsedRepo.kind === 'github-ssh') {
            return res.status(400).json({ error: SSH_NOT_SUPPORTED_MESSAGE });
          }
          if (parsedRepo.kind !== 'github-https') {
            return res.status(400).json({
              error: 'repoUrl must be an HTTPS GitHub URL (https://github.com/owner/repo or .git).',
            });
          }
          (project as Record<string, unknown>).repoUrl = trimmed;
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'mode')) {
      const rawMode = (req.body as Record<string, unknown>).mode;
      if (rawMode === null || rawMode === undefined || rawMode === '') {
        delete (project as Record<string, unknown>).mode;
      } else if (rawMode === 'dev' || rawMode === 'workflow') {
        (project as Record<string, unknown>).mode = rawMode as ProjectMode;
      } else {
        return res.status(400).json({ error: 'mode must be "dev", "workflow", or null' });
      }
    }
    // ─── Visibility (shared ↔ private) ──────────────────────────────
    // Mirrors the create-time validation but additionally enforces the
    // role-gated transition policy (see `canChangeVisibility`). Two
    // transitions are real:
    //   - shared → private ("claim"): org Owner only. `ownerUserId`
    //     stamped from the body (when provided) or the caller. We require
    //     a non-null owner unless localBypass is active (single-tenant).
    //   - private → shared ("publish"): current ownerUserId OR org Owner.
    //     We unconditionally clear `ownerUserId` so a future re-claim
    //     stamps a fresh owner rather than inheriting the previous one.
    // Same-visibility "no-op" patches are accepted and stamp the
    // optional new owner only if the caller is allowed (Owner) — useful
    // for transferring ownership of a private project.
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'visibility')) {
      const rawVisibility = (req.body as Record<string, unknown>).visibility;
      if (
        rawVisibility !== 'shared' &&
        rawVisibility !== 'private' &&
        rawVisibility !== null &&
        rawVisibility !== undefined &&
        rawVisibility !== ''
      ) {
        return res.status(400).json({ error: 'visibility must be "shared" or "private"' });
      }
      const targetVisibility: 'shared' | 'private' =
        rawVisibility === 'private' ? 'private' : 'shared';
      const currentVisibility = getVisibility(project);
      const transition = classifyVisibilityTransition(currentVisibility, targetVisibility);
      const caller = resolveVisibilityCaller(req);
      if (!canChangeVisibility(project, transition, caller)) {
        return res.status(403).json({
          error:
            transition === 'shared->private'
              ? 'Only org Owners can make a shared project private.'
              : 'Only the project owner or an org Owner can publish a private project.',
        });
      }
      // Resolve ownerUserId for the post-state:
      //   - publish: always clear.
      //   - claim:   prefer body.ownerUserId if provided (Owner can claim on
      //              behalf of another user), otherwise stamp the caller.
      //              Validate the user exists.
      //   - noop:    leave ownerUserId untouched (transfer-of-ownership is
      //              out of scope for v1; a follow-up card can add it).
      if (transition === 'private->shared') {
        (project as Record<string, unknown>).visibility = 'shared';
        (project as Record<string, unknown>).ownerUserId = null;
      } else if (transition === 'shared->private') {
        let nextOwner: string | null = caller.userId ?? null;
        if (Object.prototype.hasOwnProperty.call(req.body as object, 'ownerUserId')) {
          const rawOwner = (req.body as Record<string, unknown>).ownerUserId;
          if (rawOwner === null || rawOwner === '') {
            // Explicit null means "stamp me" — same as omitting the field.
            nextOwner = caller.userId ?? null;
          } else if (typeof rawOwner !== 'string') {
            return res
              .status(400)
              .json({ error: 'ownerUserId must be a string user id, null, or omitted' });
          } else {
            const trimmed = rawOwner.trim();
            if (!trimmed) {
              nextOwner = caller.userId ?? null;
            } else if (!getUserById(trimmed)) {
              return res.status(400).json({ error: 'ownerUserId does not match any user' });
            } else {
              nextOwner = trimmed;
            }
          }
        }
        if (!nextOwner && !caller.localBypass) {
          return res.status(400).json({
            error:
              'Private projects require an authenticated user (JWT or per-user API key) to be the owner.',
          });
        }
        (project as Record<string, unknown>).visibility = 'private';
        (project as Record<string, unknown>).ownerUserId = nextOwner;
      }
      // noop: visibility unchanged; intentionally no-op for ownerUserId
      // in v1. A future ownership-transfer endpoint will live here.
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'browserToolsDefaultEnabled')) {
      const v = (req.body as Record<string, unknown>).browserToolsDefaultEnabled;
      if (v === null || v === undefined) {
        delete (project as Record<string, unknown>).browserToolsDefaultEnabled;
      } else if (v === true || v === false) {
        (project as Record<string, unknown>).browserToolsDefaultEnabled = v;
      } else {
        return res.status(400).json({
          error: 'browserToolsDefaultEnabled must be a boolean, null, or omitted',
        });
      }
    }
    {
      const err =
        patchProjectOptionalBrowserDimension(
          project,
          req.body as Record<string, unknown>,
          'browserViewportWidth',
          320,
          3840,
        ) ||
        patchProjectOptionalBrowserDimension(
          project,
          req.body as Record<string, unknown>,
          'browserViewportHeight',
          240,
          2160,
        ) ||
        patchProjectBrowserPageLoadTimeout(project, req.body as Record<string, unknown>);
      if (err) return res.status(400).json({ error: err });
    }
    if (
      (req.body as Record<string, unknown>).githubRepo &&
      typeof (req.body as Record<string, unknown>).githubRepo === 'string'
    ) {
      const repoUrl = `https://github.com/${(req.body as Record<string, unknown>).githubRepo}`;
      const existing = stmts.getWebhookConfigByProjectAndRepo.get(project.id, repoUrl) as
        | Record<string, unknown>
        | undefined;
      if (!existing) {
        const secret = crypto.randomBytes(32).toString('hex');
        // Default-on set is deliberately scoped to events the autonomous-mode
        // polling safety net in `autonomous.ts` does NOT already cover. The
        // three events seeded as `enabled: false` below are handled by the
        // every-3-minute poll:
        //   - pull_request.closed           → reconcileKanbanWithGitHub sweeps merged PRs to Done
        //   - pull_request_review.submitted → pollForMissedReviews catches changes_requested
        //   - check_suite.completed         → not polled by default; autofix-on-CI is opt-in
        // They're still seeded (rather than omitted) so they appear in the
        // webhook config UI pre-wired for operators to flip on per-repo.
        // Prior default-on all six caused 1,079 Claude invocations in one
        // log window under routine PR activity (incident 2026-04-16).
        const defaultEvents = JSON.stringify({
          'pull_request.opened': { enabled: true },
          'pull_request.synchronize': { enabled: true },
          'pull_request_review_comment.created': { enabled: true },
          'pull_request.closed': { enabled: false },
          'pull_request_review.submitted': { enabled: false },
          'check_suite.completed': { enabled: false },
          'check_run.completed': { enabled: false },
        });
        stmts.createWebhookConfig.run(project.id, repoUrl, secret, defaultEvents, 1, '[]');
      }
    }
    saveProjects();
    res.json(project);
  });

  router.delete('/api/projects/:projectId', (req: Request, res: Response) => {
    const projects = getProjects();
    const idx = projects.findIndex((p) => p.id === req.params.projectId);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const project = projects[idx];

    // Visibility gate. Owners get an explicit kill-switch path here even
    // for private projects they don't own — that's the Settings → Projects
    // admin escape hatch. Non-owners trying to delete someone else's
    // private project get a 404 (same shape as "doesn't exist") rather
    // than 403, so we don't leak existence.
    const caller = resolveVisibilityCaller(req);
    if (!canDeleteProject(project, caller)) {
      // canDeleteProject = canViewProject || role==='Owner', so !canDeleteProject
      // implies !canViewProject AND not an Owner. Mask as 404 — same shape the
      // route returns when the project is genuinely missing, so we don't leak
      // that the private project exists.
      return res.status(404).json({ error: 'Project not found' });
    }

    deleteProjectScopedRows(stmts, project);

    projects.splice(idx, 1);
    saveProjects();
    res.status(204).end();
  });

  // ─── Project analysis (Open Project wizard) ──────────────────────
  router.post('/api/projects/analyze', async (req: Request, res: Response) => {
    const { cwd } = req.body as { cwd?: string };
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });

    const resolvedCwd = cwd.replace(/^~/, process.env.HOME || '/tmp');
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      return res.status(400).json({ error: 'Path does not exist or is not a directory' });
    }

    const analyzeId = uuidv4();

    // Resolve which engine to drive the analysis. Claude Code is preferred
    // because it's the only engine whose stream-json output we currently
    // parse for live progress events; fallback engines run without
    // streaming progress but still produce a valid JSON answer.
    let resolved;
    try {
      resolved = await resolveOneShotEngine(config, { preferred: 'claude-code' });
    } catch (err) {
      if (err instanceof NoEnginesAvailableError) {
        return res.status(400).json({
          error: err.message,
          code: 'no_engines_configured',
          availability: err.availability,
        });
      }
      return res.status(500).json({ error: (err as Error).message });
    }

    if (resolved.engine === 'claude-code') {
      const CLAUDE_BIN = getClaudeBin();
      const args = [
        '--print',
        '--permission-mode',
        'bypassPermissions',
        '--model',
        resolved.model,
        '--system-prompt',
        ANALYZE_SYSTEM_PROMPT,
        '--output-format',
        'stream-json',
        '--verbose',
        ANALYZE_USER_PROMPT,
      ];

      console.log(`[analyze ${analyzeId}] spawning ${CLAUDE_BIN} in ${resolvedCwd}`);

      let proc: ChildProcess;
      try {
        proc = spawn(CLAUDE_BIN, args, {
          cwd: resolvedCwd,
          env: buildSpawnEnv(config),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (err: unknown) {
        console.error(`[analyze ${analyzeId}] spawn threw:`, (err as Error).message);
        return res.status(500).json({ error: `Failed to spawn claude: ${(err as Error).message}` });
      }
      trackChild(proc);

      const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        console.error(`[analyze ${analyzeId}] timed out after ${ANALYZE_TIMEOUT_MS}ms, killing`);
        try {
          killProcessGroup(proc, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            killProcessGroup(proc, 'SIGKILL');
          } catch {}
        }, 2000);
        broadcast({
          type: 'analyze-error',
          analyzeId,
          error: `Analysis timed out after ${ANALYZE_TIMEOUT_MS / 1000}s`,
        });
      }, ANALYZE_TIMEOUT_MS);

      const parser = createStreamParser('claude-code');
      let finalText = '';
      let stderr = '';

      const describeToolUse = (tool: string, input: Record<string, unknown> = {}): string => {
        switch (tool) {
          case 'Read':
            return `Reading ${shortPath(input.file_path as string)}`;
          case 'Glob':
            return `Searching for ${(input.pattern as string) || 'files'}`;
          case 'Grep':
            return `Grepping ${(input.pattern as string) || ''}${input.path ? ` in ${shortPath(input.path as string)}` : ''}`;
          case 'LS':
            return `Listing ${shortPath(input.path as string)}`;
          case 'Bash':
            return `Running: ${((input.command as string) || '').slice(0, 80)}`;
          case 'WebFetch':
            return `Fetching ${input.url}`;
          case 'TodoWrite':
            return `Planning next steps`;
          default:
            return `Using ${tool}`;
        }
      };
      const shortPath = (p: string | undefined): string => {
        if (!p) return '';
        const rel = p.startsWith(resolvedCwd) ? p.slice(resolvedCwd.length + 1) : p;
        return rel || p;
      };

      const handleEvent = (ev: StreamEvent): void => {
        if (ev.type === 'tool_use') {
          const message = describeToolUse(ev.tool, ev.input);
          console.log(`[analyze ${analyzeId}] ${message}`);
          broadcast({ type: 'analyze-progress', analyzeId, message });
        } else if (ev.type === 'assistant_text' && !ev.partial) {
          finalText += ev.text;
        } else if (ev.type === 'thinking') {
          broadcast({ type: 'analyze-progress', analyzeId, message: 'Thinking…' });
        } else if (ev.type === 'result' && ev.text && !finalText) {
          finalText = ev.text;
        }
      };

      proc.on('error', (err: Error) => {
        clearTimeout(timeoutHandle);
        console.error(`[analyze ${analyzeId}] process error:`, err.message);
        broadcast({
          type: 'analyze-error',
          analyzeId,
          error: `Failed to start claude (${(err as NodeJS.ErrnoException).code || 'ERR'}): ${err.message}`,
        });
      });

      proc.stdout!.on('data', (chunk: Buffer) => {
        for (const ev of parser.feed(chunk)) handleEvent(ev);
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        console.error(`[analyze ${analyzeId}] stderr:`, text.trimEnd());
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timeoutHandle);
        if (timedOut) return;
        for (const ev of parser.flush()) handleEvent(ev);
        console.log(
          `[analyze ${analyzeId}] exited code=${code}, finalText length=${finalText.length}`,
        );
        if (code !== 0) {
          broadcast({
            type: 'analyze-error',
            analyzeId,
            error: stderr || `Process exited with code ${code}`,
          });
          return;
        }

        let result: AnalysisResult | null = null;
        const fenceMatch = finalText.match(/```json\s*([\s\S]*)```/);
        if (fenceMatch) {
          try {
            result = JSON.parse(fenceMatch[1].trim()) as AnalysisResult;
          } catch {
            // Try the whole output
          }
        }
        if (!result) {
          try {
            result = JSON.parse(finalText.trim()) as AnalysisResult;
          } catch {
            broadcast({
              type: 'analyze-error',
              analyzeId,
              error: 'Failed to parse analysis output as JSON',
            });
            return;
          }
        }

        broadcast({ type: 'analyze-complete', analyzeId, result });
      });
    } else {
      // Fallback path: a non-Claude engine was selected because Claude is
      // unavailable. We don't have a stream-json parser for these engines,
      // so we run the analyzer one-shot and parse JSON from stdout. The
      // user gets a single coarse "Analyzing…" progress event instead of
      // per-tool live updates, but the run completes.
      const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
      console.log(
        `[analyze ${analyzeId}] using fallback engine "${resolved.engine}" (Claude unavailable: ${resolved.fallbackFromReason})`,
      );
      broadcast({
        type: 'analyze-progress',
        analyzeId,
        message: `Analyzing with ${resolved.engine}…`,
      });
      runOneShotPrompt(
        {
          engine: resolved.engine,
          model: resolved.model,
          prompt: ANALYZE_USER_PROMPT,
          systemPrompt: ANALYZE_SYSTEM_PROMPT,
          cwd: resolvedCwd,
          timeoutMs: ANALYZE_TIMEOUT_MS,
          env: buildSpawnEnv(config),
        },
        config,
      )
        .then((output) => {
          let result: AnalysisResult | null = null;
          const fenceMatch = output.match(/```json\s*([\s\S]*)```/);
          if (fenceMatch) {
            try {
              result = JSON.parse(fenceMatch[1].trim()) as AnalysisResult;
            } catch {
              /* try whole-output below */
            }
          }
          if (!result) {
            try {
              result = JSON.parse(output.trim()) as AnalysisResult;
            } catch {
              broadcast({
                type: 'analyze-error',
                analyzeId,
                error: 'Failed to parse analysis output as JSON',
              });
              return;
            }
          }
          broadcast({ type: 'analyze-complete', analyzeId, result });
        })
        .catch((err: Error) => {
          console.error(`[analyze ${analyzeId}] fallback engine failed:`, err.message);
          broadcast({
            type: 'analyze-error',
            analyzeId,
            error: `${resolved.engine}: ${err.message}`,
          });
        });
    }

    res.json({ analyzeId });
  });

  router.post('/api/projects/onboard', (req: Request, res: Response) => {
    const {
      project: projectData,
      agents: agentDefs,
      contextFiles,
      commands,
    } = req.body as OnboardBody;

    if (!projectData?.id || !/^[a-zA-Z0-9-]+$/.test(projectData.id)) {
      return res
        .status(400)
        .json({ error: 'Project id is required and must be alphanumeric+hyphens' });
    }
    if (findProject(projectData.id)) {
      return res.status(409).json({ error: 'Project id already exists' });
    }

    const resolvedCwd = (projectData.cwd || config.defaultCwd).replace(
      /^~/,
      process.env.HOME || '/tmp',
    );

    const dataDir = getProjectDataDir(projectData.id);
    const project: Project = {
      id: projectData.id,
      name: projectData.name || projectData.id,
      cwd: resolvedCwd,
      ahw: dataDir,
      color: projectData.color || '#6b7280',
      agents: [],
    };
    if (commands && typeof commands === 'object') {
      (project as Record<string, unknown>).commands = {
        install: commands.install || null,
        build: commands.build || null,
        test: commands.test || null,
        lint: commands.lint || null,
      };
    }
    const pcOnboard = normalizePreCommitCommands(projectData.preCommitCommands);
    if (pcOnboard.length) (project as Record<string, unknown>).preCommitCommands = pcOnboard;
    const healOnboard = normalizePreCommitCommands(projectData.checkHealCommands);
    if (healOnboard.length) (project as Record<string, unknown>).checkHealCommands = healOnboard;
    if (projectData.checkHealMaxRounds !== undefined) {
      const healRoundsOnboard = normalizeCheckHealMaxRounds(projectData.checkHealMaxRounds);
      if (healRoundsOnboard == null) {
        return res.status(400).json({ error: CHECK_HEAL_MAX_ROUNDS_INVALID });
      }
      (project as Record<string, unknown>).checkHealMaxRounds = healRoundsOnboard;
    }

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
    mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

    if (contextFiles) {
      for (const [filename, content] of Object.entries(contextFiles)) {
        if (content && typeof content === 'string') {
          writeFileSync(path.join(dataDir, filename), content, 'utf-8');
        }
      }
    }

    // Flat agent model — every onboarded agent lands as a peer `role: 'dev'`.
    // The legacy lead/sub hierarchy (with `parentAgentId` / `subAgents`
    // wiring) is no longer set automatically here; `<delegate>` / `<handoff>`
    // are deprecated and CLI engines manage their own internal sub-agent
    // orchestration. The wizard should be sending a single dev agent in
    // most cases — but we tolerate multiple peers in case the caller
    // explicitly wants them (e.g. for power users who already have a
    // multi-specialist setup in mind).
    if (Array.isArray(agentDefs)) {
      for (const def of agentDefs) {
        if (!def.id || !/^[a-zA-Z0-9-]+$/.test(def.id)) continue;
        if (findAgent(def.id)) continue;

        const agent: Agent = {
          id: def.id,
          name: def.name || def.id,
          engine: def.engine || 'claude-code',
          systemPrompt: def.systemPrompt || '',
          color: def.color || project.color,
          heartbeat: { enabled: false, interval: '', prompt: '' },
          role: 'dev',
        };

        mkdirSync(path.join(dataDir, 'agents', agent.id), { recursive: true });

        if (def.identity) {
          writeFileSync(
            path.join(dataDir, 'agents', agent.id, 'IDENTITY.md'),
            def.identity,
            'utf-8',
          );
        }

        project.agents.push(agent);
      }
    }

    // Specialist helpers (`ensureDocsAgents`, `ensureIntakeAgents`,
    // `ensureReviewerAgents`) intentionally skip projects with an empty
    // `agents` roster. Require at least one validated dev peer so onboard
    // cannot return 201 without Docs/Intake (and Reviewer when GitHub-linked).
    if (project.agents.length === 0) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[Onboard] Failed to remove data dir after empty roster: ${(err as Error).message}`,
        );
      }
      return res.status(400).json({
        error: 'onboard_dev_roster_required',
        message: 'At least one dev agent with a valid id is required (non-empty `agents` array).',
      });
    }

    if (projectData.githubRepo?.owner && projectData.githubRepo?.repo) {
      const { owner, repo } = projectData.githubRepo;
      // Persist the `owner/repo` slug on the project record so downstream
      // helpers (e.g. `ensureReviewerAgents()`) can detect GitHub
      // integration without needing to re-query the webhook table. Also set
      // `repoUrl` so the Settings page shows the link and the worktree manager
      // can auto-clone on session spawn.
      const repoUrl = `https://github.com/${owner}/${repo}`;
      project.githubRepo = `${owner}/${repo}`;
      project.repoUrl = `${repoUrl}.git`;
      const defaultEvents = JSON.stringify([
        'pull_request.opened',
        'pull_request.closed',
        'pull_request.synchronize',
        'pull_request_review.submitted',
        'pull_request_review_comment.created',
        'check_suite.completed',
      ]);
      try {
        stmts.createWebhookConfig.run(project.id, repoUrl, null, defaultEvents, 1, '[]');
      } catch (err: unknown) {
        console.warn(`[Onboard] Failed to create webhook config: ${(err as Error).message}`);
      }
    }

    const projects = getProjects();
    projects.push(project);
    saveProjects();

    // Seed the role-specialist agents alongside the analyzed dev roster.
    //   * Docs + Intake are seeded for every onboarded project.
    //   * Reviewer is GitHub-only — `ensureReviewerAgents()` internally
    //     gates on `githubRepo` / webhook configs and is a no-op for
    //     non-GitHub projects. (It's also re-invoked from the GitHub-App /
    //     webhook routes when the user wires up GitHub later, so the
    //     reviewer path remains opt-in for after-the-fact connections.)
    try {
      ensureDocsAgents();
      ensureIntakeAgents();
      ensureReviewerAgents();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Onboard] Specialist agent seeding failed: ${message}`);
      rollbackIncompleteProjectCreation(project, dataDir);
      return res.status(500).json({
        error: 'specialist_agent_seeding_failed',
        message,
      });
    }

    ensureProjectRoom(project);

    // Notify any connected clients so their sidebar picks up the new
    // project without requiring a full page refresh.
    broadcast({ type: 'projects_updated', reason: 'project-created' });

    const enriched = {
      ...project,
      agents: project.agents.map((a) => ({
        ...a,
        projectId: project.id,
        projectName: project.name,
        cwd: project.cwd,
        ahw: project.ahw,
      })),
    };
    res.status(201).json(enriched);
  });

  return router;
}
