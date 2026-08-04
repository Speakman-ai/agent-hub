import { describe, it, expect, vi, beforeEach } from 'vitest';

const readReplayEventsPage = vi.fn();
const listSessionSegments = vi.fn();
const readSegment = vi.fn();

vi.mock('./replay-store.js', async () => {
  const actual = await vi.importActual<typeof import('./replay-store.js')>('./replay-store.js');
  return {
    ...actual,
    readReplayEventsPage: (...args: unknown[]) => readReplayEventsPage(...args),
  };
});

vi.mock('./segment-store.js', () => ({
  listSessionSegments: (...args: unknown[]) => listSessionSegments(...args),
  readSegment: (...args: unknown[]) => readSegment(...args),
}));

const {
  readAllReplayEvents,
  loadCardReplayContext,
  loadReplayRefContext,
  loadReplayContextForRow,
  MAX_TRANSCRIPT_EVENTS,
} = await import('./replay-context-loader.js');

const T0 = 1_700_000_000_000;

function monolithicRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'replay-1',
    project_id: 'demo',
    created_at: '2026-08-04 12:00:00',
    duration_ms: 5_000,
    event_count: 3,
    size: 100,
    uncompressed_size: 900,
    storage_kind: 'local',
    storage_key: 'replays/replay-1.json.gz',
    storage_bucket: null,
    storage_region: null,
    storage_layout: 'monolithic',
    ...overrides,
  } as any;
}

function sampleEvents() {
  return [
    {
      type: 4,
      timestamp: T0,
      data: { href: 'https://app.example.com/cart', width: 800, height: 600 },
    },
    {
      type: 2,
      timestamp: T0 + 1,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'button',
              attributes: { id: 'checkout' },
              childNodes: [{ type: 3, id: 3, textContent: 'Checkout' }],
            },
          ],
        },
      },
    },
    { type: 3, timestamp: T0 + 2_000, data: { source: 2, type: 2, id: 2 } },
  ];
}

function stmtsWith(overrides: Record<string, unknown> = {}) {
  return {
    getSessionReplay: { get: vi.fn() },
    getSessionReplayByCard: { get: vi.fn() },
    ...overrides,
  } as any;
}

const deps = () => ({ stmts: stmtsWith(), config: {} as any });

beforeEach(() => {
  readReplayEventsPage.mockReset();
  listSessionSegments.mockReset();
  readSegment.mockReset();
});

describe('readAllReplayEvents', () => {
  it('pages through a monolithic capture until the blob is exhausted', async () => {
    const events = Array.from({ length: 12_000 }, (_, i) => ({ type: 3, timestamp: T0 + i }));
    readReplayEventsPage.mockImplementation(
      async (_d: any, _row: any, offset: number, limit: number) => {
        const page = events.slice(offset, offset + limit);
        return {
          events: page,
          total: events.length,
          offset,
          limit,
          hasMore: offset + page.length < events.length,
        };
      },
    );

    const out = await readAllReplayEvents(deps(), monolithicRow());
    expect(out).toHaveLength(12_000);
    expect(readReplayEventsPage.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops at the event cap instead of loading an unbounded capture', async () => {
    readReplayEventsPage.mockImplementation(
      async (_d: any, _row: any, offset: number, limit: number) => ({
        events: Array.from({ length: limit }, (_, i) => ({ type: 3, timestamp: T0 + offset + i })),
        total: 1_000_000,
        offset,
        limit,
        hasMore: true,
      }),
    );
    const out = await readAllReplayEvents(deps(), monolithicRow());
    expect(out).toHaveLength(MAX_TRANSCRIPT_EVENTS);
  });

  it('reads a segmented capture through the session segments door', async () => {
    listSessionSegments.mockReturnValue([{ id: 'seg-1' }]);
    readSegment.mockResolvedValue({ events: sampleEvents(), meta: null });
    const out = await readAllReplayEvents(deps(), monolithicRow({ storage_layout: 'segmented' }));
    expect(out).toHaveLength(3);
    expect(listSessionSegments).toHaveBeenCalledWith(expect.anything(), 'replay-1');
    expect(readReplayEventsPage).not.toHaveBeenCalled();
  });

  // Regression: the segmented path used to call `readSessionEvents`, which
  // fetches EVERY segment object before the caller can trim — so the 20k cap
  // bound the returned array but not the fetching or the allocation, inline on
  // the assign path.
  it('stops fetching segments once the event cap is met', async () => {
    listSessionSegments.mockReturnValue(Array.from({ length: 50 }, (_, i) => ({ id: `seg-${i}` })));
    readSegment.mockImplementation(async (_d: any, seg: { id: string }) => ({
      events: Array.from({ length: 10 }, (_, i) => ({
        type: 3,
        timestamp: T0 + Number(seg.id.split('-')[1]) * 10 + i,
      })),
      meta: null,
    }));

    const out = await readAllReplayEvents(
      deps(),
      monolithicRow({ storage_layout: 'segmented' }),
      25,
    );

    expect(out).toHaveLength(25);
    // 3 segments cover 25 events — the remaining 47 objects are never fetched.
    expect(readSegment).toHaveBeenCalledTimes(3);
  });

  it('returns segmented events in timestamp order across segments', async () => {
    listSessionSegments.mockReturnValue([{ id: 'seg-a' }, { id: 'seg-b' }]);
    readSegment.mockImplementation(async (_d: any, seg: { id: string }) => ({
      events:
        seg.id === 'seg-a'
          ? [
              { type: 3, timestamp: T0 + 30 },
              { type: 3, timestamp: T0 + 10 },
            ]
          : [{ type: 3, timestamp: T0 + 20 }],
      meta: null,
    }));
    const out = await readAllReplayEvents(deps(), monolithicRow({ storage_layout: 'segmented' }));
    expect(out.map((e) => e.timestamp)).toEqual([T0 + 10, T0 + 20, T0 + 30]);
  });

  it('handles a segmented capture with no segments', async () => {
    listSessionSegments.mockReturnValue([]);
    await expect(
      readAllReplayEvents(deps(), monolithicRow({ storage_layout: 'segmented' })),
    ).resolves.toEqual([]);
    expect(readSegment).not.toHaveBeenCalled();
  });

  it('terminates on a page that reports hasMore but returns nothing', async () => {
    readReplayEventsPage.mockResolvedValue({
      events: [],
      total: 10,
      offset: 0,
      limit: 500,
      hasMore: true,
    });
    await expect(readAllReplayEvents(deps(), monolithicRow())).resolves.toEqual([]);
  });
});

describe('loadReplayContextForRow', () => {
  it('builds a transcript and prompt pack for a stored capture', async () => {
    readReplayEventsPage.mockResolvedValue({
      events: sampleEvents(),
      total: 3,
      offset: 0,
      limit: 500,
      hasMore: false,
    });
    const result = await loadReplayContextForRow(deps(), monolithicRow());
    expect(result).not.toBeNull();
    expect(result!.transcript.text).toContain('button#checkout "Checkout"');
    expect(result!.pack.contextBlock).toContain('- Replay id: replay-1');
  });

  it('degrades to null when storage fails rather than throwing', async () => {
    readReplayEventsPage.mockRejectedValue(new Error('S3 unavailable'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadReplayContextForRow(deps(), monolithicRow())).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe('loadCardReplayContext', () => {
  it('resolves the replay attributed to a card', async () => {
    readReplayEventsPage.mockResolvedValue({
      events: sampleEvents(),
      total: 3,
      offset: 0,
      limit: 500,
      hasMore: false,
    });
    const stmts = stmtsWith();
    stmts.getSessionReplayByCard.get.mockReturnValue(monolithicRow());

    const block = await loadCardReplayContext({ stmts, config: {} as any }, 'card-9');
    expect(stmts.getSessionReplayByCard.get).toHaveBeenCalledWith('card-9');
    expect(block).toContain('Session replay facts (trusted)');
    expect(block).toContain('click');
  });

  it('returns null for a card with no replay', async () => {
    const stmts = stmtsWith();
    stmts.getSessionReplayByCard.get.mockReturnValue(undefined);
    await expect(loadCardReplayContext({ stmts, config: {} as any }, 'card-x')).resolves.toBeNull();
    expect(readReplayEventsPage).not.toHaveBeenCalled();
  });

  it('never throws when the lookup itself blows up', async () => {
    const stmts = stmtsWith();
    stmts.getSessionReplayByCard.get.mockImplementation(() => {
      throw new Error('db closed');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadCardReplayContext({ stmts, config: {} as any }, 'card-x')).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe('loadReplayRefContext', () => {
  it('resolves a /uploads/replay-<id>.json ref to its stored capture', async () => {
    readReplayEventsPage.mockResolvedValue({
      events: sampleEvents(),
      total: 3,
      offset: 0,
      limit: 500,
      hasMore: false,
    });
    const stmts = stmtsWith();
    stmts.getSessionReplay.get.mockReturnValue(monolithicRow());

    const block = await loadReplayRefContext(
      { stmts, config: {} as any },
      '/uploads/replay-replay-1.json',
    );
    expect(stmts.getSessionReplay.get).toHaveBeenCalledWith('replay-1');
    expect(block).toContain('Session replay facts (trusted)');
  });

  it('ignores refs that are not stored replays', async () => {
    const stmts = stmtsWith();
    for (const ref of ['https://example.com/replay.json', '/uploads/screenshot.png', null, '']) {
      await expect(loadReplayRefContext({ stmts, config: {} as any }, ref)).resolves.toBeNull();
    }
    expect(stmts.getSessionReplay.get).not.toHaveBeenCalled();
  });

  it('returns null when the row is gone (retention swept it)', async () => {
    const stmts = stmtsWith();
    stmts.getSessionReplay.get.mockReturnValue(undefined);
    await expect(
      loadReplayRefContext({ stmts, config: {} as any }, '/uploads/replay-gone.json'),
    ).resolves.toBeNull();
  });
});
