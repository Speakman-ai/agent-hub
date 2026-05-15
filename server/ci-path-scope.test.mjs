import { describe, expect, it } from 'vitest';

import {
  DORNY_PATH_FILTER_KEYS,
  filterUncoveredPaths,
  isPathInCiPathFilterScope,
} from '../scripts/ci-path-scope.mjs';

describe('ci-path-scope', () => {
  it('matches workflow global exact paths', () => {
    expect(isPathInCiPathFilterScope('.github/workflows/ci.yml')).toBe(true);
    expect(isPathInCiPathFilterScope('package.json')).toBe(true);
    expect(isPathInCiPathFilterScope('server/package-lock.json')).toBe(true);
  });

  it('matches directory prefixes from the workflow map', () => {
    expect(isPathInCiPathFilterScope('server/index.ts')).toBe(true);
    expect(isPathInCiPathFilterScope('ops/terraform/main.tf')).toBe(true);
    expect(isPathInCiPathFilterScope('scripts/foo.mjs')).toBe(true);
    expect(isPathInCiPathFilterScope('e2e/smoke.spec.js')).toBe(true);
  });

  it('flags typical root and docs paths as out of scope', () => {
    expect(isPathInCiPathFilterScope('README.md')).toBe(false);
    expect(isPathInCiPathFilterScope('Dockerfile')).toBe(false);
    expect(isPathInCiPathFilterScope('docs/api/foo.md')).toBe(false);
    expect(isPathInCiPathFilterScope('CLAUDE.md')).toBe(false);
  });

  it('filterUncoveredPaths lists only out-of-scope paths', () => {
    expect(filterUncoveredPaths(['server/a.ts', 'README.md'])).toEqual(['README.md']);
    expect(filterUncoveredPaths(['client/x.ts'])).toEqual([]);
  });

  it('exports the dorny filter key list used by workflow YAML', () => {
    expect(DORNY_PATH_FILTER_KEYS).toEqual([
      'global',
      'server',
      'client',
      'electron',
      'mobile',
      'shared',
      'terraform',
      'scripts',
      'e2e',
    ]);
  });
});
