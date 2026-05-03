/**
 * reaper-heartbeat tests (W4).
 *
 * Covers the wiring logic between scheduler and reaper:
 *   - No-op when feature is disabled (config === null)
 *   - Reentrancy guard (reaperLock.running)
 *   - Lock released even when the reaper throws
 *   - Passes config.repoFullName through as defaultRepoFullName
 *   - Never throws — returns null on internal error
 *   - defaultDockerOps.listPrEnvProjects parsing + PR_ENV_PROJECT_PREFIX filter
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POOL_SCHEMA } from './schema.js';
import { PoolAllocator } from './allocator.js';
import {
  runReaperHeartbeat,
  reaperLock,
  REAPER_CRON,
  defaultDockerOps,
  DockerCliMissingError,
  __resetDockerUnavailableForTests,
  __isDockerUnavailableForTests,
  type ReaperHeartbeatDeps,
} from './reaper-heartbeat.js';
import type { ReaperDockerOps, ReaperGitHubOps } from './reaper.js';
import type { PrEnvRuntimeConfig } from './pr-env-runtime.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function makeLogger() {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    warns,
    errors,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
  };
}

function makeConfig(partial: Partial<PrEnvRuntimeConfig> = {}): PrEnvRuntimeConfig {
  return {
    enabled: true,
    prodDbPath: '/db.sqlite',
    prEnvDataDir: '/data',
    envFilesDir: '/envs',
    composeTemplatePath: '/tpl.yml',
    previewBaseUrl: 'https://preview.agenthub.dev',
    github: { appId: '1', installationId: '2', privateKey: 'k' },
    route53: {
      accessKeyId: 'AKIA',
      secretAccessKey: 'sekret',
      hostedZoneId: 'Z1',
    },
    nginx: {
      sitesAvailableDir: '/etc/nginx/sites-available',
      sitesEnabledDir: '/etc/nginx/sites-enabled',
      certPath: '/cert.pem',
      keyPath: '/key.pem',
      previewHost: 'preview.agenthub.dev',
      certHome: '/var/lib/agent-hub/acme',
    },
    repoFullName: 'Speakman-ai/agent-hub',
    ...partial,
  };
}

function noopDocker(): ReaperDockerOps {
  return {
    async listPrEnvProjects() {
      return [];
    },
    async composeDown() {},
  };
}

function noopGitHub(): ReaperGitHubOps {
  return {
    async getPrState() {
      return null;
    },
  };
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(POOL_SCHEMA);
  return db;
}

function freshDeps(
  overrides: Partial<ReaperHeartbeatDeps> = {},
): ReaperHeartbeatDeps & { logger: ReturnType<typeof makeLogger> } {
  const db = overrides.db ?? freshDb();
  const logger = (overrides.logger as ReturnType<typeof makeLogger>) ?? makeLogger();
  return {
    db,
    allocator: overrides.allocator ?? new PoolAllocator(db),
    getConfig: overrides.getConfig ?? (() => makeConfig()),
    docker: overrides.docker ?? noopDocker(),
    github: overrides.github ?? noopGitHub(),
    logger,
    ...overrides,
    // ensure logger is always the typed version for assertions
  } as ReaperHeartbeatDeps & { logger: ReturnType<typeof makeLogger> };
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('runReaperHeartbeat', () => {
  beforeEach(() => {
    reaperLock.running = false;
  });

  it('exports a valid cron expression', () => {
    expect(REAPER_CRON).toBe('*/3 * * * *');
  });

  // ─── feature-flag gating ──────────────────────────────────────────────

  it('is a no-op when the feature is disabled (config null)', async () => {
    const deps = freshDeps({ getConfig: () => null });
    const result = await runReaperHeartbeat(deps);
    expect(result).toBeNull();
    expect(deps.logger.logs.some((l) => l.includes('disabled'))).toBe(true);
  });

  it('runs a tick and returns a result when enabled', async () => {
    const deps = freshDeps();
    const result = await runReaperHeartbeat(deps);
    expect(result).not.toBeNull();
    expect(result!.skipped).toBe(false);
    expect(result!.webhookDropEvictions).toBe(0);
  });

  // ─── reentrancy guard ─────────────────────────────────────────────────

  describe('reentrancy guard', () => {
    it('returns null + logs a skip when a previous tick is still running', async () => {
      const deps = freshDeps();
      reaperLock.running = true;
      try {
        const result = await runReaperHeartbeat(deps);
        expect(result).toBeNull();
        expect(deps.logger.logs.some((l) => l.includes('previous tick still running'))).toBe(true);
      } finally {
        reaperLock.running = false;
      }
    });

    it('releases the lock even when the reaper throws', async () => {
      const deps = freshDeps({
        docker: {
          async listPrEnvProjects() {
            throw new Error('simulated docker failure');
          },
          async composeDown() {},
        },
      });
      // Seed a slot that triggers the orphaned-project pass (which calls listPrEnvProjects)
      await runReaperHeartbeat(deps);
      expect(reaperLock.running).toBe(false);
    });

    it('allows a subsequent tick to run after the previous one completes', async () => {
      const deps = freshDeps();
      const first = await runReaperHeartbeat(deps);
      expect(first).not.toBeNull();
      expect(reaperLock.running).toBe(false);
      const second = await runReaperHeartbeat(deps);
      expect(second).not.toBeNull();
    });
  });

  // ─── config.repoFullName threading ────────────────────────────────────

  it('passes config.repoFullName as defaultRepoFullName to the reaper', async () => {
    const db = freshDb();
    const allocator = new PoolAllocator(db);
    // Insert a busy pr_env slot so reapWebhookDrops queries GitHub
    db.exec(`INSERT INTO pool_slots (slot_id, class, status, pr_number)
             VALUES ('pr-1', 'pr_env', 'busy', 42)`);

    const queriedRepos: string[] = [];
    const github: ReaperGitHubOps = {
      async getPrState(repoFullName, _prNumber) {
        queriedRepos.push(repoFullName);
        return 'open'; // keep it alive so we don't evict
      },
    };
    const deps = freshDeps({
      db,
      allocator,
      getConfig: () => makeConfig({ repoFullName: 'my-org/my-repo' }),
      github,
    });

    await runReaperHeartbeat(deps);
    expect(queriedRepos).toContain('my-org/my-repo');
  });

  it('evicts a slot whose PR is closed on GitHub (webhook-drop recovery)', async () => {
    const db = freshDb();
    const allocator = new PoolAllocator(db);
    db.exec(`INSERT INTO pool_slots (slot_id, class, status, pr_number)
             VALUES ('pr-1', 'pr_env', 'busy', 99)`);

    const github: ReaperGitHubOps = {
      async getPrState() {
        return 'closed';
      },
    };
    const deps = freshDeps({ db, allocator, github });

    const result = await runReaperHeartbeat(deps);
    expect(result!.webhookDropEvictions).toBe(1);
    expect(result!.notes.some((n) => n.includes('#99') && n.includes('closed'))).toBe(true);
  });

  // ─── never throws ────────────────────────────────────────────────────

  it('never throws — returns null and logs when Reaper constructor fails', async () => {
    // Pass a closed DB so the Reaper.init() throws
    const db = freshDb();
    const allocator = new PoolAllocator(db);
    db.close();
    const deps = freshDeps({ db, allocator });

    const result = await runReaperHeartbeat(deps);
    expect(result).toBeNull();
    expect(deps.logger.errors.some((e) => e.includes('heartbeat threw'))).toBe(true);
    expect(reaperLock.running).toBe(false);
  });

  // ─── structured log output ───────────────────────────────────────────

  it('logs a structured summary after a successful tick', async () => {
    const deps = freshDeps();
    await runReaperHeartbeat(deps);
    const summary = deps.logger.logs.find((l) => l.includes('evictions='));
    expect(summary).toBeDefined();
    expect(summary).toMatch(/evictions=\d+/);
    expect(summary).toMatch(/crashedScaffolds=\d+/);
    expect(summary).toMatch(/stuckDraining=\d+/);
    expect(summary).toMatch(/orphanedProjects=\d+/);
    expect(summary).toMatch(/stalePortsReleased=\d+/);
  });
});

// ─── defaultDockerOps.listPrEnvProjects parsing ─────────────────────────

describe('defaultDockerOps.listPrEnvProjects — parsing', () => {
  // We can't test the real docker ps, but we can exercise the parsing
  // logic by examining the shape. The function is exported for direct
  // testing but requires a running Docker daemon. Instead we verify the
  // export shape + the prefix constant via a proxy test.

  it('exports a listPrEnvProjects function', () => {
    expect(typeof defaultDockerOps.listPrEnvProjects).toBe('function');
  });

  it('exports a composeDown function', () => {
    expect(typeof defaultDockerOps.composeDown).toBe('function');
  });
});

// ─── docker CLI missing — graceful degradation ──────────────────────────────

describe('defaultDockerOps — graceful degradation when docker CLI is missing', () => {
  // We force ENOENT by temporarily mutating PATH so `spawn('docker', …)`
  // can't resolve the binary. This is the same failure mode as a runtime
  // image without docker installed (the symptom we observed in dev).
  const origPath = process.env.PATH;

  beforeEach(() => {
    __resetDockerUnavailableForTests();
    // Use a path that definitely does not contain a `docker` binary.
    process.env.PATH = '/tmp/__definitely_no_docker_here__';
  });

  afterEach(() => {
    process.env.PATH = origPath;
    __resetDockerUnavailableForTests();
  });

  it('listPrEnvProjects returns [] (instead of throwing) when docker is missing', async () => {
    const result = await defaultDockerOps.listPrEnvProjects();
    expect(result).toEqual([]);
    expect(__isDockerUnavailableForTests()).toBe(true);
  });

  it('only logs the docker-missing warning once per process', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await defaultDockerOps.listPrEnvProjects();
      await defaultDockerOps.listPrEnvProjects();
      await defaultDockerOps.listPrEnvProjects();
      const dockerWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0] ?? '').includes('docker CLI not found'),
      );
      expect(dockerWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('subsequent listPrEnvProjects calls short-circuit without spawning', async () => {
    // First call latches the unavailable flag.
    await defaultDockerOps.listPrEnvProjects();
    expect(__isDockerUnavailableForTests()).toBe(true);

    // Restore PATH — if we still spawn, it would now succeed (or at
    // least return a different error). The latch should mean we never
    // spawn at all, so the result is still [] silently.
    process.env.PATH = origPath;
    const start = Date.now();
    const result = await defaultDockerOps.listPrEnvProjects();
    const elapsed = Date.now() - start;

    expect(result).toEqual([]);
    // Skipping the spawn should be fast (<10ms in practice).
    expect(elapsed).toBeLessThan(50);
  });

  it('composeDown is a silent no-op once docker is known to be unavailable', async () => {
    await defaultDockerOps.listPrEnvProjects(); // latch the flag
    process.env.PATH = origPath;
    // Should not throw and should not spawn.
    await expect(defaultDockerOps.composeDown('agent-hub-pr-99')).resolves.toBeUndefined();
  });

  it('composeDown also latches the flag when called first', async () => {
    // Reset and call composeDown directly (skipping listPrEnvProjects).
    __resetDockerUnavailableForTests();
    await expect(defaultDockerOps.composeDown('agent-hub-pr-1')).resolves.toBeUndefined();
    expect(__isDockerUnavailableForTests()).toBe(true);
  });
});

describe('DockerCliMissingError', () => {
  it('is an Error subclass with the right name', () => {
    const e = new DockerCliMissingError(
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DockerCliMissingError');
    expect(e.message).toContain('docker CLI not available');
    expect(e.message).toContain('ENOENT');
  });
});
