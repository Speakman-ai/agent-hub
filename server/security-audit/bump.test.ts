import '../test/setup.js';
import { describe, it, expect } from 'vitest';
import {
  applyNpmLockfileBump,
  applyPackageJsonRangeBump,
  bumpRange,
  detectJsonIndent,
  planSecurityBumps,
} from './bump.js';
import type { Advisory, DependencyFinding, ResolvedDependency, Severity } from './types.js';

function dep(over: Partial<ResolvedDependency> = {}): ResolvedDependency {
  return {
    ecosystem: 'npm',
    name: 'lodash',
    version: '4.17.11',
    manifestPath: 'package-lock.json',
    ...over,
  };
}

function adv(over: Partial<Advisory> = {}): Advisory {
  return {
    id: 'GHSA-aaaa',
    summary: 'Prototype pollution',
    severity: 'high',
    aliases: [],
    fixedVersion: '4.17.21',
    url: 'https://example.test/GHSA-aaaa',
    ...over,
  };
}

function finding(d: Partial<ResolvedDependency>, a: Partial<Advisory>): DependencyFinding {
  return { dependency: dep(d), advisory: adv(a) };
}

describe('planSecurityBumps', () => {
  it('groups multiple advisories on the same package@version into one bump at the MAX fixed version', () => {
    const plans = planSecurityBumps([
      finding({}, { id: 'GHSA-bbbb', fixedVersion: '4.17.19', severity: 'medium' }),
      finding({}, { id: 'GHSA-aaaa', fixedVersion: '4.17.21', severity: 'critical' }),
    ]);
    expect(plans).toHaveLength(1);
    const [p] = plans;
    expect(p.packageName).toBe('lodash');
    expect(p.fromVersions).toEqual(['4.17.11']);
    expect(p.toVersion).toBe('4.17.21'); // max of the two fixed versions
    expect(p.advisoryIds).toEqual(['GHSA-aaaa', 'GHSA-bbbb']); // sorted, de-duped
    expect(p.severity).toBe('critical'); // worst severity wins
  });

  it('excludes findings with no published fix', () => {
    expect(planSecurityBumps([finding({}, { fixedVersion: null })])).toEqual([]);
  });

  it('excludes a fix that is not strictly ahead of the installed version', () => {
    expect(
      planSecurityBumps([finding({ version: '4.17.21' }, { fixedVersion: '4.17.21' })]),
    ).toEqual([]);
    expect(planSecurityBumps([finding({ version: '5.0.0' }, { fixedVersion: '4.17.21' })])).toEqual(
      [],
    );
  });

  it('excludes findings with unparseable versions', () => {
    expect(
      planSecurityBumps([finding({ version: 'latest' }, { fixedVersion: '4.17.21' })]),
    ).toEqual([]);
    expect(planSecurityBumps([finding({}, { fixedVersion: 'next' })])).toEqual([]);
  });

  it('keeps the same package in different manifests as separate plans', () => {
    const plans = planSecurityBumps([
      finding({ manifestPath: 'package-lock.json' }, {}),
      finding({ manifestPath: 'client/package-lock.json' }, {}),
    ]);
    expect(plans.map((p) => p.manifestPath)).toEqual([
      'client/package-lock.json',
      'package-lock.json',
    ]);
  });

  it('merges the same package at different installed versions into ONE plan (all fromVersions)', () => {
    // Two vulnerable installed copies of lodash → a single plan/branch/PR that
    // bumps BOTH to the one fixed version, so neither commit overwrites the
    // other on the shared deterministic branch.
    const plans = planSecurityBumps([
      finding({ version: '4.17.11' }, { fixedVersion: '4.17.21' }),
      finding({ version: '4.16.0' }, { fixedVersion: '4.17.21' }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].fromVersions).toEqual(['4.16.0', '4.17.11']); // sorted ascending
    expect(plans[0].toVersion).toBe('4.17.21');
  });

  it('picks the MAX fixed version across all installed copies as the single target', () => {
    // lodash@4.16.0 fixed in 4.16.5, lodash@4.17.11 fixed in 4.17.21 → bump both
    // to the max (4.17.21), which resolves every advisory for every copy.
    const plans = planSecurityBumps([
      finding({ version: '4.16.0' }, { id: 'GHSA-a', fixedVersion: '4.16.5' }),
      finding({ version: '4.17.11' }, { id: 'GHSA-b', fixedVersion: '4.17.21' }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].fromVersions).toEqual(['4.16.0', '4.17.11']);
    expect(plans[0].toVersion).toBe('4.17.21');
    expect(plans[0].advisoryIds).toEqual(['GHSA-a', 'GHSA-b']);
  });
});

describe('applyNpmLockfileBump', () => {
  it('bumps a lockfileVersion-3 packages-map entry and drops stale resolved/integrity', () => {
    const lock = JSON.stringify(
      {
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/lodash': {
            version: '4.17.11',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.11.tgz',
            integrity: 'sha512-OLD',
          },
          'node_modules/express': { version: '4.18.2' },
        },
      },
      null,
      2,
    );
    const out = applyNpmLockfileBump(lock, {
      packageName: 'lodash',
      fromVersion: '4.17.11',
      toVersion: '4.17.21',
    });
    expect(out).not.toBeNull();
    expect(out!.rootDependencyBumped).toBe(true); // node_modules/lodash is top-level
    const parsed = JSON.parse(out!.content);
    expect(parsed.packages['node_modules/lodash'].version).toBe('4.17.21');
    expect(parsed.packages['node_modules/lodash'].resolved).toBeUndefined();
    expect(parsed.packages['node_modules/lodash'].integrity).toBeUndefined();
    // unrelated package untouched
    expect(parsed.packages['node_modules/express'].version).toBe('4.18.2');
  });

  it('bumps an aliased install under its real registry name, not the path alias', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/safe-alias': { name: 'lodash', version: '4.17.11' },
      },
    });
    const out = applyNpmLockfileBump(lock, {
      packageName: 'lodash',
      fromVersion: '4.17.11',
      toVersion: '4.17.21',
    });
    expect(JSON.parse(out!.content).packages['node_modules/safe-alias'].version).toBe('4.17.21');
  });

  it('bumps a lockfileVersion-1 nested dependencies tree', () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: {
          version: '1.0.0',
          dependencies: {
            lodash: {
              version: '4.17.11',
              resolved: 'https://x/lodash.tgz',
              integrity: 'sha512-OLD',
            },
          },
        },
      },
    });
    const out = applyNpmLockfileBump(lock, {
      packageName: 'lodash',
      fromVersion: '4.17.11',
      toVersion: '4.17.21',
    });
    const parsed = JSON.parse(out!.content);
    expect(parsed.dependencies.a.dependencies.lodash.version).toBe('4.17.21');
    expect(parsed.dependencies.a.dependencies.lodash.resolved).toBeUndefined();
    // lodash here is nested under `a` → transitive, not the root direct dep.
    expect(out!.rootDependencyBumped).toBe(false);
  });

  it('syncs the root packages[""] range mirror with the bumped version (v2/v3)', () => {
    // npm mirrors the root package.json ranges into packages[""]. Bumping the
    // install entry WITHOUT this would leave packages[""].dependencies on the
    // old range — an npm ci mismatch vs the bumped package.json.
    const lock = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'fixture',
            version: '1.0.0',
            dependencies: { lodash: '^4.17.11', express: '~4.18.0' },
            devDependencies: { jest: '29.0.0' },
          },
          'node_modules/lodash': { version: '4.17.11' },
        },
      },
      null,
      2,
    );
    const out = applyNpmLockfileBump(lock, {
      packageName: 'lodash',
      fromVersion: '4.17.11',
      toVersion: '4.17.21',
    });
    expect(out!.rootDependencyBumped).toBe(true);
    const parsed = JSON.parse(out!.content);
    expect(parsed.packages[''].dependencies.lodash).toBe('^4.17.21'); // synced
    expect(parsed.packages[''].dependencies.express).toBe('~4.18.0'); // untouched
    expect(parsed.packages[''].devDependencies.jest).toBe('29.0.0'); // untouched
    expect(parsed.packages['node_modules/lodash'].version).toBe('4.17.21');
  });

  it('does NOT rewrite the root range for a transitive/nested bump (v2/v3)', () => {
    // The vulnerable lodash@4.17.11 is nested under foo; the root declares an
    // UNRELATED direct lodash@^4.18.0 (resolved top-level to 4.18.5, not vuln).
    // Bumping the transitive copy must leave the root range + the top-level
    // install entry untouched.
    const lock = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0', dependencies: { lodash: '^4.18.0' } },
          'node_modules/lodash': { version: '4.18.5' },
          'node_modules/foo': { version: '1.0.0' },
          'node_modules/foo/node_modules/lodash': { version: '4.17.11' },
        },
      },
      null,
      2,
    );
    const out = applyNpmLockfileBump(lock, {
      packageName: 'lodash',
      fromVersion: '4.17.11',
      toVersion: '4.17.21',
    });
    expect(out!.rootDependencyBumped).toBe(false);
    const parsed = JSON.parse(out!.content);
    // transitive entry bumped...
    expect(parsed.packages['node_modules/foo/node_modules/lodash'].version).toBe('4.17.21');
    // ...but the top-level install + the root range are untouched.
    expect(parsed.packages['node_modules/lodash'].version).toBe('4.18.5');
    expect(parsed.packages[''].dependencies.lodash).toBe('^4.18.0');
  });

  it('does not move the root range when the installed version is absent (returns null)', () => {
    // A root range but no matching install entry → nothing to bump; must NOT
    // emit a lockfile whose range moved while the install tree did not.
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { lodash: '^4.17.11' } } },
    });
    expect(
      applyNpmLockfileBump(lock, {
        packageName: 'lodash',
        fromVersion: '4.17.11',
        toVersion: '4.17.21',
      }),
    ).toBeNull();
  });

  it('returns null when no entry matches the expected installed version (already bumped/absent)', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.21' } },
    });
    expect(
      applyNpmLockfileBump(lock, {
        packageName: 'lodash',
        fromVersion: '4.17.11',
        toVersion: '4.17.21',
      }),
    ).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    expect(
      applyNpmLockfileBump('{ not json', {
        packageName: 'lodash',
        fromVersion: '4.17.11',
        toVersion: '4.17.21',
      }),
    ).toBeNull();
  });

  it('preserves the original indentation and trailing newline', () => {
    const lock =
      JSON.stringify(
        { lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.11' } } },
        null,
        4,
      ) + '\n';
    const out = applyNpmLockfileBump(lock, {
      packageName: 'lodash',
      fromVersion: '4.17.11',
      toVersion: '4.17.21',
    });
    expect(out!.content.endsWith('\n')).toBe(true);
    expect(out!.content).toContain('\n    "lockfileVersion"'); // 4-space indent retained
  });
});

describe('bumpRange', () => {
  it('preserves the caret/tilde/gte operators', () => {
    expect(bumpRange('^4.17.11', '4.17.21')).toBe('^4.17.21');
    expect(bumpRange('~4.17.11', '4.17.21')).toBe('~4.17.21');
    expect(bumpRange('>=4.0.0', '4.17.21')).toBe('>=4.17.21');
  });
  it('rewrites a pinned exact version', () => {
    expect(bumpRange('4.17.11', '4.17.21')).toBe('4.17.21');
  });
  it('refuses ranges it cannot safely rewrite', () => {
    expect(bumpRange('*', '4.17.21')).toBeNull();
    expect(bumpRange('workspace:*', '4.17.21')).toBeNull();
    expect(bumpRange('file:../local', '4.17.21')).toBeNull();
    expect(bumpRange('1.x || 2.x', '4.17.21')).toBeNull();
  });
});

describe('applyPackageJsonRangeBump', () => {
  it('bumps the range across dependency sections, preserving the operator', () => {
    const pkg = JSON.stringify(
      {
        name: 'fixture',
        dependencies: { lodash: '^4.17.11', express: '~4.18.0' },
        devDependencies: { jest: '29.0.0' },
      },
      null,
      2,
    );
    const out = applyPackageJsonRangeBump(pkg, { packageName: 'lodash', toVersion: '4.17.21' });
    const parsed = JSON.parse(out as string);
    expect(parsed.dependencies.lodash).toBe('^4.17.21');
    expect(parsed.dependencies.express).toBe('~4.18.0'); // untouched
  });

  it('bumps a package declared in devDependencies', () => {
    const pkg = JSON.stringify({ devDependencies: { lodash: '4.17.11' } });
    const out = applyPackageJsonRangeBump(pkg, { packageName: 'lodash', toVersion: '4.17.21' });
    expect(JSON.parse(out as string).devDependencies.lodash).toBe('4.17.21');
  });

  it('returns null when the package is not declared', () => {
    const pkg = JSON.stringify({ dependencies: { express: '^4.18.0' } });
    expect(
      applyPackageJsonRangeBump(pkg, { packageName: 'lodash', toVersion: '4.17.21' }),
    ).toBeNull();
  });

  it('returns null when only an unbumpable range is present', () => {
    const pkg = JSON.stringify({ dependencies: { lodash: '*' } });
    expect(
      applyPackageJsonRangeBump(pkg, { packageName: 'lodash', toVersion: '4.17.21' }),
    ).toBeNull();
  });
});

describe('detectJsonIndent', () => {
  it('detects 2 vs 4 spaces and tabs, defaulting to 2', () => {
    expect(detectJsonIndent(JSON.stringify({ a: 1 }, null, 2))).toBe(2);
    expect(detectJsonIndent(JSON.stringify({ a: 1 }, null, 4))).toBe(4);
    expect(detectJsonIndent(JSON.stringify({ a: 1 }, null, '\t'))).toBe('\t');
    expect(detectJsonIndent('{"a":1}')).toBe(2);
  });
});

// Sanity: the Severity union covers every rank used by planSecurityBumps.
const ALL_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
describe('severity coverage', () => {
  it('picks the single advisory severity when only one', () => {
    for (const sev of ALL_SEVERITIES) {
      const [p] = planSecurityBumps([finding({}, { severity: sev })]);
      expect(p.severity).toBe(sev);
    }
  });
});
