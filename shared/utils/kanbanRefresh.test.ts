import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addKanbanRefreshProject,
  createRefreshScheduler,
  kanbanEventTargetsProject,
} from './kanbanRefresh.js';

describe('kanban refresh coordination', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ignores events from projects other than the visible board', () => {
    expect(kanbanEventTargetsProject('project-a', 'project-a')).toBe(true);
    expect(kanbanEventTargetsProject('project-b', 'project-a')).toBe(false);
    expect(kanbanEventTargetsProject(undefined, 'project-a')).toBe(false);
  });

  it('preserves all project IDs in one coalesced refresh window', () => {
    let pending = new Set<string>();
    pending = addKanbanRefreshProject(pending, 'project-a');
    pending = addKanbanRefreshProject(pending, 'project-b');

    expect(pending).toEqual(new Set(['project-a', 'project-b']));
  });

  it('coalesces a burst into one refresh and cancels it on dispose', () => {
    const refresh = vi.fn();
    const scheduler = createRefreshScheduler(refresh, 100);

    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(99);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    scheduler.dispose();
    vi.advanceTimersByTime(100);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
