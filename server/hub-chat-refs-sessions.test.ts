/**
 * `#` autocomplete for sessions: readability is decided per session, so the
 * search must keep paging until it finds readable matches instead of
 * filtering a fixed window of the newest ones.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { Project } from './types.js';

// Owner-only reads, as on an auth-enabled hub for a plain User.
vi.mock('./session-ownership.js', async () => {
  const { getDb } = await import('./db.js');
  return {
    userCanReadSession: (req: { authUserId?: string } | undefined, sessionId: string) => {
      const row = getDb()
        .prepare('SELECT owner_user_id FROM sessions WHERE id = ?')
        .get(sessionId) as { owner_user_id: string | null } | undefined;
      return !!row && !!req?.authUserId && row.owner_user_id === req.authUserId;
    },
  };
});

const { initDb, getDb } = await import('./db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { createMembership } = await import('./memberships-store.js');
const { buildRefViewer, searchRefs } = await import('./hub-chat-refs.js');

let alice = '';
let bob = '';
const projects: Project[] = [
  {
    id: 'web',
    name: 'Web',
    cwd: '/tmp',
    agents: [{ id: 'web-dev', name: 'Web Dev', engine: 'claude-code' }],
  } as Project,
];
const lookups = {
  findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
  getProjects: () => projects,
};

function addSession(id: string, owner: string, name: string, updatedAt: string) {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_id, name, owner_user_id, created_at, updated_at)
       VALUES (?, 'web-dev', ?, ?, ?, ?)`,
    )
    .run(id, name, owner, updatedAt, updatedAt);
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-refs-sessions-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
});

function sessionHits(viewer: string, q: string) {
  return searchRefs(lookups, buildRefViewer(viewer, 'acme', false), '#', q).filter(
    (s) => s.kind === 'session',
  );
}

describe('session autocomplete', () => {
  it('finds a readable session behind 24 newer ones the viewer cannot read', () => {
    for (let i = 0; i < 24; i++) {
      addSession(
        `bob-${i}`,
        bob,
        `deploy fix ${i}`,
        `2026-10-13 12:${String(i).padStart(2, '0')}:00`,
      );
    }
    addSession('alice-old', alice, 'deploy fix mine', '2026-10-01 09:00:00');

    expect(sessionHits(alice, 'deploy').map((s) => s.targetId)).toEqual(['alice-old']);
    expect(sessionHits(bob, 'deploy')).toHaveLength(8);
  });

  it('keeps paging past many unreadable pages and stops when matches run out', () => {
    for (let i = 0; i < 130; i++) {
      addSession(
        `bob-${i}`,
        bob,
        `triage ${i}`,
        `2026-10-13 10:00:${String(i % 60).padStart(2, '0')}`,
      );
    }
    addSession('alice-1', alice, 'triage mine', '2026-09-01 09:00:00');
    expect(sessionHits(alice, 'triage').map((s) => s.targetId)).toEqual(['alice-1']);
    expect(sessionHits(alice, 'nothing matches')).toEqual([]);
  });
});
