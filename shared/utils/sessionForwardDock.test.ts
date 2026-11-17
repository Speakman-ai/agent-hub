import { describe, expect, it, vi } from 'vitest';
import {
  DISMISSED_FORWARD_VALUE,
  createSessionForwardDock,
  dockedForwardsFor,
  parseSavedForwardState,
} from './sessionForwardDock.js';
import type { ExtractedForward } from './extractForwardBlocks.js';

const forward: ExtractedForward = {
  forwardId: 'fwd-1',
  projectId: 'app',
  agentId: 'ada',
  name: 'Fix login',
  summary: 'Repair it.',
  prompt: 'Fix it.',
  mode: 'manual',
};

const entry = (identity: string, chatSessionId = 'chat-1') => ({
  identity,
  chatSessionId,
  messageId: 'm-1',
  forward: { ...forward },
  occurrence: 0,
});

describe('createSessionForwardDock', () => {
  it('keeps pin order and only notifies on a real change', () => {
    const dock = createSessionForwardDock();
    const listener = vi.fn();
    dock.subscribe(listener);
    dock.pin(entry('a'));
    dock.pin(entry('b'));
    const before = dock.snapshot();
    // A re-render pins an equal entry with a new object: no change.
    dock.pin(entry('a'));
    expect(dock.snapshot()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(dock.snapshot().map((e) => e.identity)).toEqual(['a', 'b']);
    dock.unpin('a');
    dock.unpin('missing');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(dock.snapshot().map((e) => e.identity)).toEqual(['b']);
  });

  it('filters by chat', () => {
    const dock = createSessionForwardDock();
    dock.pin(entry('a', 'chat-1'));
    dock.pin(entry('b', 'chat-2'));
    expect(dockedForwardsFor(dock.snapshot(), 'chat-2').map((e) => e.identity)).toEqual(['b']);
    expect(dockedForwardsFor(dock.snapshot(), null)).toEqual([]);
  });
});

describe('parseSavedForwardState', () => {
  it('reads dismissed and forwarded values', () => {
    expect(parseSavedForwardState(DISMISSED_FORWARD_VALUE)).toBe('dismissed');
    expect(parseSavedForwardState(JSON.stringify({ sessionId: 's', agentId: 'a' }))).toBe(
      'forwarded',
    );
    expect(parseSavedForwardState(null)).toBeNull();
    expect(parseSavedForwardState('not json')).toBeNull();
    expect(parseSavedForwardState('{}')).toBeNull();
  });
});
