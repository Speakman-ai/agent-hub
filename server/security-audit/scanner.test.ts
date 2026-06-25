import { describe, it, expect, vi } from 'vitest';
import { scanResolvedDependencies, type RepoFileReader } from './scanner.js';
import type { AdvisorySource, DependencyFinding, ResolvedDependency } from './types.js';

function fakeReader(files: Record<string, string>): RepoFileReader {
  return {
    async listFiles() {
      return Object.keys(files);
    },
    async readFile(_ref, filePath) {
      return files[filePath] ?? null;
    },
  };
}

const npmLock = (deps: Record<string, string>): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(deps).map(([name, version]) => [`node_modules/${name}`, { version }]),
    ),
  });

class CapturingSource implements AdvisorySource {
  seen: ResolvedDependency[] = [];
  constructor(private readonly findings: (deps: ResolvedDependency[]) => DependencyFinding[]) {}
  async query(deps: ResolvedDependency[]): Promise<DependencyFinding[]> {
    this.seen = deps;
    return this.findings(deps);
  }
}

describe('scanResolvedDependencies', () => {
  it('finds lockfiles, resolves + dedupes deps, and queries the source once', async () => {
    const reader = fakeReader({
      'package-lock.json': npmLock({ lodash: '4.17.20' }),
      'packages/api/package-lock.json': npmLock({ lodash: '4.17.20', express: '4.18.2' }),
      'README.md': '# not a lockfile',
    });
    const source = new CapturingSource(() => []);
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });

    // lodash@4.17.20 dedup across both lockfiles → 2 distinct deps.
    expect(result.dependencyCount).toBe(2);
    expect(result.scannedManifests.sort()).toEqual([
      'package-lock.json',
      'packages/api/package-lock.json',
    ]);
    expect(source.seen.map((d) => `${d.name}@${d.version}`).sort()).toEqual([
      'express@4.18.2',
      'lodash@4.17.20',
    ]);
  });

  it('sorts findings worst-severity first', async () => {
    const reader = fakeReader({ 'package-lock.json': npmLock({ a: '1.0.0', b: '1.0.0' }) });
    const source = new CapturingSource((deps) =>
      deps.map((d, i) => ({
        dependency: d,
        advisory: {
          id: `ADV-${i}`,
          summary: 's',
          severity: d.name === 'a' ? 'low' : 'critical',
          aliases: [],
          fixedVersion: null,
          url: '',
        },
      })),
    );
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });
    expect(result.findings.map((f) => f.advisory.severity)).toEqual(['critical', 'low']);
  });

  it('does not query the source when there are no lockfiles', async () => {
    const reader = fakeReader({ 'README.md': '# hi' });
    const source = new CapturingSource(() => []);
    const spy = vi.spyOn(source, 'query');
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });
    expect(result.dependencyCount).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('records a CORRUPT lockfile as failed (not scanned) so its findings are preserved', async () => {
    const reader = fakeReader({ 'package-lock.json': '{bad json' });
    const source = new CapturingSource(() => []);
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });
    // Parse failure → excluded from the sweep scope, surfaced as failed. But it
    // EXISTS, so it's in presentManifests (preserves its findings, not deleted).
    expect(result.scannedManifests).toEqual([]);
    expect(result.failedManifests).toEqual(['package-lock.json']);
    expect(result.presentManifests).toEqual(['package-lock.json']);
    expect(result.dependencyCount).toBe(0);
  });

  it('records an unreadable lockfile (null content) as failed, not scanned', async () => {
    const reader: RepoFileReader = {
      async listFiles() {
        return ['package-lock.json'];
      },
      async readFile() {
        return null; // listed but unreadable
      },
    };
    const source = new CapturingSource(() => []);
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });
    expect(result.scannedManifests).toEqual([]);
    expect(result.failedManifests).toEqual(['package-lock.json']);
  });

  it('counts a VALID but empty lockfile as scanned (eligible for the fixed sweep)', async () => {
    const reader = fakeReader({
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
    });
    const source = new CapturingSource(() => []);
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });
    // Parsed fine, just no deps → it WAS scanned, so its findings can be cleared.
    expect(result.scannedManifests).toEqual(['package-lock.json']);
    expect(result.failedManifests).toEqual([]);
    expect(result.dependencyCount).toBe(0);
  });

  it('truncates beyond the cap deterministically and flags it', async () => {
    // 150 lockfiles, each with one dep. Only the first 100 (sorted) are scanned.
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i++) {
      const n = String(i).padStart(3, '0');
      files[`pkg-${n}/package-lock.json`] = npmLock({ [`dep${n}`]: '1.0.0' });
    }
    const source = new CapturingSource(() => []);
    const result = await scanResolvedDependencies({
      reader: fakeReader(files),
      ref: 'main',
      advisorySource: source,
    });
    expect(result.truncated).toBe(true);
    expect(result.scannedManifests).toHaveLength(100);
    // Deterministic prefix: sorted, so pkg-000 in and pkg-149 out.
    expect(result.scannedManifests).toContain('pkg-000/package-lock.json');
    expect(result.scannedManifests).not.toContain('pkg-149/package-lock.json');
    // All 150 EXIST → presentManifests covers the truncated overflow too, so the
    // sweep preserves (never deletes) findings on un-scanned-but-present manifests.
    expect(result.presentManifests).toHaveLength(150);
    expect(result.presentManifests).toContain('pkg-149/package-lock.json');
  });

  it('attributes a shared vulnerable package@version to EVERY manifest (no first-wins drop)', async () => {
    // lodash@4.17.20 is vulnerable and present in two lockfiles. The OSV query
    // is deduped to one, but the finding must expand to both manifests.
    const reader = fakeReader({
      'package-lock.json': npmLock({ lodash: '4.17.20' }),
      'packages/api/package-lock.json': npmLock({ lodash: '4.17.20' }),
    });
    const source = new CapturingSource((deps) =>
      deps.map((d) => ({
        dependency: d,
        advisory: {
          id: 'GHSA-lodash',
          summary: 'vuln',
          severity: 'high',
          aliases: [],
          fixedVersion: '4.17.21',
          url: '',
        },
      })),
    );
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });

    // Queried once (deduped), but reported for both manifests.
    expect(source.seen).toHaveLength(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.dependency.manifestPath).sort()).toEqual([
      'package-lock.json',
      'packages/api/package-lock.json',
    ]);
    expect(result.findings.every((f) => f.advisory.id === 'GHSA-lodash')).toBe(true);
  });

  it('discovers Python lockfiles (requirements.txt + poetry.lock) and surfaces pip findings', async () => {
    const reader = fakeReader({
      'requirements.txt': 'Django==3.2.0\nrequests==2.25.1\n',
      'svc/poetry.lock': '[[package]]\nname = "Jinja2"\nversion = "2.11.3"\n',
      'package-lock.json': npmLock({ lodash: '4.17.20' }),
    });
    // Flag django (pip) and lodash (npm) as vulnerable to prove the scanner
    // routes BOTH ecosystems through one advisory source.
    const source = new CapturingSource((deps) =>
      deps
        .filter((d) => d.name === 'django' || d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: d.name === 'django' ? 'PYSEC-2021-1' : 'GHSA-lodash',
            summary: 'vuln',
            severity: 'high' as const,
            aliases: [],
            fixedVersion: null,
            url: '',
          },
        })),
    );
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });

    // All three lockfiles parsed → all three in the fixed-sweep scope.
    expect(result.scannedManifests.sort()).toEqual([
      'package-lock.json',
      'requirements.txt',
      'svc/poetry.lock',
    ]);
    // pip deps carry the pip ecosystem with PEP 503-normalized names.
    expect(source.seen.map((d) => `${d.ecosystem}:${d.name}@${d.version}`).sort()).toEqual([
      'npm:lodash@4.17.20',
      'pip:django@3.2.0',
      'pip:jinja2@2.11.3',
      'pip:requests@2.25.1',
    ]);
    expect(result.findings.map((f) => `${f.dependency.ecosystem}:${f.advisory.id}`).sort()).toEqual(
      ['npm:GHSA-lodash', 'pip:PYSEC-2021-1'],
    );
  });

  it('discovers requirements filename variants and surfaces pip findings', async () => {
    const reader = fakeReader({
      'backend/opensign/requirements-base.txt': 'Django==4.2.30\nrequests==2.25.1\n',
      'backend/opensign/requirements-docker.txt': 'gunicorn==22.0.0\n',
    });
    const source = new CapturingSource((deps) =>
      deps
        .filter((d) => d.name === 'django')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'PYSEC-django',
            summary: 'vuln',
            severity: 'high' as const,
            aliases: [],
            fixedVersion: null,
            url: '',
          },
        })),
    );
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });

    expect(result.scannedManifests.sort()).toEqual([
      'backend/opensign/requirements-base.txt',
      'backend/opensign/requirements-docker.txt',
    ]);
    expect(source.seen.map((d) => `${d.ecosystem}:${d.name}@${d.version}`).sort()).toEqual([
      'pip:django@4.2.30',
      'pip:gunicorn@22.0.0',
      'pip:requests@2.25.1',
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.dependency).toMatchObject({
      ecosystem: 'pip',
      name: 'django',
      version: '4.2.30',
      manifestPath: 'backend/opensign/requirements-base.txt',
    });
  });

  it('records a corrupt poetry.lock (no [[package]] blocks) as failed, preserving findings', async () => {
    const reader = fakeReader({ 'poetry.lock': '# truncated, no packages\n' });
    const source = new CapturingSource(() => []);
    const result = await scanResolvedDependencies({ reader, ref: 'main', advisorySource: source });
    expect(result.scannedManifests).toEqual([]);
    expect(result.failedManifests).toEqual(['poetry.lock']);
    expect(result.presentManifests).toEqual(['poetry.lock']);
  });

  it('propagates a listFiles failure instead of treating it as a clean (empty) repo', async () => {
    // A git read failure must abort the scan — never resolve to zero findings,
    // which would make the store mark every open finding as fixed.
    const reader: RepoFileReader = {
      async listFiles() {
        throw new Error('fatal: bad revision');
      },
      async readFile() {
        return null;
      },
    };
    const source = new CapturingSource(() => []);
    await expect(
      scanResolvedDependencies({ reader, ref: 'nope', advisorySource: source }),
    ).rejects.toThrow(/bad revision/);
  });
});
