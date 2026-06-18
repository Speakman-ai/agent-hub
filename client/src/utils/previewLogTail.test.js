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

  it('mergePreviewEventLogTail adopts a snapshot that forward-extends the live tail', () => {
    // Snapshot continues from the live tail's end and adds new lines (e.g.
    // recovering lines lost to a dropped live frame) — adopt the extension.
    expect(mergePreviewEventLogTail(['a', 'b', 'c'], ['a'])).toEqual(['a', 'b', 'c']);
  });

  it('mergePreviewEventLogTail never lets a stale snapshot rewind the live stream', () => {
    // Live stream already streamed past the snapshot — keep the live tail so
    // the boot log does not jump backwards ("looping").
    expect(mergePreviewEventLogTail(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('mergePreviewEventLogTail does not rewind when a stale snapshot is LONGER than the live tail', () => {
    // Reviewer case: length must not be the freshness signal. The snapshot
    // is longer but does not continue the live tail's most recent line, so
    // it must NOT replace it.
    expect(mergePreviewEventLogTail(['a', 'b', 'c', 'd'], ['c', 'd', 'e'])).toEqual([
      'c',
      'd',
      'e',
    ]);
  });

  it('mergePreviewEventLogTail recovers new lines across two capped windows', () => {
    // Two sliding windows of the same stream (as happens at
    // PREVIEW_LOG_TAIL_MAX): the snapshot window has shifted forward by one
    // and exposes a newer line — adopt that line without rewinding.
    expect(mergePreviewEventLogTail(['d', 'e', 'f'], ['c', 'd', 'e'])).toEqual([
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('mergePreviewEventLogTail is a no-op for an identical snapshot (no duplication)', () => {
    expect(mergePreviewEventLogTail(['a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('mergePreviewEventLogTail recovers across REPEATED lines (reviewer case)', () => {
    // previous = ['x','a','b'], incoming = ['a','b','c','b','d']. The valid
    // overlap is ['a','b'] at the start; the later repeated 'b' (incoming[3])
    // is an inconsistent anchor and must NOT abort the scan — we continue to
    // the earlier anchor and recover c/b/d.
    expect(mergePreviewEventLogTail(['a', 'b', 'c', 'b', 'd'], ['x', 'a', 'b'])).toEqual([
      'x',
      'a',
      'b',
      'c',
      'b',
      'd',
    ]);
  });

  it('mergePreviewEventLogTail recovers when the snapshot carries older leading history', () => {
    // The overlap (['b','c']) sits in the MIDDLE of incoming, not its prefix,
    // because the snapshot still holds older line 'a' the live tail trimmed.
    expect(mergePreviewEventLogTail(['a', 'b', 'c', 'd'], ['b', 'c'])).toEqual(['b', 'c', 'd']);
  });

  it('mergePreviewEventLogTail picks the consistent anchor when the last line repeats', () => {
    // Same stream ...a,b,c,b,c,d. Live tail = [a,b,c]; snapshot is the fuller
    // window [a,b,c,b,c,d]. The last line 'c' occurs twice in the snapshot;
    // the later occurrence's preceding context (…b,c) does not match the live
    // tail's (…a,b,c), so only the earlier anchor is valid — recover b/c/d.
    expect(mergePreviewEventLogTail(['a', 'b', 'c', 'b', 'c', 'd'], ['a', 'b', 'c'])).toEqual([
      'a',
      'b',
      'c',
      'b',
      'c',
      'd',
    ]);
  });
});
