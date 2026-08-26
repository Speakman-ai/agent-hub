import { Router, Request, Response } from 'express';
import cron from 'node-cron';
import { execFileSync, spawn, ChildProcess, exec, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createStreamParser } from '../stream-parser.js';
import { parseDevServerConfig, type DevServerConfig } from '../dev-server-config.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { buildSpawnEnv } from '../config.js';
import {
  classifyCloneUrl,
  buildAuthenticatedUrl,
  redactToken,
  SSH_NOT_SUPPORTED_MESSAGE,
} from '../clone-url-auth.js';
import { resolveUserGithubToken } from '../skill-credentials-github.js';
import { resolveOAuthAppCredentials } from '../spawn-github-credentials.js';
import { resolveGithubConnectionUserId } from '../github-connection-user.js';
import { invalidateCursorAuthCache } from '../cursor-auth-cache.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from '../engine-resolver.js';
import type { SupportedEngine } from '../engine-availability.js';
import { claudePermissionModeForSpawn } from '../claude-cli-args.js';
import {
  ANALYZE_FINALIZE_SHIPPING_GUIDELINES,
  applyOnboardDevAgentShippingContracts,
  patchOnboardContextFilesForShipping,
} from '../finalize/shipping-prompt.js';
import { runOneShotPrompt } from '../one-shot-spawn.js';
import { rescheduleProjectBackgroundAgents } from '../heartbeat.js';
import { getUserById } from '../users-store.js';
import { isAuthConfigured } from '../auth-store.js';
import { isOnboardingComplete, markOnboardingComplete } from '../onboarding-complete.js';
import { detectPreviewDefaults } from '../scaffolding/detect-preview-defaults.js';
import { normalizeReplayConfig } from '../replays/replay-config.js';
import { getOrCreateBoard } from './board.js';
import { createPage } from '../wiki.js';
import { getEngineAuthStatus } from '../engine-auth-status.js';
import { userHasEngineCreds, resolveUserCliCredOverride } from '../per-user-cli-spawn.js';
import type { AuthenticatedRequest } from '../auth.js';
import {
  isEligibleSecurityActor,
  resolveSecurityActorForWrite,
} from '../security-audit/actor-user.js';
import {
  canViewProject,
  canDeleteProject,
  filterVisibleProjects,
  getVisibility,
  canChangeVisibility,
  classifyVisibilityTransition,
} from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import {
  addProjectMember,
  isProjectMember,
  isProjectRestricted,
  removeProjectMember,
  listProjectMembers,
} from '../project-members-store.js';
import { getMembershipRole } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { deleteProjectScopedRows } from '../project-owner-cascade.js';
import {
  FINALIZE_AUTOMATION_LEVELS,
  type FinalizeAutomationLevel,
} from '../finalize/automation.js';
import {
  getUserProjectDefaultFinalizeAutomation,
  setUserProjectDefaultFinalizeAutomation,
} from '../user-project-settings.js';
import { archiveHostedRepo, refreshBranchProtection } from '../git-host/repo-store.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import type {
  RouteDeps,
  Agent,
  Project,
  ProjectMode,
  StreamEvent,
  GithubWorkflowSettings,
  BackgroundCustomAgentConfig,
} from '../types.js';
import { sanitizeOrchestrationBudgetsPartial } from '../orchestration-budgets.js';
import { resolveProjectSkillsDir } from '../project-model.js';
import { getProjectMode, getWorkflowWorkspaceDir } from '../project-mode.js';
import { isHubSystemProject } from '../../shared/utils/hub.js';

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
  },
  "wikiPages": [
    {
      "title": "Short wiki page title",
      "category": "one of: architecture, conventions, test-patterns, troubleshooting, onboarding, api-docs, general",
      "content": "Markdown content for a starter wiki page based only on facts found in the repository."
    }
  ]
}

Guidelines for agents — SINGLE FLAT DEV AGENT:
- Return EXACTLY ONE agent in the array. Sub-agent hierarchies (lead + frontend + backend, etc.) are deprecated — Agent Hub uses a flat agent model. The user can add additional dev agents from the UI later if they want a multi-specialist setup.
- The agent's role MUST be "dev".
- The agent's name should be "[Project] Dev" (e.g. "MyApp Dev") — short and human-readable.
- The agent's systemPrompt should be a comprehensive, full-stack-capable persona that owns the entire codebase: architecture, frontend, backend, tests, deploy. 3-5 paragraphs that bake in the project's tech stack, conventions, and notable directories so a fresh chat session has the context it needs to deliver work without delegating. Do **not** tell the dev agent to push, open PRs, or merge — see the shipping guidelines below.
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
- AGENTS.md: describe the single dev agent and the kinds of work they own. The flat-agent model means there is no team to coordinate — write this from the perspective of one full-stack developer agent. Include that GitHub shipping goes through Finalize Code Changes (not dev-agent \`gh pr create\`).
- TOOLS.md: list actual commands from package.json scripts, Makefile targets, etc.
- MEMORY.md: note the project structure and key directories
- All content must be specific to this project, not generic

Guidelines for wikiPages:
- Return 3-5 starter wiki pages that capture facts a new contributor or agent would need on day one.
- Favor pages for architecture, conventions, key workflows, testing, deployment, and troubleshooting when the repository contains enough evidence.
- Each page must be self-contained Markdown with concrete file paths, commands, and decisions discovered in the repository.
- Do not invent undocumented APIs, processes, credentials, or deployment details. If evidence is thin, say what was observed and keep the page short.
${ANALYZE_FINALIZE_SHIPPING_GUIDELINES}`;

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

// Engine fallback chain for project analysis. Claude Code is preferred
// (its stream-json output drives the live progress UI); when the acting
// user has no Claude credentials we fall back to the other interactive
// agent CLIs. Gemini is deliberately excluded — it is reserved for
// RAG/embeddings and is not used to drive interactive project analysis.
const ANALYZE_FALLBACK_CHAIN: readonly SupportedEngine[] = [
  'claude-code',
  'cursor-agent',
  'codex-cli',
];

function isAnalyzeEngine(value: unknown): value is SupportedEngine {
  return typeof value === 'string' && (ANALYZE_FALLBACK_CHAIN as readonly string[]).includes(value);
}

function findAnalyzeEngineForModel(
  engineValidModels: Record<string, string[]>,
  model: string,
): SupportedEngine | null {
  for (const engine of ANALYZE_FALLBACK_CHAIN) {
    const models = engineValidModels[engine] || [];
    if (models.includes(model)) return engine;
  }
  return null;
}

function analyzeErrorDetail(raw: string | null | undefined): string {
  const text = (raw || '').trim();
  if (!text) return 'No diagnostic output was returned by the engine.';
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.slice(-6).join('\n') || text).slice(0, 1200);
}

function analyzeRunErrorMessage(input: {
  engine: SupportedEngine;
  model: string;
  cwd?: string;
  detail?: string | null;
}): string {
  const where = input.cwd ? ` in ${input.cwd}` : '';
  return `Project analysis failed while running ${input.engine} (${input.model})${where}: ${analyzeErrorDetail(input.detail)}`;
}

// The Claude Code CLI reports fatal conditions (expired login, model access
// denied, quota) on stdout as a stream-json `result` event with
// `is_error: true` and writes NOTHING to stderr, then exits non-zero. Reading
// only stderr surfaces the useless "Process exited with code 1". Prefer, in
// order: real stderr, the error text carried on the stream, then the bare code.
export function resolveAnalyzeCloseErrorDetail(input: {
  code: number | null;
  stderr: string;
  streamErrorText: string;
}): string {
  const stderr = input.stderr.trim();
  if (stderr) return stderr;
  const streamed = input.streamErrorText.trim();
  if (streamed) return streamed;
  return `Process exited with code ${input.code}`;
}

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
  wikiPages?: AnalysisWikiPage[];
}

interface AnalysisWikiPage {
  title: string;
  content?: string;
  category?: string;
}

const WIKI_INTAKE_CATEGORIES = new Set([
  'general',
  'api-docs',
  'architecture',
  'conventions',
  'test-patterns',
  'troubleshooting',
  'onboarding',
]);

function slugifyWikiDraftTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeWikiDraftPages(value: unknown): AnalysisWikiPage[] {
  if (!Array.isArray(value)) return [];
  const seenSlugs = new Set<string>();
  const pages: AnalysisWikiPage[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const page = raw as Record<string, unknown>;
    const title = typeof page.title === 'string' ? page.title.trim().slice(0, 160) : '';
    if (!title) continue;

    const slug = slugifyWikiDraftTitle(title);
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const categoryInput =
      typeof page.category === 'string' ? page.category.trim().toLowerCase() : '';
    const category = WIKI_INTAKE_CATEGORIES.has(categoryInput) ? categoryInput : 'onboarding';
    const content = typeof page.content === 'string' ? page.content.trim().slice(0, 40_000) : '';

    pages.push({ title, category, content });
  }

  return pages;
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AnalysisResult>;
  return (
    Array.isArray(candidate.agents) ||
    typeof candidate.description === 'string' ||
    (candidate.techStack !== null &&
      candidate.techStack !== undefined &&
      typeof candidate.techStack === 'object')
  );
}

function parseAnalysisCandidate(text: string): AnalysisResult | null {
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    return isAnalysisResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseFirstAnalysisObject(text: string): AnalysisResult | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const result = parseAnalysisCandidate(text.slice(start, i + 1));
          if (result) return result;
          break;
        }
      }
    }
  }
  return null;
}

function parseAnalysisResult(text: string): AnalysisResult | null {
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencePattern)) {
    const result = parseAnalysisCandidate(match[1]);
    if (result) return result;
  }

  return parseAnalysisCandidate(text) ?? parseFirstAnalysisObject(text);
}

function extractOneShotAnalysisText(engine: SupportedEngine, output: string): string {
  if (engine !== 'codex-cli') return output;

  const parser = createStreamParser(engine);
  const events = [...parser.feed(Buffer.from(output)), ...parser.flush()];
  const finalText: string[] = [];
  const errors: string[] = [];

  for (const event of events) {
    if (event.type === 'assistant_text' && !event.partial) {
      finalText.push(event.text);
    } else if (event.type === 'result' && event.isError && event.text) {
      errors.push(event.text);
    } else if (event.type === 'error' && event.message) {
      errors.push(event.message);
    } else if (event.type === 'unknown' && event.text.startsWith('codex error:')) {
      errors.push(event.text);
    }
  }

  if (finalText.length > 0) return finalText.join('\n');
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return output;
}

interface OnboardBody {
  project: {
    id: string;
    name?: string;
    cwd?: string;
    color?: string;
    githubRepo?: { owner: string; repo: string };
    preCommitCommands?: unknown;
    sessionStartupCommands?: unknown;
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
  wikiPages?: Array<{
    title?: string;
    content?: string;
    category?: string;
  }>;
}

interface ProjectCommands {
  install: string | null;
  build: string | null;
  test: string | null;
  lint: string | null;
}

/** Normalize string-command lists from JSON bodies (POST/PATCH/onboard). */
function normalizePreCommitCommands(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Same shape as pre-commit — reused for `sessionStartupCommands`. */
const normalizeSessionStartupCommands = normalizePreCommitCommands;

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
  devServer?: DevServerConfig;
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
    // still the home of the dev-server config (`prEnv.devServer`) and the
    // shared `prEnv.healthPath`, both of which the in-session runtime reads
    // regardless of the parent flag. So when parent is disabled we still
    // validate and round-trip those two fields, while dropping anything
    // PR-env-only (startScript, internalPort, setupCommand, dockerfilePath,
    // env) — those are meaningless without the PR-env runner.
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
    // The dev-server block is session-scoped and read by the in-session
    // runtime regardless of the parent PR-env flag.
    if (obj.devServer !== undefined && obj.devServer !== null) {
      const devServerResult = parseDevServerConfig(obj.devServer);
      if (!devServerResult.ok) return { ok: false, error: devServerResult.error };
      value.devServer = devServerResult.value;
    }
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

  const value: ValidatedPrEnvConfig = {
    enabled: true,
    startScript,
    internalPort,
  };
  if (setupCommand) value.setupCommand = setupCommand;
  if (healthPath) value.healthPath = healthPath;
  if (dockerfilePath) value.dockerfilePath = dockerfilePath;
  if (envResult.value) value.env = envResult.value;
  if (obj.devServer !== undefined && obj.devServer !== null) {
    const devServerResult = parseDevServerConfig(obj.devServer);
    if (!devServerResult.ok) return { ok: false, error: devServerResult.error };
    value.devServer = devServerResult.value;
  }
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
  return resolveGithubConnectionUserId(req);
}

export default function createProjectRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    broadcast,
    findProject,
    findAgent,
    saveProjects,
    config,
    getProjects,
    getProjectDataDir,
    retireIntakeAgents,
    ensureSkillBuilderAgents,
    ensureReviewerAgents,
    ensureContextFiles,
    getClaudeBin,
    setClaudeBin,
    getCursorBin,
    setCursorBin,
    getCodexBin,
    setCodexBin,
    getGrokBin,
    setGrokBin,
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
          const oauthCreds = resolveOAuthAppCredentials(config);
          const token = await resolveUserGithubToken(userId, { oauthCredentials: oauthCreds });
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
        // `prEnv.devServer` block. The wizard waits for the
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

  router.get('/api/projects', (req: Request, res: Response) => {
    const caller = resolveVisibilityCaller(req);
    // Visibility gate: shared projects always pass; private projects only
    // surface to their owner (and local-bundled / apiKey bypass). Org
    // Owners do NOT get a read bypass — they hit the admin endpoint
    // (`GET /api/admin/projects`) for the kill-switch view.
    const projects = filterVisibleProjects(getProjects(), caller).filter(
      (p) => !isHubSystemProject(p),
    );
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

  // ─── Per-project member assignment (Owner-managed visibility ACL) ───
  //
  // A user sees a project only if assigned to it (see project-visibility.ts).
  // These routes let an Owner manage that assignment set. They sit behind
  // the `/api/projects/:projectId` visibility gate, so a caller who cannot
  // view the project is already masked as 404; `requireProjectMemberAdmin`
  // is the management gate layered on top — only org Owners (and the
  // local-bundle / global-apiKey break-glass) may mutate the ACL.
  function requireProjectMemberAdmin(req: Request, res: Response): boolean {
    const areq = req as AuthenticatedRequest;
    const caller = resolveVisibilityCaller(req);
    if (areq.authRole === 'Owner' || caller.localBypass) return true;
    res.status(403).json({ error: 'Owner role required to manage project members.' });
    return false;
  }

  router.get('/api/projects/:projectId/members', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!requireProjectMemberAdmin(req, res)) return;
    const members = listProjectMembers(project.id);
    // `restricted` tells the UI whether the assignment ACL is active. It is
    // deliberately stored separately from member rows so deleting the last
    // assigned user does not implicitly reopen a shared project.
    res.json({
      projectId: project.id,
      ownerUserId: project.ownerUserId ?? null,
      visibility: getVisibility(project),
      restricted: isProjectRestricted(project.id),
      members,
    });
  });

  router.post('/api/projects/:projectId/members', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!requireProjectMemberAdmin(req, res)) return;
    const body = req.body as { userId?: unknown };
    if (typeof body.userId !== 'string' || !body.userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const user = getUserById(body.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Only assign users who belong to the active org — a cross-org id would
    // create a dangling ACL row that never resolves to a real caller.
    if (getMembershipRole(user.id, getActiveOrgId()) === null) {
      return res.status(400).json({ error: 'User is not a member of this org' });
    }
    const actorUserId = (req as AuthenticatedRequest).authUserId ?? null;
    const alreadyMember = isProjectMember(project.id, user.id);
    addProjectMember(project.id, user.id, actorUserId);
    try {
      broadcast({
        type: 'projects_updated',
        reason: 'project-members-changed',
        projectId: project.id,
      });
    } catch {
      /* best-effort */
    }
    res
      .status(alreadyMember ? 200 : 201)
      .json({ projectId: project.id, userId: user.id, username: user.username });
  });

  router.delete('/api/projects/:projectId/members/:userId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!requireProjectMemberAdmin(req, res)) return;
    const userId = req.params.userId as string;
    const removed = removeProjectMember(project.id, userId);
    if (!removed) return res.status(404).json({ error: 'Member not found' });
    try {
      broadcast({
        type: 'projects_updated',
        reason: 'project-members-changed',
        projectId: project.id,
      });
    } catch {
      /* best-effort */
    }
    res.json({ projectId: project.id, userId, removed: true });
  });

  router.get('/api/setup/status', async (req: Request, res: Response) => {
    const projects = getProjects();

    // Probe engine availability with ASYNC, PARALLEL `<bin> --version` calls.
    // These were previously three serial `execSync` calls (5s timeout each):
    // a synchronous `execSync` blocks the Node event loop, so when a CLI hangs
    // on `--version` this endpoint — hit on every app load — could freeze the
    // whole server for up to ~15s, failing health checks and stalling all
    // other requests. `execFile` (no shell) runs off-thread; `Promise.all`
    // parallelises so worst case is one 5s timeout, not three, and the loop
    // stays responsive throughout.
    const cursorBinResolved = getCursorBin?.() ?? config.cursorBin;
    const codexBinResolved = getCodexBin?.() ?? config.codexBin;
    const grokBinResolved = getGrokBin?.() ?? config.grokBin;
    const probeEngine = async (bin: string): Promise<boolean> => {
      try {
        await execFileAsync(bin, ['--version'], { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    };
    const [claudeAvailable, cursorAvailable, codexAvailable, grokAvailable] = await Promise.all([
      probeEngine(getClaudeBin()),
      probeEngine(cursorBinResolved),
      probeEngine(codexBinResolved),
      probeEngine(grokBinResolved),
    ]);

    // `hasAnyAiCredentials` mirrors the auth-resolution that `buildSpawnEnv`
    // applies — strictly per-account: the requesting user's own Claude /
    // Cursor / Codex credentials, with no host fallback. The client uses this
    // to decide whether to pop the SetupWizard regardless of `firstRun`, so a
    // user with no engine logins still sees the AI-credentials walkthrough
    // instead of being dropped into the project picker with no working
    // engine. See `engine-auth-status.ts` for the full contract.
    const authedReq = req as AuthenticatedRequest;
    let engineAuth: { claude: boolean; cursor: boolean; codex: boolean; any: boolean };
    try {
      engineAuth = await getEngineAuthStatus({
        cursorBin: cursorBinResolved,
        userId: authedReq.authUserId ?? null,
        dataDir: config.dataDir,
      });
    } catch {
      engineAuth = { claude: false, cursor: false, codex: false, any: false };
    }

    // Grok per-account credential check. `getEngineAuthStatus` covers
    // Claude/Cursor/Codex (the engines that gate `hasAnyAiCredentials`); Grok
    // auth is a simple per-user cred-file presence check, so resolve it
    // directly here for the wizard's Grok card. Strictly per-account — no host
    // fallback, mirroring `probeEngineAvailability` in engine-availability.ts.
    let grokAuthenticated = false;
    try {
      const grokUserId = authedReq.authUserId ?? null;
      grokAuthenticated = grokUserId
        ? userHasEngineCreds('grok-cli', grokUserId, config.dataDir)
        : false;
    } catch {
      grokAuthenticated = false;
    }

    // `authConfigured` reflects whether the Agent Hub Owner record exists.
    // `onboardingComplete` is the authoritative "SetupWizard finished"
    // signal — Owner creation alone is not enough (password managers can
    // interrupt mid-wizard after auth.json lands). See
    // server/onboarding-complete.ts.
    let authConfigured = false;
    try {
      authConfigured = isAuthConfigured();
    } catch {
      // auth-store may not be initialized in some test contexts; treat as
      // not-configured so the wizard runs in tests by default.
      authConfigured = false;
    }
    let onboardingComplete = false;
    try {
      onboardingComplete = isOnboardingComplete(config.dataDir);
    } catch {
      onboardingComplete = authConfigured;
    }

    // Server-authoritative capability: may THIS caller finish instance
    // onboarding (POST /api/setup/complete)? Resolved from the caller's
    // CURRENT org membership, using the exact gate /api/setup/complete
    // enforces. The client must key the Owner-only wizard ending off this,
    // not off the role cached in localStorage at login — a promotion or
    // demotion after login makes the cached role stale, which would either
    // strand a demoted-Owner in a 403 setup trap or skip onboarding for a
    // freshly promoted Owner.
    const setupCaller = resolveVisibilityCaller(req);
    const canCompleteOnboarding =
      (req as AuthenticatedRequest).authRole === 'Owner' || setupCaller.localBypass;

    res.json({
      firstRun: projects.length === 0,
      authConfigured,
      onboardingComplete,
      canCompleteOnboarding,
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
        'grok-cli': {
          available: grokAvailable,
          authenticated: grokAuthenticated,
          path: grokBinResolved,
        },
      },
      dataDir: config.dataDir,
      projectsDir: config.projectsDir,
    });
  });

  router.post('/api/setup/configure', (req: Request, res: Response) => {
    const { claudeBin, cursorBin, codexBin, grokBin } = req.body as {
      claudeBin?: string;
      cursorBin?: string;
      codexBin?: string;
      grokBin?: string;
    };

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {}

    if (claudeBin !== undefined) fileConfig.claudeBin = claudeBin;
    if (cursorBin !== undefined) fileConfig.cursorBin = cursorBin;
    if (codexBin !== undefined) fileConfig.codexBin = codexBin;
    if (grokBin !== undefined) fileConfig.grokBin = grokBin;

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
    if (grokBin !== undefined && setGrokBin) {
      setGrokBin(grokBin);
      config.grokBin = grokBin;
    }

    res.json({ ok: true, message: 'Configuration updated.' });
  });

  // Mark interactive SetupWizard finished. Called from the client when the
  // user reaches the final "Open Project" step — distinct from Owner
  // creation so interrupted first-runs can resume.
  //
  // Owner-gated: the flag is global instance state, and flipping it to
  // `true` is what stops `GET /api/setup/status` from re-opening the
  // wizard. An authenticated Admin/User must not be able to strand the
  // Owner's interrupted first-run by marking it done on their behalf.
  // Same gate shape as `GET /api/admin/projects` above — `localBypass`
  // covers the local-bundled, global-apiKey, and no-auth-configured
  // identities, all of which legitimately drive the wizard.
  router.post('/api/setup/complete', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    const caller = resolveVisibilityCaller(req);
    if (areq.authRole !== 'Owner' && !caller.localBypass) {
      return res.status(403).json({ error: 'Owner role required.' });
    }
    try {
      markOnboardingComplete(config.dataDir);
    } catch (err) {
      res.status(500).json({
        error: `Failed to mark onboarding complete: ${(err as Error).message}`,
      });
      return;
    }
    res.json({ ok: true, onboardingComplete: true });
  });

  router.get('/api/projects/:projectId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  // ─── Per-user, project-scoped settings ───────────────────────────
  //
  // Each user picks their own default Finalize automation level for a
  // project; new ad-hoc sessions they create inherit it (see the manual
  // session-creation path in server/routes/sessions.ts). Scoped strictly to
  // the requesting user — there is no way to read or write another user's
  // preference through these routes.

  router.get('/api/projects/:projectId/user-settings', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    // 404 (not 403) for projects the caller can't see, matching the rest of
    // the project surface — don't leak the existence of a private project.
    if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const userId = (req as AuthenticatedRequest).authUserId ?? null;
    res.json({
      projectId: project.id,
      defaultFinalizeAutomation: getUserProjectDefaultFinalizeAutomation(stmts, userId, project.id),
    });
  });

  router.put('/api/projects/:projectId/user-settings', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Body must be a JSON object. Express parses primitives ("x", 5) and
    // arrays as valid JSON too; a primitive RHS would throw on the `in` check
    // below, so reject anything that isn't a plain object up front (400, not
    // an unhandled 500). A missing body (`{}`) is allowed — it's a no-op.
    const rawBody = req.body ?? {};
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }
    const body = rawBody as Record<string, unknown>;
    const userId = (req as AuthenticatedRequest).authUserId ?? null;
    // Partial update: `defaultFinalizeAutomation` accepts a known level (set)
    // or null (clear). Omitting the key entirely is "no change requested" — we
    // must NOT persist in that case, or a `PUT {}` would silently clear an
    // existing preference.
    if ('defaultFinalizeAutomation' in body) {
      const raw = body.defaultFinalizeAutomation;
      let level: FinalizeAutomationLevel | null;
      if (raw === null) {
        level = null;
      } else if (
        typeof raw === 'string' &&
        (FINALIZE_AUTOMATION_LEVELS as readonly string[]).includes(raw)
      ) {
        level = raw as FinalizeAutomationLevel;
      } else {
        return res.status(400).json({
          error: `defaultFinalizeAutomation must be null or one of: ${FINALIZE_AUTOMATION_LEVELS.join(', ')}`,
        });
      }
      setUserProjectDefaultFinalizeAutomation(stmts, userId, project.id, level);
    }
    res.json({
      projectId: project.id,
      defaultFinalizeAutomation: getUserProjectDefaultFinalizeAutomation(stmts, userId, project.id),
    });
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
      sessionStartupCommands,
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
      sessionStartupCommands?: unknown;
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
    const VALID_ENGINES = [
      'claude-code',
      'cursor-agent',
      'gemini-cli',
      'codex-cli',
      'grok-cli',
    ] as const;
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
    // Workflow (no-code) projects have no git repo and no per-session
    // worktree — every session runs directly in `project.cwd`. Point that
    // at a durable, project-scoped directory under the managed data dir so
    // agent-produced resources live in one persistent place instead of the
    // historical `/tmp` placeholder (shared across projects, wiped on
    // reboot). Dev projects keep the caller-supplied cwd / defaultCwd.
    const workflowWorkspaceDir =
      createMode === 'workflow' ? getWorkflowWorkspaceDir(dataDir) : null;
    // Authenticated creators get a private durable staging state first.
    // Once their member ACL row exists, a shared project can be published
    // safely. If any post-save ACL/publish step fails, the project remains
    // private rather than org-visible with zero members.
    const initialVisibility: 'shared' | 'private' = ownerUserId ? 'private' : createVisibility;
    const project: Project = {
      id,
      name: name || id,
      cwd: workflowWorkspaceDir ?? (cwd || config.defaultCwd),
      ahw: dataDir,
      color: color || '#6b7280',
      visibility: initialVisibility,
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
    const startupCreate = normalizeSessionStartupCommands(sessionStartupCommands);
    if (startupCreate.length) {
      (project as Record<string, unknown>).sessionStartupCommands = startupCreate;
    }
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
    mkdirSync(resolveProjectSkillsDir(project), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
    // Create the no-code project's durable resource directory up front so
    // it exists before the first chat spawn rather than relying on the
    // just-in-time ensure step.
    if (workflowWorkspaceDir) mkdirSync(workflowWorkspaceDir, { recursive: true });

    projects.push(project);
    try {
      saveProjects();
    } catch (err) {
      const idx = projects.findIndex((p) => p.id === project.id);
      if (idx !== -1) projects.splice(idx, 1);
      rmSync(dataDir, { recursive: true, force: true });
      console.error(
        `[POST /api/projects] Failed to persist project "${project.id}":`,
        (err as Error).message,
      );
      return res.status(500).json({ error: 'project_create_failed' });
    }

    // Auto-assign the creator to the visibility ACL. This makes a new
    // project "restricted" (≥1 member) before it is ever published as shared,
    // so it's private to its creator until an Owner assigns others — the
    // intended "only assigned users see it" default. Callers with no
    // authenticated user (local bundle / global apiKey) have
    // `ownerUserId === null` and skip this: their projects stay unassigned
    // (org-visible), which is correct for single-tenant installs.
    //
    // If seeding fails after the private staging save, keep the project and
    // return success with `visibility: private`. The client learns the created
    // project id, retries do not collide, and the persisted state is still
    // fail-closed.
    let creatorMemberSeedFailed = false;
    if (ownerUserId) {
      try {
        addProjectMember(project.id, ownerUserId, ownerUserId);
      } catch (err) {
        console.error(
          `[POST /api/projects] Failed to seed creator membership for "${project.id}":`,
          (err as Error).message,
        );
        creatorMemberSeedFailed = true;
      }
    }

    if (!creatorMemberSeedFailed && project.visibility !== createVisibility) {
      project.visibility = createVisibility;
      try {
        saveProjects();
      } catch (err) {
        project.visibility = initialVisibility;
        console.error(
          `[POST /api/projects] Failed to publish project visibility for "${project.id}":`,
          (err as Error).message,
        );
        return res.status(500).json({
          error: 'project_visibility_publish_failed',
          message: 'The project remains private.',
        });
      }
    }

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
    //   2. NO Docs agent; projects can still add one explicitly if needed.
    //   3. NO Intake agent — Ticket Intake is retired; `retireIntakeAgents()`
    //      runs as a purge sweep that removes any legacy intake agents.
    //   4. A Reviewer agent is NOT seeded here — Reviewer is GitHub-only
    //      (`ensureReviewerAgents()` gates on `githubRepo` / webhooks).
    if (createMode === 'workflow') {
      try {
        // 1. Pre-create the kanban board with default columns so the user
        //    lands on a structured To Do → Done view.
        getOrCreateBoard(stmts, project.id);

        // 2. Seed the primary agent so subsequent helpers
        //    (`ensureProjectRoom`, `retireIntakeAgents`) have an anchor —
        //    those helpers early-return on
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
        //    specialist helpers — they pick the project up via the
        //    in-memory `projects` array and call `saveProjects()`
        //    themselves once they add their own rows.
        saveProjects();

        // 4. Purge any retired intake agents. Reviewer is GitHub-only and
        //    skipped here intentionally.
        retireIntakeAgents();
        // Creation-scoped: pass the new project's id so we never backfill a
        // Skill Builder into every pre-existing project.
        ensureSkillBuilderAgents(project.id);

        // 5. Create the project's conference room now that we have an
        //    anchor agent.

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

    // The Hub is a system project hidden from lists; it must also be immutable.
    // Its id (`__hub__`) is a published constant and the Hub assistant can edit
    // project config when asked — a PATCH of engine/role/mode here must not be
    // able to reshape the singleton. Hiding it is not the same as protecting it.
    if (isHubSystemProject(project)) {
      return res.status(403).json({
        error: 'The Hub is a system project and cannot be modified or deleted.',
        code: 'hub_project_protected',
      });
    }

    // Mode validation MUST run before any in-place mutation of the shared
    // project object. A mixed PATCH like `{ cwd, mode }` used to rewrite cwd
    // first, then 409 on the mode guard — leaving the rejected cwd live in
    // memory (and later persisted by an unrelated save).
    let pendingMode: ProjectMode | 'clear' | undefined;
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'mode')) {
      const rawMode = (req.body as Record<string, unknown>).mode;
      if (rawMode === null || rawMode === undefined || rawMode === '') {
        pendingMode = 'clear';
      } else if (rawMode === 'dev' || rawMode === 'workflow') {
        pendingMode = rawMode;
      } else {
        return res.status(400).json({ error: 'mode must be "dev", "workflow", or null' });
      }
      // Mode drives SessionEnv adapter + worktree routing (workflow → host /
      // project.cwd; dev → possibly Firecracker env-owned). A live session may
      // already hold a warm env on the old adapter — flipping mode would split
      // chat onto one filesystem while terminal/preview keep another. Reject
      // until every live session is archived/deleted.
      const nextEffective: ProjectMode = pendingMode === 'clear' ? 'dev' : pendingMode;
      if (nextEffective !== getProjectMode(project)) {
        let liveSessionCount = 0;
        for (const agent of project.agents) {
          liveSessionCount += (stmts.getSessions.all(agent.id) as Array<{ id: string }>).length;
        }
        if (liveSessionCount > 0) {
          return res.status(409).json({
            error:
              `Cannot change project mode while ${liveSessionCount} live session(s) exist. ` +
              'Archive or delete them first so session environments are not split across adapters.',
            code: 'mode_change_blocked_by_sessions',
            liveSessionCount,
          });
        }
      }
    }

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
    if ((req.body as Record<string, unknown>).sessionStartupCommands !== undefined) {
      const rawSu = (req.body as Record<string, unknown>).sessionStartupCommands;
      const su = normalizeSessionStartupCommands(rawSu);
      if (su.length) (project as Record<string, unknown>).sessionStartupCommands = su;
      else delete (project as Record<string, unknown>).sessionStartupCommands;
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
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'gitHost')) {
      // gitHost transitions have filesystem side effects (bare repo
      // creation/import, cwd origin rewrite) that a plain field write
      // would skip — they only happen via the dedicated endpoints.
      return res.status(400).json({
        error:
          'gitHost cannot be set directly — use POST /api/projects/:projectId/git-host/enable or /disable.',
      });
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'gitMirror')) {
      const rawMirror = (req.body as Record<string, unknown>).gitMirror;
      if (rawMirror === null) {
        delete (project as Record<string, unknown>).gitMirror;
      } else if (typeof rawMirror !== 'object' || Array.isArray(rawMirror)) {
        return res.status(400).json({ error: 'gitMirror must be an object or null' });
      } else {
        const m = rawMirror as Record<string, unknown>;
        const next: { enabled?: boolean; refs?: 'default-branch' | 'all' } = {};
        if (m.enabled !== undefined) {
          if (typeof m.enabled !== 'boolean') {
            return res.status(400).json({ error: 'gitMirror.enabled must be a boolean' });
          }
          next.enabled = m.enabled;
        }
        if (m.refs !== undefined) {
          if (m.refs !== 'default-branch' && m.refs !== 'all') {
            return res
              .status(400)
              .json({ error: 'gitMirror.refs must be "default-branch" or "all"' });
          }
          next.refs = m.refs;
        }
        (project as Record<string, unknown>).gitMirror = {
          ...(project.gitMirror ?? {}),
          ...next,
        };
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'ciOnPush')) {
      const rawCi = (req.body as Record<string, unknown>).ciOnPush;
      if (rawCi === null) {
        delete (project as Record<string, unknown>).ciOnPush;
      } else if (typeof rawCi !== 'object' || Array.isArray(rawCi)) {
        return res.status(400).json({ error: 'ciOnPush must be an object or null' });
      } else {
        const enabled = (rawCi as Record<string, unknown>).enabled;
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'ciOnPush.enabled must be a boolean' });
        }
        (project as Record<string, unknown>).ciOnPush = {
          ...(project.ciOnPush ?? {}),
          ...(enabled !== undefined ? { enabled } : {}),
        };
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'securityAutoPr')) {
      const rawSec = (req.body as Record<string, unknown>).securityAutoPr;
      if (rawSec === null) {
        delete (project as Record<string, unknown>).securityAutoPr;
      } else if (typeof rawSec !== 'object' || Array.isArray(rawSec)) {
        return res.status(400).json({ error: 'securityAutoPr must be an object or null' });
      } else {
        const sec = rawSec as Record<string, unknown>;
        const enabled = sec.enabled;
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'securityAutoPr.enabled must be a boolean' });
        }
        const autoMerge = sec.autoMerge;
        if (autoMerge !== undefined && typeof autoMerge !== 'boolean') {
          return res.status(400).json({ error: 'securityAutoPr.autoMerge must be a boolean' });
        }
        // actorUserId: null/'' clears it; a string must reference an Admin/Owner
        // member of the caller's org (unattended automation acts as this user
        // and must hold merge rights).
        const hasActor = Object.prototype.hasOwnProperty.call(sec, 'actorUserId');
        let actorUserId: string | null | undefined;
        if (hasActor) {
          const raw = sec.actorUserId;
          if (raw === null || raw === '') {
            actorUserId = null;
          } else if (typeof raw !== 'string') {
            return res
              .status(400)
              .json({ error: 'securityAutoPr.actorUserId must be a user id string or null' });
          } else {
            // Auth-enabled → require Admin/Owner membership in the caller's
            // org; a known-but-non-member user is rejected. No-auth/local mode
            // falls back to the "known Hub user" bar. See isEligibleSecurityActor.
            const orgId = (req as AuthenticatedRequest).authOrgId;
            if (!isEligibleSecurityActor(raw, orgId)) {
              return res.status(400).json({
                error: 'securityAutoPr.actorUserId must be an Admin or Owner member of the org',
              });
            }
            actorUserId = raw;
          }
        }
        const nextSec: Record<string, unknown> = {
          ...(project.securityAutoPr ?? {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(autoMerge !== undefined ? { autoMerge } : {}),
        };
        if (hasActor) {
          if (actorUserId === null) delete nextSec.actorUserId;
          else nextSec.actorUserId = actorUserId;
        }
        // Turning auto-merge on shouldn't force the caller to also name an
        // actor: default to the Admin flipping the switch. Only when there is
        // no eligible caller does the fail-safe below reject.
        if (nextSec.autoMerge === true) {
          const resolved = resolveSecurityActorForWrite({
            configured: nextSec.actorUserId,
            callerUserId: (req as AuthenticatedRequest).authUserId,
            orgId: (req as AuthenticatedRequest).authOrgId,
          });
          if (resolved) nextSec.actorUserId = resolved;
        }
        // Fail-safe coupling: auto-merge cannot be on without a configured actor
        // — unattended automation would have no one to attribute the PR/merge to.
        if (nextSec.autoMerge === true && !nextSec.actorUserId) {
          return res.status(400).json({
            error: 'securityAutoPr.autoMerge requires securityAutoPr.actorUserId to be set',
          });
        }
        (project as Record<string, unknown>).securityAutoPr = nextSec;
      }
    }
    let backgroundAgentsTouched = false;
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'backgroundAgents')) {
      backgroundAgentsTouched = true;
      const rawBg = (req.body as Record<string, unknown>).backgroundAgents;
      if (rawBg === null) {
        delete (project as Record<string, unknown>).backgroundAgents;
      } else if (typeof rawBg !== 'object' || Array.isArray(rawBg)) {
        return res.status(400).json({ error: 'backgroundAgents must be an object or null' });
      } else {
        const bg = rawBg as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(bg, 'wiki')) {
          const rawWiki = bg.wiki;
          if (rawWiki === null) {
            const next = { ...(project.backgroundAgents ?? {}) };
            delete (next as Record<string, unknown>).wiki;
            (project as Record<string, unknown>).backgroundAgents = next;
          } else if (typeof rawWiki !== 'object' || Array.isArray(rawWiki)) {
            return res
              .status(400)
              .json({ error: 'backgroundAgents.wiki must be an object or null' });
          } else {
            const w = rawWiki as Record<string, unknown>;
            const nextWiki: Record<string, unknown> = { ...(project.backgroundAgents?.wiki ?? {}) };

            if (Object.prototype.hasOwnProperty.call(w, 'enabled')) {
              if (typeof w.enabled !== 'boolean') {
                return res
                  .status(400)
                  .json({ error: 'backgroundAgents.wiki.enabled must be a boolean' });
              }
              nextWiki.enabled = w.enabled;
            }
            if (Object.prototype.hasOwnProperty.call(w, 'schedule')) {
              const schedule = w.schedule;
              if (typeof schedule !== 'string' || !cron.validate(schedule)) {
                return res.status(400).json({
                  error: 'backgroundAgents.wiki.schedule must be a valid cron expression',
                });
              }
              nextWiki.schedule = schedule;
            }
            if (Object.prototype.hasOwnProperty.call(w, 'timezone')) {
              const tz = w.timezone;
              if (tz === null || tz === '') nextWiki.timezone = null;
              else if (typeof tz !== 'string') {
                return res
                  .status(400)
                  .json({ error: 'backgroundAgents.wiki.timezone must be a string or null' });
              } else nextWiki.timezone = tz;
            }
            if (Object.prototype.hasOwnProperty.call(w, 'ownerUserId')) {
              const raw = w.ownerUserId;
              if (raw === null || raw === '') nextWiki.ownerUserId = null;
              else if (typeof raw !== 'string' || !getUserById(raw)) {
                return res.status(400).json({
                  error: 'backgroundAgents.wiki.ownerUserId must be a known user id or null',
                });
              } else nextWiki.ownerUserId = raw;
            }
            if (Object.prototype.hasOwnProperty.call(w, 'model')) {
              const model = w.model;
              if (model === null || model === '') nextWiki.model = null;
              else if (typeof model !== 'string') {
                return res
                  .status(400)
                  .json({ error: 'backgroundAgents.wiki.model must be a string or null' });
              } else {
                // The wiki run uses the docs agent's engine; validate the
                // override against that engine's model allowlist (the same set
                // the client picks from). Skip the check when the engine has no
                // known list, mirroring normalizeCronModel's leniency toward
                // engine-catalog drift.
                const docsAgent = project.agents?.find(
                  (a) => (a.role ?? '').trim().toLowerCase() === 'docs',
                );
                const engine = docsAgent?.engine || 'claude-code';
                const validModels = config.engineValidModels?.[engine] || [];
                if (validModels.length > 0 && !validModels.includes(model)) {
                  return res.status(400).json({
                    error: `backgroundAgents.wiki.model must be a valid ${engine} model`,
                  });
                }
                nextWiki.model = model;
              }
            }
            if (Object.prototype.hasOwnProperty.call(w, 'limit')) {
              const limit = w.limit;
              if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1 || limit > 50) {
                return res.status(400).json({
                  error: 'backgroundAgents.wiki.limit must be a number between 1 and 50',
                });
              }
              nextWiki.limit = Math.trunc(limit);
            }
            (project as Record<string, unknown>).backgroundAgents = {
              ...(project.backgroundAgents ?? {}),
              wiki: nextWiki,
            };
          }
        }
        if (Object.prototype.hasOwnProperty.call(bg, 'custom')) {
          const rawCustom = bg.custom;
          if (rawCustom === null) {
            const next = { ...(project.backgroundAgents ?? {}) };
            delete (next as Record<string, unknown>).custom;
            (project as Record<string, unknown>).backgroundAgents = next;
          } else if (!Array.isArray(rawCustom)) {
            return res
              .status(400)
              .json({ error: 'backgroundAgents.custom must be an array or null' });
          } else {
            const seenIds = new Set<string>();
            const normalized: BackgroundCustomAgentConfig[] = [];
            for (let i = 0; i < rawCustom.length; i++) {
              const raw = rawCustom[i];
              if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                return res
                  .status(400)
                  .json({ error: `backgroundAgents.custom[${i}] must be an object` });
              }
              const c = raw as Record<string, unknown>;
              if (typeof c.id !== 'string' || !c.id.trim()) {
                return res
                  .status(400)
                  .json({ error: `backgroundAgents.custom[${i}].id is required` });
              }
              if (seenIds.has(c.id)) {
                return res
                  .status(400)
                  .json({ error: `backgroundAgents.custom[${i}].id is duplicated` });
              }
              seenIds.add(c.id);
              if (typeof c.name !== 'string' || !c.name.trim()) {
                return res
                  .status(400)
                  .json({ error: `backgroundAgents.custom[${i}].name is required` });
              }
              if (typeof c.prompt !== 'string' || !c.prompt.trim()) {
                return res
                  .status(400)
                  .json({ error: `backgroundAgents.custom[${i}].prompt is required` });
              }
              const entry: BackgroundCustomAgentConfig = {
                id: c.id,
                name: c.name.trim(),
                prompt: c.prompt,
                enabled: false,
              };
              if (Object.prototype.hasOwnProperty.call(c, 'enabled')) {
                if (typeof c.enabled !== 'boolean') {
                  return res
                    .status(400)
                    .json({ error: `backgroundAgents.custom[${i}].enabled must be a boolean` });
                }
                entry.enabled = c.enabled;
              }
              if (Object.prototype.hasOwnProperty.call(c, 'schedule')) {
                if (typeof c.schedule !== 'string' || !cron.validate(c.schedule)) {
                  return res.status(400).json({
                    error: `backgroundAgents.custom[${i}].schedule must be a valid cron expression`,
                  });
                }
                entry.schedule = c.schedule;
              }
              if (Object.prototype.hasOwnProperty.call(c, 'timezone')) {
                const tz = c.timezone;
                if (tz === null || tz === '') entry.timezone = null;
                else if (typeof tz !== 'string') {
                  return res.status(400).json({
                    error: `backgroundAgents.custom[${i}].timezone must be a string or null`,
                  });
                } else entry.timezone = tz;
              }
              if (Object.prototype.hasOwnProperty.call(c, 'ownerUserId')) {
                const raw2 = c.ownerUserId;
                if (raw2 === null || raw2 === '') entry.ownerUserId = null;
                else if (typeof raw2 !== 'string' || !getUserById(raw2)) {
                  return res.status(400).json({
                    error: `backgroundAgents.custom[${i}].ownerUserId must be a known user id or null`,
                  });
                } else entry.ownerUserId = raw2;
              }
              if (Object.prototype.hasOwnProperty.call(c, 'engine')) {
                const eng = c.engine;
                if (eng === null || eng === '') entry.engine = null;
                else if (typeof eng !== 'string') {
                  return res.status(400).json({
                    error: `backgroundAgents.custom[${i}].engine must be a string or null`,
                  });
                } else entry.engine = eng;
              }
              if (Object.prototype.hasOwnProperty.call(c, 'model')) {
                const model = c.model;
                if (model === null || model === '') entry.model = null;
                else if (typeof model !== 'string') {
                  return res.status(400).json({
                    error: `backgroundAgents.custom[${i}].model must be a string or null`,
                  });
                } else entry.model = model;
              }
              normalized.push(entry);
            }
            (project as Record<string, unknown>).backgroundAgents = {
              ...(project.backgroundAgents ?? {}),
              custom: normalized,
            };
          }
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'securityScan')) {
      const rawScan = (req.body as Record<string, unknown>).securityScan;
      if (rawScan === null) {
        delete (project as Record<string, unknown>).securityScan;
      } else if (typeof rawScan !== 'object' || Array.isArray(rawScan)) {
        return res.status(400).json({ error: 'securityScan must be an object or null' });
      } else {
        const onPush = (rawScan as Record<string, unknown>).onPush;
        if (onPush !== undefined && typeof onPush !== 'boolean') {
          return res.status(400).json({ error: 'securityScan.onPush must be a boolean' });
        }
        const schedule = (rawScan as Record<string, unknown>).schedule;
        if (
          schedule !== undefined &&
          schedule !== 'off' &&
          schedule !== 'daily' &&
          schedule !== 'weekly'
        ) {
          return res
            .status(400)
            .json({ error: 'securityScan.schedule must be "off", "daily", or "weekly"' });
        }
        (project as Record<string, unknown>).securityScan = {
          ...(project.securityScan ?? {}),
          ...(onPush !== undefined ? { onPush } : {}),
          ...(schedule !== undefined ? { schedule } : {}),
        };
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'replay')) {
      // Per-project session-replay policy (continuous-tier sample rate + opt-in
      // flag), server-delivered so it applies to every user on the project
      // rather than whoever flipped a per-browser localStorage toggle.
      const result = normalizeReplayConfig((req.body as Record<string, unknown>).replay);
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      if (result.value === null) {
        delete (project as Record<string, unknown>).replay;
      } else {
        (project as Record<string, unknown>).replay = result.value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'deleteBranchOnMerge')) {
      const rawDel = (req.body as Record<string, unknown>).deleteBranchOnMerge;
      if (rawDel === null) {
        delete (project as Record<string, unknown>).deleteBranchOnMerge;
      } else if (typeof rawDel !== 'boolean') {
        return res.status(400).json({ error: 'deleteBranchOnMerge must be a boolean or null' });
      } else {
        (project as Record<string, unknown>).deleteBranchOnMerge = rawDel;
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'branchProtection')) {
      const rawBp = (req.body as Record<string, unknown>).branchProtection;
      if (rawBp === null) {
        delete (project as Record<string, unknown>).branchProtection;
      } else if (typeof rawBp !== 'object' || Array.isArray(rawBp)) {
        return res.status(400).json({ error: 'branchProtection must be an object or null' });
      } else {
        const merged: Record<string, boolean> = {
          ...((project.branchProtection ?? {}) as Record<string, boolean>),
        };
        for (const key of ['requiredChecks', 'requiredReview', 'blockDirectPushes'] as const) {
          const v = (rawBp as Record<string, unknown>)[key];
          if (v === undefined) continue;
          if (typeof v !== 'boolean') {
            return res.status(400).json({ error: `branchProtection.${key} must be a boolean` });
          }
          merged[key] = v;
        }
        (project as Record<string, unknown>).branchProtection = merged;
      }
      // The pre-receive push block lives as a config file inside the bare
      // repo — sync it whenever the setting changes (no-op if not hosted).
      void refreshBranchProtection(project).catch((err: unknown) => {
        console.error(
          `[git-host] branch-protection refresh failed for ${project.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
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
    if (pendingMode !== undefined) {
      if (pendingMode === 'clear') {
        delete (project as Record<string, unknown>).mode;
      } else {
        (project as Record<string, unknown>).mode = pendingMode;
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'awsEnabled')) {
      // Boolean toggle that gates the per-project "AWS" sidebar entry. Stored
      // explicitly so the sidebar can read it off the project list; defaults
      // to false (we delete the key) so projects stay lean until opted in.
      const rawAwsEnabled = (req.body as Record<string, unknown>).awsEnabled;
      if (typeof rawAwsEnabled !== 'boolean') {
        return res.status(400).json({ error: 'awsEnabled must be a boolean' });
      }
      if (rawAwsEnabled) {
        (project as Record<string, unknown>).awsEnabled = true;
      } else {
        delete (project as Record<string, unknown>).awsEnabled;
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'infraEnabled')) {
      // Boolean toggle that gates the per-project Infrastructure sidebar
      // entry. Store `true`; delete `false` so projects retain the default-off
      // shape used by the other module visibility flags.
      const rawInfraEnabled = (req.body as Record<string, unknown>).infraEnabled;
      if (typeof rawInfraEnabled !== 'boolean') {
        return res.status(400).json({ error: 'infraEnabled must be a boolean' });
      }
      if (rawInfraEnabled) {
        (project as Record<string, unknown>).infraEnabled = true;
      } else {
        delete (project as Record<string, unknown>).infraEnabled;
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
    saveProjects();
    // Re-register the wiki background agent so schedule/enable changes take
    // effect immediately without waiting for the next full scheduler sweep.
    // Only when this PATCH actually touched backgroundAgents — avoids
    // needless stop/restart churn on unrelated project edits.
    if (backgroundAgentsTouched) rescheduleProjectBackgroundAgents(project);
    res.json(project);
  });

  router.delete('/api/projects/:projectId', (req: Request, res: Response) => {
    const projects = getProjects();
    const idx = projects.findIndex((p) => p.id === req.params.projectId);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const project = projects[idx];

    // The Hub is a system project: never deletable, even by an Owner. Deleting
    // it would drop every user's Hub chat via the scoped-row cleanup below.
    if (isHubSystemProject(project)) {
      return res.status(403).json({
        error: 'The Hub is a system project and cannot be modified or deleted.',
        code: 'hub_project_protected',
      });
    }

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

    // Hosted bare repo (gitHost: 'agenthub') is archived by rename, never
    // deleted — recovering a project's history must stay possible.
    try {
      const archived = archiveHostedRepo(project.id);
      if (archived) console.log(`[git-host] archived hosted repo for ${project.id}: ${archived}`);
    } catch (err: unknown) {
      console.warn(
        `[git-host] archive on delete failed for ${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    projects.splice(idx, 1);
    saveProjects();
    res.status(204).end();
  });

  // ─── Project analysis (Open Project wizard) ──────────────────────
  router.post('/api/projects/analyze', async (req: Request, res: Response) => {
    const { cwd } = req.body as { cwd?: string };
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });

    const body = req.body as { engine?: unknown; model?: unknown };
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const requestedEngineRaw = typeof body.engine === 'string' ? body.engine.trim() : '';
    const engineValidModels = config.engineValidModels || {};

    if (requestedEngineRaw && !isAnalyzeEngine(requestedEngineRaw)) {
      return res.status(400).json({
        error: `Project analysis does not support engine "${requestedEngineRaw}". Choose one of: ${ANALYZE_FALLBACK_CHAIN.join(', ')}.`,
        code: 'invalid_analysis_engine',
        acceptedEngines: ANALYZE_FALLBACK_CHAIN,
      });
    }

    let requestedEngine = requestedEngineRaw || '';
    if (requestedModel) {
      if (requestedEngine) {
        const models = engineValidModels[requestedEngine] || [];
        if (!models.includes(requestedModel)) {
          return res.status(400).json({
            error: `Model "${requestedModel}" is not valid for project analysis engine "${requestedEngine}".`,
            code: 'invalid_analysis_model',
            acceptedModels: models,
          });
        }
      } else {
        const inferred = findAnalyzeEngineForModel(engineValidModels, requestedModel);
        if (!inferred) {
          return res.status(400).json({
            error: `Model "${requestedModel}" is not available for project analysis. Choose a model from Claude Code, Cursor Agent, or Codex.`,
            code: 'invalid_analysis_model',
            acceptedModels: Object.fromEntries(
              ANALYZE_FALLBACK_CHAIN.map((engine) => [engine, engineValidModels[engine] || []]),
            ),
          });
        }
        requestedEngine = inferred;
      }
    }

    const resolvedCwd = cwd.replace(/^~/, process.env.HOME || '/tmp');
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      return res.status(400).json({ error: 'Path does not exist or is not a directory' });
    }

    const analyzeId = uuidv4();

    // Resolve which engine to drive the analysis. Claude Code is preferred
    // because it's the only engine whose stream-json output we currently
    // parse for live progress events; fallback engines run without
    // streaming progress but still produce a valid JSON answer.
    // The agent CLIs (Claude/Cursor/Codex) authenticate strictly per-account,
    // so the acting user's id must be threaded through — otherwise the probe
    // reports "No acting user for this <engine> run" even when the user's
    // credentials are configured.
    const analyzeUserId = (req as AuthenticatedRequest).authUserId ?? null;
    let resolved;
    try {
      resolved = await resolveOneShotEngine(config, {
        preferred: requestedEngine || 'claude-code',
        preferredModel: requestedModel || null,
        userId: analyzeUserId,
        fallbackChain: requestedEngine
          ? [requestedEngine as SupportedEngine]
          : ANALYZE_FALLBACK_CHAIN,
      });
    } catch (err) {
      if (err instanceof NoEnginesAvailableError) {
        return res.status(400).json({
          error: requestedEngine
            ? `Project analysis could not start with ${requestedEngine}${requestedModel ? ` (${requestedModel})` : ''}. ${err.message}`
            : `Project analysis could not start. ${err.message}`,
          code: 'no_engines_configured',
          availability: err.availability,
        });
      }
      return res.status(500).json({
        error: `Project analysis could not choose an engine: ${(err as Error).message}`,
      });
    }

    // Thread the acting user's id + stored credentials into the spawn env so
    // the CLI runs as them (per-user HOME pin + DB-stored OAuth token). Without
    // this the analyzer inherits the host HOME with no token and Claude reports
    // "Not logged in · Please run /login" for DB-credential users. Mirrors the
    // heartbeat / chat spawn env resolution.
    const analyzeSpawnEnv = buildSpawnEnv(config, {
      userId: analyzeUserId,
      userOverride: resolveUserCliCredOverride(analyzeUserId),
      engine: resolved.engine,
    });

    if (resolved.engine === 'claude-code') {
      const CLAUDE_BIN = getClaudeBin();
      const args = [
        '--print',
        '--permission-mode',
        claudePermissionModeForSpawn('bypassPermissions'),
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
          env: analyzeSpawnEnv,
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
          error: analyzeRunErrorMessage({
            engine: resolved.engine,
            model: resolved.model,
            cwd: resolvedCwd,
            detail: `timed out after ${ANALYZE_TIMEOUT_MS / 1000}s`,
          }),
        });
      }, ANALYZE_TIMEOUT_MS);

      const parser = createStreamParser('claude-code');
      let finalText = '';
      let stderr = '';
      // Claude reports auth/model/quota failures on stdout (result event with
      // isError) and leaves stderr empty. Capture that text so a non-zero exit
      // surfaces the real cause instead of "Process exited with code 1".
      let streamErrorText = '';

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
        } else if (ev.type === 'result') {
          if (ev.isError && ev.text) streamErrorText = ev.text;
          if (ev.text && !finalText) finalText = ev.text;
        }
      };

      proc.on('error', (err: Error) => {
        clearTimeout(timeoutHandle);
        console.error(`[analyze ${analyzeId}] process error:`, err.message);
        broadcast({
          type: 'analyze-error',
          analyzeId,
          error: analyzeRunErrorMessage({
            engine: resolved.engine,
            model: resolved.model,
            cwd: resolvedCwd,
            detail: `failed to start (${(err as NodeJS.ErrnoException).code || 'ERR'}): ${err.message}`,
          }),
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
        if (code !== 0 || streamErrorText) {
          broadcast({
            type: 'analyze-error',
            analyzeId,
            error: analyzeRunErrorMessage({
              engine: resolved.engine,
              model: resolved.model,
              cwd: resolvedCwd,
              detail: resolveAnalyzeCloseErrorDetail({ code, stderr, streamErrorText }),
            }),
          });
          return;
        }

        const result = parseAnalysisResult(finalText);
        if (!result) {
          broadcast({
            type: 'analyze-error',
            analyzeId,
            error:
              `Project analysis ran with ${resolved.engine} (${resolved.model}) but returned output that was not valid JSON. ` +
              'Retry with a different model or check the engine output for prompt/configuration errors.',
          });
          return;
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
          env: analyzeSpawnEnv,
        },
        config,
      )
        .then((output) => {
          const finalText = extractOneShotAnalysisText(resolved.engine, output);
          const result = parseAnalysisResult(finalText);
          if (!result) {
            broadcast({
              type: 'analyze-error',
              analyzeId,
              error:
                `Project analysis ran with ${resolved.engine} (${resolved.model}) but returned output that was not valid JSON. ` +
                'Retry with a different model or check the engine output for prompt/configuration errors.',
            });
            return;
          }
          broadcast({ type: 'analyze-complete', analyzeId, result });
        })
        .catch((err: Error) => {
          console.error(`[analyze ${analyzeId}] fallback engine failed:`, err.message);
          broadcast({
            type: 'analyze-error',
            analyzeId,
            error: analyzeRunErrorMessage({
              engine: resolved.engine,
              model: resolved.model,
              cwd: resolvedCwd,
              detail: err.message,
            }),
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
      wikiPages,
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
    const startupOnboard = normalizeSessionStartupCommands(projectData.sessionStartupCommands);
    if (startupOnboard.length) {
      (project as Record<string, unknown>).sessionStartupCommands = startupOnboard;
    }
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
    mkdirSync(resolveProjectSkillsDir(project), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

    if (contextFiles) {
      for (const [filename, content] of Object.entries(contextFiles)) {
        if (content && typeof content === 'string') {
          writeFileSync(path.join(dataDir, filename), content, 'utf-8');
        }
      }
    }

    // Flat agent model — every onboarded agent lands as a peer `role: 'dev'`.
    // The wizard should be sending a single dev agent in most cases, but we
    // tolerate multiple peers when a caller explicitly wants a multi-specialist
    // setup.
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

    // Specialist helpers intentionally skip projects with an empty `agents`
    // roster. Require at least one validated dev peer so onboard cannot return
    // 201 without a usable primary agent.
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
      // integration. Also set `repoUrl` so the Settings page shows the link
      // and the worktree manager can auto-clone on session spawn.
      const repoUrl = `https://github.com/${owner}/${repo}`;
      project.githubRepo = `${owner}/${repo}`;
      project.repoUrl = `${repoUrl}.git`;
    }

    if (project.githubRepo) {
      applyOnboardDevAgentShippingContracts(project);
      patchOnboardContextFilesForShipping(dataDir, project);
    }

    const projects = getProjects();
    projects.push(project);
    saveProjects();

    const seededWikiPages = normalizeWikiDraftPages(wikiPages);
    try {
      for (const page of seededWikiPages) {
        const created = createPage(project.id, {
          title: page.title,
          content: page.content || '',
          category: page.category,
          updatedBy: 'project-analysis',
        });
        broadcast({ type: 'wiki_update', projectId: project.id, page: created });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Onboard] Wiki seeding failed for "${project.id}": ${message}`);
      rollbackIncompleteProjectCreation(project, dataDir);
      return res.status(500).json({
        error: 'wiki_seeding_failed',
        message,
      });
    }

    // Seed the remaining role-specialist agents alongside the analyzed dev roster.
    //   * Docs is no longer auto-seeded. Ticket Intake is retired (never seeded),
    //     and `retireIntakeAgents()` purges any legacy intake agent.
    //   * Reviewer is GitHub-only — `ensureReviewerAgents()` internally
    //     gates on `githubRepo` and is a no-op for non-GitHub projects.
    //     (It's also re-invoked when the user wires up GitHub later via a
    //     project PATCH, so the Finalize reviewer remains available for
    //     after-the-fact connections.)
    try {
      retireIntakeAgents();
      // Creation-scoped: only the project just onboarded, never a backfill.
      ensureSkillBuilderAgents(project.id);
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
