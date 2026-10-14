import { describe, it, expect, vi } from 'vitest';
import { SILENCE_WARNING_MS } from '@shared/utils/audioLevel';
import { createVoiceLevelStore } from './voiceLevel';

describe('voice level store', () => {
  it('ignores readings until a take begins', () => {
    const store = createVoiceLevelStore();
    store.push(-10, 100);
    expect(store.get().level).toBe(0);
  });

  it('publishes level readings and notifies subscribers', () => {
    const store = createVoiceLevelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.begin(0);
    store.push(-30, 200);
    expect(store.get().level).toBeCloseTo(0.5);
    expect(listener).toHaveBeenCalled();
  });

  it('warns when the mic delivers no metering at all', () => {
    const store = createVoiceLevelStore();
    store.begin(0);
    for (let t = 200; t <= SILENCE_WARNING_MS + 200; t += 200) store.push(undefined, t);
    expect(store.get().warning).toBe('no-signal');
    store.reset();
    expect(store.get()).toEqual({ level: 0, warning: null });
  });

  it('warns about a quiet live mic', () => {
    const store = createVoiceLevelStore();
    store.begin(0);
    for (let t = 200; t <= SILENCE_WARNING_MS + 200; t += 200) store.push(-75, t);
    expect(store.get().warning).toBe('quiet');
  });
});
