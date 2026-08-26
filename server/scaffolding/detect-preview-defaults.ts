/**
 * detect-preview-defaults
 *
 * Pure helper that inspects a workspace directory on disk and, when the
 * project's stack is one we recognise (Vite, Next.js, Create React App,
 * Astro, Nuxt, Expo web, Docker Compose, FastAPI, Go, Rust), returns sensible `prEnv.devServer` defaults so
 * the new-project / clone-from-GitHub flows can pre-populate the wizard
 * with zero manual configuration.
 *
 * Detection contract:
 *   - Reads `<workspaceDir>/package.json` first; if it has a recognisable
 *     JS framework the answer comes from that single file.
 *   - For monorepos (no top-level recognisable framework) it scans the
 *     first match under `<workspaceDir>/apps/<name>/package.json`.
 *   - Otherwise looks for Docker Compose, a Dockerfile, then Python /
 *     Go / Rust manifests so a first-build session that didn't pick Node
 *     still gets preview defaults. Only the Compose branch emits a
 *     `docker compose` command — every other branch emits a command that
 *     runs against its own files (a Dockerfile build+run, `go run .`,
 *     `cargo run`, the framework's dev server) so a repo without a Compose
 *     file is never handed a command that deterministically fails.
 *   - Returns `null` for unknown stacks; the caller is responsible for
 *     surfacing the empty wizard so the user can configure it manually.
 *
 * The result is framework-shaped rather than config-shaped: callers map
 * `startScript` → `devServer.startCommand` and `port` → a
 * `devServer.portMap` entry, and decide for themselves whether to persist
 * the block at all.
 *
 * This file is dependency-free beyond the Node `fs`/`path` builtins so
 * it can be unit-tested without spinning up the rest of the server.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

/** What detection knows about a workspace, before any config mapping. */
export interface DetectedPreviewDefaults {
  /** Shell command that boots the dev server. */
  startScript: string;
  /** Port the dev server conventionally listens on. */
  port: number;
  /** Routes the session preview should open by default. */
  captureRoutes: string[];
  /** Seconds of inactivity before the dev server is reaped. */
  idleTTL: number;
  /**
   * Tag for the recognised stack — useful for log lines and the wizard
   * "We detected a Vite project" copy. Not persisted anywhere; it lives
   * only on the detection result.
   */
  stack: KnownStack;
}

export type KnownStack =
  | 'vite'
  | 'next'
  | 'cra'
  | 'astro'
  | 'nuxt'
  | 'expo'
  | 'compose'
  | 'docker'
  | 'fastapi'
  | 'flask'
  | 'django'
  | 'go'
  | 'rust';

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
  // `docker compose up --build` is emitted ONLY for the `compose` stack —
  // i.e. only when a Compose file is actually present. Every other stack
  // below carries a command that runs against its own project files, so a
  // Dockerfile-only / bare-manifest repo is never auto-configured with a
  // Compose command that would deterministically fail.
  compose: {
    startScript: 'docker compose up --build',
    port: 8000,
    captureRoutes: ['/'],
    idleTTL: 600,
  },
  // Dockerfile-only: the runnable command is built dynamically in
  // `classifyDockerfile` (build + run with the EXPOSEd port). The default
  // here only seeds the fallback port.
  docker: {
    startScript:
      'docker build -t agent-hub-preview . && docker run --rm -p 8000:8000 agent-hub-preview',
    port: 8000,
    captureRoutes: ['/'],
    idleTTL: 600,
  },
  fastapi: {
    startScript: 'uvicorn main:app --host 0.0.0.0 --port 8000',
    port: 8000,
    captureRoutes: ['/'],
    idleTTL: 600,
  },
  flask: {
    startScript: 'flask run --host=0.0.0.0 --port=5000',
    port: 5000,
    captureRoutes: ['/'],
    idleTTL: 600,
  },
  django: {
    startScript: 'python manage.py runserver 0.0.0.0:8000',
    port: 8000,
    captureRoutes: ['/'],
    idleTTL: 600,
  },
  go: { startScript: 'go run .', port: 8080, captureRoutes: ['/'], idleTTL: 600 },
  rust: {
    startScript: 'cargo run',
    port: 3000,
    captureRoutes: ['/'],
    idleTTL: 600,
  },
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
 * Inspect a workspace directory and return dev-server defaults for the
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
const COMPOSE_FILENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

function firstExisting(workspaceDir: string, names: string[]): string | null {
  for (const name of names) {
    const abs = path.join(workspaceDir, name);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function safeRead(absPath: string): string {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

/** Host port from a Compose `ports: - "HOST:CONTAINER"` mapping, if any. */
export function parseComposeHostPort(contents: string): number | null {
  const match = contents.match(/['"]?(\d{2,5}):\d{2,5}['"]?/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function classifyCompose(workspaceDir: string): DetectedPreviewDefaults | null {
  const composePath = firstExisting(workspaceDir, COMPOSE_FILENAMES);
  if (!composePath) return null;
  const defaults = STACK_DEFAULTS.compose;
  const port = parseComposeHostPort(safeRead(composePath)) ?? defaults.port;
  return { stack: 'compose', ...defaults, port };
}

/** First `EXPOSE <port>` declared in a Dockerfile, if any. */
export function parseDockerfileExpose(contents: string): number | null {
  const match = contents.match(/^\s*EXPOSE\s+(\d{2,5})/im);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function classifyDockerfile(workspaceDir: string): DetectedPreviewDefaults | null {
  const dockerfilePath = path.join(workspaceDir, 'Dockerfile');
  if (!existsSync(dockerfilePath)) return null;
  const defaults = STACK_DEFAULTS.docker;
  const port = parseDockerfileExpose(safeRead(dockerfilePath)) ?? defaults.port;
  // `sh -c` runs the persisted startCommand, so `&&` chains fine. Build then
  // run the image, publishing the EXPOSEd port. No Compose file exists on
  // this path — that's handled earlier by classifyCompose.
  const startScript = `docker build -t agent-hub-preview . && docker run --rm -p ${port}:${port} agent-hub-preview`;
  return { stack: 'docker', ...defaults, port, startScript };
}

function classifyPython(workspaceDir: string): KnownStack | null {
  const blobs = [
    safeRead(path.join(workspaceDir, 'pyproject.toml')),
    safeRead(path.join(workspaceDir, 'requirements.txt')),
  ]
    .join('\n')
    .toLowerCase();
  if (!blobs.trim()) return null;
  if (blobs.includes('django')) return 'django';
  if (blobs.includes('fastapi')) return 'fastapi';
  if (blobs.includes('flask')) return 'flask';
  return null;
}

function classifyGo(workspaceDir: string): KnownStack | null {
  return existsSync(path.join(workspaceDir, 'go.mod')) ? 'go' : null;
}

function classifyRust(workspaceDir: string): KnownStack | null {
  return existsSync(path.join(workspaceDir, 'Cargo.toml')) ? 'rust' : null;
}

export function detectPreviewDefaults(workspaceDir: string): DetectedPreviewDefaults | null {
  if (!workspaceDir || typeof workspaceDir !== 'string') return null;
  // Caller mistake — be lenient and bail rather than throw.
  if (!existsSync(workspaceDir)) return null;

  const topPkg = readPkgJson(path.join(workspaceDir, 'package.json'));
  let stack: KnownStack | null = topPkg ? classifyPackageJson(topPkg) : null;
  if (!stack) {
    stack = classifyMonorepo(workspaceDir);
  }
  if (stack) return { stack, ...STACK_DEFAULTS[stack] };

  const compose = classifyCompose(workspaceDir);
  if (compose) return compose;
  const docker = classifyDockerfile(workspaceDir);
  if (docker) return docker;

  const py = classifyPython(workspaceDir);
  if (py) return { stack: py, ...STACK_DEFAULTS[py] };
  const go = classifyGo(workspaceDir);
  if (go) return { stack: go, ...STACK_DEFAULTS[go] };
  const rust = classifyRust(workspaceDir);
  if (rust) return { stack: rust, ...STACK_DEFAULTS[rust] };

  return null;
}
