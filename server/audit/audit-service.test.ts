/**
 * Unit tests for the post-scaffold audit service.
 *
 * Each check runs against a temp workspace seeded with the minimum file
 * set the check actually inspects. The injected `runCommand` lets us
 * simulate test/lint exit codes without spawning real binaries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  runAudit,
  computeScore,
  suggestTracks,
  checkAuthAndSecrets,
  checkDeps,
  checkAws,
  defaultSecretsScan,
  type CommandRunner,
  type CommandResult,
  type AuditCategory,
  DEFAULT_TRACKS,
} from './audit-service.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdirSync(path.join(os.tmpdir(), `audit-test-${Date.now()}-${Math.random()}`), {
    recursive: true,
  }) as string;
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function fakeRunner(handlers: Record<string, CommandResult>): CommandRunner {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (handlers[key]) return handlers[key]!;
    if (handlers[cmd]) return handlers[cmd]!;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function passingRunner(): CommandRunner {
  return async (cmd) => {
    if (cmd === 'git') {
      return { exitCode: 0, stdout: 'deadbeefdeadbeef', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function writeFile(rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ─── computeScore ───────────────────────────────────────────────────

describe('computeScore', () => {
  it('weights ok=1, warn=0.5, fail=0 and excludes na from the denominator', () => {
    const cats: AuditCategory[] = [
      { id: 'a', label: 'A', status: 'ok', weight: 10 },
      { id: 'b', label: 'B', status: 'warn', weight: 10 },
      { id: 'c', label: 'C', status: 'fail', weight: 10 },
      { id: 'd', label: 'D', status: 'na', weight: 10 },
    ];
    // earned = 10 + 5 + 0 = 15 ; total weight excluding na = 30 → 50
    expect(computeScore(cats)).toBe(50);
  });

  it('returns 100 when every category is na', () => {
    expect(
      computeScore([
        { id: 'x', label: 'X', status: 'na', weight: 10 },
        { id: 'y', label: 'Y', status: 'na', weight: 10 },
      ]),
    ).toBe(100);
  });

  it('falls back to weight=10 when categories omit weight', () => {
    expect(computeScore([{ id: 'x', label: 'X', status: 'ok' }])).toBe(100);
  });
});

// ─── suggestTracks ──────────────────────────────────────────────────

describe('suggestTracks', () => {
  it('matches each track against agent name/role/tags', () => {
    const result = suggestTracks([
      { id: 'be', name: 'API Builder', role: 'backend' },
      { id: 'fe', name: 'UI Hacker', role: 'frontend' },
      { id: 'qa', name: 'Test Runner', role: 'qa' },
    ]);
    const byId = Object.fromEntries(result.map((t) => [t.id, t.defaultAgent]));
    expect(byId.backend).toBe('be');
    expect(byId.frontend).toBe('fe');
    expect(byId.qa).toBe('qa');
    // architect/devex/deploy don't match → null
    expect(byId.deploy).toBeNull();
  });

  it('returns one entry per default track', () => {
    const result = suggestTracks([]);
    expect(result.map((t) => t.id)).toEqual(DEFAULT_TRACKS.map((t) => t.id));
    expect(result.every((t) => t.defaultAgent === null)).toBe(true);
  });

  it('exposes both defaultAgent and suggestedAgentId aliases', () => {
    const result = suggestTracks([{ id: 'b1', role: 'backend' }]);
    const backend = result.find((t) => t.id === 'backend')!;
    expect(backend.defaultAgent).toBe('b1');
    expect(backend.suggestedAgentId).toBe('b1');
  });
});

// ─── checkAuthAndSecrets ────────────────────────────────────────────

describe('checkAuthAndSecrets', () => {
  it('flags missing README and .gitignore as warns', () => {
    const result = checkAuthAndSecrets(workspace, () => ({ hits: [], envFiles: [] }));
    expect(result.category.status).toBe('warn');
    const ids = result.findings.map((f) => f.id);
    expect(ids).toContain('readme-missing');
    expect(ids).toContain('gitignore-missing');
  });

  it('flags a stub README (≤100 bytes) as a warn', () => {
    writeFile('README.md', 'x'); // 1 byte
    writeFile('.gitignore', 'node_modules');
    const result = checkAuthAndSecrets(workspace, () => ({ hits: [], envFiles: [] }));
    expect(result.findings.find((f) => f.id === 'readme-stub')).toBeDefined();
    expect(result.category.status).toBe('warn');
  });

  it('returns ok when README is substantial, .gitignore present, no secrets', () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'node_modules');
    const result = checkAuthAndSecrets(workspace, () => ({ hits: [], envFiles: [] }));
    expect(result.category.status).toBe('ok');
    expect(result.findings).toHaveLength(0);
  });

  it('marks the category as fail when secrets are detected', () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'node_modules');
    const result = checkAuthAndSecrets(workspace, () => ({
      hits: [{ file: 'src/keys.ts', pattern: 'aws-access-key-id' }],
      envFiles: [],
    }));
    expect(result.category.status).toBe('fail');
    expect(result.findings.some((f) => f.id.startsWith('secret-'))).toBe(true);
    expect(result.findings.find((f) => f.id.startsWith('secret-'))!.severity).toBe('error');
  });

  it('warns when an .env file is committed', () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'node_modules');
    const result = checkAuthAndSecrets(workspace, () => ({
      hits: [],
      envFiles: ['.env'],
    }));
    expect(result.category.status).toBe('warn');
    expect(result.findings.some((f) => f.id === 'env-committed-.env')).toBe(true);
  });
});

// ─── defaultSecretsScan ─────────────────────────────────────────────

describe('defaultSecretsScan', () => {
  it('detects an AWS access key in a tracked file', () => {
    writeFile('config.txt', 'AWS_KEY=AKIAABCDEFGHIJKLMNOP');
    const result = defaultSecretsScan(workspace);
    expect(result.hits.some((h) => h.pattern === 'aws-access-key-id')).toBe(true);
  });

  it('lists committed .env files', () => {
    writeFile('.env', 'SECRET=value');
    writeFile('.env.local', 'OTHER=value');
    const result = defaultSecretsScan(workspace);
    expect(result.envFiles.sort()).toEqual(['.env', '.env.local'].sort());
  });

  it('skips node_modules and other ignored dirs', () => {
    writeFile('node_modules/sketchy/key.txt', 'AKIAABCDEFGHIJKLMNOP');
    const result = defaultSecretsScan(workspace);
    expect(result.hits).toHaveLength(0);
  });

  it('returns empty hits/envFiles when the workspace is clean', () => {
    writeFile('README.md', 'clean');
    const result = defaultSecretsScan(workspace);
    expect(result.hits).toHaveLength(0);
    expect(result.envFiles).toHaveLength(0);
  });
});

// ─── checkDeps ──────────────────────────────────────────────────────

describe('checkDeps', () => {
  it('na when no recognised manifest', () => {
    const result = checkDeps(
      {
        hasNodePackageJson: false,
        hasPyProject: false,
        hasGoMod: false,
        hasCargoToml: false,
        packageScripts: {},
      },
      workspace,
    );
    expect(result.category.status).toBe('na');
  });

  it('ok when manifest + lockfile present', () => {
    writeFile('package-lock.json', '{}');
    const result = checkDeps(
      {
        hasNodePackageJson: true,
        hasPyProject: false,
        hasGoMod: false,
        hasCargoToml: false,
        packageScripts: {},
      },
      workspace,
    );
    expect(result.category.status).toBe('ok');
  });

  it('warn when manifest present but no lockfile', () => {
    const result = checkDeps(
      {
        hasNodePackageJson: true,
        hasPyProject: false,
        hasGoMod: false,
        hasCargoToml: false,
        packageScripts: {},
      },
      workspace,
    );
    expect(result.category.status).toBe('warn');
    expect(result.findings.some((f) => f.id === 'deps-no-lockfile')).toBe(true);
  });
});

// ─── checkAws ───────────────────────────────────────────────────────

describe('checkAws', () => {
  it('na when integrations does not include aws', () => {
    expect(checkAws(['github']).category.status).toBe('na');
    expect(checkAws(null).category.status).toBe('na');
    expect(checkAws('idk').category.status).toBe('na');
  });

  it('warn + recommends a deploy agent when aws is selected', () => {
    const result = checkAws(['github', 'aws']);
    expect(result.category.status).toBe('warn');
    expect(result.findings[0]?.id).toBe('aws-deploy-agent');
  });
});

// ─── runAudit (integration) ─────────────────────────────────────────

describe('runAudit', () => {
  it('returns a high score for a healthy node project', async () => {
    writeFile('README.md', '# My Project\n\n' + 'x'.repeat(200));
    writeFile('.gitignore', 'node_modules');
    writeFile('.git/HEAD', 'ref: refs/heads/main');
    writeFile('package.json', JSON.stringify({ scripts: { test: 'echo ok', lint: 'echo ok' } }));
    writeFile('package-lock.json', '{}');

    const report = await runAudit({
      projectId: 'p1',
      cwd: workspace,
      integrations: ['github'],
      agents: [{ id: 'be', name: 'API', role: 'backend' }],
      runCommand: passingRunner(),
    });

    expect(report.projectId).toBe('p1');
    expect(report.generatedAt).toMatch(/T.*Z$/);
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.readinessScore).toBe(report.score);
    expect(report.findings).toHaveLength(0);
    expect(report.gaps).toHaveLength(0);

    // All five "live" categories are non-na (aws is na — github only).
    const byId = Object.fromEntries(report.categories.map((c) => [c.id, c.status]));
    expect(byId.git).toBe('ok');
    expect(byId.tests).toBe('ok');
    expect(byId.lint).toBe('ok');
    expect(byId.deps).toBe('ok');
    expect(byId.auth).toBe('ok');
    expect(byId.aws).toBe('na');

    expect(report.suggestedTracks.find((t) => t.id === 'backend')!.defaultAgent).toBe('be');
  });

  it('drops the score and emits findings when tests fail', async () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'x');
    writeFile('.git/HEAD', 'ref: refs/heads/main');
    writeFile('package.json', JSON.stringify({ scripts: { test: 'exit 1' } }));
    writeFile('package-lock.json', '{}');

    const runner: CommandRunner = async (cmd) => {
      if (cmd === 'git') return { exitCode: 0, stdout: 'abc', stderr: '' };
      if (cmd === 'npm') return { exitCode: 1, stdout: '', stderr: 'tests failed' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const report = await runAudit({
      projectId: 'p2',
      cwd: workspace,
      integrations: [],
      runCommand: runner,
    });

    const tests = report.categories.find((c) => c.id === 'tests')!;
    expect(tests.status).toBe('fail');
    expect(report.findings.some((f) => f.id === 'tests-failed')).toBe(true);
    expect(report.score).toBeLessThan(100);
  });

  it('flags aws gap when integrations include aws', async () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'x');
    writeFile('.git/HEAD', 'ref: refs/heads/main');

    const report = await runAudit({
      projectId: 'p3',
      cwd: workspace,
      integrations: ['aws'],
      agents: [{ id: 'a1', name: 'Generic', role: null }],
      runCommand: passingRunner(),
    });

    expect(report.gaps.some((g) => g.id === 'deploy-agent-recommended')).toBe(true);
    const aws = report.categories.find((c) => c.id === 'aws')!;
    expect(aws.status).toBe('warn');
  });

  it('reports git fail when no .git directory exists', async () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'x');
    const report = await runAudit({
      projectId: 'p4',
      cwd: workspace,
      integrations: [],
      runCommand: passingRunner(),
    });
    const git = report.categories.find((c) => c.id === 'git')!;
    expect(git.status).toBe('fail');
    expect(report.findings.some((f) => f.id === 'git-missing')).toBe(true);
  });

  it('reports git fail when .git exists but rev-parse HEAD errors', async () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'x');
    writeFile('.git/HEAD', 'ref: refs/heads/main');
    const runner = fakeRunner({ git: { exitCode: 128, stdout: '', stderr: 'no commit' } });
    const report = await runAudit({
      projectId: 'p5',
      cwd: workspace,
      integrations: [],
      runCommand: runner,
    });
    const git = report.categories.find((c) => c.id === 'git')!;
    expect(git.status).toBe('fail');
    expect(report.findings.some((f) => f.id === 'git-no-head')).toBe(true);
  });

  it('marks lint+tests na when no recognised stack is detected', async () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'x');
    writeFile('.git/HEAD', 'ref: refs/heads/main');

    const report = await runAudit({
      projectId: 'p6',
      cwd: workspace,
      integrations: [],
      runCommand: passingRunner(),
    });
    expect(report.categories.find((c) => c.id === 'tests')!.status).toBe('na');
    expect(report.categories.find((c) => c.id === 'lint')!.status).toBe('na');
  });

  it('uses injected `now` so generatedAt is deterministic', async () => {
    writeFile('README.md', 'x'.repeat(200));
    writeFile('.gitignore', 'x');
    writeFile('.git/HEAD', 'ref: refs/heads/main');
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    const report = await runAudit({
      projectId: 'p7',
      cwd: workspace,
      integrations: [],
      runCommand: passingRunner(),
      now: () => fixed,
    });
    expect(report.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws when projectId or cwd are missing', async () => {
    await expect(
      runAudit({ projectId: '', cwd: workspace, runCommand: passingRunner() }),
    ).rejects.toThrow(/projectId/);
    await expect(
      runAudit({ projectId: 'p', cwd: '', runCommand: passingRunner() }),
    ).rejects.toThrow(/cwd/);
  });
});
