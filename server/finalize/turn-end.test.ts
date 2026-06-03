import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testFinalizeTurnEndListenerCount,
  __testResetFinalizeTurnEndListeners,
  finalizeTurnEndSubscriber,
  notifyFinalizeSessionTurnEnd,
  notifyFinalizeSessionSpawnFailed,
} from './turn-end.js';

describe('finalize turn-end bus', () => {
  afterEach(() => {
    __testResetFinalizeTurnEndListeners();
  });

  it('notifies subscribers when a session turn ends', () => {
    const onEnd = vi.fn();
    finalizeTurnEndSubscriber.subscribe('sess-1', onEnd);
    expect(__testFinalizeTurnEndListenerCount('sess-1')).toBe(1);

    notifyFinalizeSessionTurnEnd('sess-1');
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith('turn_ended');

    notifyFinalizeSessionTurnEnd('other');
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('notifies subscribers when agent spawn fails', () => {
    const onEnd = vi.fn();
    finalizeTurnEndSubscriber.subscribe('sess-1', onEnd);
    notifyFinalizeSessionSpawnFailed('sess-1');
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith('spawn_failed');
  });

  it('unsubscribes cleanly', () => {
    const onEnd = vi.fn();
    const unsub = finalizeTurnEndSubscriber.subscribe('sess-1', onEnd);
    unsub();
    notifyFinalizeSessionTurnEnd('sess-1');
    expect(onEnd).not.toHaveBeenCalled();
    expect(__testFinalizeTurnEndListenerCount('sess-1')).toBe(0);
  });
});
