/**
 * README / env-example scanning for Preview environment settings.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const README_NAMES = ['README.md', 'Readme.md', 'readme.md', 'README.MD'];
const ENV_EXAMPLE_NAMES = ['.env.example', '.env.sample', 'env.example', '.env.template'];

const ENV_LINE_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;
const ENV_MENTION_RE = /\b([A-Z][A-Z0-9_]{2,})\b/g;
const DOCKER_HINT_RE = /docker\s+compose|docker-compose|compose\.ya?ml/i;

const README_SKIP_ENV = new Set([
  'API',
  'URL',
  'HTTP',
  'HTTPS',
  'JSON',
  'YAML',
  'YML',
  'MD',
  'README',
  'DOCKER',
  'COMPOSE',
  'NODE',
  'NPM',
  'PNPM',
  'TRUE',
  'FALSE',
  'NULL',
  'UTC',
]);

export interface ReadmeScanResult {
  readmePath: string | null;
  /** Short excerpt around docker/setup instructions (max ~600 chars). */
  setupExcerpt: string | null;
  hasDockerHints: boolean;
  envKeysFromReadme: string[];
}

export interface EnvExampleScanResult {
  envExamplePath: string | null;
  keys: string[];
  requiredKeys: string[];
}

export type EnvVarSource = 'source' | 'readme' | 'env-example';

export interface EnvVarSuggestion {
  key: string;
  sources: EnvVarSource[];
  /** True when key appears in `.env.example` with an empty value. */
  required: boolean;
}

function readFirstExisting(workspaceDir: string, names: string[]): string | null {
  for (const name of names) {
    const full = path.join(workspaceDir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

function extractDockerExcerpt(text: string): string | null {
  const idx = text.search(DOCKER_HINT_RE);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 120);
  const end = Math.min(text.length, idx + 480);
  return text.slice(start, end).trim();
}

function extractEnvKeysFromReadme(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const codeMatch = trimmed.match(/^`?([A-Z][A-Z0-9_]*)`?\s*[:=]/);
    if (codeMatch && !README_SKIP_ENV.has(codeMatch[1])) keys.add(codeMatch[1]);
    const assign = trimmed.match(ENV_LINE_RE);
    if (assign && !README_SKIP_ENV.has(assign[1])) keys.add(assign[1]);
    if (/process\.env\.|import\.meta\.env\.|ENV\[/.test(trimmed)) {
      let m: RegExpExecArray | null;
      ENV_MENTION_RE.lastIndex = 0;
      while ((m = ENV_MENTION_RE.exec(trimmed)) !== null) {
        if (!README_SKIP_ENV.has(m[1]) && m[1].length >= 3) keys.add(m[1]);
      }
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export function scanReadme(workspaceDir: string): ReadmeScanResult {
  const readmePath = readFirstExisting(workspaceDir, README_NAMES);
  if (!readmePath) {
    return {
      readmePath: null,
      setupExcerpt: null,
      hasDockerHints: false,
      envKeysFromReadme: [],
    };
  }
  let text = '';
  try {
    text = readFileSync(readmePath, 'utf8');
    if (text.length > 200_000) text = text.slice(0, 200_000);
  } catch {
    return {
      readmePath: path.basename(readmePath),
      setupExcerpt: null,
      hasDockerHints: false,
      envKeysFromReadme: [],
    };
  }
  return {
    readmePath: path.basename(readmePath),
    setupExcerpt: extractDockerExcerpt(text),
    hasDockerHints: DOCKER_HINT_RE.test(text),
    envKeysFromReadme: extractEnvKeysFromReadme(text),
  };
}

export function scanEnvExample(workspaceDir: string): EnvExampleScanResult {
  const envPath = readFirstExisting(workspaceDir, ENV_EXAMPLE_NAMES);
  if (!envPath) {
    return { envExamplePath: null, keys: [], requiredKeys: [] };
  }
  const keys: string[] = [];
  const requiredKeys: string[] = [];
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(ENV_LINE_RE);
      if (!m) continue;
      keys.push(m[1]);
      const val = (m[2] || '').trim();
      if (!val || val === '""' || val === "''") requiredKeys.push(m[1]);
    }
  } catch {
    return { envExamplePath: path.basename(envPath), keys: [], requiredKeys: [] };
  }
  return {
    envExamplePath: path.basename(envPath),
    keys: [...new Set(keys)].sort((a, b) => a.localeCompare(b)),
    requiredKeys: [...new Set(requiredKeys)],
  };
}

export function mergeEnvVarSuggestions(
  sourceKeys: string[],
  readme: ReadmeScanResult,
  envExample: EnvExampleScanResult,
): EnvVarSuggestion[] {
  const requiredFromExample = new Set(envExample.requiredKeys);
  const map = new Map<string, Set<EnvVarSource>>();

  const add = (key: string, source: EnvVarSource) => {
    if (!key || key.length < 2) return;
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(source);
  };

  for (const k of sourceKeys) add(k, 'source');
  for (const k of readme.envKeysFromReadme) add(k, 'readme');
  for (const k of envExample.keys) add(k, 'env-example');

  return [...map.entries()]
    .map(([key, sources]) => ({
      key,
      sources: [...sources].sort(),
      required: requiredFromExample.has(key),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
