/**
 * POST /api/threads/:threadId/entries/:entryId/forward
 *
 * Forwarding a single thread entry to an agent must create a NEW session for
 * the target agent, seeded with that one entry wrapped in a provenance block.
 * autoStart is left false here so the forwarded message is pre-stored (no real
 * CLI is ever spawned — the test harness in setup.ts forbids it).
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { v4 as uuidv4 } from 'uuid';
import { getRequest, createProject, createAgent, createThread } from './helpers.js';
import type { Project, ThreadRow, ThreadEntryRow, MessageRow, RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

let request: TestAgent;
let project: Project;

beforeAll(async () => {
  request = await getRequest();
  project = (await createProject()) as unknown as Project;
});

async function seedEntry(threadId: string, content: string): Promise<ThreadEntryRow> {
  // Daemon-style write (role='system') — the common case for forwarding a log line.
  const { getStmts } = await import('../db.js');
  const stmts = getStmts();
  const id = uuidv4();
  stmts.createThreadEntry.run(id, threadId, content);
  return stmts.getThreadEntry.get(id) as ThreadEntryRow;
}

describe('POST /api/threads/:threadId/entries/:entryId/forward', () => {
  it('creates a new session for the target agent seeded with the entry content', async () => {
    const agent = await createAgent({ projectId: project.id as string });
    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;
    const entry = await seedEntry(thread.id, 'deploy finished: 3 cards shipped');

    const res = await request
      .post(`/api/threads/${thread.id}/entries/${entry.id}/forward`)
      .send({ targetAgentId: agent.id, prompt: 'Please summarize this for the changelog.' })
      .expect(201);

    expect(res.body.session).toBeTruthy();
    expect(res.body.session.agent_id).toBe(agent.id);
    expect(res.body.session.name).toContain('[Fwd]');
    expect(typeof res.body.forwardedMessageId).toBe('string');

    // The forwarded user message must be pre-stored (autoStart was false) and
    // contain both the extra prompt and the original entry content.
    const { getStmts } = await import('../db.js');
    const stmts = getStmts();
    const messages = stmts.getMessages.all(res.body.session.id) as MessageRow[];
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toContain('deploy finished: 3 cards shipped');
    expect(messages[0]?.content).toContain('Please summarize this for the changelog.');
    expect(messages[0]?.content).toContain(`Forwarded from ${thread.type} thread`);
  });

  it('skips the pre-stored message when autoStart is true (handleChat owns it)', async () => {
    // The shared test app wires a safe handleChat (no real CLI is spawned —
    // setup.ts forbids it), so this exercises the autoStart dispatch branch
    // and the skipped pre-store without touching a binary.
    const agent = await createAgent({ projectId: project.id as string });
    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;
    const entry = await seedEntry(thread.id, 'autostart entry');

    const res = await request
      .post(`/api/threads/${thread.id}/entries/${entry.id}/forward`)
      .send({ targetAgentId: agent.id, autoStart: true })
      .expect(201);

    // The route's deterministic signal that it skipped the pre-store is
    // forwardedMessageId === null — handleChat (dispatched fire-and-forget) is
    // what stores the turn, so asserting on message count here would race the
    // async dispatch. forwardedMessageId === null is the contract under test.
    expect(res.body.forwardedMessageId).toBeNull();
    expect(res.body.session.agent_id).toBe(agent.id);
  });

  it('404s for a missing thread', async () => {
    const agent = await createAgent({ projectId: project.id as string });
    await request
      .post(`/api/threads/${uuidv4()}/entries/${uuidv4()}/forward`)
      .send({ targetAgentId: agent.id })
      .expect(404);
  });

  it('404s when the entry does not belong to the thread', async () => {
    const agent = await createAgent({ projectId: project.id as string });
    const threadA = (await createThread(project.id as string)) as unknown as ThreadRow;
    const threadB = (await createThread(project.id as string)) as unknown as ThreadRow;
    const entry = await seedEntry(threadA.id, 'belongs to A');

    await request
      .post(`/api/threads/${threadB.id}/entries/${entry.id}/forward`)
      .send({ targetAgentId: agent.id })
      .expect(404);
  });

  it('400s when targetAgentId is missing', async () => {
    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;
    const entry = await seedEntry(thread.id, 'no target');
    await request
      .post(`/api/threads/${thread.id}/entries/${entry.id}/forward`)
      .send({})
      .expect(400);
  });

  it('404s for an unknown target agent', async () => {
    const thread = (await createThread(project.id as string)) as unknown as ThreadRow;
    const entry = await seedEntry(thread.id, 'unknown target');
    await request
      .post(`/api/threads/${thread.id}/entries/${entry.id}/forward`)
      .send({ targetAgentId: 'does-not-exist' })
      .expect(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-project visibility — the forward route is the real authorization
// boundary. The shared test app runs under no-auth bypass (every project
// visible). To exercise the private-project block we mount the threads
// router behind a middleware that stamps a concrete non-Owner user, so the
// visibility resolver does NOT collapse to localBypass.
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/threads/:threadId/entries/:entryId/forward — cross-project visibility', () => {
  it('404s a private-project target the caller cannot view, but allows a shared one', async () => {
    const createThreadRoutes = (await import('../routes/threads.js')).default;
    const { getStmts } = await import('../db.js');
    const { findAgent, findProject, getEnrichedAgent } = await import('../project-model.js');

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const r = req as AuthenticatedRequest;
      r.authUserId = 'thread-fwd-visibility-user';
      r.authUser = 'thread-fwd-visibility-user';
      r.authRole = 'User';
      next();
    });
    app.use(
      createThreadRoutes({
        stmts: getStmts(),
        findAgent,
        findProject,
        getEnrichedAgent,
        handleChat: () => Promise.resolve(),
        broadcast: () => {},
        config: { engineValidModels: {}, engineDefaultModels: {} },
      } as unknown as RouteDeps),
    );
    const scopedRequest = supertest(app);

    // Source thread lives in a default (viewable) project so the source-thread
    // guard passes; the only variable is the *target* project's visibility.
    const srcProject = (await createProject()) as unknown as Project;
    const thread = (await createThread(srcProject.id as string)) as unknown as ThreadRow;
    const entry = await seedEntry(thread.id, 'cross-project entry');

    const privProj = await createProject({
      id: 'thread-fwd-priv-proj',
      name: 'Private Thread Fwd',
      cwd: '/tmp',
      visibility: 'private',
    });
    const privAgent = await createAgent({
      projectId: privProj.id as string,
      id: 'thread-agent-priv',
      name: 'Thread Agent Private',
    });

    const sharedProj = await createProject({
      id: 'thread-fwd-shared-proj',
      name: 'Shared Thread Fwd',
      cwd: '/tmp',
    });
    const sharedAgent = await createAgent({
      projectId: sharedProj.id as string,
      id: 'thread-agent-shared',
      name: 'Thread Agent Shared',
    });

    // Unviewable target → masked 404 before any session is created.
    await scopedRequest
      .post(`/api/threads/${thread.id}/entries/${entry.id}/forward`)
      .send({ targetAgentId: privAgent.id })
      .expect(404);

    // Viewable target → forward succeeds.
    await scopedRequest
      .post(`/api/threads/${thread.id}/entries/${entry.id}/forward`)
      .send({ targetAgentId: sharedAgent.id })
      .expect(201);
  });
});

describe('POST /api/threads/:threadId/entries/:entryId/forward — autoStart without a chat handler', () => {
  it('503s when autoStart is requested but handleChat is not wired', async () => {
    const createThreadRoutes = (await import('../routes/threads.js')).default;
    const { getStmts } = await import('../db.js');
    const { findAgent, findProject, getEnrichedAgent } = await import('../project-model.js');

    // No auth middleware → localBypass Owner, so visibility passes and we reach
    // the autoStart guard. handleChat is intentionally omitted.
    const app = express();
    app.use(express.json());
    app.use(
      createThreadRoutes({
        stmts: getStmts(),
        findAgent,
        findProject,
        getEnrichedAgent,
        broadcast: () => {},
        config: { engineValidModels: {}, engineDefaultModels: {} },
      } as unknown as RouteDeps),
    );
    const scopedRequest = supertest(app);

    const proj = (await createProject()) as unknown as Project;
    const agent = await createAgent({ projectId: proj.id as string });
    const thread = (await createThread(proj.id as string)) as unknown as ThreadRow;
    const entry = await seedEntry(thread.id, 'no handler entry');

    await scopedRequest
      .post(`/api/threads/${thread.id}/entries/${entry.id}/forward`)
      .send({ targetAgentId: agent.id, autoStart: true })
      .expect(503);
  });
});
