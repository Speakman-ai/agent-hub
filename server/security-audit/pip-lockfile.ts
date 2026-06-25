/**
 * pip-lockfile.ts — parse Python dependency lockfiles into a flat list of
 * resolved PyPI dependencies. Mirrors how Dependabot treats the Python
 * ecosystem: pip / pip-tools / poetry / pipenv all map to a single `pip`
 * ecosystem that queries OSV's `PyPI` database.
 *
 * Three formats are supported, one parser per basename:
 *   - `requirements.txt` — pip / pip-tools. A line-oriented format. Only
 *     EXACT pins (`name==version`) are audited; unpinned requirements have no
 *     single installed version to check, so they are skipped (honest
 *     under-reporting rather than guessing). Options lines (`-r`, `-e`,
 *     `--hash`, `-c`, …), comments, environment markers, extras, and inline
 *     `--hash` fragments are all stripped.
 *   - `poetry.lock` — TOML. We don't pull in a TOML dependency for one shape;
 *     a focused line parser reads each `[[package]]` block's top-level
 *     `name` / `version` scalars (and stops at the block's nested
 *     `[package.*]` sub-tables so a `[package.source]` reference can't be
 *     mistaken for the package version).
 *   - `Pipfile.lock` — JSON. The `default` and `develop` maps key package
 *     name → `{ version: "==x.y.z" }`; we strip the `==` operator. VCS / local
 *     entries that carry no pinned `version` are skipped.
 *
 * Package names are normalised to their PEP 503 canonical form (lowercase,
 * every run of `-`, `_`, `.` collapsed to a single `-`) so `Flask`,
 * `flask`, and `Jinja2`/`jinja2` match the names OSV's PyPI records use.
 *
 * Like every {@link LockfileParser}, parse functions NEVER throw and return
 * `null` only when the content cannot be parsed as that format at all.
 */

import type { LockfileParser, ResolvedDependency } from './types.js';

/**
 * Normalise a Python project name to its PEP 503 canonical form: lowercase,
 * with every run of `-`, `_`, `.` collapsed to a single `-`. This is the form
 * OSV's PyPI advisories are keyed by, so `zope.interface`, `Zope_Interface`,
 * and `zope-interface` all match the same advisory.
 */
export function normalizePypiName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

/** True for a PEP 440-ish exact version token (digits/letters, no operators). */
function looksLikeVersion(v: string): boolean {
  if (v.length === 0) return false;
  // PEP 440 allows a single leading epoch segment `N!` (e.g. `1!2.0.0`), where
  // the `!` is part of a valid EXACT version — not the `!=` range operator.
  // Strip a well-formed epoch prefix first so epoch-pinned packages are audited
  // rather than silently skipped, then validate the release body.
  const body = v.replace(/^[0-9]+!/, '');
  // The body must start with a digit (release segment) and carry no comparison
  // or range markers. `!`, `=`, `<`, `>`, `~`, `*`, whitespace, comma are all
  // range/operator characters; a pinned exact version has none. (`+local` and
  // pre/post/dev suffixes are allowed.)
  return /^[0-9]/.test(body) && !/[<>=!~*\s,]/.test(body);
}

/**
 * Parse a `requirements.txt`. Only exact `==`/`===` pins are emitted — an
 * unpinned or range-specified requirement has no single installed version to
 * audit. Always returns an array (plain text is always "parseable"); an empty
 * array means no exact pins were found.
 */
export function parseRequirementsTxt(
  content: string,
  manifestPath: string,
): ResolvedDependency[] | null {
  const out: ResolvedDependency[] = [];
  const seen = new Set<string>();

  // Join backslash line-continuations first so a wrapped requirement is one
  // logical line.
  const logical = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/);

  for (const rawLine of logical) {
    // Strip inline comments. A `#` starts a comment when at line start or
    // preceded by whitespace (PEP 508 doesn't allow `#` inside a bare name).
    let line = rawLine.replace(/(^|\s)#.*$/, '$1').trim();
    if (!line) continue;
    // Skip pip option / include lines: -r, -c, -e, --hash, --index-url, etc.
    if (line.startsWith('-')) continue;

    // Drop environment markers (`; python_version < "3.8"`) and any trailing
    // `--hash=...` fragments that share the line.
    line = line.split(';')[0];
    line = line.replace(/--hash[=\s]\S+/g, '').trim();
    if (!line) continue;

    // Match `name[extras] == version`. Require the `==`/`===` operator so only
    // exact pins are captured. Names follow PEP 508 (letters, digits, -_.).
    const m = line.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*===?\s*([^\s]+)$/);
    if (!m) continue;
    const name = normalizePypiName(m[1]);
    // A `==1.2.*` prefix-match pin is a range, not an exact install — its `*`
    // makes looksLikeVersion reject it below, so it is skipped (not audited).
    const version = m[2];
    if (!name || !looksLikeVersion(version)) continue;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ecosystem: 'pip', name, version, manifestPath });
  }

  return out;
}

/**
 * Parse a `poetry.lock`. A focused line parser over the `[[package]]` blocks —
 * we deliberately avoid adding a TOML dependency for this single shape. Reads
 * the top-level `name`/`version` scalar of each package block and stops
 * consuming scalars once a nested `[package.*]` sub-table begins, so a
 * `[package.source]` `reference`/`url` can never be read as the version.
 *
 * Returns `null` only when the file has no `[[package]]` blocks at all (an
 * empty / non-poetry file matched by basename); a block missing a name or
 * version is simply skipped.
 */
export function parsePoetryLock(
  content: string,
  manifestPath: string,
): ResolvedDependency[] | null {
  const lines = content.split(/\r?\n/);
  const out: ResolvedDependency[] = [];
  const seen = new Set<string>();

  let sawPackageHeader = false;
  let inScalars = false; // directly under [[package]], before any nested table
  let curName: string | null = null;
  let curVersion: string | null = null;

  const flush = (): void => {
    if (curName && curVersion) {
      const name = normalizePypiName(curName);
      const key = `${name}@${curVersion}`;
      if (name && looksLikeVersion(curVersion) && !seen.has(key)) {
        seen.add(key);
        out.push({ ecosystem: 'pip', name, version: curVersion, manifestPath });
      }
    }
    curName = null;
    curVersion = null;
  };

  // Strip a `"..."` or `'...'` quoted TOML string value.
  const unquote = (raw: string): string | null => {
    const t = raw.trim();
    const m = t.match(/^"([^"]*)"$/) ?? t.match(/^'([^']*)'$/);
    return m ? m[1] : null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '[[package]]') {
      flush();
      sawPackageHeader = true;
      inScalars = true;
      continue;
    }
    // Any other table header ends the current package's top-level scalars.
    // A new top-level table (e.g. `[metadata]`) also flushes the package.
    if (line.startsWith('[')) {
      if (!line.startsWith('[package.')) flush();
      inScalars = false;
      continue;
    }
    if (!inScalars) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === 'name') {
      const v = unquote(line.slice(eq + 1));
      if (v !== null) curName = v;
    } else if (key === 'version') {
      const v = unquote(line.slice(eq + 1));
      if (v !== null) curVersion = v;
    }
  }
  flush();

  // No package blocks at all → not a parseable poetry.lock (corrupt/truncated
  // or wrong file). Signal a parse failure so the scanner preserves findings.
  if (!sawPackageHeader) return null;
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Extract the pinned exact version from a Pipfile.lock entry. An entry is
 * either an object `{ version: "==x.y.z" }` (the common pipenv shape) OR a
 * plain version-spec string `"==x.y.z"`. Both encode the same pin, so we
 * accept either. Returns `null` for VCS / editable entries (no `version`),
 * non-`==` specs (`"*"`, ranges), or anything that isn't an exact pin.
 */
function pipfilePinnedVersion(rawEntry: unknown): string | null {
  let spec: string | null = null;
  if (typeof rawEntry === 'string') spec = rawEntry;
  else if (isObject(rawEntry) && typeof rawEntry.version === 'string') spec = rawEntry.version;
  if (spec === null) return null;
  // Require a `==`/`===` exact pin; strip the operator. Anything else (a bare
  // `*`, a range, or a VCS marker) has no single installed version to audit.
  const m = spec.trim().match(/^===?\s*(.+)$/);
  return m ? m[1].trim() : null;
}

/**
 * Parse a `Pipfile.lock` (pipenv). JSON with `default` / `develop` maps of
 * package name → either `{ version: "==x.y.z" }` or a plain `"==x.y.z"`
 * string. Returns `null` on non-object JSON (corrupt). Entries without a
 * pinned `==` version (VCS / editable installs, bare `*`) are skipped.
 */
export function parsePipfileLock(
  content: string,
  manifestPath: string,
): ResolvedDependency[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const out: ResolvedDependency[] = [];
  const seen = new Set<string>();

  for (const group of ['default', 'develop']) {
    const section = parsed[group];
    if (!isObject(section)) continue;
    for (const [rawName, rawEntry] of Object.entries(section)) {
      // Handle both the object `{ version: "==x" }` shape and a plain
      // `"==x"` version-spec string; both are valid Pipfile.lock encodings.
      const version = pipfilePinnedVersion(rawEntry);
      if (version === null) continue; // VCS/local/range → no pinned version
      const name = normalizePypiName(rawName);
      if (!name || !looksLikeVersion(version)) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ecosystem: 'pip', name, version, manifestPath });
    }
  }

  return out;
}

/** Python lockfile parsers for the scanner's parser list (PyPI ecosystem). */
export const pipLockfileParsers: readonly LockfileParser[] = [
  { ecosystem: 'pip', filenames: ['requirements.txt'], parse: parseRequirementsTxt },
  { ecosystem: 'pip', filenames: ['poetry.lock'], parse: parsePoetryLock },
  { ecosystem: 'pip', filenames: ['pipfile.lock'], parse: parsePipfileLock },
];
