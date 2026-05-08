import { Router, Request, Response } from 'express';
import { execSync, execFileSync, spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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
import { getUserByUsername, createUser } from '../users-store.js';
import { detectPreviewDefaults } from '../scaffolding/detect-preview-defaults.js';
import { getOrCreateBoard } from './board.js';
import type { AuthenticatedRequest } from '../auth.js';

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
      "role": "lead | sub",
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

Guidelines for agents — LEAD + SUB-AGENT HIERARCHY:
- ALWAYS create exactly ONE lead agent first in the array with role "lead"
- The lead agent is the project coordinator — it understands the full codebase, delegates tasks to sub-agents, and synthesizes results
- The lead agent's name should be "[Project] Lead" (e.g. "MyApp Lead")
- The lead agent's systemPrompt should emphasize coordination, architecture decisions, code review, and delegation
- For small projects (single language, few files): create 1 lead + 1 sub-agent (general developer)
- For medium projects: create 1 lead + 2 sub-agents (e.g. frontend + backend, or app + testing)
- For large projects: create 1 lead + 2-3 sub-agents (e.g. frontend, backend, devops)
- Never create more than 4 agents total (1 lead + 3 subs max)
- Sub-agents have role "sub" and should be specialists for specific areas of the codebase
- Each sub-agent's systemPrompt should be detailed about their specialty and the specific tech stack they work with
- Agent IDs should be descriptive kebab-case (e.g. "myapp-lead", "myapp-frontend", "myapp-backend")

Guidelines for commands:
- Detect the install command by checking lock files: bun.lockb/bun.lock -> "bun install", pnpm-lock.yaml -> "pnpm install", yarn.lock -> "yarn install", package-lock.json -> "npm ci", package.json -> "npm install", requirements.txt -> "pip install -r requirements.txt", Cargo.toml -> "cargo build"
- Detect the build command from package.json "scripts.build", Makefile "build" target, Cargo.toml, etc.
- Detect the test command from package.json "scripts.test", Makefile "test" target, pytest.ini, Cargo.toml, etc.
- Detect the lint command from package.json "scripts.lint", .eslintrc*, ruff.toml, Cargo.toml (clippy), etc.
- Return null for any command that cannot be detected

Guidelines for contextFiles:
- SOUL.md: capture actual coding style (indentation, naming conventions, patterns observed)
- AGENTS.md: describe the lead/sub-agent team structure and how they coordinate
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

  const value: ValidatedPrEnvPreviewConfig = { enabled: true };
  if (startScript) value.startScript = startScript;
  if (port !== undefined) value.port = port;
  if (captureRoutes && captureRoutes.length > 0) value.captureRoutes = captureRoutes;
  if (idleTTL !== undefined) value.idleTTL = idleTTL;
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
    // Cross-field guard: preview requires the parent feature on. Reject
    // before we silently drop the preview block, so users see a clear
    // error instead of wondering why their preview config disappeared.
    if (
      obj.preview &&
      typeof obj.preview === 'object' &&
      !Array.isArray(obj.preview) &&
      !!(obj.preview as Record<string, unknown>).enabled
    ) {
      return {
        ok: false,
        error:
          'prEnv.preview.enabled requires prEnv.enabled (preview cannot run when PR-env is off)',
      };
    }
    // When the user toggles off, we keep the slot for round-tripping —
    // dispatch already short-circuits on `!project.prEnv.enabled`.
    return { ok: true, value: { enabled: false } };
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
  } = deps;

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

  router.get('/api/projects', (_req: Request, res: Response) => {
    const projects = getProjects();
    const enriched = projects.map((p) => ({
      ...p,
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

  router.get('/api/setup/status', (_req: Request, res: Response) => {
    const projects = getProjects();
    let claudeAvailable = false;

    try {
      execSync(`"${getClaudeBin()}" --version`, { timeout: 5000, stdio: 'pipe' });
      claudeAvailable = true;
    } catch {}

    res.json({
      firstRun: projects.length === 0,
      engines: {
        'claude-code': {
          available: claudeAvailable,
          path: getClaudeBin(),
        },
      },
      dataDir: config.dataDir,
      projectsDir: config.projectsDir,
    });
  });

  router.post('/api/setup/configure', (req: Request, res: Response) => {
    const { claudeBin } = req.body as { claudeBin?: string };

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {}

    if (claudeBin !== undefined) fileConfig.claudeBin = claudeBin;

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

    if (claudeBin !== undefined) {
      setClaudeBin(claudeBin);
      config.claudeBin = claudeBin;
    }

    res.json({ ok: true, message: 'Configuration updated.' });
  });

  router.get('/api/projects/:projectId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

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
    const dataDir = getProjectDataDir(id);
    const project: Project = {
      id,
      name: name || id,
      cwd: cwd || config.defaultCwd,
      ahw: dataDir,
      color: color || '#6b7280',
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
    // agents (so `ensureIntakeAgents` / `ensureProjectRoom` early-return),
    // and no conference room. We seed the minimum so the project is
    // immediately usable as a tasks-only workspace.
    //
    // Dev-mode (default) projects keep the lean POST behavior — the richer
    // `POST /api/projects/onboard` route owns dev scaffolding because it
    // already has an analyzed agent roster + GitHub repo to wire up.
    if (createMode === 'workflow') {
      try {
        // 1. Pre-create the kanban board with default columns so the user
        //    lands on a structured Backlog → Done view.
        getOrCreateBoard(stmts, project.id);

        // 2. Seed a single project-coordinator "lead" agent so subsequent
        //    helpers (intake / room) have an anchor — those helpers
        //    early-return on `project.agents.length === 0`. Engine
        //    defaults to claude-code but is overridable via the optional
        //    `engine` POST field for Cursor-only installs.
        const leadAgentId = `${project.id}-lead`;
        if (!findAgent(leadAgentId)) {
          const leadAgent: Agent = {
            id: leadAgentId,
            name: `${project.name} Lead`,
            engine: resolvedEngine,
            role: 'lead',
            color: project.color,
            systemPrompt: `You are the lead coordinator for the ${project.name} workspace — a non-coding (workflow-mode) project on Agent Hub.

You own:
- The kanban board (Backlog → Done) at /api/projects/${project.id}/board
- The wiki at /api/projects/${project.id}/wiki
- Conversations with collaborators in this workspace's conference room
- Triaging and routing user requests to the right agent

This workspace has no git repo and no PR automation — your job is planning, organizing, and synthesizing, not shipping code. Use the kanban board to track work, the wiki to capture decisions and reference material, and chat sessions to drive the work forward.`,
            heartbeat: { enabled: false, interval: '', prompt: '' },
            subAgents: [],
          };
          mkdirSync(path.join(dataDir, 'agents', leadAgentId), { recursive: true });
          writeFileSync(
            path.join(dataDir, 'agents', leadAgentId, 'IDENTITY.md'),
            `# ${project.name} Lead\n\nYou coordinate work in the ${project.name} workspace. You own the kanban board, the wiki, and routing user requests to the right specialist. This is a non-coding workspace — no git repo, no PRs.\n`,
            'utf-8',
          );
          project.agents.push(leadAgent);
          // No saveProjects() here — `ensureIntakeAgents()` below will save
          // the lead+intake state in a single write. The initial empty-row
          // save above keeps crash-safety covered if the helper short-circuits.
        }

        // 3. Seed the Intake agent (generic, board-only — no git deps) so
        //    the user can convert natural-language requests into tickets
        //    out of the box. We deliberately SKIP `ensureDocsAgents` here
        //    because the docs agent's heartbeat is git-/PR-coupled and
        //    would fail on a workflow project. We also SKIP
        //    `ensureReviewerAgents` — it's already gated on `githubRepo`.
        //
        // Side-effect note: `ensureIntakeAgents()` iterates ALL projects,
        // so calling it here also retroactively backfills intake into any
        // pre-existing project that has agents but no intake. That's the
        // helper's documented contract (matches `/api/projects/onboard`'s
        // usage) — flagged for the next reader.
        ensureIntakeAgents();

        // 4. Defensive save — guarantees the seeded lead row is on disk
        //    even if `ensureIntakeAgents()` short-circuited (e.g. the
        //    intake agent already existed on a re-POST scenario). When
        //    the helper did add an intake agent, this is a redundant but
        //    cheap second write; the alternative — trusting the helper
        //    to always save — was fragile across future refactors.
        saveProjects();

        // 5. Create the project's conference room now that we have agents.
        ensureProjectRoom(project);

        // 6. Seed the workspace's top-level context files (SOUL.md, AGENTS.md,
        //    USER.md, TOOLS.md, MEMORY.md). Without this, a freshly-scaffolded
        //    workflow project's data dir has empty `agents/`, `skills/`,
        //    `memory/` subdirs but no top-level context files until the next
        //    server restart — `ensureContextFiles()` is otherwise only
        //    invoked at startup (`server/index.ts:302`).
        ensureContextFiles();
      } catch (err) {
        // Scaffolding failure is non-fatal — the project row is already
        // persisted. Log loudly so the operator can investigate, but
        // return success so the wizard doesn't pretend the project
        // wasn't created.
        console.warn(
          `[POST /api/projects] Workflow scaffolding failed for "${project.id}": ${(err as Error).message}`,
        );
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

    stmts.deleteEscalationsByProject.run(project.id);
    stmts.deleteNotesByProject.run(project.id);
    stmts.deleteWikiPagesByProject.run(project.id);
    stmts.deleteWebhookConfigsByProject.run(project.id);
    stmts.deleteBoardsByProject.run(project.id);
    stmts.deleteWorkflowsByProject.run(project.id);
    stmts.deleteThreadsByProject.run(project.id);
    stmts.deleteRoomsByProject.run(project.id);
    stmts.deleteCronsByProject.run(project.id);

    const agentIds = (project.agents || []).map((a) => a.id);
    for (const agentId of agentIds) {
      stmts.deleteSessionsByAgent.run(agentId);
    }

    projects.splice(idx, 1);
    saveProjects();
    res.status(204).end();
  });

  // ─── Project analysis (Open Project wizard) ──────────────────────
  router.post('/api/projects/analyze', (req: Request, res: Response) => {
    const { cwd } = req.body as { cwd?: string };
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });

    const resolvedCwd = cwd.replace(/^~/, process.env.HOME || '/tmp');
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      return res.status(400).json({ error: 'Path does not exist or is not a directory' });
    }

    const analyzeId = uuidv4();

    const CLAUDE_BIN = getClaudeBin();
    const args = [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      config.defaultModel,
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

    if (Array.isArray(agentDefs)) {
      const leadDef =
        agentDefs.find((d) => d.role === 'lead') || (agentDefs.length > 1 ? agentDefs[0] : null);
      const subDefs = agentDefs.filter((d) => d !== leadDef);

      for (const def of agentDefs) {
        if (!def.id || !/^[a-zA-Z0-9-]+$/.test(def.id)) continue;
        if (findAgent(def.id)) continue;

        const isLead = def === leadDef && agentDefs.length > 1;
        const isSub = !isLead && leadDef && agentDefs.length > 1;

        const agent: Agent = {
          id: def.id,
          name: def.name || def.id,
          engine: def.engine || 'claude-code',
          systemPrompt: def.systemPrompt || '',
          color: def.color || project.color,
          heartbeat: { enabled: false, interval: '', prompt: '' },
        };

        if (isLead) {
          agent.role = 'lead';
          agent.subAgents = subDefs
            .filter((s) => s.id && /^[a-zA-Z0-9-]+$/.test(s.id))
            .map((s) => s.id);
        } else if (isSub) {
          agent.role = 'sub';
          agent.parentAgentId = leadDef!.id;
        }

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

    if (projectData.githubRepo?.owner && projectData.githubRepo?.repo) {
      const { owner, repo } = projectData.githubRepo;
      const repoUrl = `https://github.com/${owner}/${repo}`;
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

    ensureDocsAgents();
    ensureIntakeAgents();
    ensureReviewerAgents();

    ensureProjectRoom(project);

    // Notify any connected clients so their sidebar picks up the new
    // project (and any auto-seeded Docs/Intake/Reviewer agents) without
    // requiring a full page refresh.
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
