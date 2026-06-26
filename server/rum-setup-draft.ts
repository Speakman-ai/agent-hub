/**
 * rum-setup-draft.ts — server-side scan for the AI RUM (real user
 * monitoring) instrumentation wizard. Mirrors the shape of
 * `finalize-setup-draft.ts` / `preview-environment-draft.ts`: a pure,
 * DB-free, spawn-free function that reads files under `workspaceDir` and
 * returns a JSON-serialisable struct the wizard route embeds in its
 * kickoff prompt (and, today, a read-only `rum/setup-draft` endpoint
 * returns verbatim).
 *
 * The draft answers the questions the eventual recorder-injection wizard
 * needs before it touches any code:
 *
 *   - which frontend framework is this? (Next, Nuxt, SvelteKit, Remix,
 *     Astro, Vue, Angular, React, vanilla, unknown)
 *   - is the rrweb recorder already wired? (dependency + init call)
 *   - which file should the recorder init be injected into?
 *   - is there an existing Content-Security-Policy that an ingest
 *     `connect-src` would have to be added to?
 *
 * This module deliberately does NOT mutate the repo, mint tokens, or
 * spawn anything. Those are follow-up slices (the worktree-backed
 * injection session + per-project client token). Keeping detection pure
 * makes it exhaustively unit-testable.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { scanReadme, type ReadmeScanResult } from './preview-readme-scan.js';

// ─── Public types ─────────────────────────────────────────────────────

export type RumFramework =
  | 'next'
  | 'nuxt'
  | 'sveltekit'
  | 'remix'
  | 'astro'
  | 'vue'
  | 'angular'
  | 'react'
  | 'vanilla'
  | 'unknown';

export type RumPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | null;

export interface RumEntryCandidate {
  /** Path relative to `workspaceDir` (posix-style). */
  path: string;
  /**
   * Why this file is an injection candidate:
   *   - `root-layout`    — framework root layout/shell (Next app/layout, Remix root)
   *   - `app-entry`      — SPA bootstrap (src/main.tsx, src/index.jsx)
   *   - `html-entry`     — the served HTML document (index.html)
   *   - `document`       — framework HTML document wrapper (Next pages/_document)
   */
  kind: 'root-layout' | 'app-entry' | 'html-entry' | 'document';
}

export interface RumCspHit {
  /** Path relative to `workspaceDir` where a CSP directive was found. */
  path: string;
  /** `meta` = HTML `<meta http-equiv>`; `header` = a CSP string in config/source. */
  source: 'meta' | 'header';
}

export interface RumInstrumentationPlan {
  /** True when a recorder dependency AND an init/ingest reference already exist. */
  alreadyInstrumented: boolean;
  /** Best file to inject the recorder init into, or null if none detected. */
  targetFile: string | null;
  /**
   * How the recorder should be added to `targetFile`:
   *   - `module-init`      — an `import` + init call in a JS/TS module that
   *                          already runs in the browser (SPA bootstrap,
   *                          pages-router `_app`, Remix root, etc.)
   *   - `client-component` — `targetFile` is a Server Component by default
   *                          (Next.js app-router `app/layout.*`); the
   *                          recorder must live in a `'use client'` child
   *                          component started in `useEffect`, NOT inlined
   *                          into the server layout.
   *   - `script-tag`       — a `<script>` snippet in an HTML document
   */
  injectionStyle: 'module-init' | 'client-component' | 'script-tag' | null;
  /**
   * Origin the recorder POSTs replays to; must be allowed by the page CSP
   * `connect-src`. Defaults to the `${AGENT_HUB_URL}` placeholder — the
   * wizard substitutes the resolved Hub origin when it writes the snippet.
   */
  recommendedConnectSrc: string;
  /** Human-readable guidance for the wizard / agent. */
  notes: string[];
}

export interface RumSetupDraft {
  /**
   * Directory (relative to `project.cwd`) where the browser app was found.
   * `.` when the UI lives at the repo root; `frontend`, `client`, `apps/web`, …
   * for monorepos. All `entryCandidates` / `cspHits` / `plan.targetFile` paths
   * are relative to the project root (prefixed with `webRoot` when not `.`).
   */
  webRoot: string;
  framework: RumFramework;
  /** Dependency names / files that drove the framework decision. */
  frameworkEvidence: string[];
  packageManager: RumPackageManager;
  typescript: boolean;
  /** Injection candidates in priority order (best first). */
  entryCandidates: RumEntryCandidate[];
  /** Existing CSP locations the wizard must extend with the ingest origin. */
  cspHits: RumCspHit[];
  recorder: {
    /** `rrweb` / `@agent-hub/rum` present in package.json deps. */
    dependencyPresent: boolean;
    /** An init call / ingest endpoint reference found in source. */
    initDetected: boolean;
  };
  plan: RumInstrumentationPlan;
  readme: ReadmeScanResult;
}

export interface CollectRumSetupDraftOptions {
  /**
   * Origin the recorder will POST replays to. Substituted into
   * `plan.recommendedConnectSrc`. Defaults to a `${AGENT_HUB_URL}`
   * placeholder so the scanner stays pure.
   */
  ingestOrigin?: string;
}

// ─── Internals ────────────────────────────────────────────────────────

const MAX_SCAN_FILE_BYTES = 256 * 1024;
const DEFAULT_INGEST_ORIGIN = '${AGENT_HUB_URL}';

/** Shallow monorepo subdirs probed when the repo root has no browser surface. */
const MONOREPO_SUBDIR_CANDIDATES = ['frontend', 'client', 'web'] as const;

/** Recorder packages that signal the page is (or will be) instrumented. */
const RECORDER_DEP_NAMES = ['rrweb', 'rrweb-snapshot', '@rrweb/record', '@agent-hub/rum'];

/**
 * Patterns specific enough to count as a wired recorder on their own. Bare
 * package/import identifiers (`rrweb`, `@agent-hub/rum`) are deliberately
 * excluded: an unused import, a type reference, or a comment must NOT count
 * as "instrumented", otherwise the wizard would skip a project that still
 * needs setup.
 */
const RECORDER_INIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\binitSessionReplay\s*\(/, // Hub helper init call
  /\brrwebRecord\s*\(/, // aliased rrweb `record` import call
  /\brrweb\s*\.\s*record\s*\(/, // namespace import: rrweb.record(...)
  /['"`]\/api\/replays\b/, // replay ingest endpoint wiring
];

/**
 * An rrweb-family import/require in the file. A bare `record({ ... })` call
 * is only a recorder signal when paired with one of these — otherwise
 * `record(` is too generic (e.g. an analytics `record({ type: 'page-view' })`
 * call from unrelated code).
 */
const RECORDER_IMPORT_RE =
  /(?:from|require\()\s*['"](?:rrweb(?:-snapshot)?|@rrweb\/[\w.-]+|@agent-hub\/rum)['"]/;

/** rrweb's destructured `record({ emit, ... })` call shape. */
const RECORD_CALL_RE = /\brecord\s*\(\s*\{/;

/** Candidate files, by priority, that a recorder init can live in. */
const ENTRY_CANDIDATES: ReadonlyArray<{ path: string; kind: RumEntryCandidate['kind'] }> = [
  // Next.js (app router first, then pages router)
  { path: 'app/layout.tsx', kind: 'root-layout' },
  { path: 'app/layout.jsx', kind: 'root-layout' },
  { path: 'app/layout.ts', kind: 'root-layout' },
  { path: 'app/layout.js', kind: 'root-layout' },
  { path: 'src/app/layout.tsx', kind: 'root-layout' },
  { path: 'src/app/layout.jsx', kind: 'root-layout' },
  { path: 'pages/_app.tsx', kind: 'app-entry' },
  { path: 'pages/_app.jsx', kind: 'app-entry' },
  { path: 'pages/_app.js', kind: 'app-entry' },
  { path: 'src/pages/_app.tsx', kind: 'app-entry' },
  { path: 'pages/_document.tsx', kind: 'document' },
  { path: 'pages/_document.jsx', kind: 'document' },
  // Remix
  { path: 'app/root.tsx', kind: 'root-layout' },
  { path: 'app/root.jsx', kind: 'root-layout' },
  // Nuxt
  { path: 'app.vue', kind: 'root-layout' },
  { path: 'src/app.vue', kind: 'root-layout' },
  // SvelteKit
  { path: 'src/routes/+layout.svelte', kind: 'root-layout' },
  // Astro
  { path: 'src/layouts/Layout.astro', kind: 'root-layout' },
  // Generic SPA bootstrap (Vite / CRA / Angular / Vue)
  { path: 'src/main.tsx', kind: 'app-entry' },
  { path: 'src/main.jsx', kind: 'app-entry' },
  { path: 'src/main.ts', kind: 'app-entry' },
  { path: 'src/main.js', kind: 'app-entry' },
  { path: 'src/index.tsx', kind: 'app-entry' },
  { path: 'src/index.jsx', kind: 'app-entry' },
  { path: 'src/index.ts', kind: 'app-entry' },
  { path: 'src/index.js', kind: 'app-entry' },
  // Served HTML documents (vanilla / Vite template / CRA public)
  { path: 'index.html', kind: 'html-entry' },
  { path: 'public/index.html', kind: 'html-entry' },
  { path: 'src/index.html', kind: 'html-entry' },
];

/** Files commonly carrying a CSP directive (HTML meta or response header). */
const CSP_CANDIDATE_FILES: ReadonlyArray<string> = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'app/layout.tsx',
  'src/app/layout.tsx',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'middleware.ts',
  'src/middleware.ts',
  'vite.config.ts',
  'vite.config.js',
  'vercel.json',
  'netlify.toml',
  'public/_headers',
  '_headers',
  'nginx.conf',
  'server.js',
  'server.ts',
];

function safeReadFile(absPath: string, maxBytes = MAX_SCAN_FILE_BYTES): string | null {
  try {
    const text = readFileSync(absPath, 'utf8');
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  }
}

function fileExists(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

interface ParsedPackageJson {
  deps: Record<string, string>;
}

function readPackageJson(workspaceDir: string): ParsedPackageJson | null {
  const txt = safeReadFile(path.join(workspaceDir, 'package.json'));
  if (txt === null) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(txt);
  } catch {
    return { deps: {} };
  }
  if (!pkg || typeof pkg !== 'object') return { deps: {} };
  const deps: Record<string, string> = {};
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const block = (pkg as Record<string, unknown>)[field];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
        if (typeof v === 'string' && !(k in deps)) deps[k] = v;
      }
    }
  }
  return { deps };
}

/** Package-manager evidence from a lockfile in `dir` ONLY (no package.json fallback). */
function detectLockfilePackageManager(dir: string): RumPackageManager {
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return null;
}

/**
 * Resolve the package manager for a (possibly nested) web root.
 *
 * A monorepo web root (`frontend/`, `apps/web/`, …) usually has its own
 * `package.json` but NO lockfile — the lockfile (`pnpm-lock.yaml` / `yarn.lock`
 * / …) lives at the workspace ROOT. Detecting only from the subdir would then
 * fall through to `npm`, making the RUM flow install with the wrong manager or
 * write a stray lockfile. So: prefer a lockfile in the web root, else fall back
 * to the workspace root's lockfile evidence, and only assume `npm` when a
 * `package.json` exists but no lockfile is found anywhere up the chain.
 */
function detectPackageManager(scanDir: string, workspaceDir: string = scanDir): RumPackageManager {
  const local = detectLockfilePackageManager(scanDir);
  if (local) return local;
  if (path.resolve(scanDir) !== path.resolve(workspaceDir)) {
    const root = detectLockfilePackageManager(workspaceDir);
    if (root) return root;
  }
  if (existsSync(path.join(scanDir, 'package.json'))) return 'npm';
  return null;
}

/**
 * Resolve the frontend framework. Meta-frameworks (Next, Nuxt, SvelteKit,
 * Remix, Astro) are checked before the base UI libraries they wrap so a
 * Next app is never mislabelled as plain React.
 */
function detectFramework(
  workspaceDir: string,
  pkg: ParsedPackageJson | null,
): { framework: RumFramework; evidence: string[] } {
  const evidence: string[] = [];
  if (!pkg) {
    // No package.json — vanilla site if an HTML document exists, else unknown.
    if (
      fileExists(path.join(workspaceDir, 'index.html')) ||
      fileExists(path.join(workspaceDir, 'public', 'index.html'))
    ) {
      evidence.push('index.html (no package.json)');
      return { framework: 'vanilla', evidence };
    }
    return { framework: 'unknown', evidence };
  }
  const has = (name: string): boolean => name in pkg.deps;
  const note = (name: string): boolean => {
    if (has(name)) {
      evidence.push(`dependency: ${name}`);
      return true;
    }
    return false;
  };

  if (note('next')) return { framework: 'next', evidence };
  if (note('nuxt') || note('nuxt3')) return { framework: 'nuxt', evidence };
  if (note('@sveltejs/kit')) return { framework: 'sveltekit', evidence };
  if (note('@remix-run/react') || note('@remix-run/node') || note('@remix-run/dev')) {
    return { framework: 'remix', evidence };
  }
  if (note('astro')) return { framework: 'astro', evidence };
  if (note('@angular/core')) return { framework: 'angular', evidence };
  if (note('vue')) return { framework: 'vue', evidence };
  if (note('react')) return { framework: 'react', evidence };

  // Has a package.json but none of the known UI libs. If it ships an HTML
  // document it is effectively a vanilla site; otherwise unknown.
  if (
    fileExists(path.join(workspaceDir, 'index.html')) ||
    fileExists(path.join(workspaceDir, 'public', 'index.html'))
  ) {
    evidence.push('index.html (no known UI framework dependency)');
    return { framework: 'vanilla', evidence };
  }
  return { framework: 'unknown', evidence };
}

function findEntryCandidates(workspaceDir: string): RumEntryCandidate[] {
  const out: RumEntryCandidate[] = [];
  for (const cand of ENTRY_CANDIDATES) {
    if (fileExists(path.join(workspaceDir, cand.path))) {
      out.push({ path: cand.path, kind: cand.kind });
    }
  }
  return out;
}

function findCspHits(workspaceDir: string): RumCspHit[] {
  const out: RumCspHit[] = [];
  const seen = new Set<string>();
  for (const rel of CSP_CANDIDATE_FILES) {
    if (seen.has(rel)) continue;
    const content = safeReadFile(path.join(workspaceDir, rel));
    if (content === null) continue;
    if (!/content-security-policy/i.test(content)) continue;
    seen.add(rel);
    const isMeta = /<meta[^>]+http-equiv\s*=\s*["']content-security-policy["']/i.test(content);
    out.push({ path: rel, source: isMeta ? 'meta' : 'header' });
  }
  return out;
}

/**
 * Strip JS/TS line and block comments so commented-out code is not
 * mistaken for a live recorder init. The line-comment match is guarded by
 * `[^:]` so it does not eat `://` in URLs. Over-stripping only risks a
 * false negative (the wizard would offer setup), which is the safe
 * direction; a false positive (skipping setup) is the failure we must
 * avoid.
 */
function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function detectRecorderInit(workspaceDir: string, entryCandidates: RumEntryCandidate[]): boolean {
  // Scan the injection candidates plus a couple of likely bootstrap files.
  const probeFiles = new Set<string>(entryCandidates.map((c) => c.path));
  for (const extra of ['src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts']) {
    probeFiles.add(extra);
  }
  for (const rel of probeFiles) {
    const raw = safeReadFile(path.join(workspaceDir, rel));
    if (raw === null) continue;
    const content = stripJsComments(raw);
    if (RECORDER_INIT_PATTERNS.some((re) => re.test(content))) return true;
    // Bare `record({...})` only counts when the file imports rrweb — guards
    // against unrelated `record({ ... })` calls in analytics/telemetry code.
    if (RECORD_CALL_RE.test(content) && RECORDER_IMPORT_RE.test(content)) return true;
  }
  return false;
}

/** Next.js app-router root layout (`app/layout.*` / `src/app/layout.*`). */
function isNextAppRouterLayout(relPath: string): boolean {
  return /^(?:src\/)?app\/layout\.(?:tsx|jsx|ts|js)$/.test(relPath);
}

function joinWebRoot(webRoot: string, relPath: string): string {
  if (webRoot === '.') return relPath;
  return `${webRoot}/${relPath}`;
}

function absoluteScanDir(workspaceDir: string, webRoot: string): string {
  return webRoot === '.' ? workspaceDir : path.join(workspaceDir, webRoot);
}

function prefixRelativePaths<T extends { path: string }>(webRoot: string, items: T[]): T[] {
  if (webRoot === '.') return items;
  return items.map((item) => ({ ...item, path: joinWebRoot(webRoot, item.path) }));
}

/** Candidate scan roots, shallowest first — mirrors preview-setup scanners. */
export function collectMonorepoScanRoots(workspaceDir: string): string[] {
  const roots: string[] = ['.'];
  const seen = new Set<string>(['.']);

  for (const name of MONOREPO_SUBDIR_CANDIDATES) {
    if (seen.has(name)) continue;
    if (fileExists(path.join(workspaceDir, name, 'package.json'))) {
      roots.push(name);
      seen.add(name);
    }
  }

  const appsDir = path.join(workspaceDir, 'apps');
  try {
    if (statSync(appsDir).isDirectory()) {
      for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rel = `apps/${entry.name}`;
        if (seen.has(rel)) continue;
        if (fileExists(path.join(workspaceDir, rel, 'package.json'))) {
          roots.push(rel);
          seen.add(rel);
        }
      }
    }
  } catch {
    // apps/ absent — skip
  }

  return roots;
}

interface RumSubdirScanResult {
  webRoot: string;
  framework: RumFramework;
  frameworkEvidence: string[];
  packageManager: RumPackageManager;
  typescript: boolean;
  entryCandidates: RumEntryCandidate[];
  cspHits: RumCspHit[];
  recorder: { dependencyPresent: boolean; initDetected: boolean };
}

const FRAMEWORK_SCAN_SCORE: Record<RumFramework, number> = {
  next: 90,
  nuxt: 90,
  sveltekit: 90,
  remix: 90,
  astro: 90,
  angular: 80,
  vue: 80,
  react: 80,
  vanilla: 40,
  unknown: 0,
};

function scoreRumSubdirScan(scan: RumSubdirScanResult): number {
  let score = FRAMEWORK_SCAN_SCORE[scan.framework] ?? 0;
  if (scan.entryCandidates.length > 0) score += 30 + scan.entryCandidates.length;
  if (scan.recorder.initDetected) score += 5;
  return score;
}

function webRootDepth(webRoot: string): number {
  return webRoot === '.' ? 0 : webRoot.split('/').length;
}

function pickBestRumSubdirScan(scans: RumSubdirScanResult[]): RumSubdirScanResult {
  return [...scans].sort((a, b) => {
    const scoreDiff = scoreRumSubdirScan(b) - scoreRumSubdirScan(a);
    if (scoreDiff !== 0) return scoreDiff;
    return webRootDepth(a.webRoot) - webRootDepth(b.webRoot);
  })[0]!;
}

function scanRumSubdir(workspaceDir: string, webRoot: string): RumSubdirScanResult {
  const scanDir = absoluteScanDir(workspaceDir, webRoot);
  const pkg = readPackageJson(scanDir);
  const { framework, evidence } = detectFramework(scanDir, pkg);
  // Paths are kept WEB-ROOT-RELATIVE (local) here so framework-specific planner
  // matchers (e.g. isNextAppRouterLayout, which expects `app/layout.tsx`) see the
  // real relative path even in a monorepo subdir. The webRoot prefix is applied
  // only to the final returned draft (collectRumSetupDraft / buildPlan output).
  const localEntries = findEntryCandidates(scanDir);
  return {
    webRoot,
    framework,
    frameworkEvidence: evidence,
    packageManager: detectPackageManager(scanDir, workspaceDir),
    typescript: existsSync(path.join(scanDir, 'tsconfig.json')),
    entryCandidates: localEntries,
    cspHits: findCspHits(scanDir),
    recorder: {
      dependencyPresent: pkg ? RECORDER_DEP_NAMES.some((name) => name in pkg.deps) : false,
      initDetected: detectRecorderInit(scanDir, localEntries),
    },
  };
}

function buildPlan(args: {
  webRoot: string;
  framework: RumFramework;
  entryCandidates: RumEntryCandidate[];
  cspHits: RumCspHit[];
  dependencyPresent: boolean;
  initDetected: boolean;
  ingestOrigin: string;
}): RumInstrumentationPlan {
  const { webRoot, entryCandidates, cspHits, dependencyPresent, initDetected, ingestOrigin } = args;
  // Only treat the app as instrumented when BOTH a recorder dependency and an
  // init/ingest reference are present. A dependency without a wired init is
  // exactly the case that still needs setup, so it must NOT be flagged done.
  const alreadyInstrumented = dependencyPresent && initDetected;
  // `entryCandidates`/`cspHits` are WEB-ROOT-RELATIVE here. The framework
  // matchers run against that local path so a monorepo layout (e.g.
  // `frontend/app/layout.tsx`) is recognized exactly like a root one. Only the
  // OUTPUT paths (targetFile + the paths embedded in notes) are prefixed.
  const target = entryCandidates[0] ?? null;
  const targetFile = target ? joinWebRoot(webRoot, target.path) : null;
  let injectionStyle: RumInstrumentationPlan['injectionStyle'] = null;
  if (target) {
    if (target.kind === 'html-entry' || target.kind === 'document') {
      injectionStyle = 'script-tag';
    } else if (isNextAppRouterLayout(target.path)) {
      // Next.js app-router layouts are Server Components by default — the
      // recorder cannot be started directly here; it needs a client child.
      injectionStyle = 'client-component';
    } else {
      injectionStyle = 'module-init';
    }
  }

  const notes: string[] = [];
  if (webRoot !== '.') {
    notes.push(
      `Browser app detected under ${webRoot}/ — file paths below are relative to the project root.`,
    );
  }
  if (args.framework === 'unknown') {
    notes.push(
      'No frontend framework or HTML document detected — confirm this project has a browser-rendered surface before instrumenting.',
    );
  }
  if (!targetFile) {
    notes.push('No injection target found; the wizard must ask the user which file boots the app.');
  } else if (injectionStyle === 'module-init') {
    notes.push(
      `Inject an init call into ${targetFile} (import the recorder and start it on mount).`,
    );
  } else if (injectionStyle === 'client-component') {
    notes.push(
      `${targetFile} is a Next.js Server Component by default — do NOT init the recorder inline. ` +
        `Add a "use client" child component (e.g. components/SessionReplay.tsx) that starts the ` +
        `recorder in a useEffect, then render it inside ${targetFile}.`,
    );
  } else {
    notes.push(`Inject a <script> recorder snippet into ${targetFile} before </head>.`);
  }
  if (initDetected) {
    notes.push('A recorder init / ingest reference already exists — avoid double-instrumenting.');
  } else if (dependencyPresent) {
    notes.push('A recorder dependency is installed but no init call was found — wire the init.');
  }
  if (cspHits.length > 0) {
    notes.push(
      `Existing CSP found in ${cspHits.map((h) => joinWebRoot(webRoot, h.path)).join(', ')} — add connect-src ${ingestOrigin} so replay uploads are not blocked.`,
    );
  } else {
    notes.push(
      'No CSP detected; uploads will work, but consider adding one with the ingest origin allow-listed.',
    );
  }

  return {
    alreadyInstrumented,
    targetFile,
    injectionStyle,
    recommendedConnectSrc: ingestOrigin,
    notes,
  };
}

// ─── Public entry point ───────────────────────────────────────────────

export function collectRumSetupDraft(
  workspaceDir: string,
  opts: CollectRumSetupDraftOptions = {},
): RumSetupDraft {
  const ingestOrigin = opts.ingestOrigin?.trim() || DEFAULT_INGEST_ORIGIN;
  const scanRoots = collectMonorepoScanRoots(workspaceDir);
  const best = pickBestRumSubdirScan(
    scanRoots.map((webRoot) => scanRumSubdir(workspaceDir, webRoot)),
  );

  const plan = buildPlan({
    webRoot: best.webRoot,
    framework: best.framework,
    entryCandidates: best.entryCandidates,
    cspHits: best.cspHits,
    dependencyPresent: best.recorder.dependencyPresent,
    initDetected: best.recorder.initDetected,
    ingestOrigin,
  });

  const readme = scanReadme(workspaceDir);

  return {
    webRoot: best.webRoot,
    framework: best.framework,
    frameworkEvidence: best.frameworkEvidence,
    packageManager: best.packageManager,
    typescript: best.typescript,
    // The scan kept paths web-root-relative for planning; prefix them with the
    // webRoot now so the returned draft paths are project-root-relative (the
    // plan's targetFile + note paths were already prefixed by buildPlan).
    entryCandidates: prefixRelativePaths(best.webRoot, best.entryCandidates),
    cspHits: prefixRelativePaths(best.webRoot, best.cspHits),
    recorder: best.recorder,
    plan,
    readme,
  };
}
