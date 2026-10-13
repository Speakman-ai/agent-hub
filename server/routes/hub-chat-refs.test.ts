/**
 * Mentions and #references in Agent Hub chat: the server re-resolves every
 * `@[label](kind:id)` token as the author, flattens the ones they cannot see,
 * stores the rest as refs (driving mention counts), and resolves refs per
 * viewer for chips.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { Project, RouteDeps } from '../types.js';

const { initDb, getDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const { default: createHubChatRoutes } = await import('./hub-chat.js');
const { parseRefTokens, formatRefToken, parsePrTarget } = await import('../hub-chat-refs.js');
const { locateChatMarkdownCode } = await import('../hub-chat-markdown.js');

let alice = '';
let bob = '';
let carol = '';
let mallory = '';
let projects: Project[] = [];

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: id.toUpperCase(),
    cwd: '/tmp',
    agents: [{ id: `${id}-dev`, name: `${id} Dev`, engine: 'claude-code' }],
    ...extra,
  } as Project;
}

function as(userId: string | null): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    if (userId) {
      areq.authUserId = userId;
      areq.authUser = 'x';
      areq.authRole = 'User';
    }
    areq.authOrgId = 'acme';
    next();
  });
  app.use(
    createHubChatRoutes({
      stmts: {},
      findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
      getProjects: () => projects,
    } as unknown as RouteDeps),
  );
  return app;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-refs-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  createOrg({ id: 'other', name: 'Other', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  carol = createUser({ username: 'carol', passwordHash: 'x' }).id;
  mallory = createUser({ username: 'mallory', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
  createMembership(carol, 'acme', 'User');
  createMembership(mallory, 'other', 'User');

  // "web" is shared; "vault" is private to bob.
  projects = [project('web'), project('vault', { visibility: 'private', ownerUserId: bob })];
  const db = getDb();
  db.prepare(
    'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
  ).run('b-web', 'web', 'Board', 'WEB');
  db.prepare(
    'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
  ).run('b-vault', 'vault', 'Board', 'VLT');
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
    'col-web',
    'b-web',
    'In Progress',
    1,
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
    'col-vault',
    'b-vault',
    'To Do',
    0,
  );
  db.prepare('INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES (?, ?, ?, ?)').run(
    'card-web',
    'col-web',
    'b-web',
    'Fix login timeout',
  );
  db.prepare('INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES (?, ?, ?, ?)').run(
    'card-vault',
    'col-vault',
    'b-vault',
    'Secret roadmap',
  );
  const now = Date.now();
  db.prepare(
    `INSERT INTO pull_requests (id, project_id, number, title, head_branch, base_branch, head_sha, status, author, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'h', 'main', 'sha', 'open', 'alice', ?, ?)`,
  ).run('pr-web-7', 'web', 7, 'Add login retry', now, now);
  db.prepare(
    `INSERT INTO pull_requests (id, project_id, number, title, head_branch, base_branch, head_sha, status, author, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'h', 'main', 'sha', 'merged', 'bob', ?, ?)`,
  ).run('pr-vault-3', 'vault', 3, 'Secret change', now, now);
  db.prepare('INSERT INTO support_tickets (id, project_id, subject) VALUES (?, ?, ?)').run(
    'tkt-web',
    'web',
    'Login broken on Safari',
  );
  db.prepare('INSERT INTO support_tickets (id, project_id, subject) VALUES (?, ?, ?)').run(
    'tkt-vault',
    'vault',
    'Vault ticket',
  );
});

async function channelWith(owner: string, members: string[]): Promise<string> {
  const res = await request(as(owner))
    .post('/api/chat/channels')
    .send({ name: 'general', memberUserIds: members })
    .expect(201);
  return res.body.channel.id;
}

function post(user: string, channelId: string, body: string) {
  return request(as(user)).post(`/api/chat/channels/${channelId}/messages`).send({ body });
}

describe('token helpers', () => {
  it('parses tokens of known kinds and skips the rest', () => {
    const toks = parseRefTokens(
      'hi @[bob](user:u1) and @[x](widget:9) see @[WEB-1](card:c1)',
      locateChatMarkdownCode,
    );
    expect(toks.map((t) => [t.kind, t.targetId, t.label])).toEqual([
      ['user', 'u1', 'bob'],
      ['card', 'c1', 'WEB-1'],
    ]);
  });

  it('formats and parses PR targets', () => {
    expect(formatRefToken('web#7', 'pr', 'web#7')).toBe('@[web\\#7](pr:web#7)');
    expect(parsePrTarget('web#7')).toEqual({ projectId: 'web', number: 7 });
    expect(parsePrTarget('my#proj#12')).toEqual({ projectId: 'my#proj', number: 12 });
    expect(parsePrTarget('#7')).toBeNull();
    expect(parsePrTarget('web#07')).toBeNull();
  });
});

describe('posting refs', () => {
  it('drops refs to a project the author cannot view, keeping the label as text', async () => {
    const ch = await channelWith(alice, [bob]);
    const res = await post(
      alice,
      ch,
      'see @[VLT-1](card:card-vault), @[vault#3](pr:vault#3), @[Vault ticket](ticket:tkt-vault) and @[vault Dev](agent:vault-dev)',
    ).expect(201);
    expect(res.body.message.refs).toEqual([]);
    expect(res.body.message.body).toBe('see VLT-1, vault#3, Vault ticket and @vault Dev');
    const rows = getDb()
      .prepare('SELECT * FROM hub_chat_refs WHERE message_id = ?')
      .all(res.body.message.id);
    expect(rows).toEqual([]);
  });

  it('keeps the same refs when the author can view the project', async () => {
    const ch = await channelWith(bob, [alice]);
    const res = await post(bob, ch, 'see @[VLT-1](card:card-vault)').expect(201);
    expect(res.body.message.refs).toEqual([
      { kind: 'card', targetId: 'card-vault', projectId: 'vault' },
    ]);
    expect(res.body.message.body).toBe('see @[VLT-1](card:card-vault)');
  });

  it('stores visible refs of every kind once each', async () => {
    const ch = await channelWith(alice, [bob]);
    const res = await post(
      alice,
      ch,
      '@[bob](user:' +
        bob +
        ') @[bob](user:' +
        bob +
        ') @[WEB-1](card:card-web) @[web#7](pr:web#7) @[Login](ticket:tkt-web) @[web Dev](agent:web-dev)',
    ).expect(201);
    const rows = getDb()
      .prepare('SELECT kind, target_id, project_id FROM hub_chat_refs WHERE message_id = ?')
      .all(res.body.message.id);
    expect(rows).toHaveLength(5);
    expect(res.body.message.refs).toEqual([
      { kind: 'user', targetId: bob, projectId: null },
      { kind: 'card', targetId: 'card-web', projectId: 'web' },
      { kind: 'pr', targetId: 'web#7', projectId: 'web' },
      { kind: 'ticket', targetId: 'tkt-web', projectId: 'web' },
      { kind: 'agent', targetId: 'web-dev', projectId: 'web' },
    ]);
  });

  it('drops a mention of a user outside the org and a target that does not exist', async () => {
    const ch = await channelWith(alice, [bob]);
    const res = await post(
      alice,
      ch,
      `hey @[mallory](user:${mallory}) and @[WEB-99](card:nope) and @[web#99](pr:web#99)`,
    ).expect(201);
    expect(res.body.message.refs).toEqual([]);
    expect(res.body.message.body).toBe('hey @mallory and WEB-99 and web#99');
  });

  it('stores a ref whose label had to be truncated to fit the token', async () => {
    const subject = 'Safari login loop '.repeat(20);
    getDb()
      .prepare('INSERT INTO support_tickets (id, project_id, subject) VALUES (?, ?, ?)')
      .run('tkt-long', 'web', subject);
    const search = await request(as(alice))
      .get('/api/chat/refs/search')
      .query({ trigger: '#', q: 'safari login loop' })
      .expect(200);
    const hit = search.body.suggestions.find(
      (s: { targetId: string }) => s.targetId === 'tkt-long',
    );
    expect(hit.label.length).toBeGreaterThan(200);
    const token = formatRefToken(hit.label, 'ticket', hit.targetId) as string;
    const ch = await channelWith(alice, [bob]);
    const res = await post(alice, ch, `see ${token}`).expect(201);
    expect(res.body.message.body).toBe(`see ${token}`);
    expect(res.body.message.refs).toEqual([
      { kind: 'ticket', targetId: 'tkt-long', projectId: 'web' },
    ]);
  });

  it('leaves tokens inside inline and fenced code as literal text', async () => {
    const ch = await channelWith(alice, [bob]);
    const body = [
      'inline `@[bob](user:' + bob + ')` and `@[VLT-1](card:card-vault)`',
      '```',
      '@[bob](user:' + bob + ') @[VLT-1](card:card-vault)',
      '```',
      '~~~md',
      '@[WEB-1](card:card-web)',
      '~~~',
      '``a ` @[bob](user:' + bob + ') b``',
    ].join('\n');
    const res = await post(alice, ch, body).expect(201);
    expect(res.body.message.body).toBe(body);
    expect(res.body.message.refs).toEqual([]);
    const rows = getDb()
      .prepare('SELECT * FROM hub_chat_refs WHERE message_id = ?')
      .all(res.body.message.id);
    expect(rows).toEqual([]);
    const bobView = await request(as(bob)).get('/api/chat/channels').expect(200);
    expect(bobView.body.channels[0].mentionCount).toBe(0);
  });

  it('treats an indented code block as literal text', async () => {
    const ch = await channelWith(alice, [bob]);
    for (const body of [
      `    @[bob](user:${bob})`,
      `\t@[bob](user:${bob}) @[VLT-1](card:card-vault)`,
      `example:\n\n    @[bob](user:${bob})\n    @[VLT-1](card:card-vault)`,
    ]) {
      const res = await post(alice, ch, body).expect(201);
      expect(res.body.message.body).toBe(body);
      expect(res.body.message.refs).toEqual([]);
      const rows = getDb()
        .prepare('SELECT * FROM hub_chat_refs WHERE message_id = ?')
        .all(res.body.message.id);
      expect(rows).toEqual([]);
    }
    const bobView = await request(as(bob)).get('/api/chat/channels').expect(200);
    expect(bobView.body.channels[0].mentionCount).toBe(0);
  });

  it('counts an indented line the renderer shows as paragraph text', async () => {
    const ch = await channelWith(alice, [bob]);
    const res = await post(alice, ch, `hey\n    @[bob](user:${bob})`).expect(201);
    expect(res.body.message.refs).toEqual([{ kind: 'user', targetId: bob, projectId: null }]);
  });

  it('stores nothing for a backslash-escaped token, matching the renderer', async () => {
    const ch = await channelWith(alice, [bob]);
    const body = `literal \\@[bob](user:${bob}) and \\@[VLT-1](card:card-vault)`;
    const res = await post(alice, ch, body).expect(201);
    expect(res.body.message.body).toBe(body);
    expect(res.body.message.refs).toEqual([]);
    const bobView = await request(as(bob)).get('/api/chat/channels').expect(200);
    expect(bobView.body.channels[0].mentionCount).toBe(0);
  });

  it('still resolves tokens next to code', async () => {
    const ch = await channelWith(alice, [bob]);
    const res = await post(
      alice,
      ch,
      '`code` @[bob](user:' + bob + ') `@[VLT-1](card:card-vault)` @[VLT-1](card:card-vault)',
    ).expect(201);
    expect(res.body.message.refs).toEqual([{ kind: 'user', targetId: bob, projectId: null }]);
    expect(res.body.message.body).toBe(
      '`code` @[bob](user:' + bob + ') `@[VLT-1](card:card-vault)` VLT-1',
    );
  });

  it('stores a ref picked from a title full of Markdown characters', async () => {
    for (const [id, subject] of [
      ['tkt-bracket', '[Bug] Login broken'],
      ['tkt-slash', 'Path ends in \\'],
      ['tkt-md', '**bold** `code` <b> & [x](y)'],
    ]) {
      getDb()
        .prepare('INSERT INTO support_tickets (id, project_id, subject) VALUES (?, ?, ?)')
        .run(id, 'web', subject);
    }
    const ch = await channelWith(alice, [bob]);
    for (const [id, subject] of [
      ['tkt-bracket', '[Bug] Login broken'],
      ['tkt-slash', 'Path ends in \\'],
      ['tkt-md', '**bold** `code` <b> & [x](y)'],
    ]) {
      const token = formatRefToken(subject, 'ticket', id) as string;
      const res = await post(alice, ch, `see ${token} now`).expect(201);
      expect(res.body.message.body).toBe(`see ${token} now`);
      expect(res.body.message.refs).toEqual([{ kind: 'ticket', targetId: id, projectId: 'web' }]);
    }
  });

  it('flattens a hidden ref with Markdown in its title so it reads as written', async () => {
    const ch = await channelWith(alice, [bob]);
    const hidden = formatRefToken('[Bug] *urgent* fix', 'card', 'card-vault') as string;
    const atStart = formatRefToken('# 1. Secret', 'card', 'card-vault') as string;
    const res = await post(alice, ch, `see ${hidden}\n${atStart}`).expect(201);
    expect(res.body.message.refs).toEqual([]);
    expect(res.body.message.body).toBe('see \\[Bug\\] \\*urgent\\* fix\n\\# 1. Secret');
  });

  it('stores a ref right after "!" that the renderer shows as a chip', async () => {
    const ch = await channelWith(alice, [bob]);
    const body = `wow!@[WEB-1](card:card-web) and !@[VLT-1](card:card-vault) !@[bob](user:${bob})`;
    const res = await post(alice, ch, body).expect(201);
    expect(res.body.message.refs).toEqual([
      { kind: 'card', targetId: 'card-web', projectId: 'web' },
      { kind: 'user', targetId: bob, projectId: null },
    ]);
    expect(res.body.message.body).toBe(
      `wow!@[WEB-1](card:card-web) and !VLT-1 !@[bob](user:${bob})`,
    );
  });

  it("a user mention raises that user's mention count", async () => {
    const ch = await channelWith(alice, [bob, carol]);
    await post(alice, ch, `ping @[bob](user:${bob})`).expect(201);
    const bobView = await request(as(bob)).get('/api/chat/channels').expect(200);
    const carolView = await request(as(carol)).get('/api/chat/channels').expect(200);
    expect(bobView.body.channels[0]).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    expect(carolView.body.channels[0]).toMatchObject({ unreadCount: 1, mentionCount: 0 });
  });

  it('re-resolves refs on edit', async () => {
    const ch = await channelWith(alice, [bob]);
    const msg = (await post(alice, ch, `ping @[bob](user:${bob})`).expect(201)).body.message;
    const edited = await request(as(alice))
      .patch(`/api/chat/messages/${msg.id}`)
      .send({ body: `ping @[carol](user:${carol}) and @[VLT-1](card:card-vault)` })
      .expect(200);
    expect(edited.body.message.refs).toEqual([{ kind: 'user', targetId: carol, projectId: null }]);
    expect(edited.body.message.body).toBe(`ping @[carol](user:${carol}) and VLT-1`);
    const bobView = await request(as(bob)).get('/api/chat/channels').expect(200);
    expect(bobView.body.channels[0].mentionCount).toBe(0);
  });
});

describe('resolving refs for a viewer', () => {
  it('returns live detail to a viewer with access and label-only to one without', async () => {
    const refs = [
      { kind: 'card', targetId: 'card-vault' },
      { kind: 'card', targetId: 'card-web' },
      { kind: 'pr', targetId: 'web#7' },
      { kind: 'ticket', targetId: 'tkt-web' },
      { kind: 'user', targetId: bob },
    ];
    const asBob = await request(as(bob)).post('/api/chat/refs/resolve').send({ refs }).expect(200);
    expect(asBob.body.refs[0]).toMatchObject({
      visible: true,
      projectId: 'vault',
      label: 'VLT-1',
      title: 'Secret roadmap',
      status: 'To Do',
    });
    const asAlice = await request(as(alice))
      .post('/api/chat/refs/resolve')
      .send({ refs })
      .expect(200);
    expect(asAlice.body.refs[0]).toEqual({
      kind: 'card',
      targetId: 'card-vault',
      visible: false,
      projectId: null,
      label: null,
      title: null,
      status: null,
      agentId: null,
      number: null,
    });
    expect(asAlice.body.refs[1]).toMatchObject({
      visible: true,
      label: 'WEB-1',
      status: 'In Progress',
    });
    expect(asAlice.body.refs[2]).toMatchObject({
      visible: true,
      projectId: 'web',
      number: 7,
      status: 'open',
      title: 'Add login retry',
    });
    expect(asAlice.body.refs[3]).toMatchObject({ visible: true, status: 'new' });
    expect(asAlice.body.refs[4]).toMatchObject({ visible: true, label: 'bob' });
  });
});

describe('autocomplete', () => {
  it('@ lists org members and agents in visible projects', async () => {
    const res = await request(as(alice)).get('/api/chat/refs/search?trigger=@&q=').expect(200);
    const labels = res.body.suggestions.map((s: { label: string }) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['alice', 'bob', 'carol', 'web Dev']));
    expect(labels).not.toContain('mallory');
    expect(labels).not.toContain('vault Dev');
  });

  it('# finds a card by PREFIX-N and never one in a hidden project', async () => {
    const hit = await request(as(alice))
      .get('/api/chat/refs/search')
      .query({ trigger: '#', q: 'web-1' })
      .expect(200);
    expect(hit.body.suggestions[0]).toMatchObject({
      kind: 'card',
      targetId: 'card-web',
      label: 'WEB-1',
    });
    const miss = await request(as(alice))
      .get('/api/chat/refs/search')
      .query({ trigger: '#', q: 'vlt-1' })
      .expect(200);
    expect(miss.body.suggestions.some((s: { kind: string }) => s.kind === 'card')).toBe(false);
  });

  it('# finds PRs by project#N and tickets by subject', async () => {
    const pr = await request(as(alice))
      .get('/api/chat/refs/search')
      .query({ trigger: '#', q: 'web#7' })
      .expect(200);
    expect(pr.body.suggestions).toContainEqual(
      expect.objectContaining({ kind: 'pr', targetId: 'web#7', label: 'web#7' }),
    );
    const tkt = await request(as(alice))
      .get('/api/chat/refs/search')
      .query({ trigger: '#', q: 'safari' })
      .expect(200);
    expect(tkt.body.suggestions).toContainEqual(
      expect.objectContaining({ kind: 'ticket', targetId: 'tkt-web' }),
    );
    const hidden = await request(as(alice))
      .get('/api/chat/refs/search')
      .query({ trigger: '#', q: 'secret' })
      .expect(200);
    expect(hidden.body.suggestions).toEqual([]);
  });

  it('rejects an unknown trigger', async () => {
    await request(as(alice)).get('/api/chat/refs/search?trigger=!').expect(400);
  });
});
