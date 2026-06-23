import '../test/setup.js';
import { describe, it, expect, vi } from 'vitest';
import { bumpBranchName, openSecurityBumpPrs, type OpenSecurityBumpPrsDeps } from './auto-pr.js';
import type { SecurityBumpPlan } from './bump.js';
import type { Advisory, DependencyFinding, ResolvedDependency } from './types.js';

function finding(d: Partial<ResolvedDependency>, a: Partial<Advisory> = {}): DependencyFinding {
  return {
    dependency: {
      ecosystem: 'npm',
      name: 'lodash',
      version: '4.17.11',
      manifestPath: 'package-lock.json',
      ...d,
    },
    advisory: {
      id: 'GHSA-aaaa',
      summary: 'Prototype pollution',
      severity: 'high',
      aliases: [],
      fixedVersion: '4.17.21',
      url: 'https://example.test/GHSA-aaaa',
      ...a,
    },
  };
}

const LOCK = JSON.stringify(
  {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/lodash': { version: '4.17.11', integrity: 'sha512-OLD' },
    },
  },
  null,
  2,
);

const PKG = JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.17.11' } }, null, 2);

/** Like LOCK but the lodash entry carries a public-npm `resolved` URL, so the
 *  registry can be derived and enrichment is eligible. */
const LOCK_PINNED = JSON.stringify(
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
    },
  },
  null,
  2,
);

/** Lodash pinned to a PRIVATE registry mirror — enrichment must query THAT
 *  registry, never rewrite provenance to the public npm one. */
const LOCK_PRIVATE = JSON.stringify(
  {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/lodash': {
        version: '4.17.11',
        resolved: 'https://npm.internal.example/lodash/-/lodash-4.17.11.tgz',
        integrity: 'sha512-OLD',
      },
    },
  },
  null,
  2,
);

interface Harness {
  deps: OpenSecurityBumpPrsDeps;
  readFile: ReturnType<typeof vi.fn>;
  commitFiles: ReturnType<typeof vi.fn>;
  createOrGetOpenPr: ReturnType<typeof vi.fn>;
}

function harness(files: Record<string, string | null>): Harness {
  const readFile = vi.fn(async (p: string) => (p in files ? files[p] : null));
  const commitFiles = vi.fn(async () => ({ headSha: 'deadbeef', created: true }));
  const createOrGetOpenPr = vi.fn(
    (args: { headBranch: string; headSha: string; title: string; body: string }) => ({
      prNumber: 7,
      prUrl: `/projects/p/pulls/7`,
      prCreated: true,
      _args: args,
    }),
  );
  return {
    deps: { readFile, commitFiles, createOrGetOpenPr },
    readFile,
    commitFiles,
    createOrGetOpenPr,
  };
}

function plan(over: Partial<SecurityBumpPlan>): SecurityBumpPlan {
  return {
    manifestPath: 'package-lock.json',
    packageName: 'lodash',
    fromVersions: ['4.17.11'],
    toVersion: '4.17.21',
    advisoryIds: [],
    severity: 'high',
    advisories: [],
    ...over,
  };
}

describe('bumpBranchName', () => {
  it('is a readable slug + a stable raw-tuple hash suffix', () => {
    expect(plan({})).toBeDefined();
    expect(bumpBranchName(plan({}))).toMatch(
      /^agenthub\/security\/bump-lodash-4\.17\.21-[0-9a-f]{12}$/,
    );
    expect(bumpBranchName(plan({ packageName: '@scope/pkg', toVersion: '1.2.3' }))).toMatch(
      /^agenthub\/security\/bump-scope-pkg-1\.2\.3-[0-9a-f]{12}$/,
    );
    // folds in the manifest directory for monorepos
    expect(bumpBranchName(plan({ manifestPath: 'client/package-lock.json' }))).toMatch(
      /^agenthub\/security\/bump-client-lodash-4\.17\.21-[0-9a-f]{12}$/,
    );
  });

  it('is deterministic for the same tuple', () => {
    expect(bumpBranchName(plan({}))).toBe(bumpBranchName(plan({})));
    // fromVersions / advisories do not affect the branch (same target → same branch)
    expect(bumpBranchName(plan({ fromVersions: ['4.16.0', '4.17.11'] }))).toBe(
      bumpBranchName(plan({ fromVersions: ['4.17.11'] })),
    );
  });

  it('is collision-safe across tuples that slug identically (the reviewer case)', () => {
    // `@scope/pkg` and `scope-pkg` both slug to `scope-pkg` — the raw-tuple hash
    // keeps their branches distinct so the later commit cannot overwrite the
    // earlier one on a shared branch.
    const a = bumpBranchName(plan({ packageName: '@scope/pkg' }));
    const b = bumpBranchName(plan({ packageName: 'scope-pkg' }));
    expect(a).not.toBe(b);
    // distinct manifests that share a normalised dir also stay distinct
    const c = bumpBranchName(plan({ manifestPath: 'a.b/package-lock.json' }));
    const d = bumpBranchName(plan({ manifestPath: 'a-b/package-lock.json' }));
    expect(c).not.toBe(d);
    // distinct target versions stay distinct
    expect(bumpBranchName(plan({ toVersion: '4.17.21' }))).not.toBe(
      bumpBranchName(plan({ toVersion: '4.17.22' })),
    );
  });
});

describe('openSecurityBumpPrs', () => {
  it('opens one PR per fixable advisory, bumping lockfile + package.json', async () => {
    const h = harness({ 'package-lock.json': LOCK, 'package.json': PKG });
    const res = await openSecurityBumpPrs([finding({})], h.deps);

    expect(res.skipped).toEqual([]);
    expect(res.opened).toHaveLength(1);
    const [opened] = res.opened;
    expect(opened.branch).toMatch(/^agenthub\/security\/bump-lodash-4\.17\.21-[0-9a-f]{12}$/);
    expect(opened.prNumber).toBe(7);
    expect(opened.toVersion).toBe('4.17.21');

    // commit carried BOTH the bumped lockfile and package.json
    const commitArg = h.commitFiles.mock.calls[0][0];
    expect(Object.keys(commitArg.files).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(
      JSON.parse(commitArg.files['package-lock.json']).packages['node_modules/lodash'].version,
    ).toBe('4.17.21');
    expect(JSON.parse(commitArg.files['package.json']).dependencies.lodash).toBe('^4.17.21');

    // PR body references the advisory
    const prArg = h.createOrGetOpenPr.mock.calls[0][0];
    expect(prArg.title).toContain('bump lodash to 4.17.21');
    expect(prArg.body).toContain('GHSA-aaaa');
  });

  it('re-pins the lockfile from fetched dist metadata and drops the reconcile note', async () => {
    const h = harness({ 'package-lock.json': LOCK_PINNED, 'package.json': PKG });
    const fetchDistMetadata = vi.fn(async (_n: string, _v: string, _r: string) => ({
      resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-NEW',
    }));
    const res = await openSecurityBumpPrs([finding({})], { ...h.deps, fetchDistMetadata });

    expect(res.opened).toHaveLength(1);
    // fetched once for (package, target version, derived registry base)
    expect(fetchDistMetadata.mock.calls).toEqual([
      ['lodash', '4.17.21', 'https://registry.npmjs.org'],
    ]);

    // the committed lockfile entry is fully pinned, not stripped
    const entry = JSON.parse(h.commitFiles.mock.calls[0][0].files['package-lock.json']).packages[
      'node_modules/lodash'
    ];
    expect(entry.version).toBe('4.17.21');
    expect(entry.resolved).toBe('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz');
    expect(entry.integrity).toBe('sha512-NEW');

    // PR body advertises the pinned lockfile and omits the npm-install reconcile note
    const body = h.createOrGetOpenPr.mock.calls[0][0].body;
    expect(body).toContain('re-pinned');
    expect(body).not.toContain('npm install');
  });

  it('queries the private registry the lockfile is pinned to, preserving provenance', async () => {
    const h = harness({ 'package-lock.json': LOCK_PRIVATE, 'package.json': PKG });
    // The private registry returns a tarball on its OWN host.
    const fetchDistMetadata = vi.fn(async (_n: string, _v: string, _r: string) => ({
      resolved: 'https://npm.internal.example/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-PRIV',
    }));
    await openSecurityBumpPrs([finding({})], { ...h.deps, fetchDistMetadata });

    // queried the SAME registry the lockfile already used, not public npm
    expect(fetchDistMetadata.mock.calls).toEqual([
      ['lodash', '4.17.21', 'https://npm.internal.example'],
    ]);
    const entry = JSON.parse(h.commitFiles.mock.calls[0][0].files['package-lock.json']).packages[
      'node_modules/lodash'
    ];
    expect(entry.resolved).toBe('https://npm.internal.example/lodash/-/lodash-4.17.21.tgz');
    expect(entry.integrity).toBe('sha512-PRIV');
  });

  it('skips enrichment (drops fields) when no registry can be derived from the lockfile', async () => {
    // LOCK has no `resolved` on the lodash entry → registry undeterminable.
    const h = harness({ 'package-lock.json': LOCK, 'package.json': PKG });
    const fetchDistMetadata = vi.fn(async (_n: string, _v: string, _r: string) => ({
      resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-NEW',
    }));
    const res = await openSecurityBumpPrs([finding({})], { ...h.deps, fetchDistMetadata });

    expect(res.opened).toHaveLength(1);
    expect(fetchDistMetadata).not.toHaveBeenCalled(); // never guessed a registry
    const entry = JSON.parse(h.commitFiles.mock.calls[0][0].files['package-lock.json']).packages[
      'node_modules/lodash'
    ];
    expect(entry.version).toBe('4.17.21');
    expect(entry.resolved).toBeUndefined();
    expect(entry.integrity).toBeUndefined();
    expect(h.createOrGetOpenPr.mock.calls[0][0].body).toContain('npm install');
  });

  it('falls back to dropping resolved/integrity when the dist fetch returns null', async () => {
    const h = harness({ 'package-lock.json': LOCK_PINNED, 'package.json': PKG });
    const fetchDistMetadata = vi.fn(async (_n: string, _v: string, _r: string) => null);
    const res = await openSecurityBumpPrs([finding({})], { ...h.deps, fetchDistMetadata });

    expect(res.opened).toHaveLength(1);
    expect(fetchDistMetadata).toHaveBeenCalledTimes(1); // registry derivable, fetch attempted
    const entry = JSON.parse(h.commitFiles.mock.calls[0][0].files['package-lock.json']).packages[
      'node_modules/lodash'
    ];
    expect(entry.version).toBe('4.17.21');
    expect(entry.integrity).toBeUndefined();
    expect(h.createOrGetOpenPr.mock.calls[0][0].body).toContain('npm install');
  });

  it('treats a thrown dist fetch as null and still opens the PR', async () => {
    const h = harness({ 'package-lock.json': LOCK_PINNED, 'package.json': PKG });
    const fetchDistMetadata = vi.fn(async (_n: string, _v: string, _r: string) => {
      throw new Error('network down');
    });
    const res = await openSecurityBumpPrs([finding({})], { ...h.deps, fetchDistMetadata });

    expect(res.skipped).toEqual([]);
    expect(res.opened).toHaveLength(1);
    expect(h.createOrGetOpenPr.mock.calls[0][0].body).toContain('npm install');
  });

  it('bumps every vulnerable installed version of a package in ONE PR (no overwrite)', async () => {
    // lodash is installed twice: top-level 4.17.11 (direct) and a transitive
    // 4.16.0 under foo — both vulnerable, both fixed by 4.17.21. They must land
    // in a SINGLE PR with BOTH lockfile entries bumped (the earlier bug left one
    // unbumped because both plans shared the same branch).
    const multiLock = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0', dependencies: { lodash: '^4.17.11' } },
          'node_modules/lodash': { version: '4.17.11' },
          'node_modules/foo/node_modules/lodash': { version: '4.16.0' },
        },
      },
      null,
      2,
    );
    const h = harness({ 'package-lock.json': multiLock });
    const res = await openSecurityBumpPrs(
      [finding({ version: '4.17.11' }), finding({ version: '4.16.0' })],
      h.deps,
    );

    expect(res.opened).toHaveLength(1);
    expect(res.opened[0].fromVersions).toEqual(['4.16.0', '4.17.11']);
    expect(res.opened[0].toVersion).toBe('4.17.21');
    expect(h.createOrGetOpenPr).toHaveBeenCalledTimes(1); // one branch/PR, not two

    // BOTH installed copies bumped in the single committed lockfile.
    const committed = JSON.parse(h.commitFiles.mock.calls[0][0].files['package-lock.json']);
    expect(committed.packages['node_modules/lodash'].version).toBe('4.17.21');
    expect(committed.packages['node_modules/foo/node_modules/lodash'].version).toBe('4.17.21');
    // Top-level copy is a direct dep → root range synced too.
    expect(committed.packages[''].dependencies.lodash).toBe('^4.17.21');
    expect(h.createOrGetOpenPr.mock.calls[0][0].body).toContain('2 installed versions');
  });

  it('does NOT touch package.json for a transitive (nested) bump', async () => {
    // Vulnerable lodash@4.17.11 is nested under foo; the root package.json
    // declares an unrelated direct lodash@^4.18.0. The bump must update only the
    // lockfile's transitive entry and leave package.json alone.
    const transitiveLock = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0', dependencies: { lodash: '^4.18.0' } },
          'node_modules/lodash': { version: '4.18.5' },
          'node_modules/foo/node_modules/lodash': { version: '4.17.11' },
        },
      },
      null,
      2,
    );
    const rootPkg = JSON.stringify(
      { name: 'fixture', dependencies: { lodash: '^4.18.0' } },
      null,
      2,
    );
    const h = harness({ 'package-lock.json': transitiveLock, 'package.json': rootPkg });
    const res = await openSecurityBumpPrs([finding({})], h.deps);

    expect(res.opened).toHaveLength(1);
    // Only the lockfile is committed — package.json is left untouched.
    expect(Object.keys(h.commitFiles.mock.calls[0][0].files)).toEqual(['package-lock.json']);
    const committedLock = JSON.parse(h.commitFiles.mock.calls[0][0].files['package-lock.json']);
    expect(committedLock.packages['node_modules/foo/node_modules/lodash'].version).toBe('4.17.21');
    expect(committedLock.packages[''].dependencies.lodash).toBe('^4.18.0'); // root range intact
    // package.json never even read for the bump (rootDependencyBumped === false)
    expect(h.readFile).not.toHaveBeenCalledWith('package.json');
    expect(h.createOrGetOpenPr.mock.calls[0][0].body).toContain('Transitive dependency');
  });

  it('still opens a lockfile-only PR when there is no package.json to change', async () => {
    const h = harness({ 'package-lock.json': LOCK }); // no package.json
    const res = await openSecurityBumpPrs([finding({})], h.deps);
    expect(res.opened).toHaveLength(1);
    expect(Object.keys(h.commitFiles.mock.calls[0][0].files)).toEqual(['package-lock.json']);
    expect(h.createOrGetOpenPr.mock.calls[0][0].body).toContain('no matching `package.json` range');
  });

  it('skips with lockfile_missing when the lockfile cannot be read', async () => {
    const h = harness({});
    const res = await openSecurityBumpPrs([finding({})], h.deps);
    expect(res.opened).toEqual([]);
    expect(res.skipped).toEqual([
      {
        manifestPath: 'package-lock.json',
        packageName: 'lodash',
        toVersion: '4.17.21',
        reason: 'lockfile_missing',
      },
    ]);
    expect(h.commitFiles).not.toHaveBeenCalled();
    expect(h.createOrGetOpenPr).not.toHaveBeenCalled();
  });

  it('skips with lockfile_unchanged when the entry is already bumped/absent', async () => {
    const alreadyBumped = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.21' } },
    });
    const h = harness({ 'package-lock.json': alreadyBumped });
    const res = await openSecurityBumpPrs([finding({})], h.deps);
    expect(res.opened).toEqual([]);
    expect(res.skipped[0].reason).toBe('lockfile_unchanged');
    expect(h.createOrGetOpenPr).not.toHaveBeenCalled();
  });

  it('isolates failures: one bad bump is recorded in skipped, others still open', async () => {
    const h = harness({
      'package-lock.json': LOCK,
      'client/package-lock.json': LOCK,
    });
    // commit throws only for the client manifest's branch
    h.commitFiles.mockImplementation(async (args: { branch: string }) => {
      if (args.branch.includes('client')) throw new Error('git boom');
      return { headSha: 'deadbeef', created: true };
    });
    const res = await openSecurityBumpPrs(
      [
        finding({ manifestPath: 'package-lock.json' }),
        finding({ manifestPath: 'client/package-lock.json' }),
      ],
      h.deps,
    );
    expect(res.opened.map((o) => o.manifestPath)).toEqual(['package-lock.json']);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({
      manifestPath: 'client/package-lock.json',
      reason: 'error',
      detail: 'git boom',
    });
  });

  it('collapses multiple advisories on one package into a single PR at the max fix', async () => {
    const h = harness({ 'package-lock.json': LOCK });
    const res = await openSecurityBumpPrs(
      [
        finding({}, { id: 'GHSA-bbbb', fixedVersion: '4.17.15' }),
        finding({}, { id: 'GHSA-aaaa', fixedVersion: '4.17.21' }),
      ],
      h.deps,
    );
    expect(res.opened).toHaveLength(1);
    expect(res.opened[0].toVersion).toBe('4.17.21');
    expect(res.opened[0].advisoryIds).toEqual(['GHSA-aaaa', 'GHSA-bbbb']);
    expect(h.createOrGetOpenPr).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there are no fixable findings', async () => {
    const h = harness({ 'package-lock.json': LOCK });
    const res = await openSecurityBumpPrs([finding({}, { fixedVersion: null })], h.deps);
    expect(res).toEqual({ opened: [], skipped: [] });
    expect(h.readFile).not.toHaveBeenCalled();
  });
});
