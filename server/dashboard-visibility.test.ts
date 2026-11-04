/**
 * The org dashboard must only surface data from projects the caller can view
 * (`canViewProject`). The shared integration harness runs in no-auth mode,
 * which bypasses visibility, so this mounts the router on an ad-hoc app and
 * stamps real JWT-style claims per request.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import config from './config.js';
import { initDb, getDb, getStmts } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId } from './orgs.js';
import { createMembership } from './memberships-store.js';
import { initProjects, getProjects, findAgent, findProject, allAgents } from './project-model.js';
import createDashboardRoutes from './routes/dashboard.js';
import type { RouteDeps } from './types.js';
import type { AuthenticatedRequest } from './auth.js';

const PRIVATE_PROJECT = 'dashvis-private';
const SHARED_PROJECT = 'dashvis-shared';
const PRIVATE_AGENT = 'dashvis-private-agent';
const SHARED_AGENT = 'dashvis-shared-agent';
const PRIVATE_SESSION = 'dashvis-private-session';
const SHARED_SESSION = 'dashvis-shared-session';

function agent(id: string) {
  return {
    id,
    name: id,
    engine: 'claude-code',
    model: 'claude-sonnet-4-5',
    systemPrompt: '',
    color: '#abc',
    heartbeat: { enabled: false, interval: '', prompt: '' },
  };
}

function seedProjectRows(projectId: string, agentId: string, sessionId: string, tag: string) {
  const db = getDb();
  db.prepare('INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?)').run(
    sessionId,
    agentId,
    `${tag} session`,
  );
  db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
    `${projectId}-board`,
    projectId,
    'Board',
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name) VALUES (?, ?, ?)').run(
    `${projectId}-col`,
    `${projectId}-board`,
    `${tag} column`,
  );
  db.prepare(
    `INSERT INTO kanban_cards (id, column_id, board_id, title, priority)
     VALUES (?, ?, ?, ?, 'urgent')`,
  ).run(`${projectId}-card`, `${projectId}-col`, `${projectId}-board`, `${tag} card`);
  db.prepare(
    `INSERT INTO escalations (id, project_id, type, title) VALUES (?, ?, 'blocker', ?)`,
  ).run(`${projectId}-esc`, projectId, `${tag} escalation`);
  db.prepare(
    `INSERT INTO pr_creation_logs (id, project_id, pr_url, pr_title, author_agent)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`${projectId}-prlog`, projectId, `https://x/${projectId}/1`, `${tag} pr`, agentId);
}

function app(userId: string, role: 'Owner' | 'User') {
  const a = express();
  a.use((req, _res, next) => {
    Object.assign(req as AuthenticatedRequest, { authUserId: userId, authRole: role });
    next();
  });
  a.use(
    createDashboardRoutes({
      stmts: getStmts(),
      config,
      findAgent,
      findProject,
      getProjects,
      allAgents,
    } as unknown as RouteDeps),
  );
  return a;
}

beforeEach(() => {
  initOrgsDb();
  setActiveOrgId('default');
  initDb(config.dataDir);
  const db = getDb();
  for (const t of [
    'sessions',
    'kanban_cards',
    'kanban_columns',
    'kanban_boards',
    'escalations',
    'pr_creation_logs',
    'active_tasks',
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }
  writeFileSync(
    path.join(config.dataDir, 'projects.json'),
    JSON.stringify([
      {
        id: PRIVATE_PROJECT,
        name: 'Private',
        cwd: '/tmp',
        visibility: 'private',
        ownerUserId: 'dv-owner',
        agents: [agent(PRIVATE_AGENT)],
      },
      { id: SHARED_PROJECT, name: 'Shared', cwd: '/tmp', agents: [agent(SHARED_AGENT)] },
    ]),
  );
  initProjects(config.dataDir);
  for (const user of ['dv-owner', 'dv-member']) {
    getOrgsDb()
      .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(user, user, 'unused');
    createMembership(user, 'default', 'User');
  }
  seedProjectRows(PRIVATE_PROJECT, PRIVATE_AGENT, PRIVATE_SESSION, 'Secret');
  seedProjectRows(SHARED_PROJECT, SHARED_AGENT, SHARED_SESSION, 'Open');
});

describe('GET /api/orgs/:id/dashboard project visibility', () => {
  it('hides sessions, cards, and activity from a private project the member cannot view', async () => {
    const res = await request(app('dv-member', 'User'))
      .get('/api/orgs/default/dashboard')
      .expect(200);
    const body = res.body;
    const json = JSON.stringify(body);

    expect(body.activeSessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      SHARED_SESSION,
    ]);
    expect(json).not.toContain(PRIVATE_SESSION);
    expect(json).not.toContain(PRIVATE_AGENT);
    expect(json).not.toContain(PRIVATE_PROJECT);
    expect(json).not.toContain('Secret');

    expect(body.headline).toMatchObject({
      projects: 1,
      agents: 1,
      sessions: 1,
      activeSessions: 1,
      openCards: 1,
      escalations: 1,
    });
    expect(body.kanban).toMatchObject({ totalBoards: 1, totalCards: 1 });
    expect(body.kanban.byPriority.urgent).toBe(1);
  });

  it('still shows the private project to its owner', async () => {
    const res = await request(app('dv-owner', 'User'))
      .get('/api/orgs/default/dashboard')
      .expect(200);
    const ids = res.body.activeSessions.map((s: { sessionId: string }) => s.sessionId).sort();
    expect(ids).toEqual([PRIVATE_SESSION, SHARED_SESSION].sort());
    expect(res.body.headline).toMatchObject({ projects: 2, sessions: 2, openCards: 2 });
    expect(JSON.stringify(res.body.recentActivity)).toContain('Secret');
  });
});
