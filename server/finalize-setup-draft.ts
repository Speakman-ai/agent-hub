/**
 * finalize-setup-draft.ts — server-side scan for the Finalize ci.yaml
 * setup wizard. Mirrors the shape of `preview-environment-draft.ts` but
 * with CI-relevant signal:
 *
 *   - existing `.agent-hub/ci.yaml` (overwrite warning surface)
 *   - primary stack + package manager
 *   - monorepo / sub-projects (per-manifest)
 *   - existing CI signal (`.github/workflows/*.yml`, Makefile targets)
 *   - package.json scripts (test / lint / typecheck / build shapes)
 *   - env vars referenced in source (reuse the preview scanner)
 *   - a server-pre-built `proposedSteps` YAML the wizard can show to the
 *     user as a starting point
 *
 * This module is pure: no spawning, no DB. It reads files from
 * `workspaceDir` and returns a JSON-serialisable struct that the wizard
 * route embeds in the kickoff prompt.
 *
 * The proposed YAML always validates against the v1 parser
 * (`server/finalize/ci-config.ts`). The unit tests pin that contract so
 * a parser-breaking change shows up here before it ships to users.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { scanEnvKeys } from './preview-setup-scans.js';
import { scanReadme, type ReadmeScanResult } from './preview-readme-scan.js';

// ─── Public types ─────────────────────────────────────────────────────

export type FinalizeStack = 'node' | 'python' | 'rust' | 'go' | 'mixed' | 'unknown';

export type FinalizePackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'pip'
  | 'poetry'
  | 'cargo'
  | 'go'
  | null;

export interface FinalizeSubproject {
  /** Path of the subproject relative to `workspaceDir`. `"."` for the root. */
  path: string;
  /** Manifest file present in the subproject (relative path). */
  manifest: string;
  /** Detected package manager for this subproject. */
  manager: FinalizePackageManager;
}

export interface FinalizeNpmScriptHit {
  /** Script name as it appears in package.json. */
  name: string;
  /** Verbatim script body. */
  body: string;
  /**
   * Bucket the script fell into based on its name + body. Lets the
   * proposer decide which scripts to wire into the default pipeline.
   */
  kind: 'test' | 'lint' | 'typecheck' | 'build' | 'format' | 'other';
}

export interface FinalizeSetupDraft {
  /** True iff `<workspaceDir>/.agent-hub/ci.yaml` already exists. */
  existingCi: boolean;
  /** Verbatim content of the existing ci.yaml, if any. Capped to 64 KiB. */
  existingCiContent: string | null;
  stack: FinalizeStack;
  packageManager: FinalizePackageManager;
  isMonorepo: boolean;
  subprojects: FinalizeSubproject[];
  /** `.github/workflows/*.yml` filenames present in the repo. */
  githubWorkflows: string[];
  /** Make targets that look like test / lint / build (heuristic). */
  makefileTargets: string[];
  /** Top-level package.json scripts the wizard can wire in. */
  npmScripts: FinalizeNpmScriptHit[];
  readme: ReadmeScanResult;
  /** Env vars referenced in source — same scanner the preview wizard uses. */
  envVars: Array<{ key: string; sources: string[]; required: boolean }>;
  /**
   * Server-pre-built ci.yaml the wizard can show verbatim. Always
   * passes the v1 parser even when it falls back to the minimal shape.
   */
  proposedCiYaml: string;
}

// ─── Internals ────────────────────────────────────────────────────────

const MAX_CI_FILE_BYTES = 64 * 1024;
const MAX_NPM_SCRIPTS = 20;
const SUBPROJECT_SEARCH_DEPTH = 2;

const TEST_SCRIPT_RE = /^(test|tests|test:.+|jest|vitest|playwright|cypress)$/i;
const LINT_SCRIPT_RE = /^(lint|lint:.+|eslint)$/i;
const TYPECHECK_SCRIPT_RE = /^(typecheck|type-check|tc|types|tsc)$/i;
const BUILD_SCRIPT_RE = /^(build|build:.+|compile)$/i;
const FORMAT_SCRIPT_RE = /^(format|fmt|prettier)$/i;

const MAKE_INTERESTING_TARGETS = new Set([
  'test',
  'tests',
  'lint',
  'typecheck',
  'type-check',
  'build',
  'check',
  'fmt',
  'format',
  'ci',
  'verify',
]);

const SUBPROJECT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.worktrees',
  'worktrees',
  '.agent-hub',
  '.idea',
  '.vscode',
]);

function safeReadFile(p: string, maxBytes = Infinity): string | null {
  try {
    const text = readFileSync(p, 'utf8');
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function classifyNpmScript(name: string, body: string): FinalizeNpmScriptHit['kind'] {
  if (TEST_SCRIPT_RE.test(name)) return 'test';
  if (LINT_SCRIPT_RE.test(name)) return 'lint';
  if (TYPECHECK_SCRIPT_RE.test(name)) return 'typecheck';
  if (BUILD_SCRIPT_RE.test(name)) return 'build';
  if (FORMAT_SCRIPT_RE.test(name)) return 'format';
  // Body-based fallback for off-name scripts (`run-all` etc.)
  if (/vitest|jest|playwright|pytest|cargo\s+test|go\s+test/.test(body)) return 'test';
  if (/eslint|stylelint/.test(body)) return 'lint';
  if (/tsc(\s|$)|--noEmit/.test(body)) return 'typecheck';
  return 'other';
}

function detectPackageManagerForDir(absDir: string): FinalizePackageManager {
  if (existsSync(path.join(absDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(absDir, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(absDir, 'package-lock.json'))) return 'npm';
  if (existsSync(path.join(absDir, 'package.json'))) return 'npm';
  if (existsSync(path.join(absDir, 'poetry.lock'))) return 'poetry';
  if (existsSync(path.join(absDir, 'pyproject.toml'))) {
    const txt = safeReadFile(path.join(absDir, 'pyproject.toml')) ?? '';
    return /\[tool\.poetry\]/m.test(txt) ? 'poetry' : 'pip';
  }
  if (existsSync(path.join(absDir, 'requirements.txt'))) return 'pip';
  if (existsSync(path.join(absDir, 'Cargo.toml'))) return 'cargo';
  if (existsSync(path.join(absDir, 'go.mod'))) return 'go';
  return null;
}

function detectStack(managers: FinalizePackageManager[]): FinalizeStack {
  const set = new Set(managers.filter((m): m is NonNullable<FinalizePackageManager> => Boolean(m)));
  if (set.size === 0) return 'unknown';
  if (set.size > 1) {
    // Treat npm/pnpm/yarn as the same stack for this purpose.
    const distinct = new Set<string>();
    for (const m of set) {
      if (m === 'npm' || m === 'pnpm' || m === 'yarn') distinct.add('node');
      else if (m === 'pip' || m === 'poetry') distinct.add('python');
      else distinct.add(m);
    }
    if (distinct.size === 1) {
      const only = [...distinct][0];
      if (only === 'node') return 'node';
      if (only === 'python') return 'python';
      if (only === 'cargo') return 'rust';
      if (only === 'go') return 'go';
    }
    return 'mixed';
  }
  const only = [...set][0];
  if (only === 'npm' || only === 'pnpm' || only === 'yarn') return 'node';
  if (only === 'pip' || only === 'poetry') return 'python';
  if (only === 'cargo') return 'rust';
  if (only === 'go') return 'go';
  return 'unknown';
}

function findSubprojects(workspaceDir: string): FinalizeSubproject[] {
  const out: FinalizeSubproject[] = [];

  // Always consider the root.
  const rootManager = detectPackageManagerForDir(workspaceDir);
  if (rootManager) {
    const manifest = manifestForManager(workspaceDir, rootManager);
    if (manifest) out.push({ path: '.', manifest, manager: rootManager });
  }

  // Shallow scan two levels deep. Catches `apps/web`, `packages/cli`, etc.
  function walk(absDir: string, relDir: string, depth: number): void {
    if (depth > SUBPROJECT_SEARCH_DEPTH) return;
    const entries = safeReaddir(absDir);
    for (const name of entries) {
      if (SUBPROJECT_SKIP_DIRS.has(name)) continue;
      if (name.startsWith('.')) continue;
      const childAbs = path.join(absDir, name);
      const childRel = relDir === '.' ? name : path.posix.join(relDir, name);
      if (!statIsDir(childAbs)) continue;
      const mgr = detectPackageManagerForDir(childAbs);
      if (mgr) {
        const manifest = manifestForManager(childAbs, mgr);
        if (manifest) {
          out.push({
            path: childRel,
            manifest: path.posix.join(childRel, manifest),
            manager: mgr,
          });
        }
      }
      walk(childAbs, childRel, depth + 1);
    }
  }
  walk(workspaceDir, '.', 1);

  return out;
}

function statIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function manifestForManager(absDir: string, mgr: FinalizePackageManager): string | null {
  if (mgr === 'npm' || mgr === 'pnpm' || mgr === 'yarn') return 'package.json';
  if (mgr === 'poetry' || mgr === 'pip') {
    if (existsSync(path.join(absDir, 'pyproject.toml'))) return 'pyproject.toml';
    if (existsSync(path.join(absDir, 'requirements.txt'))) return 'requirements.txt';
  }
  if (mgr === 'cargo') return 'Cargo.toml';
  if (mgr === 'go') return 'go.mod';
  return null;
}

function scanGithubWorkflows(workspaceDir: string): string[] {
  const dir = path.join(workspaceDir, '.github', 'workflows');
  return safeReaddir(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

function scanMakefileTargets(workspaceDir: string): string[] {
  const txt = safeReadFile(path.join(workspaceDir, 'Makefile'));
  if (!txt) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    // Match "target:" but not variable assignments ("FOO:=...") or recipe
    // continuations (which start with TAB).
    const m = /^([a-zA-Z0-9_.-]+):(?!=)/.exec(line);
    if (!m) continue;
    const target = m[1];
    if (target.startsWith('.')) continue;
    if (!MAKE_INTERESTING_TARGETS.has(target)) continue;
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

function scanNpmScripts(workspaceDir: string): FinalizeNpmScriptHit[] {
  const txt = safeReadFile(path.join(workspaceDir, 'package.json'));
  if (!txt) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(txt);
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== 'object') return [];
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const out: FinalizeNpmScriptHit[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== 'string') continue;
    const kind = classifyNpmScript(name, body);
    out.push({ name, body, kind });
    if (out.length >= MAX_NPM_SCRIPTS) break;
  }
  return out;
}

// ─── Proposed YAML builder ────────────────────────────────────────────

interface ProposedStep {
  name: string;
  run: string;
}

function buildProposedSteps(
  stack: FinalizeStack,
  manager: FinalizePackageManager,
  npmScripts: FinalizeNpmScriptHit[],
  makefileTargets: string[],
  subprojects: FinalizeSubproject[],
): ProposedStep[] {
  // Makefile-first: if a Makefile has `test`, lean on it — projects with
  // a real Makefile usually expect it as the entry point.
  if (makefileTargets.includes('test')) {
    const steps: ProposedStep[] = [];
    for (const t of ['lint', 'typecheck', 'test']) {
      if (makefileTargets.includes(t)) steps.push({ name: t, run: `make ${t}` });
    }
    if (steps.length > 0) return steps;
  }

  // Node monorepo: one install + one test per sub-project.
  const nodeSubs = subprojects.filter(
    (s) => s.manager === 'npm' || s.manager === 'pnpm' || s.manager === 'yarn',
  );
  if (nodeSubs.length > 1 && stack === 'node') {
    const steps: ProposedStep[] = [];
    for (const s of nodeSubs) {
      const dirArg = s.path === '.' ? '' : `cd ${s.path} && `;
      const installCmd =
        s.manager === 'pnpm'
          ? 'pnpm install --frozen-lockfile'
          : s.manager === 'yarn'
            ? 'yarn install --frozen-lockfile'
            : 'npm ci --include=dev';
      const testCmd =
        s.manager === 'pnpm' ? 'pnpm test' : s.manager === 'yarn' ? 'yarn test' : 'npm test';
      steps.push({ name: `${s.path} install`, run: `${dirArg}${installCmd}` });
      steps.push({ name: `${s.path} test`, run: `${dirArg}${testCmd}` });
    }
    return steps;
  }

  // Single-project paths by stack:
  if (stack === 'node' && manager) {
    const steps: ProposedStep[] = [];
    if (manager === 'pnpm') {
      steps.push({ name: 'install', run: 'pnpm install --frozen-lockfile' });
    } else if (manager === 'yarn') {
      steps.push({ name: 'install', run: 'yarn install --frozen-lockfile' });
    } else {
      steps.push({ name: 'install', run: 'npm ci --include=dev' });
    }
    const runCmd = manager === 'pnpm' ? 'pnpm' : manager === 'yarn' ? 'yarn' : 'npm run';
    const hasScript = (kind: FinalizeNpmScriptHit['kind']) =>
      npmScripts.some((s) => s.kind === kind);
    if (hasScript('typecheck')) steps.push({ name: 'typecheck', run: `${runCmd} typecheck` });
    if (hasScript('lint')) steps.push({ name: 'lint', run: `${runCmd} lint` });
    if (hasScript('test')) {
      const testCmd =
        manager === 'pnpm' ? 'pnpm test' : manager === 'yarn' ? 'yarn test' : 'npm test';
      steps.push({ name: 'test', run: testCmd });
    }
    return steps;
  }

  if (stack === 'python') {
    if (manager === 'poetry') {
      return [
        { name: 'install', run: 'poetry install --no-interaction' },
        { name: 'test', run: 'poetry run pytest' },
      ];
    }
    return [
      { name: 'install', run: 'pip install -r requirements.txt' },
      { name: 'test', run: 'pytest' },
    ];
  }

  if (stack === 'rust') {
    return [
      { name: 'fmt', run: 'cargo fmt --check' },
      { name: 'test', run: 'cargo test --all' },
    ];
  }

  if (stack === 'go') {
    return [
      { name: 'vet', run: 'go vet ./...' },
      { name: 'test', run: 'go test ./...' },
    ];
  }

  // Mixed / unknown fallback: a single step that runs `make test` if
  // there's a Makefile, otherwise a placeholder that fails loud so the
  // user notices and edits before the first Finalize click.
  if (makefileTargets.length > 0) {
    return [{ name: 'test', run: 'make test' }];
  }
  return [
    {
      name: 'test',
      run: 'echo "Update .agent-hub/ci.yaml with your test command and re-run Finalize" && exit 1',
    },
  ];
}

/**
 * Serialise a `ProposedStep[]` into a v1-valid ci.yaml document.
 *
 * Kept hand-rolled rather than going through `yaml.stringify` because
 * the wire format is small, predictable, and we want stable formatting
 * across machines (the wizard shows this verbatim, then writes it to
 * disk — the parser is the only authority on validity).
 */
export function serializeProposedCiYaml(steps: ProposedStep[], timeoutMinutes = 30): string {
  if (steps.length === 0) {
    // Schema rejects empty steps — fall back to a minimal placeholder so
    // the draft always passes the v1 parser even on weird repos.
    steps = [{ name: 'test', run: 'echo "configure me" && exit 1' }];
  }
  const lines: string[] = [];
  lines.push('version: 1');
  lines.push('on:');
  lines.push('  - finalize');
  lines.push('  - manual');
  if (timeoutMinutes !== 60) {
    lines.push(`timeout_minutes: ${timeoutMinutes}`);
  }
  lines.push('steps:');
  for (const step of steps) {
    lines.push(`  - name: ${yamlScalar(step.name)}`);
    lines.push(`    run: ${yamlScalar(step.run)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Minimal YAML scalar quoting. Quotes when the value contains characters
 * that would otherwise break flow scalars (`:`, `#`, leading `-`, etc.)
 * or has surrounding whitespace; emits a plain scalar otherwise. We use
 * double-quoted form so backslash-escape is straightforward.
 */
function yamlScalar(value: string): string {
  if (value === '') return '""';
  const needsQuoting =
    /[:#&*!|>'"%@`,[\]{}?]/.test(value) ||
    /\s\s/.test(value) ||
    /^[-?\s]/.test(value) ||
    /\s$/.test(value) ||
    /[\n\r\t]/.test(value);
  if (!needsQuoting) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

// ─── Public entry point ───────────────────────────────────────────────

export function collectFinalizeSetupDraft(workspaceDir: string): FinalizeSetupDraft {
  const subprojects = findSubprojects(workspaceDir);
  const managers = subprojects.map((s) => s.manager);
  const stack = detectStack(managers);
  const manager =
    subprojects.find((s) => s.path === '.')?.manager ?? subprojects[0]?.manager ?? null;
  const npmScripts = scanNpmScripts(workspaceDir);
  const makefileTargets = scanMakefileTargets(workspaceDir);
  const githubWorkflows = scanGithubWorkflows(workspaceDir);
  const readme = scanReadme(workspaceDir);

  // Reuse the env scanner the preview-setup wizard uses — same keys
  // are interesting (project envs the steps will read). The scanner
  // returns a deduped, sorted array of names.
  const envKeys = scanEnvKeys(workspaceDir);
  const envVars = envKeys.map((key) => ({
    key,
    sources: ['source'] as string[],
    required: false,
  }));

  const proposedSteps = buildProposedSteps(
    stack,
    manager,
    npmScripts,
    makefileTargets,
    subprojects,
  );
  const proposedCiYaml = serializeProposedCiYaml(proposedSteps);

  const ciAbs = path.join(workspaceDir, '.agent-hub', 'ci.yaml');
  const existingCi = existsSync(ciAbs);
  const existingCiContent = existingCi ? safeReadFile(ciAbs, MAX_CI_FILE_BYTES) : null;

  return {
    existingCi,
    existingCiContent,
    stack,
    packageManager: manager,
    isMonorepo: subprojects.length > 1,
    subprojects,
    githubWorkflows,
    makefileTargets,
    npmScripts,
    readme,
    envVars,
    proposedCiYaml,
  };
}
