/**
 * Hosted-git bootstrap for Agent Hub-originating projects: starter
 * ci.yaml from the template manifest, scaffold commit, cwd repoint,
 * CI-on-push + hosting enable.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { Project } from '../types.js';

let buildStarterCiYaml: typeof import('./hosted-git-bootstrap.js').buildStarterCiYaml;
let bootstrapHostedGit: typeof import('./hosted-git-bootstrap.js').bootstrapHostedGit;
let persistScaffoldCheckout: typeof import('./hosted-git-bootstrap.js').persistScaffoldCheckout;
let parseCiConfig: typeof import('../finalize/ci-config.js').parseCiConfig;
let hostedRepoExists: typeof import('../git-host/repo-store.js').hostedRepoExists;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest(); // boots config/db into the test data dir
  ({ buildStarterCiYaml, bootstrapHostedGit, persistScaffoldCheckout } =
    await import('./hosted-git-bootstrap.js'));
  ({ parseCiConfig } = await import('../finalize/ci-config.js'));
  ({ hostedRepoExists } = await import('../git-host/repo-store.js'));
});

describe('buildStarterCiYaml', () => {
  it('produces a parseable v2 config from a manifest (tests + lint + setup)', () => {
    const yaml = buildStarterCiYaml({
      setup: ['npm ci'],
      test: 'npm test -- --watchAll=false',
      lint: 'npm run lint',
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) throw new Error('expected v2 config');
    expect(Object.keys(parsed.config.jobs)).toEqual(['tests', 'lint']);
    const tests = parsed.config.jobs.tests!;
    expect(tests.steps.map((s: { run: string }) => s.run)).toEqual([
      'npm ci',
      'npm test -- --watchAll=false',
    ]);
  });

  it('produces a parseable placeholder for unknown stacks', () => {
    const parsed = parseCiConfig(buildStarterCiYaml(null));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) throw new Error('expected v2 config');
    expect(Object.keys(parsed.config.jobs)).toEqual(['checks']);
  });
});

describe('bootstrapHostedGit', () => {
  it('seeds ci.yaml, commits the scaffold, repoints cwd, enables CI + hosting', async () => {
    const id = `prov-boot-${uuidv4().slice(0, 8)}`;
    const dataDir = path.join(os.tmpdir(), `prov-boot-${id}`);
    const workspace = path.join(dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    // Mirror the pipeline state after git-init: tree on disk, repo
    // initialized, nothing committed.
    writeFileSync(path.join(workspace, 'package.json'), '{"name":"x"}\n');
    execSync('git init --initial-branch=main', { cwd: workspace, stdio: 'pipe' });

    const project = {
      id,
      name: id,
      cwd: dataDir, // provisioning's pre-scaffold placeholder
      ahw: dataDir,
      mode: 'dev',
      agents: [],
    } as unknown as Project;

    const saveProjects = vi.fn();
    await bootstrapHostedGit({
      project,
      workspaceDir: workspace,
      manifest: { setup: ['npm ci'], test: 'npm test', lint: 'npm run lint' },
      saveProjects,
      broadcast: () => {},
    });

    // ci.yaml seeded + committed; cwd now the workspace.
    expect(existsSync(path.join(workspace, '.agent-hub', 'ci.yaml'))).toBe(true);
    expect(readFileSync(path.join(workspace, '.agent-hub', 'ci.yaml'), 'utf8')).toContain(
      'version: 2',
    );
    const log = execSync('git log --format=%s', { cwd: workspace, stdio: 'pipe' }).toString();
    expect(log).toContain('initial scaffold');
    expect(project.cwd).toBe(workspace);
    expect(project.ciOnPush).toEqual({ enabled: true });

    // Hosting import completes in the background.
    await vi.waitFor(
      () => {
        expect(project.gitHost).toBe('agenthub');
        expect(hostedRepoExists(project.id)).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(saveProjects).toHaveBeenCalled();
  });

  it('no-ops safely when the workspace is not a git repo', async () => {
    const id = `prov-boot-norepo-${uuidv4().slice(0, 8)}`;
    const workspace = path.join(os.tmpdir(), id);
    mkdirSync(workspace, { recursive: true });
    const project = {
      id,
      name: id,
      cwd: workspace,
      ahw: workspace,
      agents: [],
    } as unknown as Project;
    await bootstrapHostedGit({
      project,
      workspaceDir: workspace,
      manifest: null,
      saveProjects: vi.fn(),
      broadcast: () => {},
    });
    expect(project.gitHost).toBeUndefined();
    expect(project.ciOnPush).toBeUndefined();
  });

  it('records the GitHub remote when the integration produced a repoUrl', async () => {
    const id = `prov-boot-remote-${uuidv4().slice(0, 8)}`;
    const dataDir = path.join(os.tmpdir(), `prov-boot-${id}`);
    const workspace = path.join(dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'package.json'), '{"name":"x"}\n');
    execSync('git init --initial-branch=main', { cwd: workspace, stdio: 'pipe' });
    const project = {
      id,
      name: id,
      cwd: dataDir,
      ahw: dataDir,
      mode: 'dev',
      agents: [],
    } as unknown as Project;
    await bootstrapHostedGit({
      project,
      workspaceDir: workspace,
      manifest: null,
      saveProjects: vi.fn(),
      broadcast: () => {},
      repoUrl: 'https://github.com/acme/widget',
    });
    expect(project.repoUrl).toBe('https://github.com/acme/widget');
    expect(project.githubRepo).toBe('acme/widget');
  });
});

describe('persistScaffoldCheckout', () => {
  it('commits the scaffold, repoints cwd, and persists the pushed remote', async () => {
    const id = `prov-adopt-${uuidv4().slice(0, 8)}`;
    const dataDir = path.join(os.tmpdir(), `prov-adopt-${id}`);
    const workspace = path.join(dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'main.py'), 'print("hi")\n');
    // Mirror the state after git-init but before any commit (partial GitHub
    // phase, or a scaffold the gh-push never reached).
    execSync('git init --initial-branch=main', { cwd: workspace, stdio: 'pipe' });

    const project = {
      id,
      name: id,
      cwd: dataDir, // non-git data dir — the pre-scaffold placeholder
      ahw: dataDir,
      mode: 'dev',
      agents: [],
    } as unknown as Project;
    const saveProjects = vi.fn();
    const broadcast = vi.fn();

    const ok = await persistScaffoldCheckout({
      project,
      workspaceDir: workspace,
      repoUrl: 'https://github.com/acme/widget.git',
      saveProjects,
      broadcast,
    });

    expect(ok).toBe(true);
    // The checkout now has a HEAD to branch from.
    const log = execSync('git log --format=%s', { cwd: workspace, stdio: 'pipe' }).toString();
    expect(log).toContain('initial scaffold');
    // cwd points at the git checkout, not the non-git data dir.
    expect(project.cwd).toBe(workspace);
    // Remote metadata is persisted so ensureWorktree has a clone source.
    expect(project.repoUrl).toBe('https://github.com/acme/widget.git');
    expect(project.githubRepo).toBe('acme/widget');
    // Hosting is NOT enabled — this is the GitHub-only path.
    expect(project.gitHost).toBeUndefined();
    expect(project.ciOnPush).toBeUndefined();
    expect(saveProjects).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalled();
  });

  it('falls back to the workspace origin when no repoUrl is supplied', async () => {
    const id = `prov-adopt-origin-${uuidv4().slice(0, 8)}`;
    const dataDir = path.join(os.tmpdir(), `prov-adopt-${id}`);
    const workspace = path.join(dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'go.mod'), 'module example.com/app\n');
    execSync('git init --initial-branch=main', { cwd: workspace, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/acme/gopher.git', {
      cwd: workspace,
      stdio: 'pipe',
    });

    const project = {
      id,
      name: id,
      cwd: dataDir,
      ahw: dataDir,
      mode: 'dev',
      agents: [],
    } as unknown as Project;
    const ok = await persistScaffoldCheckout({
      project,
      workspaceDir: workspace,
      saveProjects: vi.fn(),
    });
    expect(ok).toBe(true);
    expect(project.repoUrl).toBe('https://github.com/acme/gopher.git');
    expect(project.githubRepo).toBe('acme/gopher');
  });

  it('returns false and mutates nothing when the workspace is not a git repo', async () => {
    const id = `prov-adopt-norepo-${uuidv4().slice(0, 8)}`;
    const workspace = path.join(os.tmpdir(), id);
    mkdirSync(workspace, { recursive: true });
    const project = {
      id,
      name: id,
      cwd: '/somewhere/else',
      ahw: workspace,
      agents: [],
    } as unknown as Project;
    const saveProjects = vi.fn();
    const ok = await persistScaffoldCheckout({
      project,
      workspaceDir: workspace,
      repoUrl: 'https://github.com/acme/widget',
      saveProjects,
    });
    expect(ok).toBe(false);
    expect(project.cwd).toBe('/somewhere/else');
    expect(project.repoUrl).toBeUndefined();
    expect(saveProjects).not.toHaveBeenCalled();
  });
});
