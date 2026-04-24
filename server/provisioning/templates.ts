/**
 * Starter template registry.
 *
 * Each subdirectory under `server/provisioning/templates/` is a
 * self-contained starter codebase for a single stack. Layout:
 *
 *   server/provisioning/templates/<id>/
 *     manifest.json       — schema below
 *     files/              — the tree that gets copied into the user's
 *                           workspace during the `copy-template` phase.
 *                           Anything inside `files/` is verbatim; nothing
 *                           outside is copied.
 *
 * Manifest schema (validated at load time):
 *   {
 *     "id":             "<matches directory name>",
 *     "label":          "Human-readable name shown in the picker",
 *     "appTypes":       ["web-app", "api", ...],  // questionnaire tags
 *     "setup":          ["command ...", ...],     // run in order
 *     "test":           "command ...",
 *     "lint":           "command ...",
 *     "recommendedFor": ["bot", "ml", ...]        // drives default picker hint
 *   }
 *
 * This module owns loading, validating, and resolving those manifests.
 * It is pure data access — the real work of copying the tree and
 * running the commands lives in `template-executor.ts`.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KNOWN_TEMPLATE_IDS, type TemplateId } from './stack-defaults.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to `server/provisioning/templates/`. */
export const TEMPLATES_ROOT = path.join(__dirname, 'templates');

export interface TemplateManifest {
  id: TemplateId;
  label: string;
  appTypes: string[];
  setup: string[];
  test: string;
  lint: string;
  recommendedFor: string[];
}

export interface LoadedTemplate {
  manifest: TemplateManifest;
  /** Absolute path to the template directory on disk. */
  dir: string;
  /** Absolute path to `<dir>/files/` (the tree copied into projects). */
  filesDir: string;
}

/** Thrown when a manifest file on disk doesn't satisfy the schema. */
export class TemplateManifestError extends Error {
  constructor(
    public readonly templateDir: string,
    message: string,
  ) {
    super(`[${path.basename(templateDir)}] ${message}`);
    this.name = 'TemplateManifestError';
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function assertManifest(raw: unknown, templateDir: string): TemplateManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TemplateManifestError(templateDir, 'manifest must be an object');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m['id'] !== 'string' || !m['id']) {
    throw new TemplateManifestError(templateDir, 'manifest.id must be a non-empty string');
  }
  if (!(KNOWN_TEMPLATE_IDS as readonly string[]).includes(m['id'])) {
    throw new TemplateManifestError(
      templateDir,
      `manifest.id "${m['id']}" is not in KNOWN_TEMPLATE_IDS — add it to stack-defaults.ts first`,
    );
  }
  if (m['id'] !== path.basename(templateDir)) {
    throw new TemplateManifestError(
      templateDir,
      `manifest.id "${m['id']}" must match its directory name "${path.basename(templateDir)}"`,
    );
  }
  if (typeof m['label'] !== 'string' || !m['label']) {
    throw new TemplateManifestError(templateDir, 'manifest.label must be a non-empty string');
  }
  if (!isStringArray(m['appTypes']) || (m['appTypes'] as string[]).length === 0) {
    throw new TemplateManifestError(
      templateDir,
      'manifest.appTypes must be a non-empty string array',
    );
  }
  if (!isStringArray(m['setup']) || (m['setup'] as string[]).length === 0) {
    throw new TemplateManifestError(templateDir, 'manifest.setup must be a non-empty string array');
  }
  if (typeof m['test'] !== 'string' || !m['test']) {
    throw new TemplateManifestError(templateDir, 'manifest.test must be a non-empty string');
  }
  if (typeof m['lint'] !== 'string' || !m['lint']) {
    throw new TemplateManifestError(templateDir, 'manifest.lint must be a non-empty string');
  }
  if (!isStringArray(m['recommendedFor'])) {
    throw new TemplateManifestError(templateDir, 'manifest.recommendedFor must be a string array');
  }

  return {
    id: m['id'] as TemplateId,
    label: m['label'],
    appTypes: m['appTypes'] as string[],
    setup: m['setup'] as string[],
    test: m['test'],
    lint: m['lint'],
    recommendedFor: m['recommendedFor'] as string[],
  };
}

function loadTemplateFromDisk(dir: string): LoadedTemplate {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new TemplateManifestError(dir, `missing manifest.json`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err: unknown) {
    throw new TemplateManifestError(
      dir,
      `manifest.json is not valid JSON: ${(err as Error).message}`,
    );
  }
  const manifest = assertManifest(parsed, dir);
  const filesDir = path.join(dir, 'files');
  if (!existsSync(filesDir) || !statSync(filesDir).isDirectory()) {
    throw new TemplateManifestError(dir, `missing files/ directory`);
  }
  return { manifest, dir, filesDir };
}

let cache: Map<TemplateId, LoadedTemplate> | null = null;

/** Drop the in-memory cache. Exposed for tests. */
export function _resetTemplateCache(): void {
  cache = null;
}

/** Load all templates from disk (cached). Invalid manifests throw. */
export function loadAllTemplates(): Map<TemplateId, LoadedTemplate> {
  if (cache) return cache;

  const next = new Map<TemplateId, LoadedTemplate>();
  if (!existsSync(TEMPLATES_ROOT)) {
    cache = next;
    return next;
  }
  const entries = readdirSync(TEMPLATES_ROOT);
  for (const name of entries) {
    const full = path.join(TEMPLATES_ROOT, name);
    if (!statSync(full).isDirectory()) continue;
    const loaded = loadTemplateFromDisk(full);
    next.set(loaded.manifest.id, loaded);
  }
  cache = next;
  return next;
}

/**
 * Look up one template by id. Throws if the id is unknown — callers
 * should resolve `idk`-style defaults via `stack-defaults.ts` first.
 */
export function getTemplate(id: TemplateId): LoadedTemplate {
  const all = loadAllTemplates();
  const hit = all.get(id);
  if (!hit) {
    throw new Error(
      `Template "${id}" is not registered. Known: ${[...all.keys()].join(', ') || '(none)'}.`,
    );
  }
  return hit;
}

/** Everything the registry knows about, in `KNOWN_TEMPLATE_IDS` order. */
export function listTemplates(): LoadedTemplate[] {
  const all = loadAllTemplates();
  return KNOWN_TEMPLATE_IDS.map((id) => all.get(id)).filter(
    (t): t is LoadedTemplate => t !== undefined,
  );
}

/** Recursively list every file under `files/` relative to `filesDir`. */
export function listTemplateFiles(template: LoadedTemplate): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(template.filesDir, rel);
    for (const entry of readdirSync(abs)) {
      const entryRel = rel ? path.join(rel, entry) : entry;
      const entryAbs = path.join(abs, entry);
      const st = statSync(entryAbs);
      if (st.isDirectory()) {
        walk(entryRel);
      } else {
        out.push(entryRel);
      }
    }
  };
  walk('');
  out.sort();
  return out;
}
