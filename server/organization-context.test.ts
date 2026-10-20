import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { authMiddleware, type AuthenticatedRequest } from './auth.js';
import config from './config.js';
import { initDb, getDb } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId, orgDataDir } from './orgs.js';
import { setProjects, getProjectDataDir } from './project-model.js';
import { createMembership } from './memberships-store.js';
import {
  attachBusinessOrganizationProject,
  createBusinessOrganization,
  detachBusinessOrganizationProject,
  setBusinessOrganizationMember,
} from './business-organizations-store.js';
import { addProjectMember, removeProjectMember } from './project-members-store.js';
import {
  issueOrganizationCapability,
  prepareOrganizationTurn,
  resetOrganizationCapabilitiesForTests,
  setOrganizationRevocationHandler,
} from './organization-capabilities.js';
import { appendOrganizationMemory, readOrganizationMemory } from './organization-memory.js';
import {
  clearOrganizationContextCache,
  organizationContextCacheKeys,
  sanitizeContextOutput,
  SCAN_CHAR_BUDGET,
  admissibleCost,
} from './organization-context.js';
import createOrganizationContextRoutes from './routes/organization-context.js';
import createCapabilityRoutes from './routes/organization-capabilities.js';
import { createPage } from './wiki.js';
import type { Agent, Project } from './types.js';

const stop = vi.fn();
let organizationId: string;
let workspace: Project;

function orgAgent(id: string, projects: 'all-linked' | string[]): Agent {
  return {
    id,
    name: id,
    engine: 'claude-code',
    organizationScope: { enabled: true, tools: ['projects:read'], projects },
  } as Agent;
}

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    cwd: config.dataDir,
    ahw: '',
    agents: [{ id: `${id}-dev`, name: `${id} dev`, engine: 'claude-code' }],
    ...extra,
  } as Project;
}

function session(id: string, agentId: string, owner: string) {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (id, agent_id, name, engine, model, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, agentId, id, 'claude-code', 'test', owner);
}

function token(sessionId = 'assistant-session') {
  prepareOrganizationTurn(sessionId, true, workspace);
  return issueOrganizationCapability(sessionId, 'person');
}

/** Capability requests use the real auth middleware; X-Test-User simulates a logged-in human. */
function app() {
  const server = express();
  server.use((req: Request, res: Response, next: NextFunction) => {
    const user = req.header('x-test-user');
    if (!user) return authMiddleware(req, res, next);
    Object.assign(req as AuthenticatedRequest, { authUserId: user, authOrgId: 'default' });
    next();
  });
  server.use(createOrganizationContextRoutes());
  server.use((_req, res) => res.status(418).json({ fellThrough: true }));
  return server;
}

function addBoard(projectId: string) {
  const db = getDb();
  db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
    `${projectId}-board`,
    projectId,
    'Board',
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
    `${projectId}-todo`,
    `${projectId}-board`,
    'To Do',
    0,
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
    `${projectId}-done`,
    `${projectId}-board`,
    'Done',
    1,
  );
}
function addCard(projectId: string, id: string, title: string, description = '', done = false) {
  getDb()
    .prepare(
      'INSERT INTO kanban_cards (id, column_id, board_id, title, description) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, `${projectId}-${done ? 'done' : 'todo'}`, `${projectId}-board`, title, description);
}

beforeEach(() => {
  resetOrganizationCapabilitiesForTests();
  clearOrganizationContextCache();
  initOrgsDb();
  setActiveOrgId('default');
  initDb(config.dataDir);
  const db = getDb();
  for (const table of [
    'messages',
    'sessions',
    'kanban_card_comments',
    'kanban_cards',
    'kanban_phases',
    'kanban_epics',
    'kanban_columns',
    'kanban_boards',
    'wiki_pages',
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  try {
    db.prepare('DELETE FROM wiki_pages_fts').run();
  } catch {
    /* FTS optional */
  }
  for (const user of ['person', 'other-user']) {
    getOrgsDb()
      .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(user, user, 'unused');
    createMembership(user, 'default', user === 'person' ? 'Owner' : 'User');
  }
  // Organizations live in the shared orgs.db; start every test from none.
  for (const table of [
    'business_organization_projects',
    'business_organization_members',
    'business_organizations',
  ])
    getOrgsDb().prepare(`DELETE FROM ${table}`).run();
  organizationId = createBusinessOrganization({
    serverId: 'default',
    name: 'Group',
    createdBy: 'person',
  }).id;
  workspace = {
    id: 'org-workspace',
    name: 'Group workspace',
    cwd: config.dataDir,
    ahw: '',
    kind: 'system',
    organizationId,
    serverId: 'default',
    workspaceKind: 'organization',
    agents: [
      orgAgent('assistant', 'all-linked'),
      orgAgent('alpha-only', ['alpha']),
      orgAgent('nothing', []),
    ],
  } as Project;
  setProjects([
    workspace,
    project('alpha'),
    project('beta'),
    project('gamma'),
    project('secret', { visibility: 'private', ownerUserId: 'someone-else' } as Partial<Project>),
  ]);
  for (const id of ['alpha', 'beta', 'secret'])
    attachBusinessOrganizationProject('default', organizationId, id);
  session('assistant-session', 'assistant', 'person');
  session('subset-session', 'alpha-only', 'person');
  session('empty-session', 'nothing', 'person');
  setOrganizationRevocationHandler(stop);
  stop.mockClear();
});
afterEach(() => {
  setActiveOrgId('default');
  vi.useRealTimers();
});

const ids = (body: { projects: Array<{ id: string }> }) => body.projects.map((p) => p.id);

describe('organization context scope', () => {
  it('gives the all-linked Assistant, a subset agent and an empty-scope agent different results', async () => {
    const overview = async (sessionId: string) =>
      (
        await request(app())
          .get(`/api/organizations/${organizationId}/context`)
          .set('X-API-Key', token(sessionId))
          .expect(200)
      ).body;
    expect(ids(await overview('assistant-session'))).toEqual(['alpha', 'beta']);
    expect(ids(await overview('subset-session'))).toEqual(['alpha']);
    expect(ids(await overview('empty-session'))).toEqual([]);
    await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/wiki`)
      .set('X-API-Key', token('empty-session'))
      .expect(404);
    await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/beta/cards`)
      .set('X-API-Key', token('subset-session'))
      .expect(404);
    // Cache entries are partitioned by agent.
    const keys = organizationContextCacheKeys().map((key) => JSON.parse(key) as unknown[]);
    expect(new Set(keys.map((key) => key[2]))).toEqual(
      new Set(['assistant', 'alpha-only', 'nothing']),
    );
  });

  it('never exposes unlinked, private or organization-workspace projects, with one 404 shape', async () => {
    const t = token();
    for (const id of ['gamma', 'secret', 'org-workspace', 'missing']) {
      const res = await request(app())
        .get(`/api/organizations/${organizationId}/context/projects/${id}/agents`)
        .set('X-API-Key', t)
        .expect(404);
      expect(res.body).toEqual({ error: 'Project not found' });
    }
  });

  it('cites server, organization, project and record with timestamps, and loads detail on demand', async () => {
    addBoard('alpha');
    addCard('alpha', 'card-1', 'Ship billing', 'x'.repeat(10_000));
    addCard('alpha', 'card-2', 'Old work', '', true);
    const t = token();
    const overview = await request(app())
      .get(`/api/organizations/${organizationId}/context`)
      .set('X-API-Key', t)
      .expect(200);
    const alpha = overview.body.projects[0];
    expect(alpha.source).toEqual({
      serverId: 'default',
      organizationId,
      projectId: 'alpha',
      projectName: 'Project alpha',
      record: 'project:alpha',
    });
    expect(alpha.board).toMatchObject({ openCards: 1, totalCards: 2 });
    expect(alpha.timestamp).toMatch(/Z$/);
    const cards = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/cards?column=to%20do`)
      .set('X-API-Key', t)
      .expect(200);
    expect(cards.body.items).toHaveLength(1);
    expect(cards.body.items[0]).not.toHaveProperty('description');
    expect(cards.body.items[0].source.record).toBe('card:card-1');
    const detail = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/cards/card-1`)
      .set('X-API-Key', t)
      .expect(200);
    expect(detail.body.record.description).toHaveLength(4000);
    expect(detail.body.record.truncated).toBe(true);
    await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/beta/cards/card-1`)
      .set('X-API-Key', t)
      .expect(404);
  });

  it('paginates large portfolios with bounded page sizes', async () => {
    const many = Array.from({ length: 30 }, (_, i) => project(`p${String(i).padStart(2, '0')}`));
    setProjects([workspace, ...many]);
    for (const p of many) attachBusinessOrganizationProject('default', organizationId, p.id);
    const t = token();
    const first = await request(app())
      .get(`/api/organizations/${organizationId}/context?limit=25`)
      .set('X-API-Key', t)
      .expect(200);
    expect(first.body.projects).toHaveLength(25);
    expect(first.body.nextOffset).toBe(25);
    const second = await request(app())
      .get(`/api/organizations/${organizationId}/context?limit=25&offset=25`)
      .set('X-API-Key', t)
      .expect(200);
    expect(second.body.projects).toHaveLength(5);
    expect(second.body.nextOffset).toBeNull();
    await request(app())
      .get(`/api/organizations/${organizationId}/context?limit=500`)
      .set('X-API-Key', t)
      .expect(400);
  });
});

describe('sessions and secrets', () => {
  it("lists only the acting user's sessions and redacts secrets from results", async () => {
    session('mine', 'alpha-dev', 'person');
    session('theirs', 'alpha-dev', 'other-user');
    const db = getDb();
    db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
      'm1',
      'mine',
      'user',
      'my password is hunter2',
    );
    db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
      'm2',
      'mine',
      'assistant',
      'Deployed. Used token=ghp_abcdefghijklmnopqrstuvwxyz0123 to push.',
    );
    db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
      'm3',
      'theirs',
      'assistant',
      'Other user private result',
    );
    const t = token();
    const list = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/sessions`)
      .set('X-API-Key', t)
      .expect(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual(['mine']);
    const detail = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/sessions/mine`)
      .set('X-API-Key', t)
      .expect(200);
    const text = JSON.stringify(detail.body);
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(text).not.toContain('hunter2');
    expect(detail.body.record.latestResult.content).toContain('Deployed.');
    await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/sessions/theirs`)
      .set('X-API-Key', t)
      .expect(404);
    // Organization-agent sessions are never listed as project sessions.
    expect(JSON.stringify(list.body)).not.toContain('assistant-session');
  });

  it('searches only authorized linked projects, with citations', async () => {
    createPage('alpha', { title: 'Launch plan', content: 'Quarterly launch', category: 'general' });
    createPage('secret', { title: 'Launch secret', content: 'Hidden launch', category: 'general' });
    createPage('gamma', { title: 'Launch gamma', content: 'Unlinked launch', category: 'general' });
    addBoard('beta');
    addCard('beta', 'beta-card', 'Launch checklist');
    const res = await request(app())
      .get(`/api/organizations/${organizationId}/context/search?q=launch`)
      .set('X-API-Key', token())
      .expect(200);
    const projects = res.body.results.map(
      (r: { source: { projectId: string } }) => r.source.projectId,
    );
    expect(new Set(projects)).toEqual(new Set(['alpha', 'beta']));
    expect(res.body.results.every((r: { timestamp: string }) => r.timestamp)).toBe(true);
  });
});

describe('server totals and Server isolation', () => {
  it('does not double-count a project linked to two organizations', async () => {
    const second = createBusinessOrganization({
      serverId: 'default',
      name: 'Second',
      createdBy: 'person',
    }).id;
    attachBusinessOrganizationProject('default', second, 'alpha');
    const res = await request(app())
      .get('/api/organizations/summary')
      .set('X-Test-User', 'person')
      .expect(200);
    expect(res.body.linkedProjects).toBe(2);
    const counts = Object.fromEntries(
      res.body.perOrganization.map((o: { organizationId: string; linkedProjects: number }) => [
        o.organizationId,
        o.linkedProjects,
      ]),
    );
    expect(counts[organizationId]).toBe(2);
    expect(counts[second]).toBe(1);
    // Organization capabilities have no Server-wide view.
    await request(app()).get('/api/organizations/summary').set('X-API-Key', token()).expect(403);
  });

  it('keeps identical project IDs on another Server out of context', async () => {
    getOrgsDb().prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('other', 'Other')").run();
    createMembership('person', 'other', 'Owner');
    mkdirSync(orgDataDir('other'), { recursive: true });
    writeFileSync(
      path.join(orgDataDir('other'), 'projects.json'),
      JSON.stringify([project('alpha'), project('delta')]),
    );
    const foreign = createBusinessOrganization({
      serverId: 'other',
      name: 'Foreign',
      createdBy: 'person',
    }).id;
    attachBusinessOrganizationProject('other', foreign, 'alpha');
    attachBusinessOrganizationProject('other', foreign, 'delta');
    const t = token();
    await request(app())
      .get(`/api/organizations/${foreign}/context`)
      .set('X-API-Key', t)
      .expect(403);
    await request(app())
      .get(`/api/organizations/${foreign}/context`)
      .set('X-Test-User', 'person')
      .expect(404);
    const own = await request(app())
      .get(`/api/organizations/${organizationId}/context`)
      .set('X-API-Key', t)
      .expect(200);
    expect(
      own.body.projects.map((p: { source: { serverId: string } }) => p.source.serverId),
    ).toEqual(['default', 'default']);
    const summary = await request(app())
      .get('/api/organizations/summary')
      .set('X-Test-User', 'person')
      .expect(200);
    expect(
      summary.body.perOrganization.map((o: { organizationId: string }) => o.organizationId),
    ).not.toContain(foreign);
  });

  it('lets a human member read with their own ACL and denies non-members', async () => {
    const res = await request(app())
      .get(`/api/organizations/${organizationId}/context`)
      .set('X-Test-User', 'person')
      .expect(200);
    expect(ids(res.body)).toEqual(['alpha', 'beta']);
    expect(res.body.agentId).toBeNull();
    await request(app())
      .get(`/api/organizations/${organizationId}/context`)
      .set('X-Test-User', 'other-user')
      .expect(404);
  });
});

describe('revocation', () => {
  it('stops the active turn on unlink, rejects the old capability and rebuilds fresh context', async () => {
    const t = token();
    const before = await request(app())
      .get(`/api/organizations/${organizationId}/context`)
      .set('X-API-Key', t)
      .expect(200);
    expect(ids(before.body)).toEqual(['alpha', 'beta']);
    expect(organizationContextCacheKeys()).not.toHaveLength(0);

    detachBusinessOrganizationProject('default', organizationId, 'alpha');
    expect(stop).toHaveBeenCalledWith('assistant-session');
    expect(organizationContextCacheKeys()).toHaveLength(0);
    await request(app())
      .get(`/api/organizations/${organizationId}/context`)
      .set('X-API-Key', t)
      .expect(401);
    expect(() => prepareOrganizationTurn('assistant-session', false, workspace)).toThrow(
      'new message',
    );

    const fresh = await request(app())
      .get(`/api/organizations/${organizationId}/context`)
      .set('X-API-Key', token())
      .expect(200);
    expect(ids(fresh.body)).toEqual(['beta']);
  });

  it('stops the turn when the agent scope narrows and serves the narrower view afterwards', async () => {
    const t = token();
    await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/beta/wiki`)
      .set('X-API-Key', t)
      .expect(200);
    workspace.agents[0].organizationScope!.projects = ['alpha'];
    setProjects([workspace, project('alpha'), project('beta')]);
    await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/beta/wiki`)
      .set('X-API-Key', t)
      .expect(401);
    expect(stop).toHaveBeenCalledWith('assistant-session');
    await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/beta/wiki`)
      .set('X-API-Key', token())
      .expect(404);
  });
});

describe('private memory', () => {
  function memoryFile() {
    const owner = createHash('sha256').update('person').digest('hex');
    return path.join(getProjectDataDir('org-workspace'), 'users', owner, 'memory.json');
  }

  it('invalidates memory on a scope change even when the source project stays allowed', () => {
    prepareOrganizationTurn('assistant-session', true, workspace);
    appendOrganizationMemory('assistant-session', {
      projectId: 'alpha',
      sourceRecord: 'card:1',
      content: 'Alpha is late',
    });
    // Linking an unrelated project to the all-linked agent is not a configuration change.
    setProjects([workspace, project('alpha'), project('beta'), project('gamma')]);
    attachBusinessOrganizationProject('default', organizationId, 'gamma');
    prepareOrganizationTurn('assistant-session', true, workspace);
    expect(readOrganizationMemory('assistant-session').map((m) => m.content)).toEqual([
      'Alpha is late',
    ]);

    // Narrow all-linked -> ['alpha']: alpha remains authorized, but the configuration changed.
    workspace.agents[0].organizationScope!.projects = ['alpha'];
    setProjects([workspace, project('alpha'), project('beta'), project('gamma')]);
    prepareOrganizationTurn('assistant-session', true, workspace);
    expect(readOrganizationMemory('assistant-session')).toEqual([]);
    const stored = JSON.parse(readFileSync(memoryFile(), 'utf8')) as Array<{ agentId: string }>;
    expect(stored.filter((m) => m.agentId === 'assistant')).toEqual([]);

    // Restoring the old scope does not revive it either.
    workspace.agents[0].organizationScope!.projects = 'all-linked';
    setProjects([workspace, project('alpha'), project('beta'), project('gamma')]);
    prepareOrganizationTurn('assistant-session', true, workspace);
    expect(readOrganizationMemory('assistant-session')).toEqual([]);
  });

  it('is per agent, and unlink-then-relink never revives it', () => {
    prepareOrganizationTurn('assistant-session', true, workspace);
    appendOrganizationMemory('assistant-session', {
      projectId: 'alpha',
      sourceRecord: 'card:1',
      content: 'Alpha is late',
    });
    expect(readOrganizationMemory('assistant-session').map((m) => m.content)).toEqual([
      'Alpha is late',
    ]);
    prepareOrganizationTurn('subset-session', true, workspace);
    expect(readOrganizationMemory('subset-session')).toEqual([]);

    detachBusinessOrganizationProject('default', organizationId, 'alpha');
    attachBusinessOrganizationProject('default', organizationId, 'alpha');
    prepareOrganizationTurn('assistant-session', true, workspace);
    expect(readOrganizationMemory('assistant-session')).toEqual([]);
    // The revocation pruned the record from durable storage too.
    const stored = existsSync(memoryFile())
      ? (JSON.parse(readFileSync(memoryFile(), 'utf8')) as Array<{ agentId: string }>)
      : [];
    expect(stored.filter((m) => m.agentId === 'assistant')).toEqual([]);
  });

  function storedFor(userId: string, agentId: string) {
    const owner = createHash('sha256').update(userId).digest('hex');
    const file = path.join(getProjectDataDir('org-workspace'), 'users', owner, 'memory.json');
    if (!existsSync(file)) return [];
    return (JSON.parse(readFileSync(file, 'utf8')) as Array<{ agentId: string }>).filter(
      (m) => m.agentId === agentId,
    );
  }

  it('stays gone when project visibility is revoked and restored with no live context', () => {
    prepareOrganizationTurn('assistant-session', true, workspace);
    appendOrganizationMemory('assistant-session', {
      projectId: 'alpha',
      sourceRecord: 'card:1',
      content: 'Alpha is late',
    });
    // A restart drops every tracked context and grant.
    resetOrganizationCapabilitiesForTests();
    const privateAlpha = project('alpha', {
      visibility: 'private',
      ownerUserId: 'someone-else',
    } as Partial<Project>);
    setProjects([workspace, privateAlpha, project('beta'), project('gamma')]);
    expect(storedFor('person', 'assistant')).toEqual([]);
    setProjects([workspace, project('alpha'), project('beta'), project('gamma')]);
    prepareOrganizationTurn('assistant-session', true, workspace);
    expect(readOrganizationMemory('assistant-session')).toEqual([]);
  });

  it('stays gone when project membership is removed and re-added after capability expiry', () => {
    // A project id unique to this test, so no other local Server makes the member grant ambiguous.
    const restricted = 'membership-memory-source';
    setProjects([workspace, project('alpha'), project('beta'), project(restricted)]);
    attachBusinessOrganizationProject('default', organizationId, restricted);
    setBusinessOrganizationMember('default', organizationId, 'other-user', 'Member');
    addProjectMember(restricted, 'other-user', 'person');
    session('member-session', 'assistant', 'other-user');
    prepareOrganizationTurn('member-session', true, workspace);
    appendOrganizationMemory('member-session', {
      projectId: restricted,
      sourceRecord: 'card:1',
      content: 'Restricted is late',
    });
    expect(readOrganizationMemory('member-session').map((m) => m.content)).toEqual([
      'Restricted is late',
    ]);
    // Expired capabilities and contexts are no longer tracked.
    resetOrganizationCapabilitiesForTests();
    removeProjectMember(restricted, 'other-user');
    expect(storedFor('other-user', 'assistant')).toEqual([]);
    addProjectMember(restricted, 'other-user', 'person');
    prepareOrganizationTurn('member-session', true, workspace);
    expect(readOrganizationMemory('member-session')).toEqual([]);
  });
});

type SearchPage = {
  body: { results: Array<{ id: string; title: string }>; nextCursor: string | null };
};
async function searchAll(t: string, query: string, limit: number) {
  const seen: Array<{ id: string; title: string }> = [];
  let cursor: string | null = '';
  while (cursor !== null) {
    const after: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res: SearchPage = await request(app())
      .get(`/api/organizations/${organizationId}/context/search?${query}&limit=${limit}${after}`)
      .set('X-API-Key', t)
      .expect(200);
    seen.push(...res.body.results);
    cursor = res.body.nextCursor;
  }
  return seen;
}

function bulkCards(projectId: string, count: number, title: (i: number) => string) {
  const insert = getDb().prepare(
    'INSERT INTO kanban_cards (id, column_id, board_id, title, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  getDb().transaction(() => {
    for (let i = 0; i < count; i++)
      insert.run(
        `${projectId}-bulk-${String(i).padStart(5, '0')}`,
        `${projectId}-todo`,
        `${projectId}-board`,
        title(i),
        // Many identical timestamps exercise the tie-breakers.
        `2026-01-01 00:00:${String(i % 7).padStart(2, '0')}`,
      );
  })();
}

describe('review regressions', () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123';

  it('redacts secrets in titles, names and labels across search, lists, detail and overview', async () => {
    setProjects([
      workspace,
      project('alpha', {
        name: `Alpha ${SECRET}`,
        agents: [{ id: 'alpha-dev', name: `Dev token=${SECRET}`, engine: 'claude-code' }],
      } as Partial<Project>),
      project('beta'),
    ]);
    addBoard('alpha');
    addCard('alpha', 'card-s', `Rotate ${SECRET} launch`, 'body');
    getDb().prepare('UPDATE kanban_cards SET labels = ? WHERE id = ?').run(SECRET, 'card-s');
    getDb()
      .prepare("INSERT INTO kanban_epics (id, board_id, name) VALUES ('epic-s', 'alpha-board', ?)")
      .run(`Launch epic ${SECRET}`);
    createPage('alpha', {
      title: `Launch ${SECRET}`,
      content: 'launch notes',
      category: 'general',
    });
    getDb()
      .prepare(
        "INSERT INTO kanban_card_comments (id, card_id, author, content) VALUES ('c1', 'card-s', ?, 'hi')",
      )
      .run(`token=${SECRET}`);
    const t = token();
    const base = `/api/organizations/${organizationId}/context`;
    const bodies = await Promise.all(
      [
        base,
        `${base}/search?q=launch`,
        `${base}/projects/alpha/cards`,
        `${base}/projects/alpha/epics`,
        `${base}/projects/alpha/wiki`,
        `${base}/projects/alpha/agents`,
        `${base}/projects/alpha/cards/card-s`,
        `${base}/projects/alpha/epics/epic-s`,
      ].map(async (url) => (await request(app()).get(url).set('X-API-Key', t).expect(200)).body),
    );
    const search = bodies[1] as { results: Array<{ type: string; title: string }> };
    expect(new Set(search.results.map((r) => r.type))).toEqual(new Set(['wiki', 'cards', 'epics']));
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(search.results.find((r) => r.type === 'cards')!.title).toContain('[redacted]');
  });

  it('bounds untrusted metadata length', async () => {
    addBoard('alpha');
    addCard('alpha', 'card-long', 'L'.repeat(5000));
    const res = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/cards`)
      .set('X-API-Key', token())
      .expect(200);
    expect(res.body.items[0].title).toHaveLength(300);
  });

  it('pages search results without repeats or gaps when relevance and recency disagree', async () => {
    // Most relevant (most matches) is oldest; least relevant is newest.
    for (let i = 0; i < 6; i++) {
      createPage('alpha', {
        title: `Page ${i}`,
        content: `${'launch '.repeat(6 - i)}${'filler '.repeat(i)}`,
        category: 'general',
      });
      getDb()
        .prepare("UPDATE wiki_pages SET updated_at = ? WHERE project_id = 'alpha' AND title = ?")
        .run(`2026-01-0${i + 1} 00:00:00`, `Page ${i}`);
    }
    const t = token();
    const seen = (await searchAll(t, 'q=launch&types=wiki', 2)).map((r) => r.title);
    expect(seen).toEqual(['Page 5', 'Page 4', 'Page 3', 'Page 2', 'Page 1', 'Page 0']);
  });

  it('follows search cursors past 1000 results without repeats or gaps', async () => {
    addBoard('alpha');
    addBoard('beta');
    bulkCards('alpha', 600, (i) => `Launch alpha ${i}`);
    bulkCards('beta', 452, (i) => `Launch beta ${i}`);
    const seen = await searchAll(token(), 'q=launch&types=cards', 50);
    expect(seen).toHaveLength(1052);
    expect(new Set(seen.map((r) => r.id)).size).toBe(1052);
    await request(app())
      .get(`/api/organizations/${organizationId}/context/search?q=launch&cursor=bogus`)
      .set('X-API-Key', token())
      .expect(400);
  });

  it('follows list and overview offsets past 5000', async () => {
    addBoard('alpha');
    bulkCards('alpha', 5052, (i) => `Card ${i}`);
    const t = token();
    const ids: string[] = [];
    let offset: number | null = 5000;
    while (offset !== null) {
      const res: { body: { items: Array<{ id: string }>; nextOffset: number | null } } =
        await request(app())
          .get(
            `/api/organizations/${organizationId}/context/projects/alpha/cards?limit=50&offset=${offset}`,
          )
          .set('X-API-Key', t)
          .expect(200);
      ids.push(...res.body.items.map((item) => item.id));
      offset = res.body.nextOffset;
    }
    expect(ids).toHaveLength(52);
    expect(new Set(ids).size).toBe(52);
    const overview = await request(app())
      .get(`/api/organizations/${organizationId}/context?offset=6000`)
      .set('X-API-Key', t)
      .expect(200);
    expect(overview.body).toMatchObject({ projects: [], nextOffset: null });
  });

  it('seals search cursors so a secret-bearing slug is never disclosed or replayable', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    createPage('alpha', { title: 'Older launch', content: 'launch', category: 'general' });
    createPage('alpha', { title: 'Newer launch', content: 'launch', category: 'general' });
    const db = getDb();
    db.prepare(
      "UPDATE wiki_pages SET slug = ?, updated_at = '2026-02-02 00:00:00' WHERE project_id = 'alpha' AND title = 'Newer launch'",
    ).run(`deploy-${secret}`);
    db.prepare(
      "UPDATE wiki_pages SET updated_at = '2026-01-01 00:00:00' WHERE project_id = 'alpha' AND title = 'Older launch'",
    ).run();
    const url = `/api/organizations/${organizationId}/context/search?q=launch&types=wiki&limit=1`;
    const t = token();
    const first = await request(app()).get(url).set('X-API-Key', t).expect(200);
    expect(first.body.results.map((r: { title: string }) => r.title)).toEqual(['Newer launch']);
    const cursor: string = first.body.nextCursor;
    expect(cursor).toBeTruthy();
    expect(JSON.stringify(first.body)).not.toContain(secret);
    expect(Buffer.from(cursor, 'base64url').toString('latin1')).not.toContain(secret);
    expect(Buffer.from(cursor, 'base64url').toString('latin1')).not.toContain('deploy-');

    const second = await request(app())
      .get(`${url}&cursor=${encodeURIComponent(cursor)}`)
      .set('X-API-Key', t)
      .expect(200);
    expect(second.body.results.map((r: { title: string }) => r.title)).toEqual(['Older launch']);
    expect(second.body.nextCursor).toBeNull();

    // Bound to caller and query: another agent, another query or a tampered cursor is refused.
    await request(app())
      .get(`${url}&cursor=${encodeURIComponent(cursor)}`)
      .set('X-API-Key', token('subset-session'))
      .expect(400);
    await request(app())
      .get(`${url.replace('q=launch', 'q=older')}&cursor=${encodeURIComponent(cursor)}`)
      .set('X-API-Key', t)
      .expect(400);
    const tampered = Buffer.from(cursor, 'base64url');
    tampered[tampered.length - 1] ^= 1;
    await request(app())
      .get(`${url}&cursor=${tampered.toString('base64url')}`)
      .set('X-API-Key', t)
      .expect(400);
  });
});

describe('redaction happens before any text processing', () => {
  const secretA = `ghp_${'A1b2C3d4E5'.repeat(4)}`; // 44 chars
  const secretB = `ghp_${'Z9y8X7w6V5'.repeat(4)}`;
  // Excerpt window is [match - 80, match + 160). Put secretA across the start boundary and
  // secretB across the end boundary, so raw slicing would leave unrecognizable fragments.
  const straddling =
    'z '.repeat(50) + secretA + ' '.repeat(60) + 'launch' + ' '.repeat(134) + secretB + ' tail';
  const fragments = [secretA.slice(20, 40), secretB.slice(4, 20), 'A1b2C3d4E5', 'Z9y8X7w6V5'];
  const noFragments = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const fragment of fragments) expect(text).not.toContain(fragment);
  };

  it('never leaks credential fragments cut by card or wiki excerpt boundaries', async () => {
    addBoard('alpha');
    addCard('alpha', 'straddle-card', 'Launch card', straddling);
    createPage('beta', { title: 'Launch page', content: straddling, category: 'general' });
    const t = token();
    for (const types of ['cards', 'wiki']) {
      const res = await request(app())
        .get(`/api/organizations/${organizationId}/context/search?q=launch&types=${types}`)
        .set('X-API-Key', t)
        .expect(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].snippet).toContain('launch');
      noFragments(res.body);
    }
  });

  it('does not let search or list filters match text inside a secret', async () => {
    addBoard('alpha');
    addCard('alpha', 'secret-card', 'Deploy notes', `push with ${secretA}`);
    createPage('alpha', { title: 'Ops', content: `key ${secretA}`, category: 'general' });
    const t = token();
    const probe = 'A1b2C3d4E5';
    for (const types of ['cards', 'wiki']) {
      const res = await request(app())
        .get(`/api/organizations/${organizationId}/context/search?q=${probe}&types=${types}`)
        .set('X-API-Key', t)
        .expect(200);
      expect(res.body.results).toEqual([]);
    }
    const list = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/cards?q=${probe}`)
      .set('X-API-Key', t)
      .expect(200);
    expect(list.body.items).toEqual([]);
    // Visible text still matches.
    const visible = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/cards?q=push%20with`)
      .set('X-API-Key', t)
      .expect(200);
    expect(visible.body.items.map((i: { id: string }) => i.id)).toEqual(['secret-card']);
  });

  it('redacts private memory and capability-context discovery', async () => {
    setProjects([
      workspace,
      project('alpha', { name: `Alpha ${secretA}` } as Partial<Project>),
      project('beta'),
    ]);
    const t = token();
    appendOrganizationMemory('assistant-session', {
      projectId: 'alpha',
      sourceRecord: `card:${secretB}`,
      content: `Remember ${secretA}`,
    });
    noFragments(readOrganizationMemory('assistant-session'));
    const server = express();
    server.use(authMiddleware);
    server.use(createCapabilityRoutes());
    const discovered = await request(server)
      .get(`/api/organizations/${organizationId}/capability-context`)
      .set('X-API-Key', t)
      .expect(200);
    expect(discovered.body.projects.map((p: { id: string }) => p.id)).toContain('alpha');
    noFragments(discovered.body);
  });

  it('treats documents with identical redacted text identically, whatever the secret', async () => {
    // The query is exactly the raw token inside one credential. A visible title word contains
    // it, so on redacted text both pages match. A raw FTS/LIKE prefilter would admit only the
    // page whose hidden credential contains the query, leaking that credential.
    const suffix = 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8';
    const pages = [
      { project: 'alpha', secret: `ghp_${suffix}` },
      { project: 'beta', secret: `ghp_${'M'.repeat(36)}` },
    ];
    addBoard('alpha');
    addBoard('beta');
    for (const { project: p, secret } of pages) {
      createPage(p, { title: `Note x${suffix}`, content: `deploy ${secret}`, category: 'general' });
      addCard(p, `${p}-same`, `Card x${suffix}`, `deploy ${secret}`);
    }
    for (const types of ['wiki', 'cards']) {
      const res = await request(app())
        .get(`/api/organizations/${organizationId}/context/search?q=${suffix}&types=${types}`)
        .set('X-API-Key', token())
        .expect(200);
      const hits = res.body.results as Array<{
        title: string;
        snippet: string;
        source: { projectId: string };
      }>;
      expect(hits.map((h) => h.source.projectId).sort()).toEqual(['alpha', 'beta']);
      expect(hits[0].title).toBe(hits[1].title);
      expect(hits[0].snippet).toBe(hits[1].snippet);
      expect(JSON.stringify(res.body)).not.toContain(`ghp_${suffix}`);
    }
  });

  it('addresses wiki pages by ID and never confirms a secret-bearing slug', async () => {
    createPage('alpha', { title: 'Ops', content: 'runbook', category: 'general' });
    getDb()
      .prepare("UPDATE wiki_pages SET slug = ? WHERE project_id = 'alpha' AND title = 'Ops'")
      .run(`ops-${secretA}`);
    const id = (
      getDb()
        .prepare("SELECT id FROM wiki_pages WHERE project_id = 'alpha' AND title = 'Ops'")
        .get() as {
        id: string;
      }
    ).id;
    const t = token();
    const base = `/api/organizations/${organizationId}/context/projects/alpha/wiki`;
    await request(app())
      .get(`${base}/${encodeURIComponent(`ops-${secretA}`)}`)
      .set('X-API-Key', t)
      .expect(404);
    const byId = await request(app()).get(`${base}/${id}`).set('X-API-Key', t).expect(200);
    expect(byId.body.record.content).toBe('runbook');
    noFragments(byId.body);
  });
});

describe('bounded output', () => {
  function manyColumns(projectId: string, count: number) {
    const db = getDb();
    db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
      `${projectId}-wide`,
      projectId,
      'Wide',
    );
    db.prepare("INSERT INTO kanban_epics (id, board_id, name) VALUES ('wide-epic', ?, 'Wide')").run(
      `${projectId}-wide`,
    );
    for (let i = 0; i < count; i++) {
      db.prepare(
        'INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
      ).run(`col-${i}`, `${projectId}-wide`, `Column ${i}`, i);
      db.prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, epic_id) VALUES (?, ?, ?, 'c', 'wide-epic')",
      ).run(`wide-card-${i}`, `col-${i}`, `${projectId}-wide`);
    }
  }

  it('caps board columns and agents per project, with explicit truncation info', async () => {
    manyColumns('alpha', 60);
    const agents = Array.from({ length: 60 }, (_, i) => ({
      id: `alpha-agent-${i}`,
      name: `Agent ${i}`,
      engine: 'claude-code',
    }));
    setProjects([workspace, project('alpha', { agents } as Partial<Project>), project('beta')]);
    const t = token();
    const res = await request(app())
      .get(`/api/organizations/${organizationId}/context?limit=1`)
      .set('X-API-Key', t)
      .expect(200);
    const alpha = res.body.projects[0];
    expect(alpha.board.columns).toHaveLength(20);
    expect(alpha.board).toMatchObject({ columnCount: 60, columnsTruncated: true, totalCards: 60 });
    expect(alpha.agents).toHaveLength(20);
    expect(alpha).toMatchObject({ agentCount: 60, agentsTruncated: true });

    const epic = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/epics/wide-epic`)
      .set('X-API-Key', t)
      .expect(200);
    expect(epic.body.record.cardsByColumn).toHaveLength(20);
    expect(epic.body.record).toMatchObject({ columnCount: 60, columnsTruncated: true });

    const server = express();
    server.use(authMiddleware);
    server.use(createCapabilityRoutes());
    const discovered = await request(server)
      .get(`/api/organizations/${organizationId}/capability-context`)
      .set('X-API-Key', t)
      .expect(200);
    const found = discovered.body.projects.find((p: { id: string }) => p.id === 'alpha');
    expect(found.agents).toHaveLength(20);
    expect(found).toMatchObject({ agentCount: 60, agentsTruncated: true });
    await request(server)
      .get(`/api/organizations/${organizationId}/capability-context?limit=100`)
      .set('X-API-Key', t)
      .expect(400);
  });

  it('paginates the per-organization Server summary while totals cover everything', async () => {
    for (let i = 0; i < 24; i++) {
      const extra = createBusinessOrganization({
        serverId: 'default',
        name: `Extra ${i}`,
        createdBy: 'person',
      }).id;
      attachBusinessOrganizationProject('default', extra, 'alpha');
    }
    const seen: string[] = [];
    let offset: number | null = 0;
    let totals: { organizations: number; linkedProjects: number } | null = null;
    while (offset !== null) {
      const res: {
        body: {
          organizations: number;
          linkedProjects: number;
          perOrganization: Array<{ organizationId: string }>;
          nextOffset: number | null;
        };
      } = await request(app())
        .get(`/api/organizations/summary?limit=10&offset=${offset}`)
        .set('X-Test-User', 'person')
        .expect(200);
      expect(res.body.perOrganization.length).toBeLessThanOrEqual(10);
      totals = res.body;
      seen.push(...res.body.perOrganization.map((o) => o.organizationId));
      offset = res.body.nextOffset;
    }
    expect(totals!.organizations).toBe(seen.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(25);
    expect(totals!.linkedProjects).toBe(2);
  });

  it('structurally caps every output array as a backstop', () => {
    const out = sanitizeContextOutput({
      nested: { list: Array.from({ length: 500 }, (_, i) => i) },
    });
    expect(out.nested.list).toHaveLength(50);
  });
});

describe('bounded search work', () => {
  type Page = {
    body: { results: Array<{ id: string }>; partial: boolean; nextCursor: string | null };
  };
  async function walk(query: string) {
    const pages: Page['body'][] = [];
    let cursor: string | null = '';
    const t = token();
    while (cursor !== null) {
      const after: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res: Page = await request(app())
        .get(`/api/organizations/${organizationId}/context/search?${query}${after}`)
        .set('X-API-Key', t)
        .expect(200);
      pages.push(res.body);
      cursor = res.body.nextCursor;
    }
    return pages;
  }

  it('stops an unmatched query at the row budget and resumes exactly where it stopped', async () => {
    addBoard('alpha');
    bulkCards('alpha', 7000, (i) => `Card ${i}`);
    // The only match is the oldest row, so it is examined last.
    getDb()
      .prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, updated_at) VALUES ('needle', 'alpha-todo', 'alpha-board', 'Needle here', '2000-01-01 00:00:00')",
      )
      .run();
    const pages = await walk('q=needle&types=cards&limit=50');
    // 7001 rows at 2000 rows per request: three budget-limited pages, then the last one.
    expect(pages).toHaveLength(4);
    expect(pages.slice(0, 3).every((p) => p.partial && p.results.length === 0)).toBe(true);
    expect(pages[3]).toMatchObject({ partial: false, nextCursor: null });
    expect(pages.flatMap((p) => p.results.map((r) => r.id))).toEqual(['needle']);
  });

  /** Characters actually materialized from SQLite while `run` executes. */
  async function loadedChars(run: () => Promise<unknown>) {
    const db = getDb();
    const prepare = db.prepare.bind(db);
    let chars = 0;
    const count = (value: unknown) => {
      for (const row of Array.isArray(value) ? value : [value])
        if (row && typeof row === 'object')
          for (const field of Object.values(row))
            if (typeof field === 'string') chars += field.length;
    };
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      const get = statement.get.bind(statement);
      const all = statement.all.bind(statement);
      Object.assign(statement, {
        get: (...args: unknown[]) => {
          const row = get(...args);
          count(row);
          return row;
        },
        all: (...args: unknown[]) => {
          const rows = all(...args);
          count(rows);
          return rows;
        },
      });
      return statement;
    }) as typeof db.prepare);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return chars;
  }

  it('bounds the text loaded from storage per request, not just the rows matched', async () => {
    for (let i = 0; i < 25; i++)
      createPage('alpha', { title: `Big ${i}`, content: 'x'.repeat(200_000), category: 'general' });
    clearOrganizationContextCache();
    let first: Page['body'] | undefined;
    const chars = await loadedChars(async () => {
      first = (
        await request(app())
          .get(`/api/organizations/${organizationId}/context/search?q=nomatch&types=wiki&limit=10`)
          .set('X-API-Key', token())
          .expect(200)
      ).body;
    });
    expect(first).toMatchObject({ partial: true, results: [] });
    expect(chars).toBeLessThanOrEqual(SCAN_CHAR_BUDGET + 50_000);
    const pages = await walk('q=nomatch&types=wiki&limit=10');
    expect(pages.at(-1)).toMatchObject({ partial: false, nextCursor: null });
  });

  it('never reads an oversized field, searching the rest of the record', async () => {
    createPage('alpha', {
      title: 'Huge findme',
      content: `contentneedle ${'x'.repeat(3_000_000)}`,
      category: 'general',
    });
    clearOrganizationContextCache();
    let found: Page['body'] | undefined;
    const chars = await loadedChars(async () => {
      found = (
        await request(app())
          .get(`/api/organizations/${organizationId}/context/search?q=findme&types=wiki`)
          .set('X-API-Key', token())
          .expect(200)
      ).body;
    });
    expect(found!.results).toHaveLength(1);
    expect(chars).toBeLessThan(50_000);
    // Policy: a field over FIELD_LOAD_MAX bytes is never read, so its text is not searchable.
    const inContent = await walk('q=contentneedle&types=wiki');
    expect(inContent.flatMap((p) => p.results)).toEqual([]);
    const id = (
      getDb().prepare("SELECT id FROM wiki_pages WHERE title = 'Huge findme'").get() as {
        id: string;
      }
    ).id;
    const detail = await request(app())
      .get(`/api/organizations/${organizationId}/context/projects/alpha/wiki/${id}`)
      .set('X-API-Key', token())
      .expect(200);
    expect(detail.body.record).toMatchObject({ content: '', truncated: true });
  });

  it('never makes SQLite read a large text column except header-only or behind a size guard', async () => {
    // Counting strings returned to JavaScript cannot see SQLite's own reads, so inspect the
    // compiled bytecode of every statement these reads issue.
    const heavy: Record<string, string[]> = {
      wiki_pages: ['title', 'slug', 'content', 'category'],
      kanban_cards: ['title', 'description', 'labels', 'assignee', 'pr_url'],
      kanban_epics: ['name', 'description'],
      kanban_phases: ['name'],
      kanban_columns: ['name'],
      kanban_card_comments: ['author', 'content'],
      sessions: ['name', 'last_turn_error'],
      messages: ['content'],
    };
    const db = getDb();
    const tableByRoot = new Map(
      (
        db
          .prepare("SELECT tbl_name, rootpage FROM sqlite_schema WHERE type = 'table'")
          .all() as Array<{
          tbl_name: string;
          rootpage: number;
        }>
      ).map((t) => [t.rootpage, t.tbl_name]),
    );
    const heavyCids = new Map(
      Object.entries(heavy).map(([table, names]) => [
        table,
        new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ cid: number; name: string }>)
            .filter((c) => names.includes(c.name))
            .map((c) => c.cid),
        ),
      ]),
    );

    addBoard('alpha');
    addCard('alpha', 'card-x', 'Launch', 'body');
    getDb()
      .prepare(
        "INSERT INTO kanban_epics (id, board_id, name) VALUES ('epic-x', 'alpha-board', 'Launch')",
      )
      .run();
    createPage('alpha', { title: 'Launch', content: 'launch', category: 'general' });
    session('mine', 'alpha-dev', 'person');
    const wikiId = (
      getDb().prepare("SELECT id FROM wiki_pages WHERE project_id = 'alpha'").get() as {
        id: string;
      }
    ).id;
    clearOrganizationContextCache();

    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      for (const method of ['get', 'all'] as const) {
        const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
        Object.assign(statement, {
          [method]: (...args: unknown[]) => {
            // Only this module's statements (auth and capability checks run their own).
            const caller = (new Error().stack ?? '')
              .split('\n')
              .slice(1)
              .find((frame) => !frame.includes('organization-context.test.ts'));
            if (caller?.includes('organization-context.ts:')) statements.push({ sql, args });
            return original(...args);
          },
        });
      }
      return statement;
    }) as typeof db.prepare);
    const t = token();
    const base = `/api/organizations/${organizationId}/context`;
    try {
      for (const url of [
        `${base}/search?q=launch`,
        `${base}/projects/alpha/cards?q=launch`,
        `${base}/projects/alpha/wiki?q=launch`,
        `${base}/projects/alpha/cards?column=to%20do`,
        `${base}/projects/alpha/cards`,
        `${base}/projects/alpha/epics`,
        `${base}/projects/alpha/phases`,
        `${base}/projects/alpha/wiki`,
        `${base}/projects/alpha/sessions`,
        `${base}/projects/alpha/cards/card-x`,
        `${base}/projects/alpha/epics/epic-x`,
        `${base}/projects/alpha/wiki/${wikiId}`,
        `${base}/projects/alpha/sessions/mine`,
        base,
      ])
        await request(app()).get(url).set('X-API-Key', t).expect(200);
    } finally {
      spy.mockRestore();
    }

    const BYTELENARG = 0xc0;
    const jumps = new Set(['Gt', 'Ge', 'Lt', 'Le', 'Eq', 'Ne', 'If', 'IfNot', 'IsNull', 'NotNull']);
    let checked = 0;
    for (const { sql, args } of statements) {
      if (!/^\s*SELECT/i.test(sql)) continue;
      const program = db.prepare(`EXPLAIN ${sql}`).all(...args) as Array<{
        addr: number;
        opcode: string;
        p1: number;
        p2: number;
        p5: number;
      }>;
      const cursorTable = new Map<number, string>();
      for (const op of program)
        if (op.opcode === 'OpenRead' && tableByRoot.has(op.p2))
          cursorTable.set(op.p1, tableByRoot.get(op.p2)!);
      for (const op of program) {
        if (op.opcode !== 'Column') continue;
        const table = cursorTable.get(op.p1);
        if (!table || !heavyCids.get(table)?.has(op.p2)) continue;
        checked++;
        if ((op.p5 & BYTELENARG) === BYTELENARG) continue; // header-only size
        // A full read must be guarded: an earlier header-only size read of the same column
        // followed by a conditional jump that skips past this read.
        const guarded = program.some(
          (size) =>
            size.addr < op.addr &&
            size.opcode === 'Column' &&
            size.p1 === op.p1 &&
            size.p2 === op.p2 &&
            (size.p5 & BYTELENARG) === BYTELENARG &&
            program.some(
              (jump) =>
                jump.addr > size.addr &&
                jump.addr < op.addr &&
                jumps.has(jump.opcode) &&
                jump.p2 > op.addr,
            ),
        );
        expect(guarded, `unguarded read of ${table} column ${op.p2} in: ${sql}`).toBe(true);
        expect(sql, 'scan key queries must never read text').not.toMatch(/AS sortKey/);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('bounds unmatched filtered lists and continues them with a cursor', async () => {
    addBoard('alpha');
    bulkCards('alpha', 7000, (i) => `Card ${i}`);
    getDb()
      .prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, updated_at) VALUES ('needle', 'alpha-todo', 'alpha-board', 'Needle here', '2000-01-01 00:00:00')",
      )
      .run();
    const t = token();
    const base = `/api/organizations/${organizationId}/context/projects/alpha/cards`;
    const pages: Array<{
      items: Array<{ id: string }>;
      partial: boolean;
      nextCursor: string | null;
    }> = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const after: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res: { body: (typeof pages)[number] } = await request(app())
        .get(`${base}?q=needle&limit=20${after}`)
        .set('X-API-Key', t)
        .expect(200);
      pages.push(res.body);
      cursor = res.body.nextCursor;
    }
    expect(pages).toHaveLength(4);
    expect(pages.slice(0, 3).every((p) => p.partial && p.items.length === 0)).toBe(true);
    expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(['needle']);
    await request(app()).get(`${base}?q=needle&offset=20`).set('X-API-Key', t).expect(400);
    await request(app()).get(`${base}?cursor=abc`).set('X-API-Key', t).expect(400);
    // An unmatched column filter is bounded the same way and continues to completion.
    const columnPages: Array<{ items: unknown[]; partial: boolean }> = [];
    let columnCursor: string | null = '';
    while (columnCursor !== null) {
      const after: string = columnCursor ? `&cursor=${encodeURIComponent(columnCursor)}` : '';
      const res: {
        body: { items: unknown[]; partial: boolean; nextCursor: string | null };
      } = await request(app())
        .get(`${base}?column=done&limit=5${after}`)
        .set('X-API-Key', t)
        .expect(200);
      columnPages.push(res.body);
      columnCursor = res.body.nextCursor;
    }
    expect(columnPages[0].partial).toBe(true);
    expect(columnPages.flatMap((p) => p.items)).toEqual([]);
  });

  describe('large metadata with an unmatched query', () => {
    const ROWS = 250;
    // Under METADATA_READ_MAX, so SQLite does read it: the scan must price it.
    const BIG = 'm'.repeat(15_000);
    async function firstPage(url: string) {
      clearOrganizationContextCache();
      let body: { partial: boolean; nextCursor: string | null } | undefined;
      const chars = await loadedChars(async () => {
        body = (await request(app()).get(url).set('X-API-Key', token()).expect(200)).body;
      });
      return { body: body!, chars };
    }

    it('prices wiki slugs in search', async () => {
      const insert = getDb().prepare(
        "INSERT INTO wiki_pages (id, project_id, title, slug, content) VALUES (?, 'alpha', 't', ?, 'c')",
      );
      getDb().transaction(() => {
        for (let i = 0; i < ROWS; i++) insert.run(`w${i}`, `${i}-${BIG}`);
      })();
      const { body, chars } = await firstPage(
        `/api/organizations/${organizationId}/context/search?q=nomatch&types=wiki`,
      );
      // 250 x 100 KB of slug is 25 MB; the 2 MB budget must stop well before reading it all.
      expect(body.partial).toBe(true);
      expect(chars).toBeLessThanOrEqual(SCAN_CHAR_BUDGET);
    });

    it('prices wiki categories in filtered lists', async () => {
      const insert = getDb().prepare(
        "INSERT INTO wiki_pages (id, project_id, title, slug, content, category) VALUES (?, 'alpha', 't', ?, 'c', ?)",
      );
      getDb().transaction(() => {
        for (let i = 0; i < ROWS; i++) insert.run(`w${i}`, `s${i}`, BIG);
      })();
      const { body, chars } = await firstPage(
        `/api/organizations/${organizationId}/context/projects/alpha/wiki?q=nomatch`,
      );
      expect(body.partial).toBe(true);
      expect(chars).toBeLessThanOrEqual(SCAN_CHAR_BUDGET);
    });

    it('prices card metadata in filtered lists', async () => {
      addBoard('alpha');
      getDb().prepare("UPDATE kanban_columns SET name = ? WHERE id = 'alpha-todo'").run(BIG);
      const insert = getDb().prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, assignee, pr_url) VALUES (?, 'alpha-todo', 'alpha-board', 't', ?, ?)",
      );
      getDb().transaction(() => {
        for (let i = 0; i < ROWS; i++) insert.run(`c${i}`, BIG, BIG);
      })();
      const { body, chars } = await firstPage(
        `/api/organizations/${organizationId}/context/projects/alpha/cards?q=nomatch`,
      );
      expect(body.partial).toBe(true);
      expect(chars).toBeLessThanOrEqual(SCAN_CHAR_BUDGET);
    });

    it('treats an unpriced row as costing the whole budget', () => {
      expect(admissibleCost(1234)).toBe(1234);
      expect(admissibleCost(0)).toBe(0);
      for (const bad of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY, '10'])
        expect(admissibleCost(bad)).toBe(SCAN_CHAR_BUDGET);
    });

    it('prices card descriptions when every metadata field is NULL', async () => {
      addBoard('alpha');
      const insert = getDb().prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, description, labels, assignee, pr_url) VALUES (?, 'alpha-todo', 'alpha-board', 't', ?, NULL, NULL, NULL)",
      );
      getDb().transaction(() => {
        for (let i = 0; i < ROWS; i++) insert.run(`n${i}`, BIG);
      })();
      const { body, chars } = await firstPage(
        `/api/organizations/${organizationId}/context/projects/alpha/cards?q=nomatch`,
      );
      // NULL metadata must add zero, not erase the row's cost: 250 x 15 KB stays over budget.
      expect(body.partial).toBe(true);
      expect(chars).toBeLessThanOrEqual(SCAN_CHAR_BUDGET);
    });

    it('never reads metadata over METADATA_READ_MAX in plain list pages', async () => {
      addBoard('alpha');
      const huge = 'h'.repeat(200_000);
      const insert = getDb().prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, assignee, pr_url) VALUES (?, 'alpha-todo', 'alpha-board', ?, ?, ?)",
      );
      getDb().transaction(() => {
        for (let i = 0; i < 50; i++) insert.run(`h${i}`, huge, huge, huge);
      })();
      clearOrganizationContextCache();
      let items: Array<{ title: string | null; assignee: string | null }> = [];
      const chars = await loadedChars(async () => {
        items = (
          await request(app())
            .get(`/api/organizations/${organizationId}/context/projects/alpha/cards?limit=50`)
            .set('X-API-Key', token())
            .expect(200)
        ).body.items;
      });
      expect(items).toHaveLength(50);
      expect(items.every((item) => !item.title && !item.assignee)).toBe(true);
      expect(chars).toBeLessThan(50_000);
    });
  });
});

describe('column filter', () => {
  it('finds a matching column beyond the first 500 and covers duplicate names', async () => {
    addBoard('alpha');
    const db = getDb();
    const insertColumn = db.prepare(
      "INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, 'alpha-board', ?, ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 600; i++)
        insertColumn.run(`col-${String(i).padStart(3, '0')}`, `Lane ${i}`, i + 2);
      // Sorted by ID, both "Target" columns fall beyond the first 500.
      insertColumn.run('col-998', 'Target', 700);
      insertColumn.run('col-999', 'target', 701);
    })();
    const insertCard = db.prepare(
      "INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES (?, ?, 'alpha-board', 't')",
    );
    insertCard.run('in-first', 'col-998');
    insertCard.run('in-second', 'col-999');
    insertCard.run('elsewhere', 'col-001');
    const t = token();
    const ids: string[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const after: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res: { body: { items: Array<{ id: string }>; nextCursor: string | null } } =
        await request(app())
          .get(
            `/api/organizations/${organizationId}/context/projects/alpha/cards?column=TARGET&limit=1${after}`,
          )
          .set('X-API-Key', t)
          .expect(200);
      ids.push(...res.body.items.map((item) => item.id));
      cursor = res.body.nextCursor;
    }
    expect(ids.sort()).toEqual(['in-first', 'in-second']);
  });
});
