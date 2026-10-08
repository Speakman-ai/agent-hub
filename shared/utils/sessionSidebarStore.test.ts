import { describe, it, expect, vi } from 'vitest';
import { createSidebarStore } from './sessionSidebarStore.js';
import { sidebarView } from './sessionSidebar.js';

describe('createSidebarStore', () => {
  it('keeps state per parent independently of any subscriber', () => {
    const store = createSidebarStore();
    store.dispatch('p1', { type: 'load_start', token: store.nextToken(), parentSessionId: 'p1' });
    store.dispatch('p1', { type: 'load_result', token: 1, sidebarId: null, running: false });
    store.dispatch('p1', { type: 'ask_local', questionId: 'q1', content: 'kept' });
    store.dispatch('p1', { type: 'ask_failed', questionId: 'q1', error: 'x' });
    expect(sidebarView(store.get('p1')).messages.map((m) => m.content)).toEqual(['kept']);
    expect(sidebarView(store.get('p2')).messages).toEqual([]);
  });

  it('notifies only that parent’s subscribers, and only on change', () => {
    const store = createSidebarStore();
    const p1 = vi.fn();
    const p2 = vi.fn();
    const off = store.subscribe('p1', p1);
    store.subscribe('p2', p2);
    store.dispatch('p1', { type: 'ask_local', questionId: 'q1', content: 'a' });
    expect(p1).toHaveBeenCalledTimes(1);
    expect(p2).not.toHaveBeenCalled();
    store.dispatch('p1', { type: 'op_discarded', opId: 99 }); // no pending op: no change
    expect(p1).toHaveBeenCalledTimes(1);
    off();
    store.dispatch('p1', { type: 'ask_local', questionId: 'q2', content: 'b' });
    expect(p1).toHaveBeenCalledTimes(1);
  });

  it('hands out ids that stay unique across mounts', () => {
    const store = createSidebarStore();
    expect(new Set([store.nextToken(), store.nextToken()]).size).toBe(2);
    expect(store.nextQuestionId()).not.toBe(store.nextQuestionId());
  });
});
