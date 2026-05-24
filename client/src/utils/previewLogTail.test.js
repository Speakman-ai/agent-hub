import { describe, it, expect } from 'vitest';
import {
  PREVIEW_LOG_TAIL_MAX,
  appendPreviewLogTail,
  mergePreviewEventLogTail,
} from './previewLogTail.js';

describe('previewLogTail', () => {
  it('caps appendPreviewLogTail at PREVIEW_LOG_TAIL_MAX', () => {
    let tail = [];
    for (let i = 0; i < PREVIEW_LOG_TAIL_MAX + 50; i++) {
      tail = appendPreviewLogTail(tail, `line-${i}`);
    }
    expect(tail).toHaveLength(PREVIEW_LOG_TAIL_MAX);
    expect(tail[0]).toBe('line-50');
    expect(tail[tail.length - 1]).toBe(`line-${PREVIEW_LOG_TAIL_MAX + 49}`);
  });

  it('mergePreviewEventLogTail keeps previous tail when incoming omits it', () => {
    expect(mergePreviewEventLogTail(undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(mergePreviewEventLogTail([], ['a'])).toEqual(['a']);
  });
});
