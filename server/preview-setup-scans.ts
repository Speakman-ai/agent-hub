/**
 * Workspace scanners for the preview-setup wizard.
 *
 * Mirrors the bundled bash helpers under
 * `default-skills/preview-setup/scripts/` so the server can precompute a
 * draft without an extra agent turn. Pure TypeScript — safe in tests
 * (no `child_process` spawn).
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';

const ENV_KEY_SKIP = new Set(['NODE_ENV', 'PATH', 'HOME', 'PWD', 'CI', 'USER', 'SHELL', 'TERM']);

const PACKAGE_JSON_CANDIDATES = [
  'package.json',
  'frontend/package.json',
  'client/package.json',
  'apps/web/package.json',
  'apps/api/package.json',
];

const SCRIPT_NAME_SHAPES = [/^dev$/, /^dev:.+/, /^start$/, /^start:.+/, /^serve$/, /^web$/];

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /os\.environ(?:\[|\.get\()['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /ENV(?:\[|\.fetch\()['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g,
];

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.svelte',
  '.vue',
  '.astro',
]);

const SCAN_ROOTS = [
  'src',
  'app',
  'pages',
  'backend',
  'frontend',
  'apps',
  'client',
  'lib',
  'server',
];

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '__pycache__',
  'venv',
  '.venv',
  '.worktrees',
  'worktrees',
]);

export interface PackageScriptCandidate {
  /** Directory containing package.json, relative to workspace (`.` = root). */
  cwd: string;
  scriptName: string;
  scriptBody: string;
  /** Convenience label for wizard pickers, e.g. `npm run dev`. */
  label: string;
}

function shouldSkipEnvKey(key: string): boolean {
  if (ENV_KEY_SKIP.has(key)) return true;
  if (key.startsWith('VITE_PUBLIC_')) return true;
  return false;
}

function collectEnvKeysFromText(text: string, out: Set<string>): void {
  for (const re of ENV_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      if (key && !shouldSkipEnvKey(key)) out.add(key);
    }
  }
}

function walkSourceFiles(dir: string, depth: number, out: string[]): void {
  if (depth > 6) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      walkSourceFiles(path.join(dir, name), depth + 1, out);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(name);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    out.push(path.join(dir, name));
  }
}

/** Deduped env-var keys referenced under common source roots. */
export function scanEnvKeys(workspaceDir: string): string[] {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  const keys = new Set<string>();
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(workspaceDir, root);
    if (!existsSync(abs)) continue;
    walkSourceFiles(abs, 0, files);
  }
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      if (text.length > 512_000) continue;
      collectEnvKeysFromText(text, keys);
    } catch {
      /* unreadable — skip */
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function npmLabel(cwd: string, scriptName: string): string {
  if (cwd === '.' || cwd === '') return `npm run ${scriptName}`;
  return `(cd ${cwd} && npm run ${scriptName})`;
}

/** Candidate dev-server scripts from package.json files. */
export function scanPackageScriptCandidates(workspaceDir: string): PackageScriptCandidate[] {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  const out: PackageScriptCandidate[] = [];
  for (const rel of PACKAGE_JSON_CANDIDATES) {
    const full = path.join(workspaceDir, rel);
    if (!existsSync(full)) continue;
    let pkg: { scripts?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(full, 'utf8')) as { scripts?: Record<string, unknown> };
    } catch {
      continue;
    }
    const scripts = pkg?.scripts;
    if (!scripts || typeof scripts !== 'object') continue;
    const cwd = path.dirname(rel) || '.';
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body !== 'string') continue;
      if (!SCRIPT_NAME_SHAPES.some((re) => re.test(name))) continue;
      out.push({
        cwd,
        scriptName: name,
        scriptBody: body,
        label: npmLabel(cwd, name),
      });
    }
  }
  return out;
}
