/**
 * Server-side repo scan for the AI-assisted Dev Server setup wizard.
 *
 * `collectDevServerSetupDraft(cwd)` reads the project working copy (never
 * throws — a missing / malformed `package.json` yields an empty-ish draft)
 * and returns the signal the `dev-server-setup` walkthrough embeds in its
 * kickoff prompt: candidate start commands from `package.json` scripts, the
 * detected package manager, monorepo layout, framework guesses, likely dev
 * ports, a health-path default, a README excerpt, and the project's existing
 * `prEnv.devServer` config (so the wizard edits rather than clobbers).
 *
 * The draft is intentionally deterministic and dependency-light: it inspects
 * `package.json`, lockfiles, and a shallow set of workspace directories. Deep
 * env-var discovery is left to the agent's interactive walkthrough (it can
 * `Read`/`grep` source during the session) so this scan stays fast and
 * testable.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { DevServerConfig } from './dev-server-config.js';

export type DevServerPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DevServerStartCommandCandidate {
  /** The runnable command, e.g. `npm run dev` (package-manager aware). */
  command: string;
  /** The `package.json` script name, e.g. `dev`. */
  script: string;
  /** The raw script body from `package.json`. */
  raw: string;
  /** True for the single best guess (the wizard pre-selects it). */
  recommended: boolean;
}

export interface DevServerPortGuess {
  internalPort: number;
  /** Short label suggestion for the port-map entry (e.g. `web`). */
  label: string;
  /** Where the guess came from, e.g. `vite default` or `--port flag`. */
  source: string;
}

export interface DevServerSetupDraft {
  /** Absolute project cwd that was scanned. */
  cwd: string;
  /** Detected package manager from lockfiles, or null when unknown. */
  packageManager: DevServerPackageManager | null;
  /** True when `package.json` declares workspaces or a pnpm workspace exists. */
  isMonorepo: boolean;
  /** Candidate app subdirectories (workspace globs resolved shallowly). */
  monorepoDirs: string[];
  /** Runnable dev/start commands parsed from `package.json` scripts. */
  startCommandCandidates: DevServerStartCommandCandidate[];
  /** Frontend/back frameworks inferred from dependencies. */
  frameworks: string[];
  /** Likely internal dev ports (framework defaults + explicit flags). */
  portGuesses: DevServerPortGuess[];
  /** Sensible readiness-probe default for the primary port. */
  healthPathGuess: string;
  /** The project's current `prEnv.devServer`, if any (edit target). */
  existing: DevServerConfig | null;
  /** README location + a short setup-oriented excerpt. */
  readme: { path: string | null; excerpt: string | null };
}

interface PackageJson {
  scripts?: Record<string, string>;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const DEV_SCRIPT_NAMES = ['dev', 'start', 'serve', 'develop', 'dev:server', 'dev:web', 'start:dev'];
const README_EXCERPT_MAX = 1200;
const MAX_MONOREPO_DIRS = 24;

function readJson(file: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function detectPackageManager(cwd: string): DevServerPackageManager | null {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock')))
    return 'bun';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
  return null;
}

function runScriptCommand(pm: DevServerPackageManager | null, script: string): string {
  // `npm`/`bun` need `run`; `pnpm`/`yarn` accept the bare script name.
  switch (pm) {
    case 'pnpm':
      return `pnpm ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'npm':
    default:
      return `npm run ${script}`;
  }
}

function collectStartCommandCandidates(
  pkg: PackageJson | null,
  pm: DevServerPackageManager | null,
): DevServerStartCommandCandidate[] {
  const scripts = pkg?.scripts ?? {};
  // `package.json` is untrusted input — JSON.parse does not enforce the
  // `Record<string, string>` shape, so a body like `{ "scripts": { "dev": 123 } }`
  // would otherwise flow a non-string into `portFromScript`. Only consider
  // scripts whose body is actually a string.
  const hasStringBody = (name: string): boolean => typeof scripts[name] === 'string';
  const names = Object.keys(scripts).filter(hasStringBody);
  if (names.length === 0) return [];
  const ordered: string[] = [];
  // Preferred names first (in priority order), then any other script that
  // looks like a long-running server (`dev`/`serve`/`start` substring).
  for (const preferred of DEV_SCRIPT_NAMES) {
    if (hasStringBody(preferred) && !ordered.includes(preferred)) ordered.push(preferred);
  }
  for (const name of names) {
    if (ordered.includes(name)) continue;
    if (/(^|:)(dev|serve|start)(:|$)/i.test(name)) ordered.push(name);
  }
  return ordered.map((script, i) => ({
    command: runScriptCommand(pm, script),
    script,
    raw: scripts[script],
    recommended: i === 0,
  }));
}

const FRAMEWORK_SIGNATURES: Array<{ dep: string; name: string; port: number }> = [
  { dep: 'next', name: 'next', port: 3000 },
  { dep: 'nuxt', name: 'nuxt', port: 3000 },
  { dep: '@remix-run/dev', name: 'remix', port: 3000 },
  { dep: 'astro', name: 'astro', port: 4321 },
  { dep: 'gatsby', name: 'gatsby', port: 8000 },
  { dep: '@angular/cli', name: 'angular', port: 4200 },
  { dep: '@sveltejs/kit', name: 'sveltekit', port: 5173 },
  { dep: 'react-scripts', name: 'create-react-app', port: 3000 },
  { dep: 'vite', name: 'vite', port: 5173 },
];

function detectFrameworks(pkg: PackageJson | null): Array<{ name: string; port: number }> {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const hits: Array<{ name: string; port: number }> = [];
  for (const sig of FRAMEWORK_SIGNATURES) {
    if (deps[sig.dep] && !hits.some((h) => h.name === sig.name)) {
      hits.push({ name: sig.name, port: sig.port });
    }
  }
  return hits;
}

/** Pull an explicit dev port out of a script body (`--port 4000`, `-p 4000`, `PORT=4000`). */
function portFromScript(raw: unknown): number | null {
  // Defense in depth: `raw` originates from untrusted `package.json`; a
  // non-string body must never reach `.match()`.
  if (typeof raw !== 'string' || !raw) return null;
  const patterns = [
    /--port(?:[=\s]+)(\d{2,5})/i,
    /(?:^|\s)-p[=\s]+(\d{2,5})/i,
    /(?:^|\s)PORT=(\d{2,5})/,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
  }
  return null;
}

function collectPortGuesses(
  candidates: DevServerStartCommandCandidate[],
  frameworks: Array<{ name: string; port: number }>,
): DevServerPortGuess[] {
  const guesses: DevServerPortGuess[] = [];
  const seen = new Set<number>();
  const push = (internalPort: number, label: string, source: string) => {
    if (seen.has(internalPort)) return;
    seen.add(internalPort);
    guesses.push({ internalPort, label, source });
  };
  // Explicit flags in the recommended script win.
  const recommended = candidates.find((c) => c.recommended);
  const flagPort = portFromScript(recommended?.raw);
  if (flagPort) push(flagPort, 'web', '--port flag');
  // Framework defaults next.
  for (const fw of frameworks) push(fw.port, 'web', `${fw.name} default`);
  return guesses;
}

function collectMonorepoDirs(cwd: string, pkg: PackageJson | null): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    if (seen.has(rel) || dirs.length >= MAX_MONOREPO_DIRS) return;
    if (existsSync(path.join(cwd, rel, 'package.json'))) {
      seen.add(rel);
      dirs.push(rel);
    }
  };
  // Resolve workspace globs shallowly: `apps/*` → each subdir of `apps`.
  const globs: string[] = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws.filter((g): g is string => typeof g === 'string'));
  else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    globs.push(
      ...((ws as { packages: unknown[] }).packages.filter(
        (g): g is string => typeof g === 'string',
      ) ?? []),
    );
  }
  // pnpm workspaces live in pnpm-workspace.yaml — treat the common roots.
  if (existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
    globs.push('apps/*', 'packages/*');
  }
  for (const glob of globs) {
    const trimmed = glob.replace(/\/\*+$/, '');
    if (trimmed === glob) {
      // Non-glob workspace entry: a direct dir.
      add(glob);
      continue;
    }
    const base = path.join(cwd, trimmed);
    let entries: string[] = [];
    try {
      entries = readdirSync(base);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      try {
        if (statSync(path.join(base, entry)).isDirectory()) add(path.join(trimmed, entry));
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return dirs;
}

function collectReadmeExcerpt(cwd: string): { path: string | null; excerpt: string | null } {
  for (const name of ['README.md', 'readme.md', 'README.MD', 'Readme.md']) {
    const file = path.join(cwd, name);
    if (existsSync(file)) {
      try {
        const body = readFileSync(file, 'utf8');
        return { path: name, excerpt: body.slice(0, README_EXCERPT_MAX) };
      } catch {
        return { path: name, excerpt: null };
      }
    }
  }
  return { path: null, excerpt: null };
}

/**
 * Read the project working copy and build the Dev Server setup draft. Pure of
 * side effects and resilient: any read failure degrades to an empty field
 * rather than throwing, so the wizard always has a draft to embed.
 */
export function collectDevServerSetupDraft(
  cwd: string,
  opts: { existing?: DevServerConfig | null } = {},
): DevServerSetupDraft {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const packageManager = detectPackageManager(cwd);
  const startCommandCandidates = collectStartCommandCandidates(pkg, packageManager);
  const frameworkHits = detectFrameworks(pkg);
  const frameworks = frameworkHits.map((f) => f.name);
  const portGuesses = collectPortGuesses(startCommandCandidates, frameworkHits);
  const workspacesDeclared = !!pkg?.workspaces || existsSync(path.join(cwd, 'pnpm-workspace.yaml'));
  const monorepoDirs = workspacesDeclared ? collectMonorepoDirs(cwd, pkg) : [];

  return {
    cwd,
    packageManager,
    isMonorepo: workspacesDeclared,
    monorepoDirs,
    startCommandCandidates,
    frameworks,
    portGuesses,
    healthPathGuess: '/',
    existing: opts.existing ?? null,
    readme: collectReadmeExcerpt(cwd),
  };
}
