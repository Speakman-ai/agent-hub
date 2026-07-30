/**
 * Unit tests for `preview-snapshot.ts` — the WS connect-handshake replay.
 *
 * No DB, no runtime — we hand the builder a tiny stub that satisfies
 * `PreviewSnapshotRuntime`. The contract being tested is the row →
 * event projection, not the DB query.
 */

import { describe, it, expect } from 'vitest';
import type { PreviewSnapshotRow } from './preview-snapshot.js';
import { buildPreviewSnapshotEvents, previewSnapshotEventFromRow } from './preview-snapshot.js';

function row(overrides: Partial<PreviewSnapshotRow>): PreviewSnapshotRow {
  return {
    id: 'grp-1',
    session_id: 'sess-1',
    port: 4200,
    url: 'http://localhost:4200',
    status: 'starting',
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

  it('includes a multi-port `ports` array on a ready snapshot', () => {
    const ports = [
      {
        internalPort: 5173,
        label: 'web',
        primary: true,
        url: '/api/sessions/sess-1/preview/proxy',
      },
      {
        internalPort: 8787,
        label: 'api',
        primary: false,
        url: '/api/sessions/sess-1/preview/proxy/p/8787',
      },
    ];
    const event = previewSnapshotEventFromRow(row({ status: 'ready' }), ['boot-ok'], ports);
    expect((event as Record<string, unknown>).ports).toEqual(ports);
  });

  it('omits `ports` when a group exposes a single port (no selector needed)', () => {
    const single = [
      {
        internalPort: 5173,
        label: 'web',
        primary: true,
        url: '/api/sessions/sess-1/preview/proxy',
      },
    ];
    const ready = previewSnapshotEventFromRow(row({ status: 'ready' }), [], single);
    expect((ready as Record<string, unknown>).ports).toBeUndefined();
    // Never surfaced on non-ready snapshots even if ports are passed.
    const starting = previewSnapshotEventFromRow(
      row({ status: 'starting' }),
      [],
      [...single, { internalPort: 8787, label: 'api', primary: false, url: '/x/p/8787' }],
    );
    expect((starting as Record<string, unknown>).ports).toBeUndefined();
  });

  it('returns null for an unknown future status (defense-in-depth)', () => {
    const future = row({
      status: 'pending' as unknown as PreviewSnapshotRow['status'],
    });
    expect(previewSnapshotEventFromRow(future, [])).toBeNull();
  });
});

describe('buildPreviewSnapshotEvents', () => {
  it('walks listActive() and emits one event per row, in listActive order', () => {
    const rows: PreviewSnapshotRow[] = [
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

  it('returns an empty list when no groups are active', () => {
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
        row({ status: 'phantom' as unknown as PreviewSnapshotRow['status'] }),
        row({ id: 'grp-real', status: 'ready' }),
      ],
      getLogTail: () => [],
    });
    expect(events.map((e) => e.previewId)).toEqual(['grp-real']);
  });

  it('keeps each tail with its owning row', () => {
    const devServer = {
      listActive: () => [
        {
          ...row({ id: 'grp-dev', session_id: 'sess-2', status: 'starting' }),
        },
      ],
      getLogTail: (id: string) => [`dev-tail:${id}`],
    };

    const events = buildPreviewSnapshotEvents(devServer);

    expect(events.map((e) => [e.previewId, e.kind])).toEqual([['grp-dev', 'preview_starting']]);
    expect(events[0].logTail).toEqual(['dev-tail:grp-dev']);
  });

  it('threads getClientPorts() into the ready snapshot for a dev-server runtime', () => {
    const ports = [
      {
        internalPort: 5173,
        label: 'web',
        primary: true,
        url: '/api/sessions/sess-2/preview/proxy',
      },
      {
        internalPort: 8787,
        label: 'api',
        primary: false,
        url: '/api/sessions/sess-2/preview/proxy/p/8787',
      },
    ];
    const devServer = {
      listActive: () => [
        {
          id: 'grp-dev',
          session_id: 'sess-2',
          status: 'ready' as const,
          url: '/api/sessions/sess-2/preview/proxy',
          port: 4500,
        },
      ],
      getLogTail: () => [],
      getClientPorts: () => ports,
    };
    const [event] = buildPreviewSnapshotEvents(devServer);
    expect((event as Record<string, unknown>).ports).toEqual(ports);
  });

  it('skips null/undefined runtimes instead of throwing on WS connect', () => {
    const live = {
      listActive: () => [row({ id: 'grp-live', status: 'ready' })],
      getLogTail: () => ['tail'],
    };
    // A null runtime wrapped in an always-truthy array must not defeat
    // the connect handler's `if (runtime)` guard.
    expect(buildPreviewSnapshotEvents([null, live, undefined]).map((e) => e.previewId)).toEqual([
      'grp-live',
    ]);
    expect(buildPreviewSnapshotEvents(null)).toEqual([]);
    expect(buildPreviewSnapshotEvents([null, undefined])).toEqual([]);
  });
});
