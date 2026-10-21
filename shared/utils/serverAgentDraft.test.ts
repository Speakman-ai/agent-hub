import { describe, it, expect } from 'vitest';
import {
  initialServerAgentDraft,
  nextServerAgentSave,
  serverAgentDraftReducer as reduce,
  type ServerAgentDraftAction,
  type ServerAgentDraftState,
} from './serverAgentDraft';

const saved = (name: string, instructions: string) => ({
  name,
  instructions,
  defaultName: 'Server Agent',
  effectiveName: name || 'Server Agent',
});

const run = (actions: ServerAgentDraftAction[], from = initialServerAgentDraft) =>
  actions.reduce<ServerAgentDraftState>(reduce, from);

const loadedA = run([
  { type: 'load', owner: 'A', settings: { name: 'A-agent', instructions: 'A secret' } },
]);

describe('serverAgentDraftReducer', () => {
  it('applies a save result to fields untouched since submitting', () => {
    const start = run([{ type: 'edit', field: 'name', value: '  A2 ' }], loadedA);
    const save = nextServerAgentSave(start)!;
    const done = run(
      [
        { type: 'saveStart' },
        { type: 'saveDone', seq: save.seq, owner: 'A', saved: saved('A2', 'A secret') },
      ],
      start,
    );
    expect(done).toMatchObject({ name: 'A2', instructions: 'A secret', pending: null });
    expect(done.status?.ok).toBe(true);
  });

  it('keeps edits made while the save was pending', () => {
    const start = run([{ type: 'edit', field: 'name', value: 'A2' }], loadedA);
    const save = nextServerAgentSave(start)!;
    const done = run(
      [
        { type: 'saveStart' },
        { type: 'edit', field: 'name', value: 'A3' },
        { type: 'edit', field: 'instructions', value: 'newer' },
        { type: 'saveDone', seq: save.seq, owner: 'A', saved: saved('A2', 'A secret') },
      ],
      start,
    );
    expect(done).toMatchObject({ name: 'A3', instructions: 'newer', pending: null });
  });

  it("drops a save that completes after the account changed, even once B's draft loads", () => {
    const save = nextServerAgentSave(loadedA)!;
    const done = run(
      [
        { type: 'saveStart' },
        { type: 'clear' },
        { type: 'load', owner: 'B', settings: { name: 'B-agent', instructions: 'B notes' } },
        { type: 'saveDone', seq: save.seq, owner: 'A', saved: saved('A2', 'A secret') },
        { type: 'saveFailed', seq: save.seq, owner: 'A', message: 'boom' },
      ],
      loadedA,
    );
    expect(done).toMatchObject({ owner: 'B', name: 'B-agent', instructions: 'B notes' });
    expect(done.status).toBeNull();
  });

  it('ignores a stale sequence and allows one save at a time', () => {
    const first = nextServerAgentSave(loadedA)!;
    const started = reduce(loadedA, { type: 'saveStart' });
    expect(nextServerAgentSave(started)).toBeNull();
    expect(reduce(started, { type: 'saveStart' })).toBe(started);
    const stale = reduce(started, {
      type: 'saveDone',
      seq: first.seq - 1,
      owner: 'A',
      saved: saved('x', 'y'),
    });
    expect(stale).toBe(started);
  });

  it('ignores edits and saves with no loaded account', () => {
    const cleared = reduce(loadedA, { type: 'clear' });
    expect(cleared).toMatchObject({ owner: null, name: '', instructions: '' });
    expect(reduce(cleared, { type: 'edit', field: 'name', value: 'x' }).name).toBe('');
    expect(nextServerAgentSave(cleared)).toBeNull();
  });

  it("ignores the first A visit's save completion after A -> B -> A, even with a new save out", () => {
    const first = nextServerAgentSave(loadedA)!;
    const backOnA = run(
      [
        { type: 'saveStart' },
        { type: 'clear' },
        { type: 'load', owner: 'B', settings: { name: 'B-agent', instructions: 'B notes' } },
        { type: 'clear' },
        { type: 'load', owner: 'A', settings: { name: 'A-new', instructions: 'fresh' } },
        { type: 'edit', field: 'instructions', value: 'newest' },
      ],
      loadedA,
    );
    const second = nextServerAgentSave(backOnA)!;
    expect(second.seq).toBeGreaterThan(first.seq);
    const started = reduce(backOnA, { type: 'saveStart' });
    const late = reduce(started, {
      type: 'saveDone',
      seq: first.seq,
      owner: 'A',
      saved: saved('A-old', 'obsolete'),
    });
    expect(late).toBe(started);
    expect(late.instructions).toBe('newest');
  });
});
