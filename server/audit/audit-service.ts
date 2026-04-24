/**
 * Post-scaffold audit service.
 *
 * Runs a battery of fast, read-only checks against a freshly-scaffolded
 * workspace and returns a structured report consumed by Act IV of the
 * New Project storyboard (`client/src/components/PostScaffoldAudit.jsx`).
 *
 * The shape produced here is what the shipped frontend already expects —
 * see `client/src/utils/auditReport.js` for the normalized schema:
 *
 *   {
 *     projectId, generatedAt, score,
 *     categories: [{ id, label, status, weight, summary? }],
 *     findings:   [{ id, severity, category, message, hint?,
 *                    title?, detail?, remediation? }],
 *     gaps:       [{ id, label, hint? }],
 *     suggestedTracks: [{ id, label, rationale, defaultAgent }],
 *   }
 *
 * Findings carry both the legacy/frontend names (`message`, `hint`) and
 * the names called out in the original card spec (`title`, `detail`,
 * `remediation`) so either consumer reads cleanly.
 *
 * All side effects are injected: `runCommand` (process spawn) and a
 * filesystem reader. Tests pass deterministic fakes; production binds
 * `runCommand` to `child_process.spawn` with a short timeout per call.
 */
import { spawn } from 'child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import path from 'path';

export type AuditCategoryStatus = 'ok' | 'warn' | 'fail' | 'na';
export type AuditSeverity = 'info' | 'warn' | 'error';

export interface AuditCategory {
  id: string;
  label: string;
  status: AuditCategoryStatus;
  weight?: number;
  summary?: string | null;
}

export interface AuditFinding {
  id: string;
  severity: AuditSeverity;
  category: string;
  /** Frontend-facing concise message. */
  message: string;
  /** Frontend-facing remediation hint. */
  hint?: string | null;
  /** Original-spec alias of `message`. */
  title?: string;
  /** Original-spec extended detail (defaults to `message`). */
  detail?: string;
  /** Original-spec remediation (defaults to `hint`). */
  remediation?: string | null;
}

export interface AuditGap {
  id: string;
  label: string;
  hint?: string | null;
}

export interface SuggestedTrack {
  id: string;
  label: string;
  rationale: string;
  /** Resolved agent id when one matched, otherwise `null`. */
  defaultAgent: string | null;
  /** Alias of `defaultAgent` for the existing roster picker UI. */
  suggestedAgentId: string | null;
  keywords: string[];
}

export interface AuditReport {
  projectId: string;
  generatedAt: string;
  score: number;
  /** Alias of `score` — matches the field name in the original card spec. */
  readinessScore: number;
  categories: AuditCategory[];
  findings: AuditFinding[];
  gaps: AuditGap[];
  suggestedTracks: SuggestedTrack[];
}

/** A single command result — what the injected `runCommand` returns. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command did not exist (ENOENT) or the runner skipped it. */
  skipped?: boolean;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<CommandResult>;

export interface AgentLike {
  id: string;
  name?: string;
  role?: string | null;
  tags?: string[] | null;
}

export interface AuditInput {
  projectId: string;
  cwd: string;
  /** Integrations from the provisioning payload (or `'idk'` / `null`). */
  integrations?: string[] | 'idk' | null;
  /** Available agents — used to resolve `suggestedTracks[].defaultAgent`. */
  agents?: AgentLike[];
  /** Injected for tests. Defaults to `runRealCommand`. */
  runCommand?: CommandRunner;
  /** Injected for tests. Defaults to a recursive scan of `cwd`. */
  scanForSecrets?: (cwd: string) => SecretsScanResult;
  /** Override "now" — used only by tests to make `generatedAt` deterministic. */
  now?: () => Date;
}

export interface SecretsScanResult {
  hits: Array<{ file: string; pattern: string }>;
  envFiles: string[];
}

// ─── Tracks (agent roster suggestions) ──────────────────────────────

export const DEFAULT_TRACKS: Array<{
  id: string;
  label: string;
  rationale: string;
  keywords: string[];
}> = [
  {
    id: 'architect',
    label: 'Architect',
    rationale: 'Owns high-level design decisions and sequencing.',
    keywords: ['lead', 'architect', 'design', 'cto'],
  },
  {
    id: 'backend',
    label: 'Backend',
    rationale: 'Implements server, database, and API work.',
    keywords: ['backend', 'server', 'api', 'node'],
  },
  {
    id: 'frontend',
    label: 'Frontend',
    rationale: 'Owns the client UI, styling, and real-time integration.',
    keywords: ['frontend', 'client', 'ui', 'react', 'web'],
  },
  {
    id: 'qa',
    label: 'QA',
    rationale: 'Reviews, runs tests, and validates releases.',
    keywords: ['qa', 'test', 'review', 'reviewer'],
  },
  {
    id: 'devex',
    label: 'DevEx',
    rationale: 'Tooling, CI/CD, and developer experience.',
    keywords: ['devex', 'tooling', 'ci', 'cd', 'ops'],
  },
  {
    id: 'deploy',
    label: 'Deploy',
    rationale: 'Infrastructure, AWS, and release operations.',
    keywords: ['deploy', 'ops', 'aws', 'infra', 'sre'],
  },
];

// ─── Category metadata ─────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  git: 'Source Control',
  lint: 'Lint',
  tests: 'Tests',
  deps: 'Dependencies',
  auth: 'Auth & Secrets',
  aws: 'AWS / Deploy',
};

const CATEGORY_WEIGHTS: Record<string, number> = {
  git: 15,
  lint: 15,
  tests: 25,
  deps: 10,
  auth: 20,
  aws: 15,
};

// ─── Stack detection ───────────────────────────────────────────────

interface DetectedStack {
  hasNodePackageJson: boolean;
  hasPyProject: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  packageScripts: Record<string, string>;
}

function detectStack(cwd: string): DetectedStack {
  const stack: DetectedStack = {
    hasNodePackageJson: false,
    hasPyProject: false,
    hasGoMod: false,
    hasCargoToml: false,
    packageScripts: {},
  };
  const pkgPath = path.join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    stack.hasNodePackageJson = true;
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      stack.packageScripts = parsed.scripts || {};
    } catch {
      /* invalid package.json — leave scripts empty */
    }
  }
  if (existsSync(path.join(cwd, 'pyproject.toml')) || existsSync(path.join(cwd, 'setup.py'))) {
    stack.hasPyProject = true;
  }
  if (existsSync(path.join(cwd, 'go.mod'))) stack.hasGoMod = true;
  if (existsSync(path.join(cwd, 'Cargo.toml'))) stack.hasCargoToml = true;
  return stack;
}

// ─── Individual checks ─────────────────────────────────────────────

export interface CheckResult {
  category: AuditCategory;
  findings: AuditFinding[];
}

function ok(category: string, summary: string, weight?: number): AuditCategory {
  return {
    id: category,
    label: CATEGORY_LABELS[category] || category,
    status: 'ok',
    summary,
    weight,
  };
}
function warn(category: string, summary: string, weight?: number): AuditCategory {
  return {
    id: category,
    label: CATEGORY_LABELS[category] || category,
    status: 'warn',
    summary,
    weight,
  };
}
function fail(category: string, summary: string, weight?: number): AuditCategory {
  return {
    id: category,
    label: CATEGORY_LABELS[category] || category,
    status: 'fail',
    summary,
    weight,
  };
}
function na(category: string, summary: string, weight?: number): AuditCategory {
  return {
    id: category,
    label: CATEGORY_LABELS[category] || category,
    status: 'na',
    summary,
    weight,
  };
}

function finding(
  id: string,
  category: string,
  severity: AuditSeverity,
  message: string,
  hint: string | null = null,
): AuditFinding {
  return {
    id,
    category,
    severity,
    message,
    hint,
    title: message,
    detail: message,
    remediation: hint,
  };
}

/**
 * Git: requires a `.git` directory and at least one commit on HEAD.
 */
export async function checkGit(cwd: string, run: CommandRunner): Promise<CheckResult> {
  const weight = CATEGORY_WEIGHTS.git;
  if (!existsSync(path.join(cwd, '.git'))) {
    return {
      category: fail('git', 'Workspace is not a git repository.', weight),
      findings: [
        finding(
          'git-missing',
          'git',
          'error',
          'No .git directory found in the workspace.',
          'Run `git init` and commit the scaffolded tree.',
        ),
      ],
    };
  }
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 5_000 });
  if (head.exitCode !== 0) {
    return {
      category: fail('git', 'Repo is initialized but has no commits.', weight),
      findings: [
        finding(
          'git-no-head',
          'git',
          'error',
          'git rev-parse HEAD returned a non-zero exit — no initial commit.',
          'Make an initial commit (`git add -A && git commit -m "initial scaffold"`).',
        ),
      ],
    };
  }
  return {
    category: ok('git', `HEAD at ${head.stdout.trim().slice(0, 12)}`, weight),
    findings: [],
  };
}

/**
 * Tests: pick the tests command for the detected stack, run it, and
 * report `ok` on exit 0. If no recognised test command is available,
 * the category is `na` (not penalised).
 */
export async function checkTests(
  cwd: string,
  stack: DetectedStack,
  run: CommandRunner,
): Promise<CheckResult> {
  const weight = CATEGORY_WEIGHTS.tests;
  const cmd = pickTestsCommand(stack);
  if (!cmd) {
    return {
      category: na('tests', 'No recognised test command for this stack.', weight),
      findings: [],
    };
  }
  const r = await run(cmd.cmd, cmd.args, { cwd, timeoutMs: 60_000 });
  if (r.skipped) {
    return {
      category: warn('tests', `${cmd.label} not available on PATH — skipped.`, weight),
      findings: [
        finding(
          'tests-skipped',
          'tests',
          'warn',
          `Could not run ${cmd.label}: binary missing.`,
          `Install ${cmd.label} so the audit can verify the test suite.`,
        ),
      ],
    };
  }
  if (r.exitCode === 0) {
    return {
      category: ok('tests', `${cmd.label} exited 0.`, weight),
      findings: [],
    };
  }
  return {
    category: fail('tests', `${cmd.label} exited ${r.exitCode}.`, weight),
    findings: [
      finding(
        'tests-failed',
        'tests',
        'error',
        `${cmd.label} failed (exit ${r.exitCode}).`,
        `Open the project, fix the failing tests, and re-run \`${cmd.cmd} ${cmd.args.join(' ')}\`.`,
      ),
    ],
  };
}

interface RunnableCommand {
  cmd: string;
  args: string[];
  label: string;
}

function pickTestsCommand(stack: DetectedStack): RunnableCommand | null {
  if (stack.hasNodePackageJson && (stack.packageScripts['test'] || '').trim()) {
    return { cmd: 'npm', args: ['test', '--silent'], label: 'npm test' };
  }
  if (stack.hasPyProject) {
    return { cmd: 'pytest', args: ['-q'], label: 'pytest' };
  }
  if (stack.hasGoMod) {
    return { cmd: 'go', args: ['test', './...'], label: 'go test ./...' };
  }
  if (stack.hasCargoToml) {
    return { cmd: 'cargo', args: ['test', '--quiet'], label: 'cargo test' };
  }
  return null;
}

/**
 * Lint: detect a runnable lint command (npm script preferred, then
 * common defaults). `na` when none can be detected.
 */
export async function checkLint(
  cwd: string,
  stack: DetectedStack,
  run: CommandRunner,
): Promise<CheckResult> {
  const weight = CATEGORY_WEIGHTS.lint;
  const cmd = pickLintCommand(stack);
  if (!cmd) {
    return {
      category: na('lint', 'No lint command detected for this stack.', weight),
      findings: [],
    };
  }
  const r = await run(cmd.cmd, cmd.args, { cwd, timeoutMs: 30_000 });
  if (r.skipped) {
    return {
      category: warn('lint', `${cmd.label} not available — skipped.`, weight),
      findings: [
        finding(
          'lint-skipped',
          'lint',
          'warn',
          `Could not run ${cmd.label}.`,
          `Install ${cmd.label} or wire a \`lint\` npm script.`,
        ),
      ],
    };
  }
  if (r.exitCode === 0) {
    return {
      category: ok('lint', `${cmd.label} exited 0.`, weight),
      findings: [],
    };
  }
  return {
    category: fail('lint', `${cmd.label} exited ${r.exitCode}.`, weight),
    findings: [
      finding(
        'lint-failed',
        'lint',
        'error',
        `${cmd.label} reported violations (exit ${r.exitCode}).`,
        `Run \`${cmd.cmd} ${cmd.args.join(' ')}\` locally and fix the reported issues.`,
      ),
    ],
  };
}

function pickLintCommand(stack: DetectedStack): RunnableCommand | null {
  if (stack.hasNodePackageJson && (stack.packageScripts['lint'] || '').trim()) {
    return { cmd: 'npm', args: ['run', 'lint', '--silent'], label: 'npm run lint' };
  }
  if (stack.hasPyProject) {
    return { cmd: 'ruff', args: ['check', '.'], label: 'ruff check' };
  }
  if (stack.hasGoMod) {
    return { cmd: 'go', args: ['vet', './...'], label: 'go vet' };
  }
  if (stack.hasCargoToml) {
    return { cmd: 'cargo', args: ['clippy', '--quiet'], label: 'cargo clippy' };
  }
  return null;
}

/**
 * Dependencies: presence of a recognised lockfile or manifest.
 */
export function checkDeps(stack: DetectedStack, cwd: string): CheckResult {
  const weight = CATEGORY_WEIGHTS.deps;
  const lockfiles = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'poetry.lock',
    'requirements.txt',
    'Pipfile.lock',
    'go.sum',
    'Cargo.lock',
  ];
  const present = lockfiles.filter((f) => existsSync(path.join(cwd, f)));
  if (!stack.hasNodePackageJson && !stack.hasPyProject && !stack.hasGoMod && !stack.hasCargoToml) {
    return {
      category: na('deps', 'No recognised package manifest in workspace.', weight),
      findings: [],
    };
  }
  if (present.length > 0) {
    return {
      category: ok('deps', `Lockfile present (${present.join(', ')}).`, weight),
      findings: [],
    };
  }
  return {
    category: warn('deps', 'Manifest present but no lockfile found.', weight),
    findings: [
      finding(
        'deps-no-lockfile',
        'deps',
        'warn',
        'No lockfile detected alongside the package manifest.',
        'Run the package manager install command to generate a lockfile (e.g. `npm install`).',
      ),
    ],
  };
}

/**
 * README, .gitignore, and a basic secrets sweep — bundled under "Auth
 * & Secrets" so a single category captures repo-hygiene gaps the user
 * cares about before sharing.
 */
export function checkAuthAndSecrets(
  cwd: string,
  scan: (cwd: string) => SecretsScanResult,
): CheckResult {
  const weight = CATEGORY_WEIGHTS.auth;
  const findings: AuditFinding[] = [];

  // README — at least one of README.md / README, > 100 bytes.
  const readmePath = ['README.md', 'README.MD', 'README', 'readme.md']
    .map((f) => path.join(cwd, f))
    .find(existsSync);
  if (!readmePath) {
    findings.push(
      finding(
        'readme-missing',
        'auth',
        'warn',
        'No README found in the workspace.',
        'Add a README.md describing what the project does and how to run it.',
      ),
    );
  } else {
    let size = 0;
    try {
      size = statSync(readmePath).size;
    } catch {
      /* already proven to exist via existsSync, but `statSync` can race */
    }
    if (size <= 100) {
      findings.push(
        finding(
          'readme-stub',
          'auth',
          'warn',
          `README is only ${size} bytes — looks like a stub.`,
          'Expand the README so a new collaborator can get started without reading source.',
        ),
      );
    }
  }

  // .gitignore
  if (!existsSync(path.join(cwd, '.gitignore'))) {
    findings.push(
      finding(
        'gitignore-missing',
        'auth',
        'warn',
        'No .gitignore in the workspace.',
        'Add a .gitignore so build outputs and secrets are not committed.',
      ),
    );
  }

  // Secrets sweep
  const scanResult = scan(cwd);
  for (const hit of scanResult.hits) {
    findings.push(
      finding(
        `secret-${hit.file}-${hit.pattern}`,
        'auth',
        'error',
        `Possible secret committed: ${hit.pattern} matched in ${hit.file}.`,
        'Rotate the credential immediately and remove it from git history.',
      ),
    );
  }
  for (const envFile of scanResult.envFiles) {
    findings.push(
      finding(
        `env-committed-${envFile}`,
        'auth',
        'warn',
        `${envFile} is checked in — environment files usually contain secrets.`,
        `Move the values to a secret store and add ${envFile} to .gitignore.`,
      ),
    );
  }

  // Roll up to a category status.
  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warn');
  const category: AuditCategory = hasError
    ? fail('auth', 'Possible secrets in the workspace.', weight)
    : hasWarn
      ? warn('auth', 'Repo hygiene issues detected.', weight)
      : ok('auth', 'README, .gitignore present and no secrets detected.', weight);
  return { category, findings };
}

/**
 * AWS deploy gate. We do not run any AWS commands here — `'aws'` in the
 * `integrations` list just opens up a recommendation (the deploy agent
 * gap).  Surfaces as `na` when the project does not declare AWS.
 */
export function checkAws(integrations: string[] | 'idk' | null | undefined): CheckResult {
  const weight = CATEGORY_WEIGHTS.aws;
  const list = Array.isArray(integrations) ? integrations : [];
  const wantsAws = list.includes('aws');
  if (!wantsAws) {
    return {
      category: na('aws', 'AWS not selected for this project.', weight),
      findings: [],
    };
  }
  return {
    category: warn('aws', 'AWS selected — no deploy agent assigned yet.', weight),
    findings: [
      finding(
        'aws-deploy-agent',
        'aws',
        'info',
        'A deploy agent is recommended for AWS-backed projects.',
        'Assign a Deploy / SRE-flavoured agent in the roster picker before launching.',
      ),
    ],
  };
}

// ─── Secrets scan ──────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'aws-access-key-id', regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'aws-secret-access-key', regex: /aws_secret_access_key\s*=\s*['"]?([A-Za-z0-9/+=]{40})/ },
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  {
    name: 'private-key-block',
    regex: /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/,
  },
];

const ENV_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
]);

const SECRET_SCAN_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

const SECRET_SCAN_MAX_FILE_BYTES = 256 * 1024;
const SECRET_SCAN_MAX_FILES = 2_000;

export function defaultSecretsScan(cwd: string): SecretsScanResult {
  const hits: Array<{ file: string; pattern: string }> = [];
  const envFiles: string[] = [];
  let scanned = 0;

  function walk(dir: string, rel: string): void {
    if (scanned >= SECRET_SCAN_MAX_FILES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= SECRET_SCAN_MAX_FILES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SECRET_SCAN_IGNORE.has(entry.name)) continue;
        walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (ENV_FILE_NAMES.has(entry.name)) {
        envFiles.push(childRel);
      }
      let size = 0;
      try {
        size = statSync(childAbs).size;
      } catch {
        continue;
      }
      if (size > SECRET_SCAN_MAX_FILE_BYTES) continue;
      let contents = '';
      try {
        contents = readFileSync(childAbs, 'utf-8');
      } catch {
        continue;
      }
      scanned++;
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(contents)) {
          hits.push({ file: childRel, pattern: pattern.name });
        }
      }
    }
  }

  walk(cwd, '');
  return { hits, envFiles };
}

// ─── Score + roster ────────────────────────────────────────────────

const STATUS_CREDIT: Record<AuditCategoryStatus, number | null> = {
  ok: 1,
  warn: 0.5,
  fail: 0,
  na: null,
};

export function computeScore(categories: AuditCategory[]): number {
  let totalWeight = 0;
  let earned = 0;
  for (const cat of categories) {
    const credit = STATUS_CREDIT[cat.status];
    if (credit == null) continue;
    const w = typeof cat.weight === 'number' ? cat.weight : 10;
    totalWeight += w;
    earned += w * credit;
  }
  if (totalWeight === 0) return 100;
  return Math.round((earned / totalWeight) * 100);
}

export function suggestTracks(agents: AgentLike[] = []): SuggestedTrack[] {
  return DEFAULT_TRACKS.map((track) => {
    const match = agents.find((agent) => agentMatchesTrack(agent, track.keywords));
    return {
      id: track.id,
      label: track.label,
      rationale: track.rationale,
      keywords: track.keywords,
      defaultAgent: match ? match.id : null,
      suggestedAgentId: match ? match.id : null,
    };
  });
}

function agentMatchesTrack(agent: AgentLike, keywords: string[]): boolean {
  // Tokenise the agent's identifying fields on non-alphanumeric chars so
  // short keywords like 'ui' or 'be' don't false-positive against
  // substrings (e.g. "Builder" contains "ui").
  const tokens = new Set(
    [agent.id, agent.name, agent.role, ...((agent.tags || []) as string[])]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  return keywords.some((kw) => kw && tokens.has(kw.toLowerCase()));
}

// ─── Public entry point ────────────────────────────────────────────

export async function runAudit(input: AuditInput): Promise<AuditReport> {
  const {
    projectId,
    cwd,
    integrations,
    agents = [],
    runCommand = runRealCommand,
    scanForSecrets = defaultSecretsScan,
    now = () => new Date(),
  } = input;

  if (!projectId) throw new Error('projectId required');
  if (!cwd) throw new Error('cwd required');

  const stack = detectStack(cwd);

  const gitResult = await checkGit(cwd, runCommand);
  const testsResult = await checkTests(cwd, stack, runCommand);
  const lintResult = await checkLint(cwd, stack, runCommand);
  const depsResult = checkDeps(stack, cwd);
  const authResult = checkAuthAndSecrets(cwd, scanForSecrets);
  const awsResult = checkAws(integrations);

  const allChecks = [gitResult, testsResult, lintResult, depsResult, authResult, awsResult];
  const categories = allChecks.map((c) => c.category);
  const findings = allChecks.flatMap((c) => c.findings);
  const gaps = buildGaps(integrations, agents);

  const score = computeScore(categories);
  return {
    projectId,
    generatedAt: now().toISOString(),
    score,
    readinessScore: score,
    categories,
    findings,
    gaps,
    suggestedTracks: suggestTracks(agents),
  };
}

function buildGaps(
  integrations: string[] | 'idk' | null | undefined,
  agents: AgentLike[],
): AuditGap[] {
  const gaps: AuditGap[] = [];
  const list = Array.isArray(integrations) ? integrations : [];
  if (list.includes('aws')) {
    gaps.push({
      id: 'deploy-agent-recommended',
      label: 'Deploy agent recommended',
      hint: 'AWS is in the integration list — assign a deploy/SRE agent before launching automated work.',
    });
  }
  if (agents.length === 0) {
    gaps.push({
      id: 'no-agents',
      label: 'No agents available',
      hint: 'Create at least one agent so a roster can be assigned to this project.',
    });
  }
  return gaps;
}

// ─── Production command runner ─────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

export const runRealCommand: CommandRunner = (cmd, args, opts) =>
  new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    } catch (err: unknown) {
      resolve({
        exitCode: 127,
        stdout: '',
        stderr: (err as Error)?.message || 'spawn failed',
        skipped: true,
      });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      resolve({
        exitCode: 124,
        stdout,
        stderr: stderr + '\n[audit] command timed out',
      });
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        stdout,
        stderr: err.message || 'command not found',
        skipped: err.code === 'ENOENT',
      });
    });
    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
