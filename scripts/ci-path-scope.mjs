/**
 * Single source of truth for which repo paths match `dorny/paths-filter` groups
 * in `.github/workflows/ci.yml` (`jobs.changes.steps.filter.with.filters`).
 *
 * If you add a filter group or glob in the workflow, update this module and run
 * `server/ci-path-scope.test.mjs` / `ci-path-plan.test.mjs`.
 */

/** @type {readonly string[]} */
export const DORNY_PATH_FILTER_KEYS = [
  'global',
  'server',
  'client',
  'electron',
  'mobile',
  'shared',
  'terraform',
  'scripts',
  'e2e',
];

const GLOBAL_EXACT = new Set([
  '.github/workflows/ci.yml',
  'eslint.config.js',
  '.prettierrc',
  '.prettierignore',
  'package.json',
  'package-lock.json',
  'server/package.json',
  'server/package-lock.json',
  'client/package.json',
  'client/package-lock.json',
  'mobile/package.json',
  'mobile/package-lock.json',
]);

const DIR_PREFIXES = [
  'server/',
  'client/',
  'electron/',
  'mobile/',
  'shared/',
  'ops/terraform/',
  'scripts/',
  'e2e/',
];

/**
 * Mirrors one changed-file path against the workflow's paths-filter `filters`
 * (same semantics as `dorny/paths-filter@v3` for this repo's YAML map).
 *
 * @param {string} relPath
 */
export function isPathInCiPathFilterScope(relPath) {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (GLOBAL_EXACT.has(p)) {
    return true;
  }
  for (const pre of DIR_PREFIXES) {
    const dir = pre.endsWith('/') ? pre.slice(0, -1) : pre;
    if (p === dir || p.startsWith(pre)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string[]} files
 * @returns {string[]} paths not matched by any `filters:` group
 */
export function filterUncoveredPaths(files) {
  /** @type {string[]} */
  const out = [];
  for (const f of files) {
    if (!f) {
      continue;
    }
    if (!isPathInCiPathFilterScope(f)) {
      out.push(f);
    }
  }
  return out;
}
