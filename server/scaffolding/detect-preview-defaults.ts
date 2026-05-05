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

import type { PrEnvPreviewConfig } from '../types.js';

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
  stack: KnownStack;
};

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

  const topPkg = readPkgJson(path.join(workspaceDir, 'package.json'));
  let stack: KnownStack | null = topPkg ? classifyPackageJson(topPkg) : null;
  if (!stack) {
    stack = classifyMonorepo(workspaceDir);
  }
  if (!stack) return null;

  return { stack, ...STACK_DEFAULTS[stack] };
}
