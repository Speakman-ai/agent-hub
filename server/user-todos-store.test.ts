import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const {
  createTodo,
  getTodo,
  listTodos,
  updateTodo,
  deleteTodo,
  reorderTodos,
  linkTodoToCard,
  setTodoLink,
  clearTodoLink,
} = await import('./user-todos-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'user-todos-store-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('user-todos-store — CRUD', () => {
  beforeEach(() => {
    freshDb();
  });

  it('creates a todo with defaults and roundtrips via getTodo', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({ userId: user.id, title: '  Buy milk  ' });

    expect(todo.title).toBe('Buy milk'); // trimmed
    expect(todo.notes).toBe('');
    expect(todo.status).toBe('open');
    expect(todo.dueAt).toBeNull();
    expect(todo.position).toBe(0);
    expect(todo.sourceType).toBe('manual');
    expect(todo.sourceId).toBeNull();
    expect(todo.sourceMeta).toBeNull();
    expect(todo.linkedCardId).toBeNull();
    expect(todo.linkedProjectId).toBeNull();

    expect(getTodo(user.id, todo.id)).toEqual(todo);
  });

  it('persists provenance fields including a JSON source_meta blob', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const meta = { messageId: 'gmail-abc', deepLink: 'https://mail.google.com/x' };
    const todo = createTodo({
      userId: user.id,
      title: 'Reply to Bob',
      notes: 'urgent',
      dueAt: '2026-07-10T09:00:00.000Z',
      sourceType: 'email',
      sourceId: 'gmail-abc',
      sourceMeta: meta,
    });

    const fetched = getTodo(user.id, todo.id)!;
    expect(fetched.sourceType).toBe('email');
    expect(fetched.sourceId).toBe('gmail-abc');
    expect(fetched.sourceMeta).toEqual(meta);
    expect(fetched.dueAt).toBe('2026-07-10T09:00:00.000Z');
    expect(fetched.notes).toBe('urgent');
  });

  it('rejects an empty title on create', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    expect(() => createTodo({ userId: user.id, title: '   ' })).toThrow(/title is required/);
  });

  it("getTodo does not leak another user's todo", () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    const todo = createTodo({ userId: alice.id, title: 'secret' });
    expect(getTodo(bob.id, todo.id)).toBeNull();
  });

  it('updateTodo patches only provided fields and bumps updated_at', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({ userId: user.id, title: 'draft', notes: 'keep me' });

    const updated = updateTodo(user.id, todo.id, { title: 'final', status: 'done' })!;
    expect(updated.title).toBe('final');
    expect(updated.status).toBe('done');
    expect(updated.notes).toBe('keep me'); // untouched
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(todo.updatedAt).getTime(),
    );
  });

  it('updateTodo can clear due_at with an explicit null', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({
      userId: user.id,
      title: 't',
      dueAt: '2026-07-10T09:00:00.000Z',
    });
    const cleared = updateTodo(user.id, todo.id, { dueAt: null })!;
    expect(cleared.dueAt).toBeNull();
  });

  it('updateTodo returns null for a todo the user does not own', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    const todo = createTodo({ userId: alice.id, title: 'x' });
    expect(updateTodo(bob.id, todo.id, { title: 'hijack' })).toBeNull();
  });

  it("deleteTodo removes only the owner's row", () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    const todo = createTodo({ userId: alice.id, title: 'x' });

    expect(deleteTodo(bob.id, todo.id)).toBe(false);
    expect(deleteTodo(alice.id, todo.id)).toBe(true);
    expect(getTodo(alice.id, todo.id)).toBeNull();
  });

  it('linkTodoToCard stamps the promoted-card link (polymorphic + back-compat)', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({ userId: user.id, title: 'promote me' });
    const linked = linkTodoToCard(user.id, todo.id, {
      cardId: 'card-1',
      projectId: 'proj-1',
    })!;
    expect(linked.linkedType).toBe('card');
    expect(linked.linkedId).toBe('card-1');
    expect(linked.linkedCardId).toBe('card-1'); // kept in sync for back-compat
    expect(linked.linkedProjectId).toBe('proj-1');
  });
});

describe('user-todos-store — priority, do-date window, polymorphic link', () => {
  beforeEach(() => {
    freshDb();
  });

  it('defaults priority to medium and leaves the do-window null', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({ userId: user.id, title: 'plain' });
    expect(todo.priority).toBe('medium');
    expect(todo.doDate).toBeNull();
    expect(todo.doStartAt).toBeNull();
    expect(todo.doEndAt).toBeNull();
    expect(todo.linkedType).toBeNull();
    expect(todo.linkedId).toBeNull();
    expect(getTodo(user.id, todo.id)).toEqual(todo);
  });

  it('round-trips priority and the do-date time window on create', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({
      userId: user.id,
      title: 'ship it',
      priority: 'urgent',
      doDate: '2026-07-10',
      doStartAt: '2026-07-10T13:00:00.000Z',
      doEndAt: '2026-07-10T14:30:00.000Z',
    });
    const fetched = getTodo(user.id, todo.id)!;
    expect(fetched.priority).toBe('urgent');
    expect(fetched.doDate).toBe('2026-07-10');
    expect(fetched.doStartAt).toBe('2026-07-10T13:00:00.000Z');
    expect(fetched.doEndAt).toBe('2026-07-10T14:30:00.000Z');
  });

  it('updateTodo patches priority and the do-date window, and clears with null', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({
      userId: user.id,
      title: 't',
      priority: 'low',
      doDate: '2026-07-10',
      doStartAt: '2026-07-10T13:00:00.000Z',
    });

    const bumped = updateTodo(user.id, todo.id, { priority: 'high', doDate: '2026-07-11' })!;
    expect(bumped.priority).toBe('high');
    expect(bumped.doDate).toBe('2026-07-11');
    expect(bumped.doStartAt).toBe('2026-07-10T13:00:00.000Z'); // untouched

    const cleared = updateTodo(user.id, todo.id, { doDate: null, doStartAt: null })!;
    expect(cleared.doDate).toBeNull();
    expect(cleared.doStartAt).toBeNull();
    expect(cleared.priority).toBe('high'); // untouched
  });

  it('rejects an out-of-range priority at the DB CHECK boundary', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    // @ts-expect-error — deliberately bad priority to prove the CHECK constraint bites.
    expect(() => createTodo({ userId: user.id, title: 'bad', priority: 'bogus' })).toThrow(
      /CHECK constraint/,
    );
  });

  it('setTodoLink links to an epic and to a session', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({ userId: user.id, title: 'link me' });

    const toEpic = setTodoLink(user.id, todo.id, {
      type: 'epic',
      id: 'epic-7',
      projectId: 'proj-3',
    })!;
    expect(toEpic.linkedType).toBe('epic');
    expect(toEpic.linkedId).toBe('epic-7');
    expect(toEpic.linkedProjectId).toBe('proj-3');
    expect(toEpic.linkedCardId).toBeNull(); // only a card link populates the back-compat column

    const toSession = setTodoLink(user.id, todo.id, { type: 'session', id: 'sess-1' })!;
    expect(toSession.linkedType).toBe('session');
    expect(toSession.linkedId).toBe('sess-1');
    expect(toSession.linkedProjectId).toBeNull(); // session links are not project-scoped
  });

  it('setTodoLink to a card keeps the back-compat linked_card_id in sync', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({ userId: user.id, title: 'link me' });
    const linked = setTodoLink(user.id, todo.id, {
      type: 'card',
      id: 'card-9',
      projectId: 'proj-4',
    })!;
    expect(linked.linkedType).toBe('card');
    expect(linked.linkedId).toBe('card-9');
    expect(linked.linkedCardId).toBe('card-9');
    expect(linked.linkedProjectId).toBe('proj-4');
  });

  it('clearTodoLink drops the polymorphic link and back-compat columns', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const todo = createTodo({ userId: user.id, title: 'link me' });
    linkTodoToCard(user.id, todo.id, { cardId: 'card-1', projectId: 'proj-1' });

    const cleared = clearTodoLink(user.id, todo.id)!;
    expect(cleared.linkedType).toBeNull();
    expect(cleared.linkedId).toBeNull();
    expect(cleared.linkedCardId).toBeNull();
    expect(cleared.linkedProjectId).toBeNull();
  });

  it('setTodoLink returns null for a todo the user does not own', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    const todo = createTodo({ userId: alice.id, title: 'x' });
    expect(setTodoLink(bob.id, todo.id, { type: 'card', id: 'c', projectId: 'p' })).toBeNull();
  });
});

describe('user-todos-store — ordering', () => {
  beforeEach(() => {
    freshDb();
  });

  it('assigns sequential positions per user and appends new todos at the end', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });

    const a1 = createTodo({ userId: alice.id, title: 'a1' });
    const a2 = createTodo({ userId: alice.id, title: 'a2' });
    const a3 = createTodo({ userId: alice.id, title: 'a3' });
    // Bob's positions are independent (start at 0), proving per-user scope.
    const b1 = createTodo({ userId: bob.id, title: 'b1' });

    expect([a1.position, a2.position, a3.position]).toEqual([0, 1, 2]);
    expect(b1.position).toBe(0);

    expect(listTodos(alice.id).map((t) => t.title)).toEqual(['a1', 'a2', 'a3']);
    expect(listTodos(bob.id).map((t) => t.title)).toEqual(['b1']);
  });

  it('listTodos filters by status', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const open1 = createTodo({ userId: user.id, title: 'open1' });
    const done1 = createTodo({ userId: user.id, title: 'done1' });
    updateTodo(user.id, done1.id, { status: 'done' });

    expect(listTodos(user.id, { status: 'open' }).map((t) => t.id)).toEqual([open1.id]);
    expect(listTodos(user.id, { status: 'done' }).map((t) => t.id)).toEqual([done1.id]);
    expect(listTodos(user.id).length).toBe(2);
  });

  it('reorderTodos reassigns dense positions from an explicit id order', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const t1 = createTodo({ userId: user.id, title: 't1' });
    const t2 = createTodo({ userId: user.id, title: 't2' });
    const t3 = createTodo({ userId: user.id, title: 't3' });

    const reordered = reorderTodos(user.id, [t3.id, t1.id, t2.id]);
    expect(reordered.map((t) => t.title)).toEqual(['t3', 't1', 't2']);
    expect(reordered.map((t) => t.position)).toEqual([0, 1, 2]);
    // Persisted, not just returned.
    expect(listTodos(user.id).map((t) => t.title)).toEqual(['t3', 't1', 't2']);
  });

  it('reorderTodos appends unlisted todos after the requested ones and ignores foreign ids', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    createTodo({ userId: alice.id, title: 't1' });
    createTodo({ userId: alice.id, title: 't2' });
    const t3 = createTodo({ userId: alice.id, title: 't3' });
    const foreign = createTodo({ userId: bob.id, title: 'bob-todo' });

    // Only name t3; t1/t2 keep their relative order after it. Foreign id ignored.
    const reordered = reorderTodos(alice.id, [t3.id, foreign.id]);
    expect(reordered.map((t) => t.title)).toEqual(['t3', 't1', 't2']);
    // Bob's todo is untouched.
    expect(listTodos(bob.id).map((t) => t.id)).toEqual([foreign.id]);
  });
});
