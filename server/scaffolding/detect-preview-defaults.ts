/**
 * detect-preview-defaults
 *
 * Pure helper that inspects a workspace directory on disk and, when the
 * project's stack is one we recognise (Vite, Next.js, Create React App,
 * Astro, Nuxt, Expo web), returns sensible `prEnv.preview` defaults so
 * the new-project / clone-from-GitHub flows can pre-populate the wizard
 * with zero manual configuration.
 *
 * Detection contract:
 *   - Reads `<workspaceDir>/package.json` first; if it has a recognisable
 *     dependency the answer comes from that single file.
 *   - For monorepos (no top-level recognisable framework) it scans the
 *     first match under `<workspaceDir>/apps/<name>/package.json` and
 *     adopts that stack's defaults — most monorepo conventions place the
 *     web app there (apps/web, apps/site, apps/admin, …).
 *   - Returns `null` for unknown stacks; the caller is responsible for
 *     surfacing the empty wizard so the user can configure it manually.
 *
 * The returned object is `Partial<PrEnvPreviewConfig>` minus `enabled`
 * (callers usually flip that to `true` themselves) — i.e. it carries
 * `startScript`, `port`, `captureRoutes`, and `idleTTL`. Caller decides
 * whether to enable.
 *
 * This file is dependency-free beyond the Node `fs`/`path` builtins so
 * it can be unit-tested without spinning up the rest of the server.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

import type { PrEnvPreviewConfig, PreviewProcess } from '../types.js';

/**
 * Subset of {@link PrEnvPreviewConfig} that detection returns. We
 * deliberately omit the `enabled` master switch so callers (provisioning
 * orchestrator, clone wizard) decide whether the user opts in.
 */
export type DetectedPreviewDefaults = Required<
  Pick<PrEnvPreviewConfig, 'startScript' | 'port' | 'captureRoutes' | 'idleTTL'>
> & {
  /**
   * Tag for the recognised stack — useful for log lines and the wizard
   * "We detected a Vite project — preview is enabled by default" copy.
   * Not part of the persisted `PrEnvPreviewConfig`, lives only on the
   * detection result.
   */
  stack: KnownStack | MultiProcessStack;
  /**
   * Optional multi-process preview graph — populated for fullstack
   * layouts where the wizard should default to spawning a backend AND
   * a frontend process. `startScript`/`port` still carry the legacy
   * single-process fallback (which the runtime ignores when `processes`
   * is non-empty), so callers that haven't been multi-process-aware yet
   * keep working.
   */
  processes?: PreviewProcess[];
};

/**
 * Stack tags for layouts whose canonical preview is a multi-process
 * graph rather than a single dev-server. Kept separate from
 * {@link KnownStack} so the existing single-process call-sites' switch
 * statements continue to be exhaustive without changes.
 */
export type MultiProcessStack =
  | 'fullstack-django-react'
  | 'fullstack-monorepo'
  | 'fullstack-scripts';

export type KnownStack = 'vite' | 'next' | 'cra' | 'astro' | 'nuxt' | 'expo';

/**
 * Default values per stack. Ports match each tool's conventional dev
 * server port; `startScript` is the npm script we expect to find (and
 * fall back to invoking via `npm run`). `captureRoutes` is `["/"]` for
 * every stack — the home page is the only universally-safe route.
 */
const STACK_DEFAULTS: Record<KnownStack, Omit<DetectedPreviewDefaults, 'stack'>> = {
  vite: { startScript: 'npm run dev', port: 5173, captureRoutes: ['/'], idleTTL: 600 },
  next: { startScript: 'npm run dev', port: 3000, captureRoutes: ['/'], idleTTL: 600 },
  cra: { startScript: 'npm start', port: 3000, captureRoutes: ['/'], idleTTL: 600 },
  astro: { startScript: 'npm run dev', port: 4321, captureRoutes: ['/'], idleTTL: 600 },
  nuxt: { startScript: 'npm run dev', port: 3000, captureRoutes: ['/'], idleTTL: 600 },
  expo: { startScript: 'npm run web', port: 19006, captureRoutes: ['/'], idleTTL: 600 },
};

interface PackageJsonShape {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
}

function readPkgJson(absPath: string): PackageJsonShape | null {
  try {
    if (!existsSync(absPath)) return null;
    const raw = readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PackageJsonShape;
    }
    return null;
  } catch {
    // Malformed package.json, missing file, permission error — treat as
    // "no signal". Caller will fall through to the unknown-stack path.
    return null;
  }
}

function hasDep(pkg: PackageJsonShape, name: string): boolean {
  return (
    !!pkg.dependencies?.[name] ||
    !!pkg.devDependencies?.[name] ||
    !!pkg.peerDependencies?.[name] ||
    !!pkg.optionalDependencies?.[name]
  );
}

/**
 * Classify a single package.json into a known stack tag, or `null` if
 * none of the recognised dependencies are present. Order matters: more
 * specific frameworks (Next.js, Nuxt) take precedence over the generic
 * substrate they're built on (Vite, Expo, etc.) so e.g. a Next app
 * doesn't get classified as Vite just because Next happens to vendor
 * Vite under the hood.
 */
export function classifyPackageJson(pkg: PackageJsonShape): KnownStack | null {
  if (hasDep(pkg, 'next')) return 'next';
  if (hasDep(pkg, 'nuxt') || hasDep(pkg, 'nuxt3')) return 'nuxt';
  if (hasDep(pkg, 'astro')) return 'astro';
  if (hasDep(pkg, 'expo')) return 'expo';
  if (hasDep(pkg, 'vite')) return 'vite';
  // Create React App ships `react-scripts`. Some projects ship CRA
  // alongside their own bundler (rare); this is intentionally last.
  if (hasDep(pkg, 'react-scripts')) return 'cra';
  return null;
}

/**
 * If the workspace's top-level `package.json` doesn't have a stack
 * marker, walk one level into common monorepo layouts (apps/*) and
 * return the first match.
 */
function classifyMonorepo(workspaceDir: string): KnownStack | null {
  const appsDir = path.join(workspaceDir, 'apps');
  let entries: string[];
  try {
    if (!existsSync(appsDir)) return null;
    if (!statSync(appsDir).isDirectory()) return null;
    entries = readdirSync(appsDir).sort();
  } catch {
    return null;
  }

  for (const entry of entries) {
    const child = path.join(appsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(child).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const pkg = readPkgJson(path.join(child, 'package.json'));
    if (!pkg) continue;
    const tag = classifyPackageJson(pkg);
    if (tag) return tag;
  }
  return null;
}

/**
 * Inspect a workspace directory and return preview defaults for the
 * stack we detected, or `null` if the stack is unknown.
 *
 * Pure with respect to the filesystem (no caching, no mutation) so the
 * caller can re-invoke after a clone re-runs / a setup step rewrites
 * package.json without worrying about staleness.
 *
 * @param workspaceDir Absolute path to the project root on disk. Must
 *   exist; pass the directory containing the project's top-level
 *   `package.json`. For provisioning this is the workspace dir the
 *   template executor copied into; for clone-from-GitHub it's the
 *   `clonePath` returned to the wizard.
 */
export function detectPreviewDefaults(workspaceDir: string): DetectedPreviewDefaults | null {
  if (!workspaceDir || typeof workspaceDir !== 'string') return null;
  // Caller mistake — be lenient and bail rather than throw.
  if (!existsSync(workspaceDir)) return null;

  // Multi-process layouts win when present: the user explicitly
  // structured the repo with two siblings (backend/+frontend/, apps/api+
  // apps/web, or matching package.json scripts), so the wizard should
  // default to spawning both — not just whichever leaf happens to win the
  // single-process classifier. Each helper returns null when its pattern
  // doesn't match so we cascade through them in priority order.
  const multi =
    detectFullstackDjangoReact(workspaceDir) ??
    detectFullstackAppsMonorepo(workspaceDir) ??
    detectFullstackPackageScripts(workspaceDir);
  if (multi) return multi;

  const topPkg = readPkgJson(path.join(workspaceDir, 'package.json'));
  let stack: KnownStack | null = topPkg ? classifyPackageJson(topPkg) : null;
  if (!stack) {
    stack = classifyMonorepo(workspaceDir);
  }
  if (!stack) return null;

  return { stack, ...STACK_DEFAULTS[stack] };
}

// ─── Multi-process detectors ──────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Django (or any Python web stack) + React-style frontend.
 *
 * Recognition signal:
 *   - `backend/` exists AND has any of: `manage.py`, `requirements.txt`,
 *     `requirements-local.txt`, `pyproject.toml`.
 *   - `frontend/` exists AND has a `package.json` with a recognisable
 *     JS-stack dep (so we know what startScript to pick).
 *
 * Names follow the canonical Surveys-style layout the card called out.
 * If either half is missing, we bail and let the single-process path
 * handle it (`frontend/` alone is just a normal Vite app).
 */
function detectFullstackDjangoReact(workspaceDir: string): DetectedPreviewDefaults | null {
  const backendDir = path.join(workspaceDir, 'backend');
  const frontendDir = path.join(workspaceDir, 'frontend');
  if (!isDir(backendDir) || !isDir(frontendDir)) return null;

  const hasPythonMarker =
    existsSync(path.join(backendDir, 'manage.py')) ||
    existsSync(path.join(backendDir, 'requirements.txt')) ||
    existsSync(path.join(backendDir, 'requirements-local.txt')) ||
    existsSync(path.join(backendDir, 'pyproject.toml'));
  if (!hasPythonMarker) return null;

  const frontendPkg = readPkgJson(path.join(frontendDir, 'package.json'));
  if (!frontendPkg) return null;
  const frontendStack = classifyPackageJson(frontendPkg);
  if (!frontendStack) return null;
  const frontendDefaults = STACK_DEFAULTS[frontendStack];

  // Prefer requirements-local.txt when present (matches the SurveyTracker
  // convention); fall back to requirements.txt; otherwise skip pip install.
  const reqLocal = existsSync(path.join(backendDir, 'requirements-local.txt'));
  const reqDefault = existsSync(path.join(backendDir, 'requirements.txt'));
  const pipPrefix = reqLocal
    ? 'python3 -m pip install -r requirements-local.txt && '
    : reqDefault
      ? 'python3 -m pip install -r requirements.txt && '
      : '';
  const hasManage = existsSync(path.join(backendDir, 'manage.py'));
  const backendStart = hasManage
    ? `${pipPrefix}python manage.py runserver 0.0.0.0:$PORT`
    : `${pipPrefix}python -m http.server $PORT`;

  const processes: PreviewProcess[] = [
    {
      name: 'backend',
      startScript: backendStart,
      cwd: 'backend',
      healthPath: '/',
    },
    {
      name: 'frontend',
      startScript: frontendDefaults.startScript,
      cwd: 'frontend',
      healthPath: '/',
      dependsOn: ['backend'],
    },
  ];

  return {
    stack: 'fullstack-django-react',
    startScript: frontendDefaults.startScript,
    port: frontendDefaults.port,
    captureRoutes: ['/'],
    idleTTL: 600,
    processes,
  };
}

/**
 * Monorepo with `apps/api` + `apps/web` siblings (Turborepo / Nx
 * convention). Each sibling needs a recognisable package.json so we know
 * how to start it.
 */
function detectFullstackAppsMonorepo(workspaceDir: string): DetectedPreviewDefaults | null {
  const apiDir = path.join(workspaceDir, 'apps', 'api');
  const webDir = path.join(workspaceDir, 'apps', 'web');
  if (!isDir(apiDir) || !isDir(webDir)) return null;
  const apiPkg = readPkgJson(path.join(apiDir, 'package.json'));
  const webPkg = readPkgJson(path.join(webDir, 'package.json'));
  if (!apiPkg || !webPkg) return null;

  const webStack = classifyPackageJson(webPkg);
  if (!webStack) return null;
  const webDefaults = STACK_DEFAULTS[webStack];

  // The api side may not match a known framework — that's fine, we still
  // know how to start it as long as it has a `dev` or `start` script.
  const apiScripts = (apiPkg.scripts ?? {}) as Record<string, unknown>;
  const apiStart =
    typeof apiScripts.dev === 'string'
      ? 'npm run dev'
      : typeof apiScripts.start === 'string'
        ? 'npm start'
        : null;
  if (!apiStart) return null;

  const processes: PreviewProcess[] = [
    {
      name: 'api',
      startScript: apiStart,
      cwd: 'apps/api',
      healthPath: '/',
    },
    {
      name: 'web',
      startScript: webDefaults.startScript,
      cwd: 'apps/web',
      healthPath: '/',
      dependsOn: ['api'],
    },
  ];

  return {
    stack: 'fullstack-monorepo',
    startScript: webDefaults.startScript,
    port: webDefaults.port,
    captureRoutes: ['/'],
    idleTTL: 600,
    processes,
  };
}

/**
 * Single package.json with explicit `start:api` + `start:web` (or
 * `dev:api` + `dev:web`) scripts. Common in small fullstack repos that
 * use `concurrently` under the hood but want each side spawned with its
 * own port/health-check via the preview runtime instead.
 */
function detectFullstackPackageScripts(workspaceDir: string): DetectedPreviewDefaults | null {
  const topPkg = readPkgJson(path.join(workspaceDir, 'package.json'));
  if (!topPkg) return null;
  const scripts = (topPkg.scripts ?? {}) as Record<string, unknown>;
  const apiKey =
    typeof scripts['start:api'] === 'string'
      ? 'start:api'
      : typeof scripts['dev:api'] === 'string'
        ? 'dev:api'
        : null;
  const webKey =
    typeof scripts['start:web'] === 'string'
      ? 'start:web'
      : typeof scripts['dev:web'] === 'string'
        ? 'dev:web'
        : null;
  if (!apiKey || !webKey) return null;

  // Best-effort frontend stack detection so we can pick a sensible
  // captureRoutes default and legacy `port` fallback.
  const frontendStack = classifyPackageJson(topPkg);
  const webDefaults = frontendStack ? STACK_DEFAULTS[frontendStack] : STACK_DEFAULTS.vite;

  const processes: PreviewProcess[] = [
    {
      name: 'api',
      startScript: `npm run ${apiKey}`,
      healthPath: '/',
    },
    {
      name: 'web',
      startScript: `npm run ${webKey}`,
      healthPath: '/',
      dependsOn: ['api'],
    },
  ];

  return {
    stack: 'fullstack-scripts',
    startScript: webDefaults.startScript,
    port: webDefaults.port,
    captureRoutes: ['/'],
    idleTTL: 600,
    processes,
  };
}
