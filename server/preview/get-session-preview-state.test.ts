/**
 * Unit tests for `get-session-preview-state.ts` — the resolver behind
 * `GET /api/sessions/:id/preview/state`.
 *
 * No DB, no runtime — we hand the resolver a tiny stub that satisfies
 * `SessionPreviewStateRuntime`. The contract under test is: pick the
 * active row for the session, project it through the shared snapshot
 * builder, and degrade gracefully when there's no runtime / no row /
 * a throwing log-tail read.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PreviewSnapshotRow } from './preview-snapshot.js';
import {
  getSessionPreviewStateEvent,
  type SessionPreviewStateRuntime,
} from './get-session-preview-state.js';

function row(overrides: Partial<PreviewSnapshotRow> = {}): PreviewSnapshotRow {
  return {
    id: 'grp-1',
    session_id: 'sess-1',
    port: 4101,
    url: '/api/sessions/sess-1/preview/proxy',
    status: 'ready',
    ...overrides,
  };
}

function stubRuntime(
  activeRow: PreviewSnapshotRow | null,
  logTail: string[] | (() => string[]) = [],
): SessionPreviewStateRuntime {
  return {
    getActiveBySessionId: vi.fn(() => activeRow),
    getLogTail: vi.fn(() => (typeof logTail === 'function' ? logTail() : logTail)),
  };
}

describe('getSessionPreviewStateEvent', () => {
  it('returns null when the runtime is null/undefined (preview not configured)', () => {
    expect(getSessionPreviewStateEvent(null, 'sess-1')).toBeNull();
    expect(getSessionPreviewStateEvent(undefined, 'sess-1')).toBeNull();
  });

  it('returns null when no active group exists for the session', () => {
    const runtime = stubRuntime(null);
    expect(getSessionPreviewStateEvent(runtime, 'sess-1')).toBeNull();
    expect(runtime.getActiveBySessionId).toHaveBeenCalledWith('sess-1');
  });

  it('projects a ready row into a `preview` event with fullUrl + port + logTail', () => {
    const runtime = stubRuntime(row({ status: 'ready' }), ['server-1 | Agent Hub server running']);
    const event = getSessionPreviewStateEvent(runtime, 'sess-1');
    expect(event).toMatchObject({
      type: 'agenthub_preview',
      kind: 'preview',
      sessionId: 'sess-1',
      previewId: 'grp-1',
      target: 'client',
      route: '/',
      previewUrl: '/api/sessions/sess-1/preview/proxy',
      fullUrl: '/api/sessions/sess-1/preview/proxy',
      port: 4101,
      logTail: ['server-1 | Agent Hub server running'],
    });
  });

  it('projects a still-booting row into a `preview_starting` event', () => {
    const runtime = stubRuntime(row({ status: 'starting' }));
    const event = getSessionPreviewStateEvent(runtime, 'sess-1');
    expect(event?.kind).toBe('preview_starting');
    // `fullUrl` is only emitted once ready — a booting snapshot must not
    // tell the client to swap to the iframe early.
    expect(event).not.toHaveProperty('fullUrl');
  });

  it('projects a failed row into a `preview_failed` event', () => {
    const runtime = stubRuntime(row({ status: 'failed' }));
    const event = getSessionPreviewStateEvent(runtime, 'sess-1');
    expect(event?.kind).toBe('preview_failed');
    expect(event?.error).toBeTruthy();
  });

  it('still returns the event with an empty tail when getLogTail throws', () => {
    const runtime = stubRuntime(row({ status: 'ready' }), () => {
      throw new Error('log tail failed');
    });
    const event = getSessionPreviewStateEvent(runtime, 'sess-1');
    expect(event?.kind).toBe('preview');
    expect(event?.logTail).toEqual([]);
  });

  it('reads the log tail keyed by the group id, not the session id', () => {
    const runtime = stubRuntime(row({ id: 'grp-xyz', status: 'ready' }));
    getSessionPreviewStateEvent(runtime, 'sess-1');
    expect(runtime.getLogTail).toHaveBeenCalledWith('grp-xyz');
  });
});
