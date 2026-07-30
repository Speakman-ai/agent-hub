/**
 * finalize-setup-draft.ts — server-side scan for the Finalize ci.yaml
 * setup wizard. Mirrors the shape of the other setup-draft modules but
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
 * The proposed YAML validates against the v1 or v2 parser depending on
 * whether the repo's e2e workflow declares a strategy.matrix block.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
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

function statIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
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

/** Deploy/release/terraform workflows are not CI gates for Finalize. */
const NON_CI_WORKFLOW_RE = /^(deploy\.|release\.|terraform_|hotfix\.)/i;

/** Workflows that represent pre-merge CI gates (one Finalize step each, in sort order). */
const CI_GATE_WORKFLOW_RE = /lint|\.ci\.|(^|\/)e2e\.|permissions|smoke-test|^ci\.ya?ml$/i;

function isCiGateWorkflow(filename: string): boolean {
  if (NON_CI_WORKFLOW_RE.test(filename)) return false;
  return CI_GATE_WORKFLOW_RE.test(filename);
}

function workflowSortKey(filename: string): number {
  const n = filename.toLowerCase();
  if (n.includes('lint')) return 0;
  if (n.includes('backend') && n.includes('ci')) return 1;
  if (n.includes('frontend') && n.includes('ci')) return 2;
  if (n.includes('permissions')) return 3;
  if (n.includes('e2e')) return 4;
  if (n.includes('smoke')) return 5;
  if (n.endsWith('.ci.yml') || n === 'ci.yml') return 6;
  return 50;
}

/** Root-level scripts commonly used as local CI gates (./lint, ./run_api_tests, …). */
function scanRootGateScripts(workspaceDir: string): Map<string, string> {
  const scripts = new Map<string, string>();
  for (const entry of safeReaddir(workspaceDir)) {
    if (entry.startsWith('.')) continue;
    const abs = path.join(workspaceDir, entry);
    if (!statIsFile(abs)) continue;
    if (/^(lint|run_|build_|test_|verify)/i.test(entry)) {
      scripts.set(entry.toLowerCase(), `./${entry}`);
    }
  }
  return scripts;
}

function extractRunCommandsFromWorkflow(workspaceDir: string, filename: string): string[] {
  const content = safeReadFile(path.join(workspaceDir, '.github', 'workflows', filename));
  if (!content) return [];
  const runs: string[] = [];
  const runRe = /^\s+run:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(content)) !== null) {
    const cmd = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (cmd && !cmd.includes('${{')) runs.push(cmd);
  }
  return runs;
}

function stepNameFromWorkflow(filename: string): string {
  return filename
    .replace(/\.ya?ml$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Mirror GitHub CI gate workflows as Finalize steps. Prefers repo root gate
 * scripts (./lint, ./run_api_tests) when filenames match; falls back to
 * `run:` lines parsed from the workflow file.
 */
export function buildProposedStepsFromGithubWorkflows(
  workspaceDir: string,
  githubWorkflows: string[],
): ProposedStep[] {
  const gates = githubWorkflows.filter(isCiGateWorkflow).sort((a, b) => {
    const d = workflowSortKey(a) - workflowSortKey(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
  if (gates.length === 0) return [];

  const rootScripts = scanRootGateScripts(workspaceDir);
  const steps: ProposedStep[] = [];

  for (const wf of gates) {
    const base = wf.replace(/\.ya?ml$/i, '').toLowerCase();
    const wfRuns = extractRunCommandsFromWorkflow(workspaceDir, wf);

    if (base === 'lint' || base.endsWith('.lint')) {
      steps.push({ name: 'lint', run: rootScripts.get('lint') ?? wfRuns[0] ?? './lint' });
      continue;
    }
    if (base.includes('backend') && base.includes('ci')) {
      steps.push({
        name: 'backend-tests',
        run: rootScripts.get('run_api_tests') ?? wfRuns[0] ?? './run_api_tests',
      });
      continue;
    }
    if (base.includes('frontend') && base.includes('ci')) {
      if (rootScripts.has('run_frontend_tests')) {
        steps.push({ name: 'frontend-tests', run: rootScripts.get('run_frontend_tests')! });
      } else {
        steps.push({
          name: 'frontend-build',
          run:
            wfRuns.find((r) => r.includes('build')) ??
            'cd frontend && npm ci && npm run build:production',
        });
        const cypressRun =
          wfRuns.find((r) => r.includes('cypress')) ?? 'cd frontend && npx cypress run --component';
        steps.push({ name: 'frontend-component-tests', run: cypressRun });
      }
      continue;
    }
    if (base.includes('permissions')) {
      const permScript =
        rootScripts.get('verifypermissionsync') ??
        [...rootScripts.values()].find((s) => s.includes('permission')) ??
        (existsSync(path.join(workspaceDir, 'scripts', 'verify_permissions_sync.sh'))
          ? './scripts/verify_permissions_sync.sh'
          : null);
      steps.push({
        name: 'permissions-sync-check',
        run: permScript ?? wfRuns[0] ?? './verifypermissionsync',
      });
      continue;
    }
    if (base.includes('e2e')) {
      const matrix = extractMatrixIncludeFromWorkflow(workspaceDir, wf);
      if (matrix && matrix.length > 0) {
        // Signal to caller — e2e uses v2 matrix jobs instead of a single step.
        steps.push({
          name: '__e2e_matrix__',
          run: JSON.stringify({ workflow: wf, matrix }),
        });
        continue;
      }
      steps.push({
        name: 'e2e',
        run: rootScripts.get('run_e2e_tests') ?? wfRuns[0] ?? './run_e2e_tests',
      });
      continue;
    }
    if (base.includes('smoke')) {
      steps.push({
        name: 'smoke-test',
        run: rootScripts.get('run_smoke_tests') ?? wfRuns[0] ?? './run_smoke_tests',
      });
      continue;
    }

    // Generic ci.yml or other gate — one step per distinct run: line, or a single named step.
    const name = stepNameFromWorkflow(wf);
    if (wfRuns.length === 1) {
      steps.push({ name, run: wfRuns[0] });
    } else if (wfRuns.length > 1) {
      wfRuns.forEach((run, i) => steps.push({ name: `${name}-${i + 1}`, run }));
    } else {
      steps.push({ name, run: `./${base}` });
    }
  }

  return steps;
}

function buildProposedSteps(
  workspaceDir: string,
  githubWorkflows: string[],
  stack: FinalizeStack,
  manager: FinalizePackageManager,
  npmScripts: FinalizeNpmScriptHit[],
  makefileTargets: string[],
  subprojects: FinalizeSubproject[],
): ProposedStep[] {
  const fromWorkflows = buildProposedStepsFromGithubWorkflows(workspaceDir, githubWorkflows);
  if (fromWorkflows.length > 0) return fromWorkflows;

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

function extractMatrixIncludeFromWorkflow(
  workspaceDir: string,
  filename: string,
): Array<Record<string, string>> | null {
  const content = safeReadFile(path.join(workspaceDir, '.github', 'workflows', filename));
  if (!content) return null;
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const jobs = (doc as Record<string, unknown>).jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return null;
  for (const jobRaw of Object.values(jobs as Record<string, unknown>)) {
    if (!jobRaw || typeof jobRaw !== 'object' || Array.isArray(jobRaw)) continue;
    const strategy = (jobRaw as Record<string, unknown>).strategy;
    if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) continue;
    const matrix = (strategy as Record<string, unknown>).matrix;
    if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) continue;
    const include = (matrix as Record<string, unknown>).include;
    if (!Array.isArray(include) || include.length === 0) continue;
    const rows: Array<Record<string, string>> = [];
    for (const entry of include) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof v !== 'string') return null;
        row[k] = v;
      }
      rows.push(row);
    }
    return rows;
  }
  return null;
}

/**
 * Reserved job ids the host-job namer must not collide with.
 *
 * `e2e` is emitted below as the container matrix job, so a detected gate that
 * sanitises to `e2e` has to be renamed or it would silently replace it.
 */
const RESERVED_JOB_IDS = new Set(['e2e']);

/**
 * Derive a YAML-safe, unique job id from a human step name.
 *
 * Two failure modes this closes, both of which silently drop CI coverage:
 *
 *   - **Collision.** `Lint` and `lint` (or `Test (unit)` and `Test [unit]`)
 *     sanitise to the same key. A duplicate key in a YAML mapping keeps only
 *     the last entry, so an entire gate disappears from the pipeline.
 *   - **Empty / unsafe id.** A name that is entirely punctuation sanitises to
 *     `''` or a bare `-`, producing `  :` or `  -:` — either unparsable or
 *     read as a sequence entry rather than a job key.
 *
 * Ids are lowercased for stability across machines, stripped of leading and
 * trailing separators, and de-duplicated with a numeric suffix.
 */
function uniqueJobId(name: string, taken: Set<string>): string {
  const base =
    name
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .toLowerCase()
      .replace(/^[-._]+|[-._]+$/g, '') || 'job';
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_JOB_IDS.has(id); n++) {
    id = `${base}-${n}`;
  }
  taken.add(id);
  return id;
}

/**
 * Serialise a `ProposedStep[]` into a valid ci.yaml document: one host job
 * per simple gate, plus an optional matrix e2e job mirroring
 * `.github/workflows/e2e.yml`.
 *
 * Host jobs are chained with `needs` in detection order rather than left
 * independent. `runs-on: host` executes on the Hub box in the session's own
 * worktree, so every host job shares one directory: running the detected gates
 * concurrently lets lint/typecheck/test start before the install gate has
 * finished writing `node_modules`, and lets any two of them race while mutating
 * build output. The steps this is built from were an ordered list, so a linear
 * chain is also the faithful translation of their original semantics. The e2e
 * matrix job is deliberately NOT chained: it runs in a container with its own
 * checkout, so it shares nothing with the host jobs and should start at once.
 *
 * Kept hand-rolled rather than going through `yaml.stringify` because the
 * wire format is small, predictable, and we want stable formatting across
 * machines (the wizard shows this verbatim, then writes it to disk — the
 * parser is the only authority on validity).
 */
export function serializeProposedCiYaml(args: {
  hostJobs: ProposedStep[];
  e2eMatrix?: Array<Record<string, string>>;
  timeoutMinutes?: number;
}): string {
  const timeoutMinutes = args.timeoutMinutes ?? 60;
  // The schema rejects an empty `jobs:` mapping, so a repo with nothing
  // detectable still gets a draft that parses (and fails loudly when run).
  const hostJobs =
    args.hostJobs.length > 0 || (args.e2eMatrix?.length ?? 0) > 0
      ? args.hostJobs
      : [{ name: 'test', run: 'echo "configure me" && exit 1' }];
  const lines: string[] = [];
  lines.push('version: 2');
  lines.push('on:');
  lines.push('  - finalize');
  lines.push('  - manual');
  if (timeoutMinutes !== 60) {
    lines.push(`timeout_minutes: ${timeoutMinutes}`);
  }
  lines.push('env:');
  lines.push('  GIT_BRANCH: ${FINALIZE_BRANCH}');
  lines.push('  GIT_COMMIT_SHA: ${FINALIZE_HEAD_SHA}');
  lines.push('jobs:');

  const takenJobIds = new Set<string>();
  let previousHostJobId: string | null = null;
  for (const step of hostJobs) {
    const jobId = uniqueJobId(step.name, takenJobIds);
    lines.push(`  ${jobId}:`);
    lines.push('    runs-on: host');
    if (previousHostJobId) {
      lines.push(`    needs: [${previousHostJobId}]`);
    }
    lines.push('    steps:');
    lines.push(`      - name: ${yamlScalar(step.name)}`);
    lines.push(`        run: ${yamlScalar(step.run)}`);
    previousHostJobId = jobId;
  }

  if (args.e2eMatrix && args.e2eMatrix.length > 0) {
    lines.push('  e2e:');
    lines.push('    runs-on: ubuntu-24.04');
    lines.push('    fail-fast: false');
    lines.push('    matrix:');
    lines.push('      include:');
    for (const row of args.e2eMatrix) {
      lines.push('        - group: ' + yamlScalar(row.group ?? 'shard'));
      if (row.specs) lines.push('          specs: ' + yamlScalar(row.specs));
      for (const [k, v] of Object.entries(row)) {
        if (k === 'group' || k === 'specs') continue;
        lines.push(`          ${k}: ${yamlScalar(v)}`);
      }
    }
    lines.push('    steps:');
    lines.push('      - name: smoke');
    lines.push('        run: docker version');
    lines.push('      - name: e2e');
    lines.push('        run: ./run_e2e_tests');
  }

  return lines.join('\n') + '\n';
}

function splitProposedStepsForJobs(steps: ProposedStep[]): {
  hostJobs: ProposedStep[];
  e2eMatrix: Array<Record<string, string>> | null;
} {
  const hostJobs: ProposedStep[] = [];
  let e2eMatrix: Array<Record<string, string>> | null = null;
  for (const step of steps) {
    if (step.name === '__e2e_matrix__') {
      try {
        const payload = JSON.parse(step.run) as { matrix?: Array<Record<string, string>> };
        e2eMatrix = payload.matrix ?? null;
      } catch {
        /* ignore */
      }
      continue;
    }
    hostJobs.push(step);
  }
  return { hostJobs, e2eMatrix };
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
    workspaceDir,
    githubWorkflows,
    stack,
    manager,
    npmScripts,
    makefileTargets,
    subprojects,
  );
  const proposedTimeout = proposedSteps.length >= 3 ? 60 : 30;
  const { hostJobs, e2eMatrix } = splitProposedStepsForJobs(proposedSteps);
  const proposedCiYaml = serializeProposedCiYaml({
    hostJobs,
    ...(e2eMatrix && e2eMatrix.length > 0 ? { e2eMatrix } : {}),
    timeoutMinutes: proposedTimeout,
  });

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
