/**
 * Integration tests for POST /api/projects/provision.
 *
 * These tests hit the real Express app via supertest, then drive the
 * orchestrator directly to assert the event contract. We use a stub
 * executor so no containers / git / gh are invoked.
 */
import './setup.js';
import type supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { getRequest } from './helpers.js';
import {
  _resetJobsForTests,
  snapshotEvents,
  subscribeToJob,
  type ProvisioningEvent,
  type ProvisioningExecutor,
} from '../provisioning/orchestrator.js';
import {
  setProvisioningExecutorFactory,
  resetProvisioningExecutorFactory,
  defaultExecutorFactory,
} from '../routes/provisioning.js';
import { stubExecutor } from '../provisioning/orchestrator.js';
import type { RouteDeps } from '../types.js';
import { getStmts } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  _resetJobsForTests();
  resetProvisioningExecutorFactory();
});

async function waitForDone(jobId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (snapshotEvents(jobId).some((e) => e.type === 'done')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for done on job ${jobId}`);
}

describe('POST /api/projects/provision', () => {
  it('rejects a payload without a description', async () => {
    const res = await request.post('/api/projects/provision').send({}).expect(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('returns jobId + wsUrl + projectId and creates a dev-mode project row', async () => {
    const fake: ProvisioningExecutor = {
      async runPhase() {
        return { status: 'ok' };
      },
    };
    setProvisioningExecutorFactory(() => fake);

    const res = await request
      .post('/api/projects/provision')
      .send({
        description: 'A cool new api',
        appType: 'api',
        stack: 'express-ts-sqlite',
        integrations: ['db'],
        name: 'cool-api',
        visibility: 'private',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      jobId: expect.any(String),
      wsUrl: expect.stringMatching(/^wss?:\/\/[^/]+\/api\/provisioning\/[^/]+\/events$/),
      projectId: expect.any(String),
    });

    // Project row exists and is tagged mode='dev'.
    const projectRes = await request.get(`/api/projects/${res.body.projectId}`).expect(200);
    expect(projectRes.body.mode).toBe('dev');
    expect(projectRes.body.id).toMatch(/^cool-api/);
  });

  it('drives the job to a terminal done via a fake executor', async () => {
    const fake: ProvisioningExecutor = {
      async runPhase(phase, ctx) {
        ctx.log(`fake ${phase}`);
        if (phase === 'gh-push') {
          return { status: 'ok', repoUrl: 'https://github.com/ex/x' };
        }
        return { status: 'ok' };
      },
    };
    setProvisioningExecutorFactory(() => fake);

    const res = await request
      .post('/api/projects/provision')
      .send({
        description: 'Scaffolds a thing',
        integrations: ['github'],
        hostOnAgentHub: false, // explicit GitHub hosting → gh phases run
      })
      .expect(201);

    const jobId = res.body.jobId as string;

    // Drive the "WS" by subscribing to the same stream the WS handler uses.
    const events: ProvisioningEvent[] = [];
    subscribeToJob(jobId, (ev) => events.push(ev));

    await waitForDone(jobId);

    const done = events.find((e) => e.type === 'done') as {
      repoUrl?: string;
      error?: unknown;
    };
    expect(done).toBeDefined();
    expect(done.error).toBeUndefined();
    expect(done.repoUrl).toBe('https://github.com/ex/x');

    // Job row persisted with the terminal status.
    const row = getStmts().getProvisioningJob.get(jobId) as {
      status: string;
      repo_url: string | null;
    };
    expect(row.status).toBe('succeeded');
    expect(row.repo_url).toBe('https://github.com/ex/x');
  });

  it('emits skipped gh-* phases when the user opted out of GitHub', async () => {
    const called: string[] = [];
    const fake: ProvisioningExecutor = {
      async runPhase(phase) {
        called.push(phase);
        return { status: 'ok' };
      },
    };
    setProvisioningExecutorFactory(() => fake);

    const res = await request
      .post('/api/projects/provision')
      .send({
        description: 'Local only project',
        integrations: ['db'],
      })
      .expect(201);

    const jobId = res.body.jobId as string;
    await waitForDone(jobId);

    expect(called).not.toContain('gh-create');
    expect(called).not.toContain('gh-push');
    expect(called).not.toContain('mint-token');

    const events = snapshotEvents(jobId);
    const skipped = events.filter(
      (e) => e.type === 'phase' && (e as { status: string }).status === 'skipped',
    );
    expect(skipped.map((s) => (s as { phase: string }).phase).sort()).toEqual(
      ['gh-create', 'gh-push', 'mint-token'].sort(),
    );
  });
});

describe('GET /api/provisioning/:jobId', () => {
  it('returns 404 for unknown jobs', async () => {
    await request.get('/api/provisioning/not-a-real-id').expect(404);
  });
});

describe('defaultExecutorFactory — AGENT_HUB_PROVISIONING_STUB hook', () => {
  // Minimal RouteDeps — defaultExecutorFactory only reads
  // getProjectDataDir when building the real executor chain, which is
  // the exact path we're trying to short-circuit in stub mode. The stub
  // branch must return before touching deps.
  const fakeDeps = {
    getProjectDataDir: () => {
      throw new Error('getProjectDataDir should not be called in stub mode');
    },
  } as unknown as RouteDeps;

  const originalEnv = process.env.AGENT_HUB_PROVISIONING_STUB;

  beforeEach(() => {
    delete process.env.AGENT_HUB_PROVISIONING_STUB;
  });

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_HUB_PROVISIONING_STUB;
    } else {
      process.env.AGENT_HUB_PROVISIONING_STUB = originalEnv;
    }
  });

  it('returns stubExecutor (the deterministic fake) when flag is "1"', () => {
    process.env.AGENT_HUB_PROVISIONING_STUB = '1';
    const executor = defaultExecutorFactory(fakeDeps);
    // Identity check against the shared stub keeps the test strict: if
    // someone wraps the stub in production glue, this test will notice.
    expect(executor).toBe(stubExecutor);
  });

  it('falls through to the real executor chain when flag is unset', () => {
    const deps = {
      getProjectDataDir: (id: string) => `/tmp/e2e-stub/${id}`,
    } as unknown as RouteDeps;
    const executor = defaultExecutorFactory(deps);
    expect(executor).not.toBe(stubExecutor);
  });

  it('ignores values other than "1"', () => {
    process.env.AGENT_HUB_PROVISIONING_STUB = 'true';
    const deps = {
      getProjectDataDir: (id: string) => `/tmp/e2e-stub/${id}`,
    } as unknown as RouteDeps;
    const executor = defaultExecutorFactory(deps);
    // Guardrail: only the exact string "1" flips the switch. Prevents
    // accidental enablement from truthy-but-unexpected values.
    expect(executor).not.toBe(stubExecutor);
  });
});

describe('POST /api/projects/provision/suggest', () => {
  it('fills idk fields via the generator, clamped to known ids', async () => {
    const { __setSuggestGeneratorForTests } = await import('../routes/provisioning.js');
    let seenPrompt = '';
    __setSuggestGeneratorForTests(async (prompt) => {
      seenPrompt = prompt;
      return 'Here you go:\n{"name": "Score Keeper", "appType": "web-app", "stack": "typescript-node-tsx"}';
    });
    try {
      const res = await request
        .post('/api/projects/provision/suggest')
        .send({ description: 'a realtime scoreboard for game nights' })
        .expect(200);
      expect(res.body).toEqual({
        name: 'Score Keeper',
        appType: 'web-app',
        stack: 'typescript-node-tsx',
      });
      expect(seenPrompt).toContain('realtime scoreboard');

      // Known answers are echoed back, not overridden by the model.
      __setSuggestGeneratorForTests(
        async () => '{"name": "X", "appType": "cli", "stack": "go-cobra"}',
      );
      const echo = await request
        .post('/api/projects/provision/suggest')
        .send({ description: 'thing', appType: 'api', stack: 'python-fastapi-uv' })
        .expect(200);
      expect(echo.body).toMatchObject({ appType: 'api', stack: 'python-fastapi-uv' });

      // Invalid ids from the model are clamped to null.
      __setSuggestGeneratorForTests(
        async () => '{"name": "Y", "appType": "spaceship", "stack": "cobol-mainframe"}',
      );
      const clamped = await request
        .post('/api/projects/provision/suggest')
        .send({ description: 'thing' })
        .expect(200);
      expect(clamped.body).toEqual({ name: 'Y', appType: null, stack: null });

      // No usable output → 502; missing description → 400.
      __setSuggestGeneratorForTests(async () => 'I cannot help with that.');
      await request
        .post('/api/projects/provision/suggest')
        .send({ description: 'thing' })
        .expect(502);
      await request.post('/api/projects/provision/suggest').send({}).expect(400);
    } finally {
      __setSuggestGeneratorForTests(null);
    }
  });
});

describe('hostOnAgentHub provisioning gate', () => {
  it('skips the hosted-git bootstrap when hostOnAgentHub is false', async () => {
    setProvisioningExecutorFactory(() => stubExecutor);
    const res = await request
      .post('/api/projects/provision')
      .send({
        description: 'a github-only project',
        name: `gh-only-${Date.now()}`,
        hostOnAgentHub: false,
      })
      .expect(201);
    const projectId = res.body.projectId as string;
    // Give the stub job time to finish all phases.
    await new Promise((r) => setTimeout(r, 1500));
    const proj = await request.get(`/api/projects/${projectId}`).expect(200);
    expect(proj.body.gitHost).toBeUndefined();
    expect(proj.body.ciOnPush).toBeUndefined();
  });
});
