import { describe, it, expect } from 'vitest';
import { createRequestGenerationState, beginRequest } from './requestGeneration.js';

describe('requestGeneration', () => {
  it('hands out monotonically increasing ids', () => {
    const s = createRequestGenerationState();
    expect(beginRequest(s).reqId).toBe(1);
    expect(beginRequest(s).reqId).toBe(2);
    expect(beginRequest(s, { silent: true }).reqId).toBe(3);
  });

  it('only foreground requests take spinner ownership', () => {
    const s = createRequestGenerationState();
    const fg = beginRequest(s);
    expect(fg.ownsLoading()).toBe(true);

    // A silent request does not steal ownership from the foreground request…
    const poll = beginRequest(s, { silent: true });
    expect(poll.ownsLoading()).toBe(false);
    expect(fg.ownsLoading()).toBe(true);

    // …but a newer foreground request does.
    const fg2 = beginRequest(s);
    expect(fg.ownsLoading()).toBe(false);
    expect(fg2.ownsLoading()).toBe(true);
  });

  it('lets the latest request commit and supersede older ones', () => {
    const s = createRequestGenerationState();
    const a = beginRequest(s);
    const b = beginRequest(s);

    // Newer (b) commits first.
    expect(b.canCommit()).toBe(true);
    b.commit();
    // Older (a) is now superseded and must not overwrite b's result.
    expect(a.canCommit()).toBe(false);
  });

  it('a request that never commits does NOT invalidate an older one (reviewer case)', () => {
    const s = createRequestGenerationState();
    // Mount/foreground load starts…
    const foreground = beginRequest(s);
    // …a 5s silent poll starts (bumps startSeq) but ultimately fails, so it
    // never calls commit().
    const failingPoll = beginRequest(s, { silent: true });
    expect(failingPoll.reqId).toBeGreaterThan(foreground.reqId);

    // The foreground request later succeeds: because the failing poll never
    // committed, the high-water mark is still 0 and the foreground result is
    // allowed to land.
    expect(foreground.canCommit()).toBe(true);
    foreground.commit();
    expect(s.commitSeq).toBe(foreground.reqId);
  });

  it('a newer committed result blocks a slower older foreground result', () => {
    const s = createRequestGenerationState();
    const foreground = beginRequest(s);
    const poll = beginRequest(s, { silent: true });

    // The newer poll commits replacement data first.
    poll.commit();
    // Now the older foreground response resolving late must be dropped.
    expect(foreground.canCommit()).toBe(false);
  });

  it('commit is idempotent and never lowers the high-water mark', () => {
    const s = createRequestGenerationState();
    const a = beginRequest(s);
    const b = beginRequest(s);
    b.commit();
    expect(s.commitSeq).toBe(b.reqId);
    // A late, superseded commit() from `a` must not move the mark backwards.
    a.commit();
    expect(s.commitSeq).toBe(b.reqId);
  });
});
