import { describe, it, expect } from 'vitest';
import { prPreviewViewState, prPreviewAvailable, prPreviewSessionLive } from './prPreview';

describe('prPreviewViewState', () => {
  it('idle when there is no state and nothing pending', () => {
    expect(prPreviewViewState(null)).toEqual({
      status: 'idle',
      url: null,
      reason: null,
      logTail: [],
    });
    expect(prPreviewViewState({ sessionId: 'abc', preview: null })).toMatchObject({
      status: 'idle',
    });
  });

  it('loading while a just-clicked Enable has no snapshot yet (pending)', () => {
    expect(prPreviewViewState({ sessionId: null, preview: null }, { pending: true })).toMatchObject(
      {
        status: 'loading',
      },
    );
  });

  it('loading while the preview snapshot is still starting', () => {
    const state = { sessionId: 's', preview: { kind: 'preview_starting', logTail: ['boot'] } };
    expect(prPreviewViewState(state)).toEqual({
      status: 'loading',
      url: null,
      reason: null,
      logTail: ['boot'],
    });
  });

  it('ready with a clickable url (prefers fullUrl over previewUrl)', () => {
    const state = {
      sessionId: 's',
      preview: {
        kind: 'preview',
        fullUrl: 'https://pr-preview.example.com/',
        previewUrl: '/api/sessions/s/preview/proxy',
        logTail: [],
      },
    };
    expect(prPreviewViewState(state)).toMatchObject({
      status: 'ready',
      url: 'https://pr-preview.example.com/',
    });
  });

  it('ready falls back to previewUrl when fullUrl is absent', () => {
    const state = {
      sessionId: 's',
      preview: { kind: 'preview', previewUrl: '/proxy', logTail: [] },
    };
    expect(prPreviewViewState(state)).toMatchObject({ status: 'ready', url: '/proxy' });
  });

  it('failed surfaces the error reason', () => {
    const state = {
      sessionId: 's',
      preview: { kind: 'preview_failed', error: 'npm run dev exited 1', logTail: ['x'] },
    };
    expect(prPreviewViewState(state)).toEqual({
      status: 'failed',
      url: null,
      reason: 'npm run dev exited 1',
      logTail: ['x'],
    });
  });

  it('failed uses a generic reason when the snapshot omits one', () => {
    const state = { sessionId: 's', preview: { kind: 'preview_failed' } };
    expect(prPreviewViewState(state)).toMatchObject({
      status: 'failed',
      reason: 'Preview failed to start.',
    });
  });

  it('an unknown snapshot kind degrades to loading, never a false ready', () => {
    const state = { sessionId: 's', preview: { kind: 'something_new' } };
    expect(prPreviewViewState(state)).toMatchObject({ status: 'loading' });
  });
});

describe('prPreviewAvailable', () => {
  const open = { source: 'agenthub', preview_available: true, pr: { state: 'open' } };
  it('true only for native, OPEN PRs with a configured dev server', () => {
    expect(prPreviewAvailable(open)).toBe(true);
  });
  it('false for native PRs without a dev server, GitHub PRs, or missing detail', () => {
    expect(
      prPreviewAvailable({ source: 'agenthub', preview_available: false, pr: { state: 'open' } }),
    ).toBe(false);
    expect(
      prPreviewAvailable({ source: 'github', preview_available: true, pr: { state: 'open' } }),
    ).toBe(false);
    expect(prPreviewAvailable(null)).toBe(false);
    expect(prPreviewAvailable(undefined)).toBe(false);
  });
  it('false for merged or closed PRs (preview is torn down on merge)', () => {
    expect(
      prPreviewAvailable({ source: 'agenthub', preview_available: true, pr: { state: 'closed' } }),
    ).toBe(false);
    expect(
      prPreviewAvailable({
        source: 'agenthub',
        preview_available: true,
        pr: { state: 'open', merged_at: '2026-08-27T00:00:00Z' },
      }),
    ).toBe(false);
    // No pr state at all → not open → false.
    expect(prPreviewAvailable({ source: 'agenthub', preview_available: true })).toBe(false);
  });
});

describe('prPreviewSessionLive', () => {
  it('false only when the server explicitly reports no live session', () => {
    expect(prPreviewSessionLive({ preview_session_available: false })).toBe(false);
  });
  it('true when a live session backs the PR', () => {
    expect(prPreviewSessionLive({ preview_session_available: true })).toBe(true);
  });
  it('defaults to true when the field is absent (older server / non-native)', () => {
    expect(prPreviewSessionLive({})).toBe(true);
    expect(prPreviewSessionLive(null)).toBe(true);
    expect(prPreviewSessionLive(undefined)).toBe(true);
  });
});
