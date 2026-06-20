/**
 * Real-git integration: builds a throwaway bare repo (no CLI engines — git
 * only, which the test guard permits), then drives the git-backed file
 * reader and the full runSecurityScan orchestration with a fake advisory
 * source. No network.
 */
import '../test/setup.js';
import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { gitRepoFileReader } from './scanner.js';
import { runSecurityScan, SecurityScanError } from './run.js';
import { SECURITY_AUDIT_SCHEMA, createSecurityAuditStore } from './findings-store.js';
import type { AdvisorySource, DependencyFinding, ResolvedDependency } from './types.js';
import type { Project } from '../types.js';

const PKG_LOCK = JSON.stringify({
  name: 'fixture',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/lodash': { version: '4.17.11' },
    'node_modules/express': { version: '4.18.2' },
  },
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

let dataDir: string;
let barePath: string;
const projectId = 'rg-secaudit';

beforeAll(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'secaudit-data-'));
  const work = mkdtempSync(path.join(os.tmpdir(), 'secaudit-work-'));
  git(work, ['init', '-q']);
  git(work, ['config', 'user.email', 'test@test.dev']);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['checkout', '-q', '-b', 'main']);
  writeFileSync(path.join(work, 'package-lock.json'), PKG_LOCK);
  writeFileSync(path.join(work, 'README.md'), '# fixture');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);

  // A non-default branch whose lockfile differs (lodash removed) — used to prove
  // a non-default-ref scan is a read-only dry run.
  git(work, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(
    path.join(work, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/express': { version: '4.18.2' },
      },
    }),
  );
  git(work, ['commit', '-q', '-am', 'feature: drop lodash']);
  git(work, ['checkout', '-q', 'main']);

  mkdirSync(path.join(dataDir, 'git'), { recursive: true });
  barePath = path.join(dataDir, 'git', `${projectId}.git`);
  git(dataDir, ['init', '--bare', '-q', barePath]);
  git(work, ['push', '-q', barePath, 'main', 'feature']);
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: barePath });
});

const fakeProject = (): Project =>
  ({
    id: projectId,
    name: projectId,
    gitHost: 'agenthub',
    cwd: '',
    color: '#000',
  }) as unknown as Project;

class FakeSource implements AdvisorySource {
  constructor(private readonly fn: (d: ResolvedDependency[]) => DependencyFinding[]) {}
  async query(deps: ResolvedDependency[]): Promise<DependencyFinding[]> {
    return this.fn(deps);
  }
}

function memStore(): ReturnType<typeof createSecurityAuditStore> {
  const db = new Database(':memory:');
  db.exec(SECURITY_AUDIT_SCHEMA);
  return createSecurityAuditStore(db);
}

describe('gitRepoFileReader', () => {
  it('lists tracked files and reads blob content at a ref', async () => {
    const reader = gitRepoFileReader(barePath);
    const files = await reader.listFiles('main');
    expect(files.sort()).toEqual(['README.md', 'package-lock.json']);
    const content = await reader.readFile('main', 'package-lock.json');
    expect(content).toContain('node_modules/lodash');
    expect(await reader.readFile('main', 'does-not-exist')).toBeNull();
  });
});

describe('runSecurityScan (real bare repo)', () => {
  it('scans the default branch, persists findings, no card when generateCard=false', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical',
            aliases: [],
            fixedVersion: '4.17.21',
            url: 'https://x',
          },
        })),
    );
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), generateCard: false },
    );

    expect(result.ref).toBe('main');
    expect(result.scannedManifests).toEqual(['package-lock.json']);
    expect(result.dependencyCount).toBe(2); // lodash + express
    expect(result.summary.newFindings).toHaveLength(1);
    expect(result.summary.newFindings[0]).toMatchObject({
      package_name: 'lodash',
      severity: 'critical',
      fixed_version: '4.17.21',
    });
    expect(result.cardId).toBeNull();
    expect(result.failedManifests).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.dryRun).toBe(false); // default branch → persisted
    expect(result.vulnerableFindings).toBe(1);
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);
  });

  it('a non-default ref is a read-only DRY RUN (persists nothing, no sweep)', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    // Persist a finding from the DEFAULT branch (real reader → not a dry run).
    await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);

    // Scan the `feature` branch (lodash removed there). A persisting scan would
    // mark the default-branch finding `fixed`; a dry run must not touch it.
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 2000,
      },
      { project: fakeProject(), ref: 'feature', generateCard: false },
    );
    expect(result.dryRun).toBe(true);
    expect(result.summary.fixed).toBe(0);
    expect(result.summary.newFindings).toHaveLength(0);
    // The default-branch finding is untouched — nothing was persisted/swept.
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);
    expect(store.listFindings(projectId, { status: 'fixed' })).toHaveLength(0);
  });

  it('dry-run authority is NOT bypassable by injecting a custom reader', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    // Seed a finding from the default branch (real reader).
    await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);

    // Inject a custom reader AND target the non-default `feature` ref. Even though
    // the reader would return content, the ref is not the default-branch tip, so
    // the run must still be a dry run and persist nothing.
    const injected = {
      async listFiles() {
        return ['package-lock.json'];
      },
      async readFile() {
        return JSON.stringify({ lockfileVersion: 3, packages: {} }); // lodash gone
      },
    };
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        reader: injected,
        dataDir,
        now: () => 2000,
      },
      { project: fakeProject(), ref: 'feature', generateCard: false },
    );
    expect(result.dryRun).toBe(true);
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1); // untouched
    expect(store.listFindings(projectId, { status: 'fixed' })).toHaveLength(0);
  });

  it('demotes a default-branch scan to a dry run if main advances mid-scan (TOCTOU)', async () => {
    const store = memStore();
    const origMain = execFileSync('git', ['--git-dir', barePath, 'rev-parse', 'main'])
      .toString()
      .trim();
    const featureSha = execFileSync('git', ['--git-dir', barePath, 'rev-parse', 'feature'])
      .toString()
      .trim();
    try {
      // The advisory lookup simulates an external push: `main` moves to a new
      // commit DURING the scan, after the tree was already pinned + read.
      let advanced = false;
      const source = new FakeSource((deps) => {
        if (!advanced) {
          execFileSync('git', ['--git-dir', barePath, 'update-ref', 'refs/heads/main', featureSha]);
          advanced = true;
        }
        return deps
          .filter((d) => d.name === 'lodash')
          .map((d) => ({
            dependency: d,
            advisory: {
              id: 'GHSA-lodash',
              summary: 'Prototype pollution',
              severity: 'critical' as const,
              aliases: [],
              fixedVersion: '4.17.21',
              url: '',
            },
          }));
      });
      // Scans the default branch (main); main advances while the scan is in flight.
      const result = await runSecurityScan(
        {
          stmts: {} as never,
          broadcast: vi.fn(),
          advisorySource: source,
          store,
          dataDir,
          now: () => 1000,
        },
        { project: fakeProject(), generateCard: false },
      );
      // scanRef (the tip at start) is no longer the tip at persist time → dry run.
      expect(result.dryRun).toBe(true);
      expect(store.listFindings(projectId)).toHaveLength(0); // nothing persisted
    } finally {
      execFileSync('git', ['--git-dir', barePath, 'update-ref', 'refs/heads/main', origMain]);
    }
  });

  it('a corrupt lockfile does NOT clear a pre-existing open finding (manifest-scoped sweep)', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical',
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    // Seed an open finding from a good scan of the real default branch.
    await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);

    // Now the lockfile is corrupt — inject a reader that returns garbage for it.
    // (Injecting a reader skips the ref check; we're exercising the scan→store
    // path with an unparsable manifest.)
    const corruptReader = {
      async listFiles() {
        return ['package-lock.json'];
      },
      async readFile() {
        return '{ corrupt json';
      },
    };
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        reader: corruptReader,
        dataDir,
        now: () => 2000,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(result.scannedManifests).toEqual([]);
    expect(result.failedManifests).toEqual(['package-lock.json']);
    expect(result.presentManifests).toEqual(['package-lock.json']); // exists → preserved
    expect(result.summary.fixed).toBe(0);
    // The pre-existing finding survives — a corrupt scan must never clear it.
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);
    expect(store.listFindings(projectId, { status: 'fixed' })).toHaveLength(0);
  });

  it('a DELETED lockfile resolves its pre-existing findings (vs corrupt → preserved)', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    // Seed an open finding from a good scan of the real default branch.
    await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);

    // The lockfile is GONE from the tree — reader lists no files at all.
    const emptyTreeReader = {
      async listFiles() {
        return [];
      },
      async readFile() {
        return null;
      },
    };
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        reader: emptyTreeReader,
        dataDir,
        now: () => 2000,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(result.presentManifests).toEqual([]); // lockfile no longer present
    expect(result.summary.fixed).toBe(1);
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(0);
    expect(store.listFindings(projectId, { status: 'fixed' })).toHaveLength(1);
  });

  it('pins the scan to an immutable commit SHA (records the resolved commit, not the symbolic ref)', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    // Real reader (no injected reader) → ref is resolved to a commit SHA.
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), ref: 'main', generateCard: false },
    );

    const expectedSha = execFileSync('git', ['rev-parse', 'main'], { cwd: barePath })
      .toString()
      .trim();
    // The response keeps the symbolic ref the caller asked for…
    expect(result.ref).toBe('main');
    // …but the audited tree (recorded scan_ref) is the immutable commit SHA.
    const rows = store.listFindings(projectId, { status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0].scan_ref).toBe(expectedSha);
    expect(rows[0].scan_ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws SecurityScanError when the project is not Hub-hosted', async () => {
    const store = memStore();
    const source = new FakeSource(() => []);
    await expect(
      runSecurityScan(
        { stmts: {} as never, broadcast: vi.fn(), advisorySource: source, store, dataDir },
        { project: { ...fakeProject(), gitHost: 'github' } as Project, generateCard: false },
      ),
    ).rejects.toBeInstanceOf(SecurityScanError);
  });

  it('aborts on a bad ref (bad_ref) and does NOT mark existing open findings fixed', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical',
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    // Seed an open finding via a good scan on the real default branch.
    await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);

    // A typo'd ref must throw bad_ref — and crucially must NOT run the store's
    // vanish-sweep, which would otherwise flip the open finding to `fixed`.
    await expect(
      runSecurityScan(
        {
          stmts: {} as never,
          broadcast: vi.fn(),
          advisorySource: source,
          store,
          dataDir,
          now: () => 2000,
        },
        { project: fakeProject(), ref: 'does-not-exist', generateCard: false },
      ),
    ).rejects.toMatchObject({ code: 'bad_ref' });
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);
    expect(store.listFindings(projectId, { status: 'fixed' })).toHaveLength(0);
  });

  it('serializes concurrent scans for the same project: the newer scan wins (no stale reopen)', async () => {
    const store = memStore();
    const lodashLock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.11' } },
    });
    const emptyLock = JSON.stringify({ lockfileVersion: 3, packages: {} });

    const readerFor = (content: string) => ({
      async listFiles() {
        return ['package-lock.json'];
      },
      async readFile() {
        return content;
      },
    });

    // Scan A is SLOW: it sees the vulnerable tree but its advisory lookup blocks
    // on a gate. Scan B is fast and sees the fixed tree (lodash gone).
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const slowVulnSource: AdvisorySource = {
      async query(deps) {
        await gateA;
        return deps
          .filter((d) => d.name === 'lodash')
          .map((d) => ({
            dependency: d,
            advisory: {
              id: 'GHSA-lodash',
              summary: 'Prototype pollution',
              severity: 'critical' as const,
              aliases: [],
              fixedVersion: '4.17.21',
              url: '',
            },
          }));
      },
    };
    const emptySource = new FakeSource(() => []);

    // A is requested first (acquires the per-project lock first), B second.
    const pA = runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: slowVulnSource,
        reader: readerFor(lodashLock),
        store,
        dataDir,
        now: () => 1000,
      },
      { project: fakeProject(), generateCard: false },
    );
    const pB = runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: emptySource,
        reader: readerFor(emptyLock),
        store,
        dataDir,
        now: () => 2000,
      },
      { project: fakeProject(), generateCard: false },
    );

    // Give B time to overtake A IF the scans were not serialized (they are, so
    // B stays queued behind the gated A and nothing is persisted yet).
    await new Promise((r) => setTimeout(r, 20));
    expect(store.listFindings(projectId)).toHaveLength(0);

    releaseA();
    await Promise.all([pA, pB]);

    // Serialized order = A then B. A recorded the vuln (open@1000); B then saw
    // it gone and resolved it (fixed@2000). Without serialization B would have
    // recorded first (nothing to clear) and A would have reopened it last,
    // leaving a stale `open`.
    const open = store.listFindings(projectId, { status: 'open' });
    const fixed = store.listFindings(projectId, { status: 'fixed' });
    expect(open).toHaveLength(0);
    expect(fixed).toHaveLength(1);
    // Resolved by B's sweep (status flips); last_seen_at stays at A's insert
    // time since the sweep only changes status. The point is it ended `fixed`,
    // not a stale `open` from A landing last.
    expect(fixed[0]).toMatchObject({ advisory_id: 'GHSA-lodash', status: 'fixed' });
  });

  it('rolls back persisted findings when card generation throws, so a retry still cards them', async () => {
    const store = memStore();
    const lodashLock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.11' } },
    });
    const reader = {
      async listFiles() {
        return ['package-lock.json'];
      },
      async readFile() {
        return lodashLock;
      },
    };
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );

    // Card generation throws on the first attempt, succeeds on the second.
    let attempt = 0;
    const flakyCardGen = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('card insert boom');
      return { card: { id: 'card-2' } as never, created: true };
    });

    const runOnce = (now: number) =>
      runSecurityScan(
        {
          stmts: {} as never,
          broadcast: vi.fn(),
          advisorySource: source,
          reader,
          store,
          cardGenerator: flakyCardGen,
          dataDir,
          now: () => now,
        },
        { project: fakeProject(), generateCard: true },
      );

    // First scan: card gen throws → the whole transaction rolls back, so the
    // finding is NOT persisted.
    await expect(runOnce(1000)).rejects.toThrow(/card insert boom/);
    expect(store.listFindings(projectId)).toHaveLength(0);

    // Retry: card gen succeeds → the finding is still treated as NEW (because
    // the first attempt rolled back) and a card is created.
    const result = await runOnce(2000);
    expect(result.summary.newFindings).toHaveLength(1);
    expect(result.cardId).toBe('card-2');
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);
    expect(flakyCardGen).toHaveBeenCalledTimes(2);
  });

  it('opens a card for a reopened (fixed -> open) finding, not just brand-new ones', async () => {
    const store = memStore();
    const lodashLock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.11' } },
    });
    const emptyLock = JSON.stringify({ lockfileVersion: 3, packages: {} });
    const readerFor = (content: string) => ({
      async listFiles() {
        return ['package-lock.json'];
      },
      async readFile() {
        return content;
      },
    });
    const vulnSource = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    const emptySource = new FakeSource(() => []);
    const cardGen = vi.fn(() => ({ card: { id: 'card-x' } as never, created: true }));
    const base = {
      stmts: {} as never,
      broadcast: vi.fn(),
      store,
      cardGenerator: cardGen,
      dataDir,
    };

    // 1. New finding → card.
    const r1 = await runSecurityScan(
      { ...base, advisorySource: vulnSource, reader: readerFor(lodashLock), now: () => 1000 },
      { project: fakeProject(), generateCard: true },
    );
    expect(r1.cardId).toBe('card-x');
    expect(cardGen).toHaveBeenCalledTimes(1);

    // 2. Vanishes → fixed; nothing new/reopened → no card.
    const r2 = await runSecurityScan(
      { ...base, advisorySource: emptySource, reader: readerFor(emptyLock), now: () => 2000 },
      { project: fakeProject(), generateCard: true },
    );
    expect(r2.cardId).toBeNull();
    expect(cardGen).toHaveBeenCalledTimes(1);

    // 3. Reappears → reopened (a regression) → card again, even though it's an
    // update rather than a brand-new row.
    const r3 = await runSecurityScan(
      { ...base, advisorySource: vulnSource, reader: readerFor(lodashLock), now: () => 3000 },
      { project: fakeProject(), generateCard: true },
    );
    expect(r3.summary.newFindings).toHaveLength(0);
    expect(r3.summary.reopenedFindings).toHaveLength(1);
    expect(r3.cardId).toBe('card-x');
    expect(cardGen).toHaveBeenCalledTimes(2);
  });

  it('invokes openBumpPrs with the scan findings on a persisted run and surfaces its result', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'Prototype pollution',
            severity: 'critical' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    const autoPrResult = { opened: [], skipped: [] };
    const openBumpPrs = vi.fn(
      async (_ctx: { findings: DependencyFinding[]; baseBranch: string; baseSha: string }) =>
        autoPrResult,
    );
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
        openBumpPrs,
      },
      { project: fakeProject(), generateCard: false },
    );

    expect(result.dryRun).toBe(false);
    expect(openBumpPrs).toHaveBeenCalledTimes(1);
    const ctx = openBumpPrs.mock.calls[0][0];
    // Reuses the freshly-computed findings (no re-scan), pinned to the scanned tip.
    expect(ctx.findings).toHaveLength(1);
    expect(ctx.findings[0].dependency.name).toBe('lodash');
    expect(ctx.findings[0].advisory.fixedVersion).toBe('4.17.21');
    expect(ctx.baseBranch).toBe('main');
    expect(ctx.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.autoPr).toBe(autoPrResult);
  });

  it('does NOT invoke openBumpPrs on a dry run, and autoPr is null', async () => {
    const store = memStore();
    const source = new FakeSource(() => []);
    const openBumpPrs = vi.fn(async () => ({ opened: [], skipped: [] }));
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 2000,
        openBumpPrs,
      },
      { project: fakeProject(), ref: 'feature', generateCard: false },
    );
    expect(result.dryRun).toBe(true);
    expect(result.autoPr).toBeNull();
    expect(openBumpPrs).not.toHaveBeenCalled();
  });

  it('a failing openBumpPrs is swallowed: the scan still succeeds with autoPr null', async () => {
    const store = memStore();
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: 'GHSA-lodash',
            summary: 'x',
            severity: 'high' as const,
            aliases: [],
            fixedVersion: '4.17.21',
            url: '',
          },
        })),
    );
    const openBumpPrs = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await runSecurityScan(
      {
        stmts: {} as never,
        broadcast: vi.fn(),
        advisorySource: source,
        store,
        dataDir,
        now: () => 1000,
        openBumpPrs,
      },
      { project: fakeProject(), generateCard: false },
    );
    expect(result.dryRun).toBe(false);
    expect(result.autoPr).toBeNull();
    // The scan still persisted its finding despite the auto-PR failure.
    expect(store.listFindings(projectId, { status: 'open' })).toHaveLength(1);
  });

  it('auto-PR excludes findings the user suppressed/dismissed (only actionable findings)', async () => {
    const store = memStore();
    // Both lodash and express are vulnerable with published fixes.
    const source = new FakeSource((deps) =>
      deps
        .filter((d) => d.name === 'lodash' || d.name === 'express')
        .map((d) => ({
          dependency: d,
          advisory: {
            id: `GHSA-${d.name}`,
            summary: 'x',
            severity: 'high' as const,
            aliases: [],
            fixedVersion: d.name === 'lodash' ? '4.17.21' : '4.18.3',
            url: '',
          },
        })),
    );
    const received: string[][] = [];
    const openBumpPrs = vi.fn(
      async (ctx: { findings: DependencyFinding[]; baseBranch: string; baseSha: string }) => {
        received.push(ctx.findings.map((f) => f.dependency.name).sort());
        return { opened: [], skipped: [] };
      },
    );
    const base = {
      stmts: {} as never,
      broadcast: vi.fn(),
      advisorySource: source,
      store,
      dataDir,
      openBumpPrs,
    };

    // First scan: both findings open → both are actionable.
    await runSecurityScan(
      { ...base, now: () => 1000 },
      { project: fakeProject(), generateCard: false },
    );
    expect(received[0]).toEqual(['express', 'lodash']);

    // The user dismisses + suppresses lodash.
    const lodashRow = store
      .listFindings(projectId, { status: 'open' })
      .find((r) => r.package_name === 'lodash');
    expect(lodashRow).toBeDefined();
    store.dismissFinding({ projectId, id: lodashRow!.id, suppress: true });

    // Second scan: lodash reconciles to dismissed (suppression is sticky), so
    // auto-PR must receive ONLY express — the suppressed advisory is silenced.
    await runSecurityScan(
      { ...base, now: () => 2000 },
      { project: fakeProject(), generateCard: false },
    );
    expect(received[1]).toEqual(['express']);
  });
});
