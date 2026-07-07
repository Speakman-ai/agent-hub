import { describe, it, expect } from 'vitest';
import {
    moveTodoId,
    splitTodos,
    dueState,
    dueLabel,
    dateInputToIso,
    isoToDateInput,
    type TodoLike,
} from './todos';

const mk = (over: Partial<TodoLike> & { id: string }): TodoLike => ({
    status: 'open',
    dueAt: null,
    position: 0,
    ...over,
});

describe('moveTodoId', () => {
    it('moves an id up one slot', () => {
        expect(moveTodoId(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
    });

    it('moves an id down one slot', () => {
        expect(moveTodoId(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
    });

    it('returns the original order when already at the top and moving up', () => {
        const ids = ['a', 'b', 'c'];
        expect(moveTodoId(ids, 'a', 'up')).toBe(ids);
    });

    it('returns the original order when already at the bottom and moving down', () => {
        const ids = ['a', 'b', 'c'];
        expect(moveTodoId(ids, 'c', 'down')).toBe(ids);
    });

    it('returns the original order for an unknown id', () => {
        const ids = ['a', 'b'];
        expect(moveTodoId(ids, 'z', 'up')).toBe(ids);
    });

    it('does not mutate the input array', () => {
        const ids = ['a', 'b', 'c'];
        moveTodoId(ids, 'b', 'up');
        expect(ids).toEqual(['a', 'b', 'c']);
    });
});

describe('splitTodos', () => {
    it('separates open and done, preserving order within each bucket', () => {
        const todos = [
            mk({ id: '1', status: 'open' }),
            mk({ id: '2', status: 'done' }),
            mk({ id: '3', status: 'open' }),
            mk({ id: '4', status: 'done' }),
        ];
        const { open, done } = splitTodos(todos);
        expect(open.map((t) => t.id)).toEqual(['1', '3']);
        expect(done.map((t) => t.id)).toEqual(['2', '4']);
    });
});

describe('dueState / dueLabel', () => {
    const now = new Date('2026-07-07T12:00:00');

    it('classifies past dates as overdue', () => {
        expect(dueState('2026-07-06T09:00:00', now)).toBe('overdue');
        expect(dueLabel('2026-07-06T09:00:00', now)).toMatch(/^Overdue/);
    });

    it('classifies same-day (any time) as today', () => {
        expect(dueState('2026-07-07T23:00:00', now)).toBe('today');
        expect(dueLabel('2026-07-07T23:00:00', now)).toBe('Today');
    });

    it('classifies the next day as tomorrow', () => {
        expect(dueState('2026-07-08T00:30:00', now)).toBe('tomorrow');
        expect(dueLabel('2026-07-08T00:30:00', now)).toBe('Tomorrow');
    });

    it('classifies further-out dates as upcoming with a short date label', () => {
        expect(dueState('2026-07-15T00:00:00', now)).toBe('upcoming');
        expect(dueLabel('2026-07-15T00:00:00', now)).not.toMatch(/Overdue|Today|Tomorrow/);
    });

    it('returns none/empty for missing or invalid dates', () => {
        expect(dueState(null, now)).toBe('none');
        expect(dueState('not-a-date', now)).toBe('none');
        expect(dueLabel(null, now)).toBe('');
    });
});

describe('date <-> input conversions', () => {
    it('round-trips a date-input value through ISO', () => {
        const iso = dateInputToIso('2026-07-12');
        expect(iso).not.toBeNull();
        expect(isoToDateInput(iso)).toBe('2026-07-12');
    });

    it('treats an empty input as clearing the due date', () => {
        expect(dateInputToIso('')).toBeNull();
        expect(dateInputToIso('   ')).toBeNull();
    });

    it('returns empty for a null/invalid ISO', () => {
        expect(isoToDateInput(null)).toBe('');
        expect(isoToDateInput('garbage')).toBe('');
    });
});
