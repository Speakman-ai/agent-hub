/**
 * Unit tests for the shared org-todos store (`org-todos-store.ts`).
 *
 * Locks the two invariants the shared list depends on:
 *   1. Every read/write is scoped to `orgId` — org B can never see, mutate, or
 *      delete org A's todos (a foreign-org id resolves to null / no-op).
 *   2. `position` is per-org: creates append at the end of the org's list and
 *      reorder reassigns dense positions from an explicit id order.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

const { initDb } = await import('./db.js');
const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createOrgTodo, getOrgTodo, listOrgTodos, updateOrgTodo, deleteOrgTodo, reorderOrgTodos } =
  await import('./org-todos-store.js');

const ORG_A = 'org-a';
const ORG_B = 'org-b';

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'org-todos-store-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
});

describe('createOrgTodo', () => {
  it('creates a todo with defaults and appends at the end of the org list', () => {
    const first = createOrgTodo({ orgId: ORG_A, title: '  Ship it  ' });
    expect(first).toMatchObject({
      orgId: ORG_A,
      title: 'Ship it', // trimmed
      notes: '',
      status: 'open',
      priority: 'medium',
      position: 0,
      createdByUserId: null,
    });

    const second = createOrgTodo({ orgId: ORG_A, title: 'Then this', createdByUserId: 'u1' });
    expect(second.position).toBe(1);
    expect(second.createdByUserId).toBe('u1');
  });

  it('throws on an empty title', () => {
    expect(() => createOrgTodo({ orgId: ORG_A, title: '   ' })).toThrow(/title is required/);
  });

  it('positions are independent per org', () => {
    createOrgTodo({ orgId: ORG_A, title: 'a1' });
    const b1 = createOrgTodo({ orgId: ORG_B, title: 'b1' });
    // ORG_B starts its own sequence at 0 even though ORG_A already has a row.
    expect(b1.position).toBe(0);
  });
});

describe('listOrgTodos', () => {
  it('returns only the given org rows in position order and filters by status', () => {
    const a1 = createOrgTodo({ orgId: ORG_A, title: 'a1' });
    const a2 = createOrgTodo({ orgId: ORG_A, title: 'a2' });
    createOrgTodo({ orgId: ORG_B, title: 'b1' });
    updateOrgTodo(ORG_A, a2.id, { status: 'done' });

    const all = listOrgTodos(ORG_A);
    expect(all.map((t) => t.id)).toEqual([a1.id, a2.id]);

    expect(listOrgTodos(ORG_A, { status: 'open' }).map((t) => t.id)).toEqual([a1.id]);
    expect(listOrgTodos(ORG_A, { status: 'done' }).map((t) => t.id)).toEqual([a2.id]);
  });
});

describe('getOrgTodo / updateOrgTodo / deleteOrgTodo scope by org', () => {
  it('a foreign-org id never resolves, updates, or deletes', () => {
    const a1 = createOrgTodo({ orgId: ORG_A, title: 'a1' });

    // Wrong org cannot see it.
    expect(getOrgTodo(ORG_B, a1.id)).toBeNull();
    // Wrong org cannot update it (and the real row is untouched).
    expect(updateOrgTodo(ORG_B, a1.id, { title: 'hacked' })).toBeNull();
    expect(getOrgTodo(ORG_A, a1.id)?.title).toBe('a1');
    // Wrong org cannot delete it.
    expect(deleteOrgTodo(ORG_B, a1.id)).toBe(false);
    expect(getOrgTodo(ORG_A, a1.id)).not.toBeNull();
  });

  it('updates mutable fields and rejects an empty title', () => {
    const a1 = createOrgTodo({ orgId: ORG_A, title: 'a1' });
    const updated = updateOrgTodo(ORG_A, a1.id, {
      title: 'renamed',
      notes: 'more',
      priority: 'urgent',
      status: 'done',
      doDate: '2026-07-10',
    });
    expect(updated).toMatchObject({
      title: 'renamed',
      notes: 'more',
      priority: 'urgent',
      status: 'done',
      doDate: '2026-07-10',
    });
    expect(() => updateOrgTodo(ORG_A, a1.id, { title: '   ' })).toThrow(/title cannot be empty/);
  });

  it('deletes and reports whether a row was removed', () => {
    const a1 = createOrgTodo({ orgId: ORG_A, title: 'a1' });
    expect(deleteOrgTodo(ORG_A, a1.id)).toBe(true);
    expect(deleteOrgTodo(ORG_A, a1.id)).toBe(false);
  });
});

describe('reorderOrgTodos', () => {
  it('reassigns dense positions from an explicit order, ignoring foreign ids', () => {
    const a1 = createOrgTodo({ orgId: ORG_A, title: 'a1' });
    const a2 = createOrgTodo({ orgId: ORG_A, title: 'a2' });
    const a3 = createOrgTodo({ orgId: ORG_A, title: 'a3' });
    const b1 = createOrgTodo({ orgId: ORG_B, title: 'b1' });

    const result = reorderOrgTodos(ORG_A, [a3.id, a1.id, b1.id /* foreign, ignored */]);
    // a3, a1 first (as requested), a2 appended after (not mentioned).
    expect(result.map((t) => t.id)).toEqual([a3.id, a1.id, a2.id]);
    expect(result.map((t) => t.position)).toEqual([0, 1, 2]);
    // ORG_B untouched.
    expect(listOrgTodos(ORG_B).map((t) => t.id)).toEqual([b1.id]);
  });
});
