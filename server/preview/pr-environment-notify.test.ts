import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolvePrEnvironmentNotifyUserIds } from './pr-environment-notify.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pull_requests (project_id TEXT, number INTEGER, author TEXT, head_branch TEXT);
    CREATE TABLE sessions (id TEXT, agent_id TEXT, owner_user_id TEXT, worktree_branch TEXT);
  `);
  return db;
}

function addSession(
  db: Database.Database,
  id: string,
  agent: string,
  owner: string,
  branch: string,
) {
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, agent, owner, branch);
}

const users = new Set(['alice', 'bob', 'carol']);
const agentProjects: Record<string, string> = { dev1: 'p1', dev2: 'p2' };
const deps = (db: Database.Database) => ({
  db,
  isUser: (id: string) => users.has(id),
  agentProjectId: (agentId: string) => agentProjects[agentId] ?? null,
});

describe('resolvePrEnvironmentNotifyUserIds', () => {
  it('addresses the native PR author and the head branch session owner', () => {
    const db = makeDb();
    db.prepare('INSERT INTO pull_requests VALUES (?, ?, ?, ?)').run('p1', 7, 'alice', 'feat');
    addSession(db, 's1', 'dev1', 'bob', 'feat');
    addSession(db, 's2', 'dev1', 'carol', 'other');
    expect(
      resolvePrEnvironmentNotifyUserIds(deps(db), {
        projectId: 'p1',
        source: 'native',
        prNumber: 7,
        headBranch: null,
      }).sort(),
    ).toEqual(['alice', 'bob']);
  });

  it('uses only the branch session for GitHub PRs, and drops non-users', () => {
    const db = makeDb();
    db.prepare('INSERT INTO pull_requests VALUES (?, ?, ?, ?)').run('p1', 7, 'alice', 'feat');
    addSession(db, 's1', 'dev1', 'bob', 'feat');
    addSession(db, 's2', 'dev1', 'local', 'feat');
    expect(
      resolvePrEnvironmentNotifyUserIds(deps(db), {
        projectId: 'p1',
        source: 'github',
        prNumber: 7,
        headBranch: 'feat',
      }),
    ).toEqual(['bob']);
  });

  it('ignores sessions in other projects that share the branch name', () => {
    const db = makeDb();
    addSession(db, 's1', 'dev1', 'bob', 'main-fix');
    addSession(db, 's2', 'dev2', 'carol', 'main-fix');
    addSession(db, 's3', 'gone-agent', 'alice', 'main-fix');
    expect(
      resolvePrEnvironmentNotifyUserIds(deps(db), {
        projectId: 'p1',
        source: 'github',
        prNumber: 3,
        headBranch: 'main-fix',
      }),
    ).toEqual(['bob']);
    // Only other projects match: nobody is addressed, so the caller falls
    // back to project viewers.
    expect(
      resolvePrEnvironmentNotifyUserIds(deps(db), {
        projectId: 'p3',
        source: 'github',
        prNumber: 3,
        headBranch: 'main-fix',
      }),
    ).toEqual([]);
  });

  it('returns nobody when tables are missing', () => {
    const db = new Database(':memory:');
    expect(
      resolvePrEnvironmentNotifyUserIds(deps(db), {
        projectId: 'p1',
        source: 'native',
        prNumber: 7,
        headBranch: 'feat',
      }),
    ).toEqual([]);
  });
});
