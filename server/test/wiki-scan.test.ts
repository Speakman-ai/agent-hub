import { describe, it, expect, beforeAll, vi } from 'vitest';
import type supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest, createProject, createAgent } from './helpers.js';
import {
  buildWikiDocScanPrompt,
  dispatchWikiDocScan,
  WIKI_SCAN_STALE_SAMPLE,
  type WikiDocDispatchDeps,
} from '../wiki-doc-session.js';
import type { Project, SessionRow, Stmts } from '../types.js';

let request: supertest.Agent;
let stmts: Stmts;

beforeAll(async () => {
  request = await getRequest();
  const dbModule = await import('../db.js');
  stmts = dbModule.stmts!;
});

describe('POST /api/projects/:projectId/wiki/scan', () => {
  it('returns 404 for an unknown project', async () => {
    await request.post('/api/projects/does-not-exist/wiki/scan').send({}).expect(404);
  });

  it('returns 404 when the project has no docs agent', async () => {
    const project = (await createProject({
      id: `wiki-scan-nodocs-${uuidv4().slice(0, 8)}`,
    })) as unknown as Project;
    await createAgent({
      projectId: project.id,
      id: `wiki-scan-nodocs-dev-${uuidv4().slice(0, 8)}`,
      name: 'Dev',
      role: 'dev',
    });
    const res = await request.post(`/api/projects/${project.id}/wiki/scan`).send({}).expect(404);
    expect(res.body.error).toMatch(/docs agent/i);
  });

  it('rejects an out-of-range maxChanges', async () => {
    const project = (await createProject({
      id: `wiki-scan-bad-${uuidv4().slice(0, 8)}`,
    })) as unknown as Project;
    await request
      .post(`/api/projects/${project.id}/wiki/scan`)
      .send({ maxChanges: 99 })
      .expect(400);
  });

  it('starts a docs scan session, then reuses it while it is running', async () => {
    const project = (await createProject({
      id: `wiki-scan-${uuidv4().slice(0, 8)}`,
      name: 'Wiki Scan',
    })) as unknown as Project;
    const docs = await createAgent({
      projectId: project.id,
      id: `wiki-scan-docs-${uuidv4().slice(0, 8)}`,
      name: 'Docs',
      role: 'docs',
    });
    await request
      .post(`/api/projects/${project.id}/wiki`)
      .send({ title: 'Existing page', content: '# Hi', category: 'general' })
      .expect(201);

    const first = await request
      .post(`/api/projects/${project.id}/wiki/scan`)
      .send({ maxChanges: 3 })
      .expect(201);
    expect(first.body).toMatchObject({
      reused: false,
      agentId: docs.id,
      pageCount: 1,
      maxChanges: 3,
    });
    const session = stmts.getSession.get(first.body.sessionId) as SessionRow;
    expect(session.name).toBe('[Wiki] scan');
  });
});

describe('dispatchWikiDocScan', () => {
  it('reuses a running scan session instead of spawning a second docs agent', () => {
    const docsAgent = { id: 'docs-1', name: 'Docs', role: 'docs' };
    const project = { id: 'p1', name: 'P', cwd: '/r', agents: [docsAgent] } as unknown as Project;
    const running = { id: 's-scan', agent_id: 'docs-1', name: '[Wiki] scan', deleted_at: null };
    const handleChat = vi.fn();
    const deps = {
      stmts: {
        getRunningBackgroundTasks: { all: () => [{ session_id: 's-scan', agent_id: 'docs-1' }] },
        getSession: { get: () => running },
      },
      config: {},
      findProject: () => project,
      findAgent: () => ({ agent: docsAgent, project }),
      handleChat,
    } as unknown as WikiDocDispatchDeps;

    const outcome = dispatchWikiDocScan(deps, { project, pages: [], maxChanges: 5 });
    expect(outcome).toMatchObject({ reused: true, sessionId: 's-scan', kind: 'scan' });
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('does not treat a running backfill session as a scan', () => {
    const docsAgent = { id: 'docs-1', name: 'Docs', role: 'docs' };
    const project = { id: 'p1', name: 'P', cwd: '/r', agents: [docsAgent] } as unknown as Project;
    const backfill = { id: 's-bf', agent_id: 'docs-1', name: '[Wiki] backfill', deleted_at: null };
    const created: unknown[][] = [];
    const deps = {
      stmts: {
        getRunningBackgroundTasks: { all: () => [{ session_id: 's-bf', agent_id: 'docs-1' }] },
        getSession: {
          get: (id: string) =>
            id === 's-bf' ? backfill : { id, agent_id: 'docs-1', name: '[Wiki] scan' },
        },
        createSession: { run: (...a: unknown[]) => created.push(a) },
        insertBackgroundTask: { run: () => undefined },
      },
      config: {},
      findProject: () => project,
      findAgent: () => ({ agent: { ...docsAgent, engine: 'claude-code', model: 'm' }, project }),
      handleChat: vi.fn().mockResolvedValue(undefined),
    } as unknown as WikiDocDispatchDeps;

    const outcome = dispatchWikiDocScan(deps, { project, pages: [], maxChanges: 5 });
    expect(outcome).toMatchObject({ reused: false, kind: 'scan' });
    expect(created[0]?.[2]).toBe('[Wiki] scan');
  });
});

describe('buildWikiDocScanPrompt', () => {
  it('names the codebase path, the write cap, and the stalest pages first', () => {
    const pages = Array.from({ length: WIKI_SCAN_STALE_SAMPLE + 5 }, (_, i) => ({
      slug: `page-${i}`,
      title: `Page ${i}`,
      updated_at: `2026-01-${String(28 - i).padStart(2, '0')} 00:00:00`,
    }));
    const prompt = buildWikiDocScanPrompt({
      projectId: 'p1',
      projectName: 'Proj',
      cwd: '/repo/p1',
      pages,
      maxChanges: 4,
    });
    expect(prompt).toContain('/repo/p1');
    expect(prompt).toContain('at most **4** page writes');
    expect(prompt).toContain(`Wiki pages: ${pages.length}`);
    // Oldest page (highest index) is listed; the freshest one is not.
    expect(prompt).toContain('page-19');
    expect(prompt).not.toContain('page-0 ');
    expect(prompt.indexOf('page-19')).toBeLessThan(prompt.indexOf('page-18'));
  });

  it('seeds an empty wiki with an overview instead of a stale list', () => {
    const prompt = buildWikiDocScanPrompt({
      projectId: 'p1',
      projectName: 'Proj',
      pages: [],
      maxChanges: 5,
    });
    expect(prompt).toContain('The wiki is empty');
    expect(prompt).toContain('your working directory');
  });
});
