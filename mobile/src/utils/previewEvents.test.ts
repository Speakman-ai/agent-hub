import { describe, expect, it } from 'vitest';
import {
  applyPreviewEvent,
  previewEventUrl,
  previewPaneStatus,
  previewLifecycleSeq,
  resolvePreviewEvent,
} from './previewEvents';

describe('applyPreviewEvent', () => {
  it('stores a ready preview and replaces it on the next frame', () => {
    const first = applyPreviewEvent(
      {},
      { sessionId: 's1', kind: 'preview', previewUrl: 'http://localhost:4000' },
    );
    expect(previewPaneStatus(first.s1)).toBe('ready');
    expect(previewEventUrl(first.s1)).toBe('http://localhost:4000');
    const next = applyPreviewEvent(first, {
      sessionId: 's1',
      kind: 'preview',
      fullUrl: 'https://hub.example/api/sessions/s1/preview/proxy/',
    });
    expect(previewEventUrl(next.s1)).toBe('https://hub.example/api/sessions/s1/preview/proxy/');
  });

  it('bumps refresh on a live preview and keeps one recorded before any live event', () => {
    const live = applyPreviewEvent(
      {},
      { sessionId: 's1', kind: 'preview', previewUrl: 'http://localhost:1' },
    );
    const refreshed = applyPreviewEvent(live, {
      sessionId: 's1',
      kind: 'preview_refresh',
      refreshAt: 9,
    });
    expect(refreshed.s1.refreshAt).toBe(9);
    const early = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_refresh', refreshAt: 4 });
    expect(early.s1).toMatchObject({ kind: 'preview_refresh', refreshAt: 4 });
    expect(
      applyPreviewEvent(early, { sessionId: 's1', kind: 'preview_refresh', refreshAt: 5 }).s1
        .refreshAt,
    ).toBe(5);
    // Recorded on a starting entry too, without touching its lifecycle: the
    // pane may be showing a newer ready snapshot it can apply it to.
    const starting = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' });
    const bumped = applyPreviewEvent(starting, {
      sessionId: 's1',
      kind: 'preview_refresh',
      refreshAt: 6,
    });
    expect(bumped.s1).toMatchObject({ kind: 'preview_starting', refreshAt: 6 });
    expect(previewLifecycleSeq(bumped.s1)).toBe(previewLifecycleSeq(starting.s1));
    expect(previewPaneStatus(resolvePreviewEvent(bumped.s1, null))).toBe('starting');
  });

  it('reloads a hydrated ready snapshot on a refresh over a cached starting event', () => {
    // cached starting -> hydrated ready -> refresh
    const cached = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' });
    const ready = { kind: 'preview', previewUrl: 'http://localhost:1' };
    const hydration = { event: ready, seqAtRequest: previewLifecycleSeq(cached.s1) };
    const bumped = applyPreviewEvent(cached, {
      sessionId: 's1',
      kind: 'preview_refresh',
      refreshAt: 11,
    });
    const shown = resolvePreviewEvent(bumped.s1, hydration);
    expect(previewPaneStatus(shown)).toBe('ready');
    expect(shown.refreshAt).toBe(11);
  });

  it('applies an early refresh to a hydrated ready snapshot', () => {
    const ready = { kind: 'preview', previewUrl: 'http://localhost:1' };
    const hydration = { event: ready, seqAtRequest: 0 };
    const early = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_refresh', refreshAt: 7 });
    expect(previewLifecycleSeq(early.s1)).toBe(0);
    expect(resolvePreviewEvent(early.s1, hydration)).toEqual({
      ...ready,
      refreshAt: 7,
      refreshReason: '',
    });
    expect(resolvePreviewEvent(early.s1, { event: null, seqAtRequest: 0 })).toBeNull();
    expect(resolvePreviewEvent(early.s1, null)).toBeNull();
    expect(resolvePreviewEvent(undefined, hydration)).toBe(ready);
  });

  it('lets a fresh snapshot supersede the event cached when it was requested', () => {
    const cachedStarting = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' }).s1;
    const ready = { kind: 'preview', previewUrl: 'http://localhost:1' };
    const hydration = { event: ready, seqAtRequest: previewLifecycleSeq(cachedStarting) };
    expect(resolvePreviewEvent(cachedStarting, hydration)).toEqual(ready);
    // The server reports nothing running: the stale cached event loses too.
    expect(
      resolvePreviewEvent(cachedStarting, {
        event: null,
        seqAtRequest: previewLifecycleSeq(cachedStarting),
      }),
    ).toBe(null);
  });

  it('keeps the snapshot when only log lines arrive after it', () => {
    // cached starting -> hydrated ready -> live log line
    const cached = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' });
    const ready = { kind: 'preview', previewUrl: 'http://localhost:1' };
    const hydration = { event: ready, seqAtRequest: previewLifecycleSeq(cached.s1) };
    const logged = applyPreviewEvent(cached, {
      sessionId: 's1',
      kind: 'preview_log',
      line: 'GET /',
    });
    expect(previewLifecycleSeq(logged.s1)).toBe(previewLifecycleSeq(cached.s1));
    const shown = resolvePreviewEvent(logged.s1, hydration);
    expect(previewPaneStatus(shown)).toBe('ready');
    expect(previewEventUrl(shown)).toBe('http://localhost:1');
    expect(shown.logTail).toEqual(['GET /']);
  });

  it('keeps the snapshot when a refresh arrives for the cached ready event', () => {
    const cached = applyPreviewEvent(
      {},
      { sessionId: 's1', kind: 'preview', previewUrl: 'http://localhost:1' },
    );
    const snapshot = { kind: 'preview', previewUrl: 'http://localhost:2' };
    const hydration = { event: snapshot, seqAtRequest: previewLifecycleSeq(cached.s1) };
    const bumped = applyPreviewEvent(cached, {
      sessionId: 's1',
      kind: 'preview_refresh',
      refreshAt: 9,
    });
    const shown = resolvePreviewEvent(bumped.s1, hydration);
    expect(previewEventUrl(shown)).toBe('http://localhost:2');
    expect(shown.refreshAt).toBe(9);
  });

  it('lets a lifecycle event received after the request win over the snapshot', () => {
    const ready = { kind: 'preview', previewUrl: 'http://localhost:1' };
    const cached = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' });
    const hydration = { event: ready, seqAtRequest: previewLifecycleSeq(cached.s1) };
    const failed = applyPreviewEvent(cached, { sessionId: 's1', kind: 'preview_failed' }).s1;
    expect(resolvePreviewEvent(failed, hydration)).toBe(failed);
    const stopped = applyPreviewEvent(cached, { sessionId: 's1', kind: 'preview_stopped' }).s1;
    expect(previewPaneStatus(resolvePreviewEvent(stopped, hydration))).toBe('idle');
    expect(resolvePreviewEvent(failed, null)).toBe(failed);
  });

  it('marks the session stopped and appends log lines', () => {
    const starting = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' });
    const logged = applyPreviewEvent(starting, {
      sessionId: 's1',
      kind: 'preview_log',
      line: 'booting',
    });
    expect(logged.s1.logTail).toEqual(['booting']);
    expect(previewPaneStatus(logged.s1)).toBe('starting');
    const stopped = applyPreviewEvent(logged, { sessionId: 's1', kind: 'preview_stopped' });
    expect(stopped).toEqual({
      s1: { kind: 'preview_stopped', sessionId: 's1', seq: expect.any(Number) },
    });
    expect(previewLifecycleSeq(stopped.s1)).toBeGreaterThan(previewLifecycleSeq(logged.s1));
    expect(previewPaneStatus(stopped.s1)).toBe('idle');
    expect(previewEventUrl(stopped.s1)).toBe('');
    // A late log line is recorded but cannot revive the stopped state.
    const lateLog = applyPreviewEvent(stopped, { sessionId: 's1', kind: 'preview_log', line: 'x' });
    expect(previewPaneStatus(lateLog.s1)).toBe('idle');
    expect(previewLifecycleSeq(lateLog.s1)).toBe(previewLifecycleSeq(stopped.s1));
    const lateRefresh = applyPreviewEvent(stopped, {
      sessionId: 's1',
      kind: 'preview_refresh',
      refreshAt: 3,
    });
    expect(
      resolvePreviewEvent(lateRefresh.s1, {
        event: { kind: 'preview', previewUrl: 'http://localhost:1' },
        seqAtRequest: 0,
      }).kind,
    ).toBe('preview_stopped');
  });

  it('records a stop even when no live event preceded it', () => {
    // A pane that hydrated a ready preview over REST has no map entry yet.
    expect(applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_stopped' })).toEqual({
      s1: { kind: 'preview_stopped', sessionId: 's1', seq: expect.any(Number) },
    });
  });

  it('maps failed and unavailable kinds', () => {
    expect(previewPaneStatus({ kind: 'preview_failed', error: 'nope' })).toBe('failed');
    expect(previewPaneStatus({ kind: 'preview_unavailable' })).toBe('unavailable');
    expect(previewPaneStatus(null)).toBe('idle');
    expect(previewEventUrl({ kind: 'preview_starting' })).toBe('');
  });
});
