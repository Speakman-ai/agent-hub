import { describe, it, expect } from 'vitest';
import {
  accumulateAssistantStream,
  applyAssistantTextChunk,
  foldAssistantTextChunk,
} from './assistant-stream-buffer.js';

describe('assistant-stream-buffer', () => {
  it('accumulates finalized and partial text', () => {
    expect(accumulateAssistantStream('a', 'b')).toBe('ab');
    expect(accumulateAssistantStream('', 'partial')).toBe('partial');
  });

  it('matches the manual fold for mixed stream chunks', () => {
    let state = { finalText: '', partialFallback: '' };
    for (const chunk of [
      { text: 'a', partial: false },
      { text: 'b', partial: true },
      { text: 'c', partial: false },
    ]) {
      const manual = foldAssistantTextChunk(state, chunk.text, chunk.partial);
      const step = applyAssistantTextChunk(state, chunk.text, chunk.partial);
      expect(step.accumulatedText).toBe(
        accumulateAssistantStream(manual.finalText, manual.partialFallback),
      );
      expect(step.next).toEqual(manual);
      state = step.next;
    }
  });

  it('supports replacing partial output with a canonical result', () => {
    let state = { finalText: '', partialFallback: 'partial-only' };
    const step = applyAssistantTextChunk(state, 'canonical', false, { replace: true });
    expect(step.next).toEqual({ finalText: 'canonical', partialFallback: '' });
    expect(step.accumulatedText).toBe('canonical');
  });
});
