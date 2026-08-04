import { describe, it, expect } from 'vitest';
import {
  buildReplayTranscript,
  ReplayNodeMirror,
  formatOffset,
  summarizeInputValue,
  EventType,
  IncrementalSource,
  REPLAY_CONSOLE_TAG,
  REPLAY_NETWORK_TAG,
  type RrwebEventLike,
} from './replay-transcript.js';

const T0 = 1_700_000_000_000;

/** A minimal but realistic serialized document: html > body > button("Place order"). */
function snapshotNode() {
  return {
    type: 0, // Document
    id: 1,
    childNodes: [
      {
        type: 2,
        id: 2,
        tagName: 'html',
        attributes: {},
        childNodes: [
          {
            type: 2,
            id: 3,
            tagName: 'body',
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 4,
                tagName: 'button',
                attributes: { id: 'submit', class: 'btn primary lg' },
                childNodes: [{ type: 3, id: 5, textContent: 'Place order' }],
              },
              {
                type: 2,
                id: 6,
                tagName: 'input',
                attributes: { name: 'coupon', type: 'text' },
                childNodes: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

function meta(offset = 0, href = 'https://app.example.com/checkout'): RrwebEventLike {
  return { type: EventType.Meta, timestamp: T0 + offset, data: { href, width: 1440, height: 900 } };
}

function fullSnapshot(offset = 1): RrwebEventLike {
  return {
    type: EventType.FullSnapshot,
    timestamp: T0 + offset,
    data: { node: snapshotNode(), initialOffset: { left: 0, top: 0 } },
  };
}

function click(offset: number, id = 4): RrwebEventLike {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: T0 + offset,
    data: { source: IncrementalSource.MouseInteraction, type: 2, id, x: 10, y: 20 },
  };
}

function consoleEvent(offset: number, payload: Record<string, unknown>): RrwebEventLike {
  return {
    type: EventType.Custom,
    timestamp: T0 + offset,
    data: { tag: REPLAY_CONSOLE_TAG, payload },
  };
}

function networkEvent(offset: number, payload: Record<string, unknown>): RrwebEventLike {
  return {
    type: EventType.Custom,
    timestamp: T0 + offset,
    data: { tag: REPLAY_NETWORK_TAG, payload },
  };
}

describe('formatOffset', () => {
  it('renders +MM:SS.s relative offsets', () => {
    expect(formatOffset(0)).toBe('+00:00.0');
    expect(formatOffset(3_240)).toBe('+00:03.2');
    expect(formatOffset(125_900)).toBe('+02:05.9');
  });
});

describe('ReplayNodeMirror', () => {
  it('describes an element by selector and visible text', () => {
    const mirror = new ReplayNodeMirror();
    mirror.ingestSnapshot(snapshotNode());
    expect(mirror.describe(4)).toBe('button#submit.btn.primary "Place order"');
  });

  it('falls back to an identifying attribute when there is no text', () => {
    const mirror = new ReplayNodeMirror();
    mirror.ingestSnapshot(snapshotNode());
    expect(mirror.describe(6)).toBe('input [name=coupon]');
  });

  it('resolves a text node to its parent element', () => {
    const mirror = new ReplayNodeMirror();
    mirror.ingestSnapshot(snapshotNode());
    expect(mirror.describe(5)).toBe('button#submit.btn.primary "Place order"');
  });

  it('names unknown ids instead of dropping the event', () => {
    expect(new ReplayNodeMirror().describe(99)).toBe('node #99');
  });

  it('tracks nodes added and removed by mutations', () => {
    const mirror = new ReplayNodeMirror();
    mirror.ingestSnapshot(snapshotNode());
    mirror.applyMutation({
      adds: [
        {
          parentId: 3,
          nextId: null,
          node: {
            type: 2,
            id: 10,
            tagName: 'div',
            attributes: { class: 'toast error' },
            childNodes: [{ type: 3, id: 11, textContent: 'Payment failed' }],
          },
        },
      ],
    });
    expect(mirror.describe(10)).toBe('div.toast.error "Payment failed"');

    mirror.applyMutation({ removes: [{ parentId: 3, id: 10 }] });
    expect(mirror.has(10)).toBe(false);
    // The subtree goes with it — no orphaned children left behind.
    expect(mirror.has(11)).toBe(false);
  });

  it('applies text and attribute mutations', () => {
    const mirror = new ReplayNodeMirror();
    mirror.ingestSnapshot(snapshotNode());
    mirror.applyMutation({
      texts: [{ id: 5, value: 'Retry payment' }],
      attributes: [{ id: 4, attributes: { class: 'btn danger' } }],
    });
    expect(mirror.describe(4)).toBe('button#submit.btn.danger "Retry payment"');
  });
});

describe('buildReplayTranscript', () => {
  it('renders the failure story a fixer actually needs', () => {
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      click(3_200),
      networkEvent(3_400, {
        kind: 'fetch',
        method: 'POST',
        url: 'https://api.example.com/orders',
        status: 500,
        durationMs: 241,
      }),
      consoleEvent(3_450, {
        level: 'error',
        message: "TypeError: Cannot read properties of undefined (reading 'id')",
      }),
    ]);

    expect(transcript.text).toContain('page');
    expect(transcript.text).toContain('https://app.example.com/checkout (1440×900)');
    expect(transcript.text).toContain('click');
    expect(transcript.text).toContain('button#submit.btn.primary "Place order"');
    expect(transcript.text).toContain('POST https://api.example.com/orders → 500 (241ms)');
    expect(transcript.text).toContain('TypeError: Cannot read properties of undefined');
    expect(transcript.lines[2]).toMatch(/^\+00:03\.2/);

    expect(transcript.stats).toMatchObject({
      interactionCount: 1,
      errorCount: 1,
      networkFailureCount: 1,
      hasTelemetry: true,
      truncated: false,
    });
    expect(transcript.stats.pageUrls).toEqual(['https://app.example.com/checkout']);
  });

  it('collapses repeated clicks into one rage-click line', () => {
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      click(1_000),
      click(1_300),
      click(1_600),
      click(1_900),
    ]);
    const clickLines = transcript.lines.filter((l) => l.includes('click'));
    expect(clickLines).toHaveLength(1);
    expect(clickLines[0]).toContain('click ×4');
    expect(clickLines[0]).toContain('(rapid repeat)');
    // The burst is stamped at its FIRST click, not its last.
    expect(clickLines[0]).toMatch(/^\+00:01\.0/);
    expect(transcript.stats.rageClickCount).toBe(1);
    expect(transcript.stats.interactionCount).toBe(4);
  });

  it('does not merge clicks separated by more than the rage window', () => {
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      click(1_000),
      click(9_000),
    ]);
    expect(transcript.lines.filter((l) => l.includes('click'))).toHaveLength(2);
    expect(transcript.stats.rageClickCount).toBe(0);
  });

  it('coalesces mutation bursts into a single dom line', () => {
    const mutations: RrwebEventLike[] = [];
    for (let i = 0; i < 30; i++) {
      mutations.push({
        type: EventType.IncrementalSnapshot,
        timestamp: T0 + 2_000 + i,
        data: {
          source: IncrementalSource.Mutation,
          adds: [
            {
              parentId: 3,
              node: { type: 2, id: 100 + i, tagName: 'li', attributes: {}, childNodes: [] },
            },
          ],
          removes: [],
          texts: [],
          attributes: [],
        },
      });
    }
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      ...mutations,
      click(5_000),
    ]);
    const domLines = transcript.lines.filter((l) => /^\+\d\d:\d\d\.\d\s+dom\b/.test(l));
    expect(domLines).toHaveLength(1);
    expect(domLines[0]).toContain('+30 nodes');
  });

  it('drops mouse-move noise but counts it', () => {
    const moves: RrwebEventLike[] = Array.from({ length: 50 }, (_, i) => ({
      type: EventType.IncrementalSnapshot,
      timestamp: T0 + 100 + i,
      data: {
        source: IncrementalSource.MouseMove,
        positions: [{ x: i, y: i, id: 4, timeOffset: 0 }],
      },
    }));
    const transcript = buildReplayTranscript([meta(0), fullSnapshot(1), ...moves]);
    expect(transcript.lines.some((l) => l.includes('mousemove'))).toBe(false);
    expect(transcript.stats.droppedEventCount).toBe(50);
  });

  it('summarizes typed input without echoing the value verbatim', () => {
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      {
        type: EventType.IncrementalSnapshot,
        timestamp: T0 + 2_000,
        data: { source: IncrementalSource.Input, id: 6, text: '***' },
      },
    ]);
    expect(transcript.text).toContain('input');
    expect(transcript.text).toContain('(masked, 3 chars)');
  });

  it('redacts secrets that reach it in the clear', () => {
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      consoleEvent(2_000, {
        level: 'error',
        message: 'refresh failed with authorization: Bearer abcdef1234567890abcdef',
      }),
    ]);
    expect(transcript.text).not.toContain('abcdef1234567890abcdef');
    expect(transcript.redactions).toBeGreaterThan(0);
  });

  it('flags a capture with no console/network telemetry', () => {
    const transcript = buildReplayTranscript([meta(0), fullSnapshot(1), click(1_000)]);
    expect(transcript.stats.hasTelemetry).toBe(false);
    expect(transcript.stats.errorCount).toBe(0);
  });

  it('counts a transport failure (status 0) as a network failure', () => {
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      networkEvent(1_000, {
        kind: 'fetch',
        method: 'GET',
        url: 'https://api.example.com/me',
        status: 0,
        durationMs: 30,
        error: 'TypeError: Failed to fetch',
      }),
    ]);
    expect(transcript.stats.networkFailureCount).toBe(1);
    expect(transcript.text).toContain('→ failed (TypeError: Failed to fetch)');
  });

  it('elides the middle when over the line budget, keeping head and tail', () => {
    const clicks = Array.from({ length: 300 }, (_, i) => click(2_000 + i * 5_000));
    const transcript = buildReplayTranscript([meta(0), fullSnapshot(1), ...clicks], {
      maxLines: 20,
    });
    expect(transcript.stats.truncated).toBe(true);
    expect(transcript.lines.length).toBeLessThanOrEqual(21);
    expect(transcript.lines[0]).toContain('page');
    expect(transcript.lines.some((l) => l.includes('lines elided'))).toBe(true);
    // The tail (where the failure lives) survives.
    expect(transcript.lines[transcript.lines.length - 1]).toContain('click');
  });

  it('respects the byte budget', () => {
    const clicks = Array.from({ length: 200 }, (_, i) => click(2_000 + i * 5_000));
    const transcript = buildReplayTranscript([meta(0), fullSnapshot(1), ...clicks], {
      maxBytes: 1024,
    });
    expect(Buffer.byteLength(transcript.text, 'utf8')).toBeLessThanOrEqual(1024);
    expect(transcript.stats.truncated).toBe(true);
  });

  it('is deterministic', () => {
    const events = [
      meta(0),
      fullSnapshot(1),
      click(1_000),
      consoleEvent(1_100, { level: 'warn', message: 'slow' }),
    ];
    expect(buildReplayTranscript(events).text).toBe(buildReplayTranscript(events).text);
  });

  it('survives an empty or malformed capture', () => {
    expect(buildReplayTranscript([]).text).toBe('');
    expect(buildReplayTranscript([]).stats.eventCount).toBe(0);
    const junk = buildReplayTranscript([
      null as any,
      { type: 3 } as any,
      { type: EventType.FullSnapshot, timestamp: T0, data: {} },
    ]);
    expect(junk.stats.eventCount).toBe(3);
    expect(() => junk.text).not.toThrow();
  });

  it('records viewport resizes and scrolls without flooding', () => {
    const scrolls = Array.from({ length: 10 }, (_, i) => ({
      type: EventType.IncrementalSnapshot,
      timestamp: T0 + 1_000 + i * 50,
      data: { source: IncrementalSource.Scroll, id: 3, x: 0, y: i * 100 },
    }));
    const transcript = buildReplayTranscript([
      meta(0),
      fullSnapshot(1),
      ...scrolls,
      {
        type: EventType.IncrementalSnapshot,
        timestamp: T0 + 3_000,
        data: { source: IncrementalSource.ViewportResize, width: 800, height: 600 },
      },
    ]);
    expect(transcript.lines.filter((l) => l.includes('scroll'))).toHaveLength(1);
    expect(transcript.text).toContain('viewport');
    expect(transcript.text).toContain('800×600');
  });
});

describe('summarizeInputValue', () => {
  const identity = (v: string) => v;
  it('describes masked placeholders by length', () => {
    expect(summarizeInputValue('*****', identity)).toBe('(masked, 5 chars)');
  });
  it('reports cleared fields', () => {
    expect(summarizeInputValue('', identity)).toBe('(cleared)');
  });
  it('keeps short opaque values', () => {
    expect(summarizeInputValue('SAVE10', identity)).toBe('"SAVE10"');
  });
  it('describes long values by shape rather than echoing them', () => {
    const out = summarizeInputValue('x'.repeat(120), identity);
    expect(out).toContain('(120 chars)');
    expect(out.length).toBeLessThan(60);
  });
  it('prefers the redacted rendering when redaction fires', () => {
    expect(summarizeInputValue('secret', () => '[redacted]')).toBe('"[redacted]"');
  });
});
