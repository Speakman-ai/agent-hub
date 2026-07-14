/**
 * Repo scan for the **Logs setup wizard** (`POST .../logs/setup-wizard`).
 *
 * Pure, DB-free, spawn-free: reads files under `workspaceDir` with sync `fs`
 * and returns a JSON-serializable draft describing how to wire the target
 * application's logs into Agent Hub — detected stack, existing logging
 * libraries / OpenTelemetry setup, the best files to instrument, a recommended
 * ingest approach, and the ingest endpoints for this Hub. The wizard route
 * enriches this with the project's existing log sources before embedding it in
 * the agent kickoff prompt; the read-only draft endpoint returns it as-is.
 *
 * Mirrors the pure-function shape of `rum-setup-draft.ts` /
 * `finalize-setup-draft.ts`.
 */
import { readFileSync, realpathSync, statSync } from 'fs';
import path from 'path';
import { scanReadme, type ReadmeScanResult } from './preview-readme-scan.js';

export type LogsStack = 'node' | 'python' | 'go' | 'ruby' | 'java' | 'mixed' | 'unknown';

export type LogsPackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'pip'
  | 'poetry'
  | 'go'
  | 'bundler'
  | 'maven'
  | 'gradle'
  | null;

/** Recommended way to get logs flowing, given what the repo already has. */
export type LogsApproach = 'collector' | 'otel-sdk' | 'json-batch';

export interface LogsEntryCandidate {
  /** Workspace-relative path of a good place to initialize the exporter. */
  path: string;
  /** Why this file was chosen (`entrypoint`, `logger-config`, `bootstrap`). */
  kind: 'entrypoint' | 'logger-config' | 'bootstrap';
}

export interface LogsSetupDraft {
  /** Absolute base a source/collector should POST to (no trailing slash). */
  ingestOrigin: string;
  /** OTLP/HTTP logs endpoint (`ingestOrigin` + `/api/otel/v1/logs`). */
  otlpEndpoint: string;
  /** Agent Hub JSON batch endpoint (`ingestOrigin` + `/api/logs/ingest`). */
  batchEndpoint: string;
  stack: LogsStack;
  packageManager: LogsPackageManager;
  /** Logging libraries found in manifests (`winston`, `pino`, `zap`, …). */
  loggingLibraries: string[];
  /** True when an OpenTelemetry SDK/exporter dependency is already present. */
  hasOtelSdk: boolean;
  /** True when an OpenTelemetry Collector config file is in the repo. */
  hasOtelCollectorConfig: boolean;
  /** Collector config paths found, if any. */
  collectorConfigPaths: string[];
  /** Ranked files to wire the exporter into. */
  entryCandidates: LogsEntryCandidate[];
  /** What this scan recommends the agent do. */
  recommendedApproach: LogsApproach;
  /** Best guess at the service name facet (from package name / dir). */
  suggestedServiceName: string | null;
  /** Env-var keys the app already reads (for placing the ingest token). */
  envExampleKeys: string[];
  readme: ReadmeScanResult;
  /** Human-readable observations the agent should weigh. */
  notes: string[];
}

export interface CollectLogsSetupDraftOptions {
  /** Absolute ingest origin (Hub public URL). Defaults to a placeholder. */
  ingestOrigin?: string;
}

const MAX_SCAN_FILE_BYTES = 256 * 1024;
const DEFAULT_INGEST_ORIGIN = 'https://your-hub.example.com';

/** Node logging libs worth calling out (name → dep key). */
const NODE_LOG_LIBS = ['winston', 'pino', 'bunyan', 'roarr', 'loglevel', 'log4js'];
/** OTel dep name fragments that mean "SDK already here". */
const OTEL_DEP_FRAGMENTS = ['@opentelemetry/', 'opentelemetry', 'opentelemetry-'];
/** Python logging libs. */
const PY_LOG_LIBS = ['structlog', 'loguru', 'opentelemetry'];

const COLLECTOR_CONFIG_NAMES = [
  'otel-collector-config.yaml',
  'otel-collector-config.yml',
  'otelcol.yaml',
  'otelcol.yml',
  'collector-config.yaml',
  'collector-config.yml',
];

/** Ranked entrypoint candidates per stack (workspace-relative paths). */
const NODE_ENTRIES: LogsEntryCandidate[] = [
  { path: 'src/index.ts', kind: 'entrypoint' },
  { path: 'src/index.js', kind: 'entrypoint' },
  { path: 'src/server.ts', kind: 'entrypoint' },
  { path: 'src/server.js', kind: 'entrypoint' },
  { path: 'src/app.ts', kind: 'bootstrap' },
  { path: 'src/app.js', kind: 'bootstrap' },
  { path: 'src/logger.ts', kind: 'logger-config' },
  { path: 'src/logger.js', kind: 'logger-config' },
  { path: 'index.ts', kind: 'entrypoint' },
  { path: 'index.js', kind: 'entrypoint' },
  { path: 'server.ts', kind: 'entrypoint' },
  { path: 'server.js', kind: 'entrypoint' },
  { path: 'app.js', kind: 'bootstrap' },
];
const PY_ENTRIES: LogsEntryCandidate[] = [
  { path: 'main.py', kind: 'entrypoint' },
  { path: 'app.py', kind: 'entrypoint' },
  { path: 'wsgi.py', kind: 'bootstrap' },
  { path: 'asgi.py', kind: 'bootstrap' },
  { path: 'src/main.py', kind: 'entrypoint' },
];
const GO_ENTRIES: LogsEntryCandidate[] = [
  { path: 'main.go', kind: 'entrypoint' },
  { path: 'cmd/main.go', kind: 'entrypoint' },
];

/**
 * Resolve `relPath` under `workspaceDir` and reject anything that — after
 * following symlinks — escapes the project workspace. A repository is untrusted
 * input: it can symlink a scanned file (README, `.env.example`, a manifest) to a
 * server-local path to exfiltrate its contents through the draft endpoint or the
 * agent kickoff prompt. Both the workspace root and the target are canonicalized
 * with `realpathSync` before the containment check, so a symlinked file (or an
 * intermediate symlinked directory) that points outside the workspace returns
 * `null`. Returns the real, in-workspace absolute path, or `null` when the file
 * is missing / unresolvable / outside the workspace.
 */
function resolveWithinWorkspace(workspaceDir: string, relPath: string): string | null {
  try {
    const realRoot = realpathSync(workspaceDir);
    const realTarget = realpathSync(path.resolve(realRoot, relPath));
    const rel = path.relative(realRoot, realTarget);
    // Inside iff the relative path neither climbs out (`..`) nor is absolute
    // (different drive/root). Empty string = the root itself (not a file).
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return null;
    }
    return realTarget;
  } catch {
    // Missing file, broken symlink, or permission error — treat as absent.
    return null;
  }
}

function fileExists(workspaceDir: string, relPath: string): boolean {
  const real = resolveWithinWorkspace(workspaceDir, relPath);
  if (!real) return false;
  try {
    return statSync(real).isFile();
  } catch {
    return false;
  }
}

function safeReadFile(
  workspaceDir: string,
  relPath: string,
  maxBytes = MAX_SCAN_FILE_BYTES,
): string | null {
  const real = resolveWithinWorkspace(workspaceDir, relPath);
  if (!real) return null;
  try {
    if (statSync(real).size > maxBytes) return null;
    return readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}

interface ParsedPackageJson {
  name?: string;
  deps: Record<string, string>;
}

function readPackageJson(workspaceDir: string): ParsedPackageJson | null {
  const raw = safeReadFile(workspaceDir, 'package.json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const deps: Record<string, string> = {};
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = parsed[key];
      if (block && typeof block === 'object') {
        Object.assign(deps, block as Record<string, string>);
      }
    }
    return { name: typeof parsed.name === 'string' ? parsed.name : undefined, deps };
  } catch {
    return null;
  }
}

function detectPackageManager(workspaceDir: string, stack: LogsStack): LogsPackageManager {
  if (stack === 'node') {
    if (fileExists(workspaceDir, 'pnpm-lock.yaml')) return 'pnpm';
    if (fileExists(workspaceDir, 'yarn.lock')) return 'yarn';
    if (fileExists(workspaceDir, 'bun.lockb')) return 'bun';
    if (fileExists(workspaceDir, 'package-lock.json')) return 'npm';
    return 'npm';
  }
  if (stack === 'python') {
    if (fileExists(workspaceDir, 'poetry.lock')) return 'poetry';
    return 'pip';
  }
  if (stack === 'go') return 'go';
  if (stack === 'ruby') return 'bundler';
  if (stack === 'java') {
    if (fileExists(workspaceDir, 'pom.xml')) return 'maven';
    if (fileExists(workspaceDir, 'build.gradle') || fileExists(workspaceDir, 'build.gradle.kts')) {
      return 'gradle';
    }
  }
  return null;
}

/** Which language stacks have manifests present. */
function detectStack(workspaceDir: string): LogsStack {
  const present: LogsStack[] = [];
  if (fileExists(workspaceDir, 'package.json')) present.push('node');
  if (
    fileExists(workspaceDir, 'pyproject.toml') ||
    fileExists(workspaceDir, 'requirements.txt') ||
    fileExists(workspaceDir, 'setup.py')
  ) {
    present.push('python');
  }
  if (fileExists(workspaceDir, 'go.mod')) present.push('go');
  if (fileExists(workspaceDir, 'Gemfile')) present.push('ruby');
  if (
    fileExists(workspaceDir, 'pom.xml') ||
    fileExists(workspaceDir, 'build.gradle') ||
    fileExists(workspaceDir, 'build.gradle.kts')
  ) {
    present.push('java');
  }
  if (present.length === 0) return 'unknown';
  if (present.length > 1) return 'mixed';
  return present[0] as LogsStack;
}

function primaryStack(stack: LogsStack, workspaceDir: string): LogsStack {
  // For a mixed repo, prefer the language with a detectable entrypoint so the
  // scan still yields concrete candidates. Node first (most common here).
  if (stack !== 'mixed') return stack;
  if (fileExists(workspaceDir, 'package.json')) return 'node';
  if (fileExists(workspaceDir, 'go.mod')) return 'go';
  return 'python';
}

function detectNodeLibs(pkg: ParsedPackageJson | null): {
  loggingLibraries: string[];
  hasOtelSdk: boolean;
} {
  if (!pkg) return { loggingLibraries: [], hasOtelSdk: false };
  const names = Object.keys(pkg.deps);
  const loggingLibraries = NODE_LOG_LIBS.filter((lib) => names.includes(lib));
  const hasOtelSdk = names.some((n) => OTEL_DEP_FRAGMENTS.some((frag) => n.includes(frag)));
  return { loggingLibraries, hasOtelSdk };
}

function detectPythonLibs(workspaceDir: string): {
  loggingLibraries: string[];
  hasOtelSdk: boolean;
} {
  const manifest =
    safeReadFile(workspaceDir, 'requirements.txt') ??
    safeReadFile(workspaceDir, 'pyproject.toml') ??
    '';
  const lower = manifest.toLowerCase();
  const loggingLibraries = PY_LOG_LIBS.filter((lib) => lower.includes(lib));
  const hasOtelSdk = lower.includes('opentelemetry');
  return { loggingLibraries, hasOtelSdk };
}

function findCollectorConfigs(workspaceDir: string): string[] {
  return COLLECTOR_CONFIG_NAMES.filter((name) => fileExists(workspaceDir, name));
}

function entryCandidatesFor(stack: LogsStack, workspaceDir: string): LogsEntryCandidate[] {
  const table = stack === 'python' ? PY_ENTRIES : stack === 'go' ? GO_ENTRIES : NODE_ENTRIES;
  return table.filter((c) => fileExists(workspaceDir, c.path));
}

/**
 * Constrain a repo-derived service name to a safe token. The source (package
 * `name` or directory basename) is untrusted, so strip anything outside
 * `[A-Za-z0-9._-]` (removing whitespace, newlines, and any prompt-injection
 * text) and cap the length. Returns null when nothing safe remains.
 */
function sanitizeServiceName(raw: string): string | null {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 100);
  return cleaned.length > 0 ? cleaned : null;
}

function suggestServiceName(pkg: ParsedPackageJson | null, workspaceDir: string): string | null {
  if (pkg?.name) {
    // Strip any npm scope: `@acme/api` → `api`.
    const parts = pkg.name.split('/');
    return sanitizeServiceName(parts[parts.length - 1] || pkg.name);
  }
  const base = path.basename(workspaceDir);
  return base && base !== '.' ? sanitizeServiceName(base) : null;
}

function recommendApproach(args: {
  hasOtelCollectorConfig: boolean;
  hasOtelSdk: boolean;
  stack: LogsStack;
}): LogsApproach {
  if (args.hasOtelCollectorConfig) return 'collector';
  if (args.hasOtelSdk) return 'otel-sdk';
  // No OTel yet: the dependency-free JSON batch is the lightest touch for Node;
  // for other stacks recommend routing through a Collector.
  return args.stack === 'node' ? 'json-batch' : 'collector';
}

function envExampleKeys(workspaceDir: string): string[] {
  const names = ['.env.example', '.env.sample', 'env.example', '.env.template'];
  for (const name of names) {
    const raw = safeReadFile(workspaceDir, name);
    if (!raw) continue;
    const keys: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
      if (m && m[1]) keys.push(m[1]);
    }
    if (keys.length) return Array.from(new Set(keys));
  }
  return [];
}

/** Empty README scan — used when the real README resolves outside the workspace. */
const EMPTY_README: ReadmeScanResult = {
  readmePath: null,
  setupExcerpt: null,
  hasDockerHints: false,
  envKeysFromReadme: [],
};

/**
 * `scanReadme` also follows symlinks, and its `setupExcerpt` is embedded
 * verbatim in the draft (and thus the agent prompt). Drop the whole result when
 * the README it read canonicalizes to a path outside the workspace, so a
 * symlinked `README.md` cannot exfiltrate a server-local file's text.
 */
function safeScanReadme(workspaceDir: string): ReadmeScanResult {
  const result = scanReadme(workspaceDir);
  if (result.readmePath && !resolveWithinWorkspace(workspaceDir, result.readmePath)) {
    return EMPTY_README;
  }
  return result;
}

/**
 * Scan `workspaceDir` and return a logs-setup draft. Never throws on a missing
 * or unreadable repo — it degrades to an `unknown`-stack draft.
 */
export function collectLogsSetupDraft(
  workspaceDir: string,
  opts: CollectLogsSetupDraftOptions = {},
): LogsSetupDraft {
  const ingestOrigin = (opts.ingestOrigin || DEFAULT_INGEST_ORIGIN).replace(/\/+$/, '');
  const detected = detectStack(workspaceDir);
  const stack = primaryStack(detected, workspaceDir);
  const pkg = stack === 'node' ? readPackageJson(workspaceDir) : null;

  const { loggingLibraries, hasOtelSdk } =
    stack === 'node'
      ? detectNodeLibs(pkg)
      : stack === 'python'
        ? detectPythonLibs(workspaceDir)
        : { loggingLibraries: [], hasOtelSdk: false };

  const collectorConfigPaths = findCollectorConfigs(workspaceDir);
  const hasOtelCollectorConfig = collectorConfigPaths.length > 0;
  const entryCandidates = entryCandidatesFor(stack, workspaceDir);
  const recommendedApproach = recommendApproach({ hasOtelCollectorConfig, hasOtelSdk, stack });

  const notes: string[] = [];
  if (detected === 'mixed') {
    notes.push(
      `Multiple stacks detected; scanned as ${stack}. Confirm the right service to instrument.`,
    );
  }
  if (detected === 'unknown') {
    notes.push('No recognized manifest found — ask the user which service produces the logs.');
  }
  if (entryCandidates.length === 0 && stack !== 'unknown') {
    notes.push('No obvious entrypoint file found — ask the user where the app boots.');
  }
  if (hasOtelCollectorConfig) {
    notes.push(
      'An OpenTelemetry Collector config is present — add an otlphttp exporter for the Hub rather than instrumenting the app directly.',
    );
  } else if (hasOtelSdk) {
    notes.push(
      'An OpenTelemetry SDK is already installed — add an OTLP log exporter pointed at the Hub.',
    );
  }

  return {
    ingestOrigin,
    otlpEndpoint: `${ingestOrigin}/api/otel/v1/logs`,
    batchEndpoint: `${ingestOrigin}/api/logs/ingest`,
    stack,
    packageManager: detectPackageManager(workspaceDir, stack),
    loggingLibraries,
    hasOtelSdk,
    hasOtelCollectorConfig,
    collectorConfigPaths,
    entryCandidates,
    recommendedApproach,
    suggestedServiceName: suggestServiceName(pkg, workspaceDir),
    envExampleKeys: envExampleKeys(workspaceDir),
    readme: safeScanReadme(workspaceDir),
    notes,
  };
}
