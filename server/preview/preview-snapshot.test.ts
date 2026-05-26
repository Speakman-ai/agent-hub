/**
 * Unit tests for `preview-snapshot.ts` — the WS connect-handshake replay.
 *
 * No DB, no runtime — we hand the builder a tiny stub that satisfies
 * `PreviewSnapshotRuntime`. The contract being tested is the row →
 * event projection, not the DB query (that's covered by
 * `PreviewComposeRuntime.listActive` tests).
 */

import { describe, it, expect } from 'vitest';
import type { ComposePreviewRow } from './preview-compose-runtime.js';
import { buildPreviewSnapshotEvents, previewSnapshotEventFromRow } from './preview-snapshot.js';

function row(overrides: Partial<ComposePreviewRow>): ComposePreviewRow {
  return {
    id: 'grp-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    port: 4200,
    url: 'http://localhost:4200',
    compose_project_name: 'agenthub-session-sess-1',
    status: 'starting',
    started_at: '2026-05-26 12:00:00',
    last_active_at: '2026-05-26 12:00:01',
    ...overrides,
  };
}

describe('previewSnapshotEventFromRow', () => {
  it('emits a `preview_starting` snapshot when the row is still booting', () => {
    const event = previewSnapshotEventFromRow(row({ status: 'starting' }), ['line-a', 'line-b']);
    expect(event).toMatchObject({
      type: 'agenthub_preview',
      kind: 'preview_starting',
      sessionId: 'sess-1',
      previewId: 'grp-1',
      target: 'client',
      route: '/',
      agentReason: '',
      previewUrl: 'http://localhost:4200',
      port: 4200,
      screenshotPath: null,
      logTail: ['line-a', 'line-b'],
    });
    // `fullUrl` is only set on the ready snapshot — clients distinguish
    // starting vs ready by `kind`, not by URL presence.
    expect((event as Record<string, unknown>).fullUrl).toBeUndefined();
    // No error field on a starting snapshot.
    expect((event as Record<string, unknown>).error).toBeUndefined();
  });

  it('emits a `preview` snapshot with fullUrl when the row is ready', () => {
    const event = previewSnapshotEventFromRow(row({ status: 'ready' }), ['boot-ok']);
    expect(event).toMatchObject({
      type: 'agenthub_preview',
      kind: 'preview',
      sessionId: 'sess-1',
      previewId: 'grp-1',
      target: 'client',
      route: '/',
      agentReason: '',
      previewUrl: 'http://localhost:4200',
      fullUrl: 'http://localhost:4200',
      port: 4200,
      screenshotPath: null,
      logTail: ['boot-ok'],
    });
  });

  it('emits a `preview_failed` snapshot with a generic error on failed rows', () => {
    const event = previewSnapshotEventFromRow(row({ status: 'failed' }), ['err-1']);
    expect(event).toMatchObject({
      type: 'agenthub_preview',
      kind: 'preview_failed',
      sessionId: 'sess-1',
      previewId: 'grp-1',
      target: 'client',
      route: '/',
      agentReason: '',
      screenshotPath: null,
      logTail: ['err-1'],
      error: 'preview boot failed',
    });
    // We don't have the original previewUrl/port at "post-failure replay"
    // time — `derivePaneState` ignores them on `preview_failed`.
    expect((event as Record<string, unknown>).fullUrl).toBeUndefined();
  });

  it('returns null for an unknown future status (defense-in-depth)', () => {
    const future = row({
      status: 'pending' as unknown as ComposePreviewRow['status'],
    });
    expect(previewSnapshotEventFromRow(future, [])).toBeNull();
  });
});

describe('buildPreviewSnapshotEvents', () => {
  it('walks listActive() and emits one event per row, in listActive order', () => {
    const rows: ComposePreviewRow[] = [
      row({ id: 'grp-a', session_id: 'sess-a', status: 'starting' }),
      row({ id: 'grp-b', session_id: 'sess-b', status: 'ready', url: 'http://localhost:4201' }),
      row({ id: 'grp-c', session_id: 'sess-c', status: 'failed' }),
    ];
    const tails: Record<string, string[]> = {
      'grp-a': ['a-1'],
      'grp-b': ['b-1', 'b-2'],
      'grp-c': ['c-fail'],
    };
    const events = buildPreviewSnapshotEvents({
      listActive: () => rows,
      getLogTail: (id) => tails[id] ?? [],
    });

    expect(events.map((e) => e.previewId)).toEqual(['grp-a', 'grp-b', 'grp-c']);
    expect(events.map((e) => e.kind)).toEqual(['preview_starting', 'preview', 'preview_failed']);
    expect(events[0].logTail).toEqual(['a-1']);
    expect(events[1].logTail).toEqual(['b-1', 'b-2']);
    expect(events[2].logTail).toEqual(['c-fail']);
  });

  it('returns an empty list when no compose groups are active', () => {
    expect(
      buildPreviewSnapshotEvents({
        listActive: () => [],
        getLogTail: () => [],
      }),
    ).toEqual([]);
  });

  it('skips rows whose status maps to no event (forward compat)', () => {
    const events = buildPreviewSnapshotEvents({
      listActive: () => [
        row({ status: 'phantom' as unknown as ComposePreviewRow['status'] }),
        row({ id: 'grp-real', status: 'ready' }),
      ],
      getLogTail: () => [],
    });
    expect(events.map((e) => e.previewId)).toEqual(['grp-real']);
  });
});
