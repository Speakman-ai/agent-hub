import { describe, it, expect } from 'vitest';
import { appendPreviewLogTailLine, trimPreviewLogTail } from './preview-log-tail.js';

describe('preview-log-tail', () => {
  it('appendPreviewLogTailLine drops oldest lines over max', () => {
    const tail: string[] = [];
    for (let i = 0; i < 10; i++) appendPreviewLogTailLine(tail, `line-${i}`, 4);
    expect(tail).toEqual(['line-6', 'line-7', 'line-8', 'line-9']);
  });

  it('trimPreviewLogTail returns the last N lines', () => {
    expect(trimPreviewLogTail(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
  });
});
