import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against wired-but-missing helper scripts.
 *
 * The repo keeps executable helpers in several `scripts/` dirs (repo root,
 * `server/`, `mobile/`, `ops/`) and wires them from `package.json` scripts,
 * husky hooks, GitHub workflows, and `.agent-hub/ci.yaml`. Deleting or moving
 * one of those files breaks its caller at run time only — on a release
 * workflow that may be weeks later.
 *
 * This scans every wiring source for `…scripts/<name>.<ext>` references and
 * asserts the file exists. It was added alongside the removal of seven dead
 * one-shot codemods and the relocation of two ops tools into `ops/scripts/`,
 * to make that class of change fail loudly instead of silently.
 *
 * Resolution is cwd-aware, because a bare `scripts/foo.mjs` is relative to
 * whatever directory the caller runs in, not to the repo root:
 *   - `package.json` scripts run with cwd = that package's directory.
 *   - husky hooks run with cwd = repo root.
 *   - workflow / ci.yaml steps run at repo root unless the step uses
 *     `working-directory:` or an inline `cd <dir>` (e.g.
 *     `(cd server && npx tsx scripts/format-release-notes.ts)`), so those
 *     directories are accepted as additional bases for that file.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `<maybe-pkg-dir>/scripts/<path>.<ext>` as written in a wiring file.
const SCRIPT_REF_RE =
  /(?:^|[\s'"(&;|])((?:[A-Za-z0-9._-]+\/)*scripts\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:mjs|cjs|js|ts|sh))/g;

const PACKAGE_JSONS = [
  'package.json',
  'server/package.json',
  'client/package.json',
  'mobile/package.json',
  'shared/package.json',
];

interface WiringSource {
  /** Repo-relative path of the file doing the wiring. */
  file: string;
  /** Repo-relative directories a bare `scripts/...` reference may resolve against. */
  bases: string[];
}

function listFiles(relDir: string): string[] {
  const abs = join(REPO_ROOT, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .map((name) => join(relDir, name))
    .filter((rel) => statSync(join(REPO_ROOT, rel)).isFile());
}

/** Directories a workflow/ci step may have cd'd into before invoking a script. */
function declaredWorkingDirs(text: string): string[] {
  const dirs = new Set<string>();
  for (const m of text.matchAll(/working-directory:\s*['"]?([A-Za-z0-9._\-/]+)/g)) dirs.add(m[1]);
  for (const m of text.matchAll(/\bcd\s+([A-Za-z0-9._\-/]+)/g)) dirs.add(m[1]);
  return [...dirs].filter((d) => !d.startsWith('/') && !d.includes('..'));
}

function collectSources(): WiringSource[] {
  const sources: WiringSource[] = [];

  for (const rel of PACKAGE_JSONS) {
    // npm runs a package's scripts with cwd set to that package's directory.
    if (existsSync(join(REPO_ROOT, rel))) sources.push({ file: rel, bases: [dirname(rel)] });
  }

  for (const rel of listFiles('.husky')) sources.push({ file: rel, bases: ['.'] });

  for (const rel of [...listFiles('.github/workflows'), '.agent-hub/ci.yaml']) {
    if (!existsSync(join(REPO_ROOT, rel))) continue;
    const text = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    sources.push({ file: rel, bases: ['.', ...declaredWorkingDirs(text)] });
  }

  return sources;
}

function resolveReference(ref: string, bases: string[]): boolean {
  return bases.some((base) => existsSync(join(REPO_ROOT, base, ref)));
}

interface Reference {
  ref: string;
  file: string;
  bases: string[];
}

function collectReferences(): Reference[] {
  const refs: Reference[] = [];
  for (const { file, bases } of collectSources()) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf-8');
    for (const m of text.matchAll(SCRIPT_REF_RE)) {
      refs.push({ ref: m[1], file, bases });
    }
  }
  return refs;
}

describe('helper script references', () => {
  it('finds the wiring sources it is meant to scan', () => {
    // Fails loudly if the repo layout moves out from under the scanner,
    // which would otherwise make the assertion below vacuously pass.
    const refs = collectReferences();
    expect(refs.length).toBeGreaterThan(5);
    expect(refs.some((r) => r.file === 'package.json')).toBe(true);
  });

  it('every wired script path exists on disk', () => {
    const missing = collectReferences()
      .filter(({ ref, bases }) => !resolveReference(ref, bases))
      .map(
        ({ ref, file, bases }) =>
          `${ref} (referenced by ${file}; tried bases: ${bases.join(', ')})`,
      );

    expect(missing).toEqual([]);
  });

  it('does not reference the deleted one-shot codemods', () => {
    // These were finished migrations removed wholesale; a reappearing
    // reference means something was restored without its file.
    const removed = [
      'migrate-to-typescript',
      'fix-strict-types',
      'ensure-mobile-deps',
      'finalize-remote-runner-2a',
    ];
    const offenders = collectReferences()
      .filter(({ ref }) => removed.some((name) => ref.includes(name)))
      .map(({ ref, file }) => `${ref} (referenced by ${file})`);

    expect(offenders).toEqual([]);
  });
});
