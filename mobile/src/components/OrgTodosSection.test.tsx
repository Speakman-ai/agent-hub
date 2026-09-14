import type { ReactTestRenderer, ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;

// Mutable app-context holder so the test can bump `lastOrgTodoEvent` between
// renders and drive the silent-refresh effect.
const ctl = vi.hoisted(() => ({ app: { lastOrgTodoEvent: null as any } }));

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
}));
vi.mock('./HubIcon', () => ({ default: () => null }));
vi.mock('../context/AppContext', () => ({ useApp: () => ctl.app }));
vi.mock('../utils/api', () => ({
  api: {
    listOrgTodos: vi.fn(),
    createOrgTodo: vi.fn(),
    updateOrgTodo: vi.fn(),
    deleteOrgTodo: vi.fn(),
    reorderOrgTodos: vi.fn(),
  },
}));

const { default: OrgTodosSection } = await import('./OrgTodosSection');
const { api } = await import('../utils/api');
const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function makeTodo(id: string, title: string) {
  return {
    id,
    orgId: 'acme',
    title,
    notes: '',
    status: 'open',
    priority: 'medium',
    doDate: null,
    doStartAt: null,
    doEndAt: null,
    position: 0,
    createdByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every plain-string chunk rendered inside a Text node. */
function texts(r: ReactTestRenderer): string[] {
  const out: string[] = [];
  r.root
    .findAll((n) => (n.type as unknown as string) === 'Text')
    .forEach((n) => {
      n.children.forEach((c) => {
        if (typeof c === 'string') out.push(c);
      });
    });
  return out;
}

function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance[] {
  return r.root.findAll((n) => (n.props as any)?.accessibilityLabel === label);
}

/** Titles of the visible open rows, in render order. */
function openRowTitles(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.props as any)?.testID === 'org-todo-row')
    .map((row) => {
      let title = '';
      row
        .findAll((t) => (t.type as unknown as string) === 'Text')
        .forEach((t) => {
          t.children.forEach((c) => {
            if (typeof c === 'string' && /^Row [ABC]$/.test(c)) title = c;
          });
        });
      return title;
    });
}

function byTestId(r: ReactTestRenderer, id: string): ReactTestInstance[] {
  return r.root.findAll((n) => (n.props as any)?.testID === id);
}

beforeEach(() => {
  ctl.app = { lastOrgTodoEvent: null };
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OrgTodosSection (mobile) — out-of-order refresh responses', () => {
  it('does not let an earlier GET that resolves late overwrite newer state', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo('t-old', 'OLD')] });

    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('OLD');

    const stale = deferred<{ todos: unknown[] }>();
    const newest = deferred<{ todos: unknown[] }>();
    mockApi.listOrgTodos.mockReturnValueOnce(stale.promise); // generation 2 (slow)
    mockApi.listOrgTodos.mockReturnValueOnce(newest.promise); // generation 3 (newest)

    // Two org-todo events → two silent loads issued in order.
    ctl.app = { lastOrgTodoEvent: { orgId: 'acme', bump: 1 } };
    await act(async () => {
      r.update(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    ctl.app = { lastOrgTodoEvent: { orgId: 'acme', bump: 2 } };
    await act(async () => {
      r.update(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });

    // Newest resolves first with fresh data…
    await act(async () => {
      newest.resolve({ todos: [makeTodo('t-new', 'NEW')] });
    });
    expect(texts(r)).toContain('NEW');

    // …stale resolves late and must be discarded by the generation guard.
    await act(async () => {
      stale.resolve({ todos: [makeTodo('t-old', 'STALE')] });
    });
    expect(texts(r)).not.toContain('STALE');
    expect(texts(r)).toContain('NEW');
  });
});

describe('OrgTodosSection (mobile) — mutation response never overwrites a newer refresh', () => {
  it('discards the PUT snapshot when a newer GET already landed (reconciles via refresh)', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo('t1', 'A')] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('A');

    const put = deferred<{ todo: unknown }>();
    const teammate = deferred<{ todos: unknown[] }>();
    const reconcile = deferred<{ todos: unknown[] }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(put.promise);
    mockApi.listOrgTodos.mockReturnValueOnce(teammate.promise); // teammate refresh
    mockApi.listOrgTodos.mockReturnValueOnce(reconcile.promise); // post-PUT reconcile

    // Start the mutation (toggle → PUT) — stays pending.
    await act(async () => {
      byLabel(r, 'Mark as done')[0].props.onPress();
    });

    // Teammate refresh lands a NEWER title mid-flight.
    ctl.app = { lastOrgTodoEvent: { orgId: 'acme', bump: 1 } };
    await act(async () => {
      r.update(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {
      teammate.resolve({ todos: [makeTodo('t1', 'NEWER')] });
    });
    expect(texts(r)).toContain('NEWER');

    // Older PUT resolves — its stale snapshot must not be installed; the mutation
    // reconciles through an authoritative refresh.
    await act(async () => {
      put.resolve({ todo: makeTodo('t1', 'PUT-STALE') });
    });
    await act(async () => {
      reconcile.resolve({ todos: [makeTodo('t1', 'FINAL')] });
    });

    expect(texts(r)).not.toContain('PUT-STALE');
    expect(texts(r)).toContain('FINAL');
  });
});

describe('OrgTodosSection (mobile) — live refresh preserves an unsaved editor draft', () => {
  it('does not reset draft fields when the edited todo is refreshed mid-edit', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo('t1', 'Original')] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Original');

    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('dirty draft');
    });

    // Teammate refresh changes the same todo's title while the editor is open.
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo('t1', 'Remote Changed')] });
    ctl.app = { lastOrgTodoEvent: { orgId: 'acme', bump: 1 } };
    await act(async () => {
      r.update(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});

    expect(byLabel(r, 'Edit org todo title')[0].props.value).toBe('dirty draft');
  });
});

describe('OrgTodosSection (mobile) — failed edit keeps the draft', () => {
  it('leaves the editor open with the typed draft when the update rejects', async () => {
    mockApi.listOrgTodos.mockResolvedValue({ todos: [makeTodo('t1', 'Original')] });
    mockApi.updateOrgTodo.mockRejectedValue(new Error('save failed'));

    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Original');

    // Enter edit mode.
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    // Type a new draft title.
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('My unsaved draft');
    });
    // Attempt to save — the update rejects.
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // Editor must remain open with the draft intact.
    const draftInput = byLabel(r, 'Edit org todo title');
    expect(draftInput).toHaveLength(1);
    expect(draftInput[0].props.value).toBe('My unsaved draft');
    expect(texts(r)).toContain('save failed');
  });
});

describe('OrgTodosSection (mobile) — mutation errors survive the reconcile refresh', () => {
  it('keeps the delete error after the reconcile GET restores the row', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo('t1', 'Keep me')] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Keep me');

    mockApi.deleteOrgTodo.mockRejectedValueOnce(new Error('delete failed'));
    // The silent reconcile after the failed delete restores the row from server.
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo('t1', 'Keep me')] });

    await act(async () => {
      byLabel(r, 'Delete org todo')[0].props.onPress();
    });
    await act(async () => {});

    // Row restored by the reconcile AND the failure explanation still visible.
    expect(texts(r)).toContain('Keep me');
    expect(texts(r)).toContain('delete failed');
  });

  it('keeps the reorder error after the reconcile GET reverts the order', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo('a', 'Row A'), makeTodo('b', 'Row B')],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    mockApi.reorderOrgTodos.mockRejectedValueOnce(new Error('reorder failed'));
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo('a', 'Row A'), makeTodo('b', 'Row B')],
    });

    await act(async () => {
      byLabel(r, 'Move down')[0].props.onPress(); // move Row A down
    });
    await act(async () => {});

    // A successful reconcile GET reverts the order but must NOT clear the error.
    expect(texts(r)).toContain('reorder failed');
  });
});

describe('OrgTodosSection (mobile) — org switch during a pending mutation', () => {
  it('a stale mutation completion for the old org never writes into the new org list', async () => {
    mockApi.listOrgTodos.mockImplementation((org: string) =>
      Promise.resolve({ todos: [makeTodo(`${org}1`, `${org}-item`)] }),
    );
    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    // The parent keys the section by orgId; changing the key remounts it.
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { key: 'A', orgId: 'A' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('A-item');

    // Start the mutation in org A.
    await act(async () => {
      byLabel(r, 'Mark as done')[0].props.onPress();
    });

    // Switch to org B — the key change unmounts A's instance and mounts B's.
    await act(async () => {
      r.update(React.createElement(OrgTodosSection, { key: 'B', orgId: 'B' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('B-item');

    // Org A's mutation finally resolves; it belongs to the unmounted A instance
    // and must not touch org B's list.
    await act(async () => {
      putA.resolve({ todo: makeTodo('A1', 'A-item') });
    });
    await act(async () => {});

    expect(texts(r)).toContain('B-item');
    expect(texts(r)).not.toContain('A-item');
  });
});

describe('OrgTodosSection (mobile) — deferred save does not close a newer editor', () => {
  it("a slow save on row A leaves row B's newly opened editor (and draft) intact", async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo('a', 'Row A'), makeTodo('b', 'Row B')],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    // Row A's save (PUT) stays pending.
    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    // Open row A's editor, change the title, save — the save is in flight.
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress(); // Row A
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('A edited');
    });
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // While A's save is pending, open row B's editor (only B shows a pencil now)
    // and type a draft.
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress(); // Row B
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('B draft');
    });

    // Now A's save resolves; its onSave completion must NOT close row B's editor.
    await act(async () => {
      putA.resolve({ todo: makeTodo('a', 'A edited') });
    });
    await act(async () => {});

    // Row B's editor is still open with the unsaved draft.
    const draftInput = byLabel(r, 'Edit org todo title');
    expect(draftInput).toHaveLength(1);
    expect(draftInput[0].props.value).toBe('B draft');
  });
});

describe('OrgTodosSection (mobile) — a reconcile GET failure after a successful mutation is surfaced', () => {
  it('shows a refresh-retry banner (not a mutation error) and never re-runs the create', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});

    // Create succeeds, but its follow-up reconcile GET rejects.
    mockApi.createOrgTodo.mockResolvedValueOnce({ todo: makeTodo('x', 'new todo') });
    mockApi.listOrgTodos.mockRejectedValueOnce(new Error('refresh failed'));

    await act(async () => {
      byLabel(r, 'New org todo title')[0].props.onChangeText('new todo');
    });
    await act(async () => {
      byTestId(r, 'org-todo-add')[0].props.onPress();
    });
    await act(async () => {});

    // Distinct stale-refresh banner shown; create ran exactly once.
    expect(byTestId(r, 'org-todos-reconcile-error')).toHaveLength(1);
    expect(mockApi.createOrgTodo).toHaveBeenCalledTimes(1);

    // Retry re-fetches only — no second create — and a successful GET clears it.
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo('x', 'new todo')] });
    await act(async () => {
      byTestId(r, 'org-todos-reconcile-retry')[0].props.onPress();
    });
    await act(async () => {});

    expect(byTestId(r, 'org-todos-reconcile-error')).toHaveLength(0);
    expect(mockApi.createOrgTodo).toHaveBeenCalledTimes(1);
    expect(texts(r)).toContain('new todo');
  });
});

describe('OrgTodosSection (mobile) — deferred create does not wipe a new add-form entry', () => {
  it('keeps a new title typed while the create is in flight', async () => {
    mockApi.listOrgTodos.mockResolvedValue({ todos: [] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});

    const create = deferred<{ todo: unknown }>();
    mockApi.createOrgTodo.mockReturnValueOnce(create.promise);

    // Submit "first todo"; the create stays pending.
    await act(async () => {
      byLabel(r, 'New org todo title')[0].props.onChangeText('first todo');
    });
    await act(async () => {
      byTestId(r, 'org-todo-add')[0].props.onPress();
    });

    // Start typing the next todo while the create is still in flight.
    await act(async () => {
      byLabel(r, 'New org todo title')[0].props.onChangeText('second todo');
    });

    // The create resolves; its success clear must not wipe the new entry.
    await act(async () => {
      create.resolve({ todo: makeTodo('x', 'first todo') });
    });
    await act(async () => {});

    expect(byLabel(r, 'New org todo title')[0].props.value).toBe('second todo');
  });
});

describe('OrgTodosSection (mobile) — a reconcile between queued reorders keeps the newer optimistic order', () => {
  it('an intermediate GET does not install the intermediate order, and a later move builds on the newer one', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [
        { ...makeTodo('a', 'Row A'), position: 0 },
        { ...makeTodo('b', 'Row B'), position: 1 },
        { ...makeTodo('c', 'Row C'), position: 2 },
      ],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(openRowTitles(r)).toEqual(['Row A', 'Row B', 'Row C']);

    const r1 = deferred<{ todos: unknown[] }>();
    const r2 = deferred<{ todos: unknown[] }>();
    mockApi.reorderOrgTodos.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);

    // Click 1: A down → [B, A, C]. Click 2: A down again → [B, C, A].
    await act(async () => {
      byLabel(r, 'Move down')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Move down')[1].props.onPress();
    });
    expect(openRowTitles(r)).toEqual(['Row B', 'Row C', 'Row A']);

    // R1 settles → its reconcile GET returns the INTERMEDIATE order [B, A, C];
    // it must be discarded while R2 is pending.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [
        { ...makeTodo('b', 'Row B'), position: 0 },
        { ...makeTodo('a', 'Row A'), position: 1 },
        { ...makeTodo('c', 'Row C'), position: 2 },
      ],
    });
    await act(async () => {
      r1.resolve({ todos: [] });
    });
    await act(async () => {});
    expect(openRowTitles(r)).toEqual(['Row B', 'Row C', 'Row A']);

    // A further move builds on [B, C, A]: moving B down yields [C, B, A].
    await act(async () => {
      byLabel(r, 'Move down')[0].props.onPress(); // B is first now
    });
    expect(openRowTitles(r)).toEqual(['Row C', 'Row B', 'Row A']);
  });
});

describe('OrgTodosSection (mobile) — concurrent reorder requests are serialized', () => {
  it('holds a second reorder until the first settles (older order cannot overwrite newer)', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [
        { ...makeTodo('a', 'Row A'), position: 0 },
        { ...makeTodo('b', 'Row B'), position: 1 },
        { ...makeTodo('c', 'Row C'), position: 2 },
      ],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    const r1 = deferred<{ todos: unknown[] }>();
    const r2 = deferred<{ todos: unknown[] }>();
    mockApi.reorderOrgTodos.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);

    // Click 1: move A down → [B, A, C]. R1 stays pending.
    await act(async () => {
      byLabel(r, 'Move down')[0].props.onPress();
    });
    // Click 2 (before R1 resolves): move A down again → [B, C, A].
    await act(async () => {
      byLabel(r, 'Move down')[1].props.onPress();
    });

    // Second whole-list request must NOT be dispatched while R1 is pending.
    expect(mockApi.reorderOrgTodos).toHaveBeenCalledTimes(1);
    expect(mockApi.reorderOrgTodos.mock.calls[0][1]).toEqual(['b', 'a', 'c']);

    // R1 settles → R2 dispatched now, strictly after R1, with the newer order.
    await act(async () => {
      r1.resolve({ todos: [] });
    });
    await act(async () => {});
    expect(mockApi.reorderOrgTodos).toHaveBeenCalledTimes(2);
    expect(mockApi.reorderOrgTodos.mock.calls[1][1]).toEqual(['b', 'c', 'a']);

    await act(async () => {
      r2.resolve({ todos: [] });
    });
    await act(async () => {});
  });
});

describe('OrgTodosSection (mobile) — reorder while another row is being edited', () => {
  it('moves a visible row against its visible neighbor, not the hidden edited row', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [
        { ...makeTodo('a', 'Row A'), position: 0 },
        { ...makeTodo('b', 'Row B'), position: 1 },
        { ...makeTodo('c', 'Row C'), position: 2 },
      ],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    // Edit the middle row B — pinned editor, hidden from the list.
    await act(async () => {
      byLabel(r, 'Edit org todo')[1].props.onPress();
    });

    mockApi.reorderOrgTodos.mockResolvedValueOnce({ todos: [] });
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [
        { ...makeTodo('c', 'Row C'), position: 0 },
        { ...makeTodo('b', 'Row B'), position: 1 },
        { ...makeTodo('a', 'Row A'), position: 2 },
      ],
    });

    // Visible open rows are [A, C]; move A down → it must land below C, and B
    // (edited, hidden) must keep its slot in the persisted order.
    await act(async () => {
      byLabel(r, 'Move down')[0].props.onPress();
    });
    await act(async () => {});

    expect(mockApi.reorderOrgTodos).toHaveBeenCalledWith('acme', ['c', 'b', 'a']);
  });
});

describe('OrgTodosSection (mobile) — a remote status transition preserves the open editor', () => {
  it('marking the edited todo done elsewhere keeps the editor open with its draft', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [{ ...makeTodo('a', 'Row A'), status: 'open' }],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    // Open A's editor and type an unsaved draft.
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('A unsaved draft');
    });

    // Another member marks A done; the refresh moves it to the completed bucket.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [{ ...makeTodo('a', 'Row A'), status: 'done' }],
    });
    ctl.app = { lastOrgTodoEvent: { orgId: 'acme', bump: 1 } };
    await act(async () => {
      r.update(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});

    // Editor stays open with the draft intact, and the conflict is surfaced.
    const input = byLabel(r, 'Edit org todo title');
    expect(input).toHaveLength(1);
    expect(input[0].props.value).toBe('A unsaved draft');
    expect(byTestId(r, 'org-todo-edit-conflict')).toHaveLength(1);
  });
});

describe('OrgTodosSection (mobile) — editor is locked while its save is in flight', () => {
  it('disables same-row editing and cancel during the save, then closes cleanly', async () => {
    mockApi.listOrgTodos.mockResolvedValue({ todos: [makeTodo('a', 'Row A')] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('v1');
    });
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // Locked while saving: inputs not editable, Cancel disabled.
    expect(byLabel(r, 'Edit org todo title')[0].props.editable).toBe(false);
    expect(byLabel(r, 'Edit org todo detail')[0].props.editable).toBe(false);
    expect(byLabel(r, 'Cancel edit')[0].props.disabled).toBe(true);

    // Completing the save closes the editor cleanly.
    await act(async () => {
      putA.resolve({ todo: makeTodo('a', 'v1') });
    });
    await act(async () => {});
    expect(byLabel(r, 'Edit org todo title')).toHaveLength(0);
  });

  it('re-enables the editor with the draft intact after a failed save', async () => {
    mockApi.listOrgTodos.mockResolvedValue({ todos: [makeTodo('a', 'Row A')] });
    mockApi.updateOrgTodo.mockRejectedValueOnce(new Error('save failed'));
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});

    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('v1');
    });
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });
    await act(async () => {});

    // Failure keeps the editor open, re-enabled, with the draft.
    const input = byLabel(r, 'Edit org todo title')[0];
    expect(input.props.editable).toBe(true);
    expect(input.props.value).toBe('v1');
    expect(byLabel(r, 'Cancel edit')[0].props.disabled).toBe(false);
    expect(texts(r)).toContain('save failed');
  });
});

describe('OrgTodosSection (mobile) — a reopened editing session survives an earlier deferred save', () => {
  it('A→B→A: the original save completing does not close the reopened A editor', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo('a', 'Row A'), makeTodo('b', 'Row B')],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    // Session 1: open A, edit, Save (stays pending; A's editor locks).
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress(); // Row A
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('A v1');
    });
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // Session 2: open B (bumps the editing session; A's editor closes).
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress(); // only B shows a pencil now
    });
    // Session 3: reopen A (bumps again; A reopens fresh/unlocked). Type a NEW draft.
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress(); // only A shows a pencil now
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('A v2 reopened');
    });

    // The original (session-1) save resolves; it must NOT close the reopened A
    // editor (session 3) — that would discard 'A v2 reopened'.
    await act(async () => {
      putA.resolve({ todo: makeTodo('a', 'A v1') });
    });
    await act(async () => {});

    const input = byLabel(r, 'Edit org todo title');
    expect(input).toHaveLength(1);
    expect(input[0].props.value).toBe('A v2 reopened');
  });
});

describe('OrgTodosSection (mobile) — concurrent writes to the same todo are serialized', () => {
  it('holds a reopened save until the previous save for that todo settles (no reversed apply)', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo('a', 'Row A'), makeTodo('b', 'Row B')],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    const s1 = deferred<{ todo: unknown }>();
    const s2 = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(s1.promise).mockReturnValueOnce(s2.promise);

    // Session 1: edit A, save S1 (PUT stays pending).
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('S1');
    });
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // A→B→A, then save S2 on the reopened A.
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress(); // B
    });
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress(); // A reopened
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('S2');
    });
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // S1's PUT in flight; S2's PUT not dispatched yet (serialized per todo).
    expect(mockApi.updateOrgTodo).toHaveBeenCalledTimes(1);
    expect(mockApi.updateOrgTodo.mock.calls[0][2]).toMatchObject({ title: 'S1' });

    // S1 settles → S2's PUT dispatched now, strictly after S1.
    await act(async () => {
      s1.resolve({ todo: makeTodo('a', 'S1') });
    });
    await act(async () => {});
    expect(mockApi.updateOrgTodo).toHaveBeenCalledTimes(2);
    expect(mockApi.updateOrgTodo.mock.calls[1][2]).toMatchObject({ title: 'S2' });

    await act(async () => {
      s2.resolve({ todo: makeTodo('a', 'S2') });
    });
    await act(async () => {});
  });
});

describe('OrgTodosSection (mobile) — a stale save failure does not unlock a newer save session', () => {
  it('S1 rejects while S2 (same row, reopened) is pending: editor stays locked, then S2 closes it', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo('a', 'Row A'), makeTodo('b', 'Row B')],
    });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OrgTodosSection, { orgId: 'acme' }));
    });
    await act(async () => {});
    expect(texts(r)).toContain('Row A');

    const s1 = deferred<{ todo: unknown }>();
    const s2 = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(s1.promise).mockReturnValueOnce(s2.promise);

    // Session 1: open A, edit, Save S1 (pending → A locks).
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('A s1');
    });
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // A→B→A: open B (session 2), reopen A (session 3, unlocked).
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo')[0].props.onPress();
    });
    await act(async () => {
      byLabel(r, 'Edit org todo title')[0].props.onChangeText('A s3');
    });

    // Session 3: Save S2 (pending → A locks again).
    await act(async () => {
      byLabel(r, 'Save org todo')[0].props.onPress();
    });

    // Stale S1 rejects — must NOT unlock the session-3 editor.
    await act(async () => {
      s1.reject(new Error('s1 failed'));
    });
    await act(async () => {});
    expect(byLabel(r, 'Edit org todo title')[0].props.editable).toBe(false);

    // S2 succeeds → editor closes.
    await act(async () => {
      s2.resolve({ todo: makeTodo('a', 'A s3') });
    });
    await act(async () => {});
    expect(byLabel(r, 'Edit org todo title')).toHaveLength(0);
  });
});
