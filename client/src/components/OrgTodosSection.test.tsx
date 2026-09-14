import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    listOrgTodos: vi.fn(),
    createOrgTodo: vi.fn(),
    updateOrgTodo: vi.fn(),
    deleteOrgTodo: vi.fn(),
    reorderOrgTodos: vi.fn(),
  },
}));

import OrgTodosSection from './OrgTodosSection';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function makeTodo(over: Partial<Record<string, unknown>> & { id: string; title: string }) {
  return {
    orgId: 'acme',
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
    ...over,
  };
}

/** A promise whose resolution we control, to force response completion order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OrgTodosSection — out-of-order refresh responses', () => {
  it('does not let an earlier GET that resolves late overwrite newer state', async () => {
    // Mount load (gen 1) resolves immediately with the "old" list.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 't-old', title: 'OLD' })],
    });

    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('OLD')).toBeInTheDocument();

    // Now stage two overlapping refreshes: gen 2 (stale/slow) and gen 3 (newest).
    const stale = deferred<{ todos: unknown[] }>();
    const newest = deferred<{ todos: unknown[] }>();
    mockApi.listOrgTodos.mockReturnValueOnce(stale.promise); // 2nd call -> generation 2
    mockApi.listOrgTodos.mockReturnValueOnce(newest.promise); // 3rd call -> generation 3

    // Fire two org_todo_update events → two silent loads issued in order.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('org_todo_update', { detail: { orgId: 'acme' } }));
      window.dispatchEvent(new CustomEvent('org_todo_update', { detail: { orgId: 'acme' } }));
    });

    // The NEWER request (gen 3) completes first with the fresh list…
    await act(async () => {
      newest.resolve({ todos: [makeTodo({ id: 't-new', title: 'NEW' })] });
    });
    expect(await screen.findByText('NEW')).toBeInTheDocument();

    // …then the older request (gen 2) resolves late with stale data. It must be
    // discarded — the generation guard keeps the newer state.
    await act(async () => {
      stale.resolve({ todos: [makeTodo({ id: 't-old', title: 'STALE' })] });
    });

    await waitFor(() => {
      expect(screen.queryByText('STALE')).not.toBeInTheDocument();
    });
    expect(screen.getByText('NEW')).toBeInTheDocument();
  });
});

describe('OrgTodosSection — mutation response never overwrites a newer refresh', () => {
  it('discards the PUT snapshot when a newer GET already landed (reconciles via refresh)', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [makeTodo({ id: 't1', title: 'A' })] });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('A')).toBeInTheDocument();

    // A mutation (toggle → PUT) that resolves slowly, a teammate refresh GET, and
    // the post-mutation authoritative reconcile GET — all staged separately.
    const put = deferred<{ todo: unknown }>();
    const teammate = deferred<{ todos: unknown[] }>();
    const reconcile = deferred<{ todos: unknown[] }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(put.promise);
    mockApi.listOrgTodos.mockReturnValueOnce(teammate.promise); // teammate refresh
    mockApi.listOrgTodos.mockReturnValueOnce(reconcile.promise); // post-PUT reconcile

    // Start the mutation; its PUT stays pending.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Mark as done'));
    });

    // A teammate's change refreshes to a NEWER title while the PUT is in flight.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('org_todo_update', { detail: { orgId: 'acme' } }));
    });
    await act(async () => {
      teammate.resolve({ todos: [makeTodo({ id: 't1', title: 'NEWER' })] });
    });
    expect(await screen.findByText('NEWER')).toBeInTheDocument();

    // Now the older PUT resolves with its stale snapshot — it must NOT be
    // installed; the mutation reconciles through an authoritative refresh.
    await act(async () => {
      put.resolve({ todo: makeTodo({ id: 't1', title: 'PUT-STALE' }) });
    });
    await act(async () => {
      reconcile.resolve({ todos: [makeTodo({ id: 't1', title: 'FINAL' })] });
    });

    expect(screen.queryByText('PUT-STALE')).not.toBeInTheDocument();
    expect(await screen.findByText('FINAL')).toBeInTheDocument();
  });
});

describe('OrgTodosSection — live refresh preserves an unsaved editor draft', () => {
  it('does not reset draft fields when the edited todo is refreshed mid-edit', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 't1', title: 'Original' })],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Original')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Edit org todo'));
    const input = (await screen.findByLabelText('Edit org todo title')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'dirty draft' } });

    // A teammate changes the same todo's title; our silent refresh applies it to
    // the underlying list, but the open editor's draft must survive.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 't1', title: 'Remote Changed' })],
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('org_todo_update', { detail: { orgId: 'acme' } }));
    });
    await act(async () => {});

    const stillEditing = screen.getByLabelText('Edit org todo title') as HTMLInputElement;
    expect(stillEditing.value).toBe('dirty draft');
  });
});

describe('OrgTodosSection — failed edit keeps the draft', () => {
  it('leaves the editor open with the typed draft when the update rejects', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo({ id: 't1', title: 'Original' })],
    });
    mockApi.updateOrgTodo.mockRejectedValue(new Error('save failed'));

    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Original')).toBeInTheDocument();

    // Enter edit mode.
    fireEvent.click(screen.getByLabelText('Edit org todo'));
    const titleInput = (await screen.findByLabelText('Edit org todo title')) as HTMLInputElement;

    // Type a new draft title, then attempt to save.
    fireEvent.change(titleInput, { target: { value: 'My unsaved draft' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // The save failed → the editor must stay open with the draft intact, not
    // collapse back to the unchanged row.
    await waitFor(() => {
      expect(screen.getByText('save failed')).toBeInTheDocument();
    });
    const stillEditing = screen.getByLabelText('Edit org todo title') as HTMLInputElement;
    expect(stillEditing).toBeInTheDocument();
    expect(stillEditing.value).toBe('My unsaved draft');
  });
});

describe('OrgTodosSection — mutation errors survive the reconcile refresh', () => {
  it('keeps the delete error after the reconcile GET restores the row', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 't1', title: 'Keep me' })],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Keep me')).toBeInTheDocument();

    mockApi.deleteOrgTodo.mockRejectedValueOnce(new Error('delete failed'));
    // The silent reconcile after the failed delete restores the row from server.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 't1', title: 'Keep me' })],
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete org todo'));
    });

    // Row restored by the reconcile AND the failure explanation still visible.
    await waitFor(() => expect(screen.getByText('delete failed')).toBeInTheDocument());
    expect(screen.getByText('Keep me')).toBeInTheDocument();
    expect(screen.getByText('delete failed')).toBeInTheDocument();
  });

  it('keeps the reorder error after the reconcile GET reverts the order', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [
        makeTodo({ id: 'a', title: 'Row A', position: 0 }),
        makeTodo({ id: 'b', title: 'Row B', position: 1 }),
      ],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    mockApi.reorderOrgTodos.mockRejectedValueOnce(new Error('reorder failed'));
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [
        makeTodo({ id: 'a', title: 'Row A', position: 0 }),
        makeTodo({ id: 'b', title: 'Row B', position: 1 }),
      ],
    });

    await act(async () => {
      fireEvent.click(screen.getAllByLabelText('Move down')[0]); // move Row A down
    });

    // A successful reconcile GET reverts the order but must NOT clear the error.
    await waitFor(() => expect(screen.getByText('reorder failed')).toBeInTheDocument());
    expect(screen.getByText('reorder failed')).toBeInTheDocument();
  });
});

describe('OrgTodosSection — org switch during a pending mutation', () => {
  it('a stale mutation completion for the old org never writes into the new org list', async () => {
    // Each org returns its own single row.
    mockApi.listOrgTodos.mockImplementation((org: string) =>
      Promise.resolve({ todos: [makeTodo({ id: `${org}1`, title: `${org}-item` })] }),
    );
    // Org A's toggle → PUT stays pending across the org switch.
    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    // The parent keys the section by orgId; changing the key remounts it.
    const { rerender } = render(<OrgTodosSection key="A" orgId="A" />);
    expect(await screen.findByText('A-item')).toBeInTheDocument();

    // Start the mutation in org A.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Mark as done'));
    });

    // Switch to org B — the key change unmounts A's instance and mounts B's.
    rerender(<OrgTodosSection key="B" orgId="B" />);
    expect(await screen.findByText('B-item')).toBeInTheDocument();

    // Org A's mutation finally resolves. Its completion belongs to the unmounted
    // A instance, so it must not touch org B's list.
    await act(async () => {
      putA.resolve({ todo: makeTodo({ id: 'A1', title: 'A-item' }) });
    });
    await act(async () => {});

    expect(screen.getByText('B-item')).toBeInTheDocument();
    expect(screen.queryByText('A-item')).not.toBeInTheDocument();
  });
});

describe('OrgTodosSection — deferred save does not close a newer editor', () => {
  it("a slow save on row A leaves row B's newly opened editor (and draft) intact", async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo({ id: 'a', title: 'Row A' }), makeTodo({ id: 'b', title: 'Row B' })],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    // Row A's save (PUT) stays pending.
    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    // Open row A's editor, change the title, click Save — the save is in flight.
    fireEvent.click(screen.getAllByLabelText('Edit org todo')[0]); // Row A
    fireEvent.change(await screen.findByLabelText('Edit org todo title'), {
      target: { value: 'A edited' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // While A's save is pending, open row B's editor (only B shows a pencil now)
    // and type a draft.
    fireEvent.click(screen.getByLabelText('Edit org todo'));
    fireEvent.change(screen.getByLabelText('Edit org todo title'), {
      target: { value: 'B draft' },
    });

    // Now A's save resolves. Its onSave completion must NOT close row B's editor.
    await act(async () => {
      putA.resolve({ todo: makeTodo({ id: 'a', title: 'A edited' }) });
    });
    await act(async () => {});

    // Row B's editor is still open with the unsaved draft.
    const stillEditing = screen.getByLabelText('Edit org todo title') as HTMLInputElement;
    expect(stillEditing).toBeInTheDocument();
    expect(stillEditing.value).toBe('B draft');
  });
});

describe('OrgTodosSection — editor is locked while its save is in flight', () => {
  it('disables same-row editing and cancel during the save, then closes cleanly', async () => {
    mockApi.listOrgTodos.mockResolvedValue({ todos: [makeTodo({ id: 'a', title: 'Row A' })] });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    fireEvent.click(screen.getByLabelText('Edit org todo'));
    fireEvent.change(await screen.findByLabelText('Edit org todo title'), {
      target: { value: 'v1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // While the save is pending the title, notes, date and Cancel are locked, so
    // the user cannot introduce a same-row edit (or cancel/reopen) that the save
    // completion would then silently discard.
    expect((screen.getByLabelText('Edit org todo title') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Edit org todo detail') as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText('Cancel edit') as HTMLButtonElement).disabled).toBe(true);

    // Completing the save closes the editor cleanly (nothing could have changed).
    await act(async () => {
      putA.resolve({ todo: makeTodo({ id: 'a', title: 'v1' }) });
    });
    await act(async () => {});
    expect(screen.queryByLabelText('Edit org todo title')).not.toBeInTheDocument();
  });

  it('re-enables the editor with the draft intact after a failed save', async () => {
    mockApi.listOrgTodos.mockResolvedValue({ todos: [makeTodo({ id: 'a', title: 'Row A' })] });
    mockApi.updateOrgTodo.mockRejectedValueOnce(new Error('save failed'));
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Edit org todo'));
    fireEvent.change(await screen.findByLabelText('Edit org todo title'), {
      target: { value: 'v1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // Failure keeps the editor open, re-enabled, with the draft — the user can
    // now edit again or cancel/reopen.
    await waitFor(() => expect(screen.getByText('save failed')).toBeInTheDocument());
    const input = screen.getByLabelText('Edit org todo title') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('v1');
    expect((screen.getByLabelText('Cancel edit') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('OrgTodosSection — a reopened editing session survives an earlier deferred save', () => {
  it('A→B→A: the original save completing does not close the reopened A editor', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo({ id: 'a', title: 'Row A' }), makeTodo({ id: 'b', title: 'Row B' })],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    const putA = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(putA.promise);

    // Session 1: open A, edit, Save (stays pending; A's editor locks).
    fireEvent.click(screen.getAllByLabelText('Edit org todo')[0]); // Row A
    fireEvent.change(await screen.findByLabelText('Edit org todo title'), {
      target: { value: 'A v1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // Session 2: open B (bumps the editing session; A's editor closes).
    fireEvent.click(screen.getByLabelText('Edit org todo')); // only B shows a pencil now

    // Session 3: reopen A (bumps again; A reopens fresh/unlocked). Type a NEW draft.
    fireEvent.click(screen.getByLabelText('Edit org todo')); // only A shows a pencil now
    fireEvent.change(screen.getByLabelText('Edit org todo title'), {
      target: { value: 'A v2 reopened' },
    });

    // The original (session-1) save finally resolves. It must NOT close the
    // reopened A editor (session 3) — that would discard 'A v2 reopened'.
    await act(async () => {
      putA.resolve({ todo: makeTodo({ id: 'a', title: 'A v1' }) });
    });
    await act(async () => {});

    const input = screen.getByLabelText('Edit org todo title') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('A v2 reopened');
  });
});

describe('OrgTodosSection — concurrent writes to the same todo are serialized', () => {
  it('holds a reopened save until the previous save for that todo settles (no reversed apply)', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo({ id: 'a', title: 'Row A' }), makeTodo({ id: 'b', title: 'Row B' })],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    const s1 = deferred<{ todo: unknown }>();
    const s2 = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(s1.promise).mockReturnValueOnce(s2.promise);

    // Session 1: edit A, save S1 (its PUT stays pending).
    fireEvent.click(screen.getAllByLabelText('Edit org todo')[0]);
    fireEvent.change(await screen.findByLabelText('Edit org todo title'), {
      target: { value: 'S1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // A→B→A, then save S2 on the reopened A.
    fireEvent.click(screen.getByLabelText('Edit org todo')); // B
    fireEvent.click(screen.getByLabelText('Edit org todo')); // A reopened
    fireEvent.change(screen.getByLabelText('Edit org todo title'), { target: { value: 'S2' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // S1's PUT is in flight; S2's PUT must NOT have been dispatched yet — the
    // per-todo write chain holds it until S1 settles.
    expect(mockApi.updateOrgTodo).toHaveBeenCalledTimes(1);
    expect(mockApi.updateOrgTodo.mock.calls[0][2]).toMatchObject({ title: 'S1' });

    // S1 settles → S2's PUT is dispatched now, strictly after S1.
    await act(async () => {
      s1.resolve({ todo: makeTodo({ id: 'a', title: 'S1' }) });
    });
    await act(async () => {});
    expect(mockApi.updateOrgTodo).toHaveBeenCalledTimes(2);
    expect(mockApi.updateOrgTodo.mock.calls[1][2]).toMatchObject({ title: 'S2' });

    await act(async () => {
      s2.resolve({ todo: makeTodo({ id: 'a', title: 'S2' }) });
    });
    await act(async () => {});
  });
});

describe('OrgTodosSection — a stale save failure does not unlock a newer save session', () => {
  it('S1 rejects while S2 (same row, reopened) is pending: editor stays locked, then S2 closes it', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [makeTodo({ id: 'a', title: 'Row A' }), makeTodo({ id: 'b', title: 'Row B' })],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    const s1 = deferred<{ todo: unknown }>();
    const s2 = deferred<{ todo: unknown }>();
    mockApi.updateOrgTodo.mockReturnValueOnce(s1.promise).mockReturnValueOnce(s2.promise);

    // Session 1: open A, edit, Save S1 (pending → A locks).
    fireEvent.click(screen.getAllByLabelText('Edit org todo')[0]); // Row A
    fireEvent.change(await screen.findByLabelText('Edit org todo title'), {
      target: { value: 'A s1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // A→B→A: open B (session 2), reopen A (session 3, unlocked).
    fireEvent.click(screen.getByLabelText('Edit org todo')); // B
    fireEvent.click(screen.getByLabelText('Edit org todo')); // A reopened
    fireEvent.change(screen.getByLabelText('Edit org todo title'), { target: { value: 'A s3' } });

    // Session 3: Save S2 (pending → A locks again).
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save org todo'));
    });

    // The stale S1 now rejects. It must NOT unlock the session-3 editor (whose
    // own save S2 is still in flight) — otherwise the user could edit and S2's
    // success would then close the editor, discarding that change.
    await act(async () => {
      s1.reject(new Error('s1 failed'));
    });
    await act(async () => {});
    expect((screen.getByLabelText('Edit org todo title') as HTMLInputElement).disabled).toBe(true);

    // S2 succeeds → the editor closes cleanly.
    await act(async () => {
      s2.resolve({ todo: makeTodo({ id: 'a', title: 'A s3' }) });
    });
    await act(async () => {});
    expect(screen.queryByLabelText('Edit org todo title')).not.toBeInTheDocument();
  });
});

describe('OrgTodosSection — a reconcile between queued reorders keeps the newer optimistic order', () => {
  it('an intermediate GET does not install the intermediate order, and a later move builds on the newer one', async () => {
    const withPos = (id: string, title: string, position: number) =>
      makeTodo({ id, title, position });
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [withPos('a', 'Row A', 0), withPos('b', 'Row B', 1), withPos('c', 'Row C', 2)],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    const r1 = deferred<{ todos: unknown[] }>();
    const r2 = deferred<{ todos: unknown[] }>();
    mockApi.reorderOrgTodos.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);

    const orderTitles = () =>
      within(screen.getByTestId('org-todos-open'))
        .getAllByTestId('org-todo-row')
        .map((row) => within(row).getByText(/^Row [ABC]$/).textContent);

    const open = () => screen.getByTestId('org-todos-open');
    // Click 1: A down → [B, A, C]. Click 2: A down again → [B, C, A].
    await act(async () => {
      fireEvent.click(within(open()).getAllByLabelText('Move down')[0]);
    });
    await act(async () => {
      fireEvent.click(within(open()).getAllByLabelText('Move down')[1]);
    });
    expect(orderTitles()).toEqual(['Row B', 'Row C', 'Row A']);

    // R1 settles → its reconcile GET returns the INTERMEDIATE order [B, A, C]
    // (only R1 applied server-side). It must be discarded while R2 is pending.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [withPos('b', 'Row B', 0), withPos('a', 'Row A', 1), withPos('c', 'Row C', 2)],
    });
    await act(async () => {
      r1.resolve({ todos: [] });
    });
    await act(async () => {});

    // The newer optimistic order survives the intermediate reconcile.
    expect(orderTitles()).toEqual(['Row B', 'Row C', 'Row A']);

    // A further move now builds on [B, C, A] (not the intermediate [B, A, C]):
    // moving B down yields [C, B, A]. If the intermediate had been installed,
    // moving B down from [B, A, C] would instead yield [A, B, C].
    await act(async () => {
      fireEvent.click(within(open()).getAllByLabelText('Move down')[0]); // B is first now
    });
    expect(orderTitles()).toEqual(['Row C', 'Row B', 'Row A']);
  });
});

describe('OrgTodosSection — concurrent reorder requests are serialized', () => {
  it('holds a second reorder until the first settles (older order cannot overwrite newer)', async () => {
    mockApi.listOrgTodos.mockResolvedValue({
      todos: [
        makeTodo({ id: 'a', title: 'Row A', position: 0 }),
        makeTodo({ id: 'b', title: 'Row B', position: 1 }),
        makeTodo({ id: 'c', title: 'Row C', position: 2 }),
      ],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    const r1 = deferred<{ todos: unknown[] }>();
    const r2 = deferred<{ todos: unknown[] }>();
    mockApi.reorderOrgTodos.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);

    // Click 1: move A down → order [B, A, C]. Request R1 stays pending.
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('org-todos-open')).getAllByLabelText('Move down')[0],
      );
    });
    // Click 2 (before R1 resolves): move A down again → [B, C, A].
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('org-todos-open')).getAllByLabelText('Move down')[1],
      );
    });

    // The second whole-list request must NOT be dispatched while R1 is pending.
    expect(mockApi.reorderOrgTodos).toHaveBeenCalledTimes(1);
    expect(mockApi.reorderOrgTodos.mock.calls[0][1]).toEqual(['b', 'a', 'c']);

    // R1 settles → R2 is dispatched now, strictly after R1, with the newer order.
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

describe('OrgTodosSection — reorder while another row is being edited', () => {
  it('moves a visible row against its visible neighbor, not the hidden edited row', async () => {
    const A = makeTodo({ id: 'a', title: 'Row A', position: 0 });
    const B = makeTodo({ id: 'b', title: 'Row B', position: 1 });
    const C = makeTodo({ id: 'c', title: 'Row C', position: 2 });
    mockApi.listOrgTodos.mockResolvedValue({ todos: [A, B, C] });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    // Edit the middle row B — it becomes the pinned editor, hidden from the list.
    fireEvent.click(screen.getAllByLabelText('Edit org todo')[1]);

    // The reconcile after the reorder returns A moved below C (B kept in place).
    mockApi.reorderOrgTodos.mockResolvedValueOnce({ todos: [] });
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [
        makeTodo({ id: 'c', title: 'Row C', position: 0 }),
        makeTodo({ id: 'b', title: 'Row B', position: 1 }),
        makeTodo({ id: 'a', title: 'Row A', position: 2 }),
      ],
    });

    // Visible open rows are [A, C]; move A down → it must land below C.
    const openList = screen.getByTestId('org-todos-open');
    await act(async () => {
      fireEvent.click(within(openList).getAllByLabelText('Move down')[0]);
    });
    await act(async () => {});

    // Reorder persisted the visible move against C, not the hidden B.
    expect(mockApi.reorderOrgTodos).toHaveBeenCalledWith('acme', ['c', 'b', 'a']);
    const titles = within(screen.getByTestId('org-todos-open'))
      .getAllByTestId('org-todo-row')
      .map((row) => within(row).getByText(/^Row [AC]$/).textContent);
    expect(titles).toEqual(['Row C', 'Row A']);
  });
});

describe('OrgTodosSection — a remote status transition preserves the open editor', () => {
  it('marking the edited todo done elsewhere keeps the editor open with its draft', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 'a', title: 'Row A', status: 'open' })],
    });
    render(<OrgTodosSection orgId="acme" />);
    expect(await screen.findByText('Row A')).toBeInTheDocument();

    // Open A's editor and type an unsaved draft.
    fireEvent.click(screen.getByLabelText('Edit org todo'));
    fireEvent.change(await screen.findByLabelText('Edit org todo title'), {
      target: { value: 'A unsaved draft' },
    });

    // Another member marks A done; the refresh moves it to the completed bucket.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 'a', title: 'Row A', status: 'done' })],
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('org_todo_update', { detail: { orgId: 'acme' } }));
    });
    await act(async () => {});

    // The editor stays open with the draft intact (it no longer lives in the
    // unmounted row), and the conflict is surfaced.
    const input = screen.getByLabelText('Edit org todo title') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('A unsaved draft');
    expect(screen.getByTestId('org-todo-edit-conflict')).toBeInTheDocument();
  });
});

describe('OrgTodosSection — a reconcile GET failure after a successful mutation is surfaced', () => {
  it('shows a refresh-retry banner (not a mutation error) and never re-runs the create', async () => {
    mockApi.listOrgTodos.mockResolvedValueOnce({ todos: [] });
    render(<OrgTodosSection orgId="acme" />);
    await screen.findByTestId('org-todos-empty');

    // The create succeeds server-side, but its follow-up reconcile GET rejects.
    mockApi.createOrgTodo.mockResolvedValueOnce({ todo: makeTodo({ id: 'x', title: 'new todo' }) });
    mockApi.listOrgTodos.mockRejectedValueOnce(new Error('refresh failed'));

    fireEvent.change(screen.getByLabelText('New org todo title'), {
      target: { value: 'new todo' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('org-todo-add'));
    });
    await act(async () => {});

    // A distinct stale-refresh banner is shown; it is NOT a mutation error, and
    // the create ran exactly once (retrying must not duplicate it).
    expect(screen.getByTestId('org-todos-reconcile-error')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockApi.createOrgTodo).toHaveBeenCalledTimes(1);

    // Retry re-fetches only — no second create — and a successful GET clears it.
    mockApi.listOrgTodos.mockResolvedValueOnce({
      todos: [makeTodo({ id: 'x', title: 'new todo' })],
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('org-todos-reconcile-retry'));
    });
    await act(async () => {});

    expect(screen.queryByTestId('org-todos-reconcile-error')).not.toBeInTheDocument();
    expect(mockApi.createOrgTodo).toHaveBeenCalledTimes(1);
    expect(screen.getByText('new todo')).toBeInTheDocument();
  });
});

describe('OrgTodosSection — deferred create does not wipe a new add-form entry', () => {
  it('keeps a new title typed while the create is in flight', async () => {
    mockApi.listOrgTodos.mockResolvedValue({ todos: [] });
    render(<OrgTodosSection orgId="acme" />);
    await screen.findByTestId('org-todos-empty');

    const create = deferred<{ todo: unknown }>();
    mockApi.createOrgTodo.mockReturnValueOnce(create.promise);

    // Submit "first todo"; the create stays pending.
    fireEvent.change(screen.getByLabelText('New org todo title'), {
      target: { value: 'first todo' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('org-todo-add'));
    });

    // Start typing the next todo while the create is still in flight.
    fireEvent.change(screen.getByLabelText('New org todo title'), {
      target: { value: 'second todo' },
    });

    // The create resolves; its success clear must not wipe the new entry.
    await act(async () => {
      create.resolve({ todo: makeTodo({ id: 'x', title: 'first todo' }) });
    });
    await act(async () => {});

    expect((screen.getByLabelText('New org todo title') as HTMLInputElement).value).toBe(
      'second todo',
    );
  });
});
