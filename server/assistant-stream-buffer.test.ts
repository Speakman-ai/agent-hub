import { describe, it, expect } from 'vitest';
import {
  accumulateAssistantStream,
  applyAssistantTextChunk,
  foldAssistantTextChunk,
} from './assistant-stream-buffer.js';

describe('assistant-stream-buffer', () => {
  it('accumulateAssistantStream matches finalText + partialFallback concatenation', () => {
    expect(accumulateAssistantStream('a', 'b')).toBe('ab');
    expect(accumulateAssistantStream('', 'partial')).toBe('partial');
    expect(accumulateAssistantStream('final', '')).toBe('final');
  });

  it('foldAssistantTextChunk routes partial vs finalized chunks', () => {
    let state = { finalText: '', partialFallback: '' };
    state = foldAssistantTextChunk(state, 'a', false);
    expect(state).toEqual({ finalText: 'a', partialFallback: '' });
    state = foldAssistantTextChunk(state, 'b', true);
    expect(state).toEqual({ finalText: 'a', partialFallback: 'b' });
    state = foldAssistantTextChunk(state, 'c', false);
    expect(state).toEqual({ finalText: 'ac', partialFallback: 'b' });
  });

  it('applyAssistantTextChunk matches manual fold + accumulate for each chunk', () => {
    let state = { finalText: '', partialFallback: '' };
    const chunks = [
      { text: 'a', partial: false },
      { text: 'b', partial: true },
      { text: 'c', partial: false },
    ];
    for (const ch of chunks) {
      const manualFold = foldAssistantTextChunk(state, ch.text, ch.partial);
      const manualAcc = accumulateAssistantStream(manualFold.finalText, manualFold.partialFallback);
      const step = applyAssistantTextChunk(state, ch.text, ch.partial);
      expect(step.accumulated).toBe(manualAcc);
      expect(step.next).toEqual(manualFold);
      state = step.next;
    }
  });

  it('replace option overwrites buffers for Cursor canonical replace', () => {
    let state = { finalText: '', partialFallback: 'partial-only' };
    const step = applyAssistantTextChunk(state, 'Intro\nfinalized', false, { replace: true });
    expect(step.next).toEqual({ finalText: 'Intro\nfinalized', partialFallback: '' });
    expect(step.accumulated).toBe('Intro\nfinalized');
  });

  it('matches partial deltas then Cursor canonical replace', () => {
    let state = { finalText: '', partialFallback: '' };
    state = applyAssistantTextChunk(state, 'stream', true).next;
    state = applyAssistantTextChunk(state, 'ed', true).next;
    const canonical = 'streamed\n\nDone.';
    state = applyAssistantTextChunk(state, canonical, false, { replace: true }).next;
    expect(state).toEqual({ finalText: canonical, partialFallback: '' });
    expect(accumulateAssistantStream(state.finalText, state.partialFallback)).toBe(canonical);
  });
});
