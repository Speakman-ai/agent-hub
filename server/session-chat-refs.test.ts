/**
 * Tagged items in a session turn: the agent gets a block describing each ref
 * the sender can see, and nothing about refs they cannot.
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
const { buildRefViewer } = await import('./hub-chat-refs.js');
const { appendSessionRefContext, buildSessionRefContext } = await import('./session-chat-refs.js');

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

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-chat-refs-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (id, agent_id, name, owner_user_id, created_at, updated_at, state)
     VALUES ('s-alice', 'web-dev', 'Fix login redirect', ?, '2026-10-01', '2026-10-01', 'idle')`,
  ).run(alice);
  db.prepare(
    `INSERT INTO pull_requests (id, project_id, number, title, head_branch, base_branch,
       head_sha, status, author, created_at, updated_at)
     VALUES ('pr1', 'web', 42, 'Retry webhook delivery', 'feat', 'main', 'abc', 'open', 'alice', 1, 1)`,
  ).run();
});

const BODY =
  'Look at @[web#42](pr:web#42) and @[Fix login redirect](session:s-alice), ' +
  'not @[ghost](card:missing). Again @[web#42](pr:web#42).';

describe('buildSessionRefContext', () => {
  it('describes each visible ref once', () => {
    const block = buildSessionRefContext(lookups, buildRefViewer(alice, 'acme', false), BODY);
    expect(block).toContain('<tagged-items>');
    expect(block).toContain(
      '- Pull request web#42 "Retry webhook delivery" · project web · number 42 · status open',
    );
    expect(block).toContain(
      '- Session "Fix login redirect" · id s-alice · agent Web Dev · project web · state idle',
    );
    expect(block).not.toContain('ghost');
    expect(block.match(/Pull request/g)).toHaveLength(1);
  });

  it('leaves out refs the sender cannot open', () => {
    const block = buildSessionRefContext(lookups, buildRefViewer(bob, 'acme', false), BODY);
    expect(block).toContain('Pull request web#42');
    expect(block).not.toContain('Fix login redirect');
    expect(block).not.toContain('s-alice');
  });

  it('ignores tokens inside code and plain text', () => {
    const viewer = buildRefViewer(alice, 'acme', false);
    expect(buildSessionRefContext(lookups, viewer, 'no refs here')).toBe('');
    expect(buildSessionRefContext(lookups, viewer, 'Use `@[web#42](pr:web#42)` literally.')).toBe(
      '',
    );
  });
});

describe('appendSessionRefContext', () => {
  it('appends the block to the CLI turn and leaves untagged turns alone', () => {
    const args = { orgId: () => 'acme', localBypass: false, lookups, senderUserId: alice };
    const out = appendSessionRefContext({ ...args, cliContent: BODY, content: BODY });
    expect(out.startsWith(`${BODY}\n\n<tagged-items>`)).toBe(true);
    expect(appendSessionRefContext({ ...args, cliContent: 'hi', content: 'hi' })).toBe('hi');
  });

  it('skips the block when there is no sender identity', () => {
    const out = appendSessionRefContext({
      cliContent: BODY,
      content: BODY,
      senderUserId: null,
      orgId: () => 'acme',
      localBypass: false,
      lookups,
    });
    expect(out).toBe(BODY);
  });
});
