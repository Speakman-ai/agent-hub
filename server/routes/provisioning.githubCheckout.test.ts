/**
 * Provisioning route — post-scaffold branch selection.
 *
 * Regression cover for the GitHub-only (hostOnAgentHub:false) path: it
 * used to skip bootstrapHostedGit — the only step that repointed
 * project.cwd at the git checkout and recorded the remote — and dispatch
 * the first build against a project still pointing at the non-git data
 * dir, so ensureWorktree had no valid source. The route must now adopt the
 * scaffold checkout (persistScaffoldCheckout) before kickoffInitialBuild,
 * threading the pushed repoUrl through, regardless of host choice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';

const bootstrapHostedGit = vi.fn().mockResolvedValue(undefined);
const persistScaffoldCheckout = vi.fn().mockResolvedValue(true);
const kickoffInitialBuild = vi.fn();

vi.mock('../provisioning/hosted-git-bootstrap.js', () => ({
  bootstrapHostedGit,
  persistScaffoldCheckout,
  // Route imports only the two above; keep the rest defined so the module
  // graph stays intact for anything transitively touched.
  buildStarterCiYaml: () => '',
}));
vi.mock('../provisioning/initial-build.js', () => ({ kickoffInitialBuild }));

const {
  default: createProvisioningRoutes,
  setProvisioningExecutorFactory,
  resetProvisioningExecutorFactory,
} = await import('./provisioning.js');
const { _resetJobsForTests } = await import('../provisioning/orchestrator.js');

function fakeSucceedingExecutor() {
  return {
    // Every phase succeeds; gh phases echo a repoUrl so done.repoUrl is set.
    async runPhase(phase: string) {
      if (phase === 'gh-create' || phase === 'gh-push') {
        return { status: 'ok' as const, repoUrl: 'https://github.com/acme/widget' };
      }
      return { status: 'ok' as const };
    },
  };
}

function buildApp() {
  const projects: any[] = [];
  const saveProjects = vi.fn();
  const broadcast = vi.fn();
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'prov-route-'));
  const deps: any = {
    stmts: {
      createProvisioningJob: { run: vi.fn() },
      finishProvisioningJob: { run: vi.fn() },
      getProvisioningJob: { get: vi.fn() },
    },
    broadcast,
    saveProjects,
    findProject: (id: string) => projects.find((p) => p.id === id),
    getProjects: () => projects,
    getProjectDataDir: (id: string) => path.join(dataRoot, id),
  };
  const app = express();
  app.use(express.json());
  app.use(createProvisioningRoutes(deps));
  return { app, projects };
}

describe('POST /api/projects/provision — post-scaffold checkout adoption', () => {
  beforeEach(() => {
    _resetJobsForTests();
    bootstrapHostedGit.mockClear();
    persistScaffoldCheckout.mockClear();
    kickoffInitialBuild.mockClear();
    setProvisioningExecutorFactory(() => fakeSucceedingExecutor() as any);
  });

  afterEach(() => {
    resetProvisioningExecutorFactory();
  });

  it('GitHub-only: adopts the scaffold checkout with the pushed repoUrl, then builds', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/projects/provision')
      .send({ description: 'a widget tracker', name: 'widget', hostOnAgentHub: false });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBeTruthy();

    await vi.waitFor(
      () => {
        expect(kickoffInitialBuild).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    // GitHub-only never runs the Hub-hosting bootstrap…
    expect(bootstrapHostedGit).not.toHaveBeenCalled();
    // …it adopts the checkout and threads the pushed remote through.
    expect(persistScaffoldCheckout).toHaveBeenCalledTimes(1);
    const arg = persistScaffoldCheckout.mock.calls[0][0];
    expect(arg.repoUrl).toBe('https://github.com/acme/widget');
    expect(arg.workspaceDir).toMatch(/[/\\]workspace$/);
    expect(arg.project?.id).toBe(res.body.projectId);
    // Checkout adoption happens before the first build is dispatched.
    expect(persistScaffoldCheckout.mock.invocationCallOrder[0]).toBeLessThan(
      kickoffInitialBuild.mock.invocationCallOrder[0],
    );
  });

  it('Hub-hosted: runs the hosting bootstrap (with repoUrl), not the GitHub-only adopt', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/projects/provision')
      .send({ description: 'a widget tracker', name: 'widget2', hostOnAgentHub: true });
    expect(res.status).toBe(201);

    await vi.waitFor(
      () => {
        expect(kickoffInitialBuild).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    expect(persistScaffoldCheckout).not.toHaveBeenCalled();
    expect(bootstrapHostedGit).toHaveBeenCalledTimes(1);
  });
});
