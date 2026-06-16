import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gunzipSync } from 'zlib';
import {
  clampSampleRate,
  shouldSample,
  resolveSampleRate,
  isSessionReplayEnabled,
  setSessionReplayEnabled,
  REPLAY_SAMPLE_RATE_KEY,
  pruneBuffer,
  selectFlushWindow,
  countSnapshotElements,
  countElementsInNode,
  PREMOUNT_SHELL_MAX_ELEMENTS,
  hasFullSnapshot,
  submitReplay,
  SessionReplayRecorder,
  getRecorder,
  flushSessionReplayRef,
  setReplayBreadcrumbSink,
  isMaskAllEnabled,
  setReplayMaskingMode,
  resolveMaskingMode,
  buildRecordPrivacyOptions,
  MASKING_MODES,
  MASKING_MODE_KEY,
  _resetSessionReplayForTest,
  DEFAULT_RECORD_PRIVACY_OPTIONS,
  RRWEB_FULL_SNAPSHOT,
  RRWEB_META,
  REPLAY_INGEST_ENDPOINT,
  gzipString,
} from './sessionReplay.js';

// startRecorder() lazy-imports rrweb; stub it so the masking-mode restart path
// is deterministic and never spins up a real recorder in jsdom. record() returns
// its stop fn, matching rrweb's contract.
vi.mock('rrweb', () => ({ record: () => () => {} }));

const ev = (type, timestamp, data = {}) => ({ type, timestamp, data });
const meta = (ts) => ev(RRWEB_META, ts);
const snap = (ts) => ev(RRWEB_FULL_SNAPSHOT, ts);
const incr = (ts) => ev(3, ts);

// A serialized rrweb DOM tree (document → html → body → `elements - 2` divs)
// carrying exactly `elements` element nodes (serialized NodeType.Element === 2).
const elemTree = (elements) => {
  const kids = [];
  for (let i = 0; i < Math.max(0, elements - 2); i++) {
    kids.push({ type: 2, tagName: 'div', attributes: {}, childNodes: [] });
  }
  return {
    type: 0,
    childNodes: [
      {
        type: 2,
        tagName: 'html',
        attributes: {},
        childNodes: [{ type: 2, tagName: 'body', attributes: {}, childNodes: kids }],
      },
    ],
  };
};
// A full-snapshot event whose captured DOM holds `elements` element nodes.
const snapEl = (ts, elements) => ev(RRWEB_FULL_SNAPSHOT, ts, { node: elemTree(elements) });
// A mutation incremental (IncrementalSource.Mutation === 0) that adds `n` nodes.
const mut = (ts, n) => ev(3, ts, { source: 0, adds: Array.from({ length: n }, () => ({})) });
// A mutation incremental that adds a SINGLE node whose serialized subtree holds
// `elements` element nodes — the shape rrweb produces when an SPA mounts a whole
// container at once (one `adds` entry, large `childNodes`).
const mutSubtree = (ts, elements) =>
  ev(3, ts, { source: 0, adds: [{ parentId: 1, nextId: null, node: elemTree(elements) }] });

describe('clampSampleRate', () => {
  it('clamps to [0,1] and treats junk as 0', () => {
    expect(clampSampleRate(-1)).toBe(0);
    expect(clampSampleRate(0)).toBe(0);
    expect(clampSampleRate(0.25)).toBe(0.25);
    expect(clampSampleRate(2)).toBe(1);
    expect(clampSampleRate('nope')).toBe(0);
    expect(clampSampleRate(undefined)).toBe(0);
  });
});

describe('shouldSample', () => {
  it('is off at rate 0 and always on at rate 1', () => {
    expect(shouldSample(0, () => 0)).toBe(false);
    expect(shouldSample(1, () => 0.999)).toBe(true);
  });
  it('compares the rng draw against the rate', () => {
    expect(shouldSample(0.5, () => 0.4)).toBe(true);
    expect(shouldSample(0.5, () => 0.6)).toBe(false);
  });
});

describe('resolveSampleRate', () => {
  afterEach(() => localStorage.removeItem('agent-hub-replay-sample-rate'));

  it('defaults to 1 (on) with no override or env', () => {
    // On by default — replay is the visual context behind bug reports.
    expect(resolveSampleRate()).toBe(1);
  });
  it('honours a localStorage override', () => {
    localStorage.setItem('agent-hub-replay-sample-rate', '0.3');
    expect(resolveSampleRate()).toBe(0.3);
  });
  it('honours an explicit off override (0) over the on-by-default', () => {
    localStorage.setItem('agent-hub-replay-sample-rate', '0');
    expect(resolveSampleRate()).toBe(0);
  });
  it('clamps a localStorage override', () => {
    localStorage.setItem('agent-hub-replay-sample-rate', '5');
    expect(resolveSampleRate()).toBe(1);
  });
});

describe('isSessionReplayEnabled / setSessionReplayEnabled', () => {
  beforeEach(() => {
    _resetSessionReplayForTest();
    localStorage.removeItem('agent-hub-replay-sample-rate');
  });
  afterEach(() => {
    _resetSessionReplayForTest();
    localStorage.removeItem('agent-hub-replay-sample-rate');
  });

  it('is enabled by default (no stored choice)', () => {
    expect(isSessionReplayEnabled()).toBe(true);
  });

  it('persists an off choice as "0" and reports disabled', async () => {
    const state = await setSessionReplayEnabled(false);
    expect(state).toBe(false);
    expect(localStorage.getItem(REPLAY_SAMPLE_RATE_KEY)).toBe('0');
    expect(isSessionReplayEnabled()).toBe(false);
  });

  it('persists an on choice as "1" and reports enabled', async () => {
    localStorage.setItem(REPLAY_SAMPLE_RATE_KEY, '0');
    const state = await setSessionReplayEnabled(true);
    expect(state).toBe(true);
    expect(localStorage.getItem(REPLAY_SAMPLE_RATE_KEY)).toBe('1');
    expect(isSessionReplayEnabled()).toBe(true);
  });

  it('stops the active recorder when turned off', async () => {
    const rec = getRecorder();
    rec.active = true;
    let stopped = false;
    rec._stopFn = () => {
      stopped = true;
    };
    await setSessionReplayEnabled(false);
    expect(stopped).toBe(true);
    expect(rec.active).toBe(false);
  });
});

describe('masking mode', () => {
  beforeEach(() => {
    _resetSessionReplayForTest();
    localStorage.removeItem(MASKING_MODE_KEY);
  });
  afterEach(() => {
    _resetSessionReplayForTest();
    localStorage.removeItem(MASKING_MODE_KEY);
  });

  it('buildRecordPrivacyOptions(mask-all) masks all inputs and all text', () => {
    const opts = buildRecordPrivacyOptions(MASKING_MODES.ALL);
    expect(opts.maskAllInputs).toBe(true);
    expect(opts.maskTextSelector).toBe('*');
    expect(opts.maskInputOptions).toEqual({ password: true });
    // Class-based opt-outs survive in every mode.
    expect(opts.unmaskTextClass).toBe('ah-replay-unmask');
  });

  it('buildRecordPrivacyOptions(passwords-only) masks only passwords, no text mask', () => {
    const opts = buildRecordPrivacyOptions(MASKING_MODES.PASSWORDS);
    expect(opts.maskAllInputs).toBe(false);
    expect(opts.maskTextSelector).toBeUndefined();
    expect(opts.maskInputOptions).toEqual({ password: true });
    expect(opts.blockClass).toBe('ah-replay-block');
  });

  it('an unknown mode falls back to the strict mask-all options', () => {
    const opts = buildRecordPrivacyOptions('nonsense');
    expect(opts.maskAllInputs).toBe(true);
    expect(opts.maskTextSelector).toBe('*');
  });

  it('DEFAULT_RECORD_PRIVACY_OPTIONS is the strict mask-all set', () => {
    expect(DEFAULT_RECORD_PRIVACY_OPTIONS).toEqual(buildRecordPrivacyOptions(MASKING_MODES.ALL));
  });

  it('resolveMaskingMode defaults to mask-all and treats junk as mask-all', () => {
    expect(resolveMaskingMode()).toBe(MASKING_MODES.ALL);
    localStorage.setItem(MASKING_MODE_KEY, 'garbage');
    expect(resolveMaskingMode()).toBe(MASKING_MODES.ALL);
  });

  it('resolveMaskingMode honours a persisted passwords-only choice', () => {
    localStorage.setItem(MASKING_MODE_KEY, MASKING_MODES.PASSWORDS);
    expect(resolveMaskingMode()).toBe(MASKING_MODES.PASSWORDS);
    expect(isMaskAllEnabled()).toBe(false);
  });

  it('setReplayMaskingMode persists the mode and reports via isMaskAllEnabled', async () => {
    const m1 = await setReplayMaskingMode(false);
    expect(m1).toBe(MASKING_MODES.PASSWORDS);
    expect(localStorage.getItem(MASKING_MODE_KEY)).toBe(MASKING_MODES.PASSWORDS);
    expect(isMaskAllEnabled()).toBe(false);

    const m2 = await setReplayMaskingMode(true);
    expect(m2).toBe(MASKING_MODES.ALL);
    expect(localStorage.getItem(MASKING_MODE_KEY)).toBe(MASKING_MODES.ALL);
    expect(isMaskAllEnabled()).toBe(true);
  });

  it('restarts an active recorder so the new mode takes effect', async () => {
    const rec = getRecorder();
    rec.active = true;
    let stopped = 0;
    rec._stopFn = () => {
      stopped += 1;
    };
    // startRecorder imports rrweb; that import is unavailable in the test env, so
    // start() is a no-op return — what we assert is that the live recorder was
    // stopped to force a re-apply of privacy options.
    await setReplayMaskingMode(false);
    expect(stopped).toBe(1);
  });
});

describe('REPLAY_INGEST_ENDPOINT', () => {
  it('derives from the bug-report endpoint origin', () => {
    expect(REPLAY_INGEST_ENDPOINT).toMatch(/\/api\/replays$/);
    expect(REPLAY_INGEST_ENDPOINT).not.toMatch(/bug-reports/);
  });
  it('points at the production hub (not the dev hub)', () => {
    expect(REPLAY_INGEST_ENDPOINT).toBe('https://agenthub.surveytracker.io/api/replays');
  });
});

describe('pruneBuffer', () => {
  it('returns the input untouched when empty', () => {
    const e = [];
    expect(pruneBuffer(e, 1000, 500)).toBe(e);
  });

  it('keeps everything when all events are within the window', () => {
    const events = [meta(900), snap(901), incr(950), incr(990)];
    const out = pruneBuffer(events, 1000, 200);
    expect(out).toEqual(events);
  });

  it('drops events older than the window but keeps a leading snapshot+meta', () => {
    // window = 100ms, now = 1000 -> cutoff 900. Old snapshot at 850 is the
    // most-recent snapshot at/before cutoff and must survive as the anchor.
    const events = [meta(800), snap(801), incr(810), meta(849), snap(850), incr(905), incr(980)];
    const out = pruneBuffer(events, 1000, 100);
    // Anchor is the 850 snapshot, with its preceding meta(849).
    expect(out[0]).toEqual(meta(849));
    expect(out[1]).toEqual(snap(850));
    expect(out).toHaveLength(4);
    expect(out).not.toContainEqual(snap(801));
  });

  it('never drops the only snapshot even if it predates the window', () => {
    const events = [meta(100), snap(101), incr(990)];
    const out = pruneBuffer(events, 1000, 100);
    expect(out).toContainEqual(snap(101));
  });

  it('enforces the maxEvents memory cap, re-anchoring to a snapshot', () => {
    const events = [
      incr(1), // stale partial head that must be trimmed
      incr(2),
      meta(3),
      snap(4),
      incr(5),
      incr(6),
    ];
    // windowMs huge so the time-prune keeps all; maxEvents forces a trim.
    const out = pruneBuffer(events, 1000, 10_000, 4);
    expect(out[0]).toEqual(meta(3));
    expect(out[1]).toEqual(snap(4));
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it('prepends a snapshot anchor when the maxEvents tail dropped every snapshot', () => {
    // The only snapshot is early; the recent tail is all incrementals. The cap
    // must still yield a replayable buffer (snapshot + most-recent events).
    const events = [meta(1), snap(2), incr(3), incr(4), incr(5), incr(6)];
    const out = pruneBuffer(events, 1000, 10_000, 3);
    expect(hasFullSnapshot(out)).toBe(true);
    expect(out[0]).toEqual(meta(1));
    expect(out[1]).toEqual(snap(2));
    // Keeps the most-recent event so the tail isn't lost entirely.
    expect(out).toContainEqual(incr(6));
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('returns a snapshot-less tail (which flush declines) when no snapshot exists', () => {
    const events = [incr(1), incr(2), incr(3), incr(4)];
    const out = pruneBuffer(events, 1000, 10_000, 2);
    expect(hasFullSnapshot(out)).toBe(false);
    expect(out).toHaveLength(2);
  });
});

describe('selectFlushWindow', () => {
  it('keeps a full window of recent context, anchored on the in-window snapshot', () => {
    // Snapshots at 200 and 980; window [now-100, now] = [900, 1000].
    const events = [meta(190), snap(200), incr(500), meta(970), snap(980), incr(990)];
    const out = selectFlushWindow(events, 1000, 100);
    // Opens on the oldest snapshot inside the window (980) and its Meta (970).
    expect(out[0]).toEqual(meta(970));
    expect(out[1]).toEqual(snap(980));
    expect(out).toContainEqual(incr(990));
    expect(out).not.toContainEqual(snap(200));
  });

  it('drops a stale pre-mount snapshot and the idle dead-gap before a recent checkout', () => {
    // The real bug: an empty snapshot at boot, a long idle, then a fresh
    // checkout. The cutoff sits in the gap, so the boot snapshot is excluded
    // and the window opens on the recent (populated) checkout.
    const events = [
      meta(0),
      snap(5), // pre-mount, empty #root
      incr(2522), // app mounts
      incr(40000),
      // ── 180s idle, no checkout ──
      meta(224350),
      snap(224355), // checkout when activity resumes (populated)
      incr(230000),
      incr(244186),
    ];
    const out = selectFlushWindow(events, 244186, 45000);
    expect(out[0]).toEqual(meta(224350));
    expect(out[1]).toEqual(snap(224355));
    expect(hasFullSnapshot(out)).toBe(true);
    // The stale boot snapshot and the 180s dead gap are gone.
    expect(out).not.toContainEqual(snap(5));
    expect(out).not.toContainEqual(incr(2522));
    expect(out).not.toContainEqual(incr(40000));
  });

  it('falls back to the newest snapshot when every snapshot predates the window', () => {
    // No checkout inside the trailing window at all → open on the freshest
    // state available rather than the oldest stale one.
    const events = [meta(0), snap(5), incr(10), meta(100), snap(105), incr(110)];
    const out = selectFlushWindow(events, 200_000, 45_000);
    expect(out[0]).toEqual(meta(100));
    expect(out[1]).toEqual(snap(105));
    expect(out).not.toContainEqual(snap(5));
  });

  it('returns the array unchanged when there is no full snapshot', () => {
    const events = [incr(1), incr(2), incr(3)];
    expect(selectFlushWindow(events, 1000, 100)).toBe(events);
  });

  it('returns the input unchanged for empty / non-array input', () => {
    const empty = [];
    expect(selectFlushWindow(empty, 1000, 100)).toBe(empty);
    expect(selectFlushWindow(null, 1000, 100)).toBe(null);
  });

  it('opens on the first populated snapshot, not a pre-mount shell, in a short session', () => {
    // Regression for the "blank replay" bug: the whole session (12.7s) is shorter
    // than the 45s window, so the boot loading-spinner snapshot stays in-window.
    // The time-based cutoff can't drop it, so the OLD heuristic opened there
    // (blank). The app mounts mid-session (a populated checkout), then the user
    // interacts. The replay must open on the populated checkout and KEEP the
    // trailing interactions — not the shell, and not only the final static frame.
    const events = [
      meta(0),
      snapEl(5, 16), // pre-mount loading spinner (shell)
      mut(2000, 80), // app mounts via mutations
      meta(2100),
      snapEl(2105, 800), // populated post-mount checkout
      incr(8000), // user interaction after mount
      incr(12000),
    ];
    const out = selectFlushWindow(events, 12005, 45000);
    expect(out[0]).toEqual(meta(2100));
    expect(out[1]).toEqual(snapEl(2105, 800));
    // The dead pre-mount lead-in is dropped …
    expect(out).not.toContainEqual(snapEl(5, 16));
    // … but the interactions that followed the mount are preserved.
    expect(out).toContainEqual(incr(8000));
    expect(out).toContainEqual(incr(12000));
  });

  it('keeps the oldest in-window snapshot when it is already populated', () => {
    // A session that opened on real content must NOT be re-anchored — we want the
    // full trailing window of context, exactly as before.
    const events = [meta(900), snapEl(905, 600), incr(950), meta(980), snapEl(985, 900)];
    const out = selectFlushWindow(events, 1000, 45000);
    expect(out[0]).toEqual(meta(900));
    expect(out[1]).toEqual(snapEl(905, 600));
    expect(out).toContainEqual(snapEl(985, 900));
  });

  it('keeps a lone shell snapshot when there is nothing more populated to skip to', () => {
    // Only one snapshot, and it is a shell: open on it rather than dropping the
    // sole replayable anchor (flush() still ships SOMETHING over nothing).
    const events = [meta(0), snapEl(5, 10), incr(100)];
    const out = selectFlushWindow(events, 200, 45000);
    expect(out[0]).toEqual(meta(0));
    expect(out[1]).toEqual(snapEl(5, 10));
  });
});

describe('countSnapshotElements', () => {
  it('counts element nodes in a captured DOM tree', () => {
    expect(countSnapshotElements(snapEl(1, 16))).toBe(16);
    expect(countSnapshotElements(snapEl(1, 890))).toBe(890);
  });

  it('returns 0 for an event with no node tree', () => {
    expect(countSnapshotElements(snap(1))).toBe(0);
    expect(countSnapshotElements(null)).toBe(0);
    expect(countSnapshotElements(undefined)).toBe(0);
  });

  it('countElementsInNode walks a node subtree (rrweb mutation-add shape)', () => {
    // A single mutation add can carry a whole mounted subtree under one node.
    const added = mutSubtree(1, 120).data.adds[0].node;
    expect(countElementsInNode(added)).toBe(120);
    expect(countElementsInNode(null)).toBe(0);
    expect(countElementsInNode({ type: 3, textContent: 'x' })).toBe(0); // leaf text
  });

  it('a boot spinner sits below the pre-mount shell threshold; a real page is above it', () => {
    expect(countSnapshotElements(snapEl(1, 16))).toBeLessThanOrEqual(PREMOUNT_SHELL_MAX_ELEMENTS);
    expect(countSnapshotElements(snapEl(1, 800))).toBeGreaterThan(PREMOUNT_SHELL_MAX_ELEMENTS);
  });
});

describe('hasFullSnapshot', () => {
  it('detects a full snapshot anywhere in the array', () => {
    expect(hasFullSnapshot([incr(1), meta(2), snap(3)])).toBe(true);
    expect(hasFullSnapshot([incr(1), meta(2)])).toBe(false);
    expect(hasFullSnapshot([])).toBe(false);
    expect(hasFullSnapshot(null)).toBe(false);
  });
});

describe('gzipString', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('produces gzip-framed bytes that inflate back to the input', async () => {
    const text = JSON.stringify({ hello: 'world', n: [1, 2, 3] });
    const bytes = await gzipString(text);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(gunzipSync(bytes).toString('utf-8')).toBe(text);
  });

  it('returns null (caller falls back to JSON) when CompressionStream is missing', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    expect(await gzipString('{}')).toBeNull();
  });
});

describe('submitReplay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gzips events, POSTs them as octet-stream, and returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ replayId: 'r1', replayRef: '/uploads/replay-r1.json' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await submitReplay({ events: [snap(1)], meta: { trigger: 't' } }, '/api/replays');
    expect(out.replayRef).toBe('/uploads/replay-r1.json');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/replays');
    expect(init.method).toBe('POST');
    // Body is gzip-framed bytes (magic 0x1f 0x8b) sent as octet-stream, and
    // round-trips back to the original payload once inflated.
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    const bytes = init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    const decoded = JSON.parse(gunzipSync(bytes).toString('utf-8'));
    expect(decoded.events).toHaveLength(1);
    expect(decoded.meta).toEqual({ trigger: 't' });
  });

  it('falls back to uncompressed JSON when CompressionStream is unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ replayId: 'r2', replayRef: '/uploads/replay-r2.json' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('CompressionStream', undefined);

    const out = await submitReplay({ events: [snap(1)] }, '/api/replays');
    expect(out.replayRef).toBe('/uploads/replay-r2.json');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body).events).toHaveLength(1);
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 429 })));
    await expect(submitReplay({ events: [snap(1)] }, '/api/replays')).rejects.toThrow();
  });

  it('throws when there are no events to submit', async () => {
    await expect(submitReplay({ events: [] })).rejects.toThrow(/no replay events/i);
  });
});

describe('SessionReplayRecorder', () => {
  function fakeRecord() {
    const calls = { emit: null, stopped: false };
    const record = ({ emit }) => {
      calls.emit = emit;
      return () => {
        calls.stopped = true;
      };
    };
    return { record, calls };
  }

  it('buffers emitted events and prunes to the trailing window', () => {
    const { record, calls } = fakeRecord();
    let now = 1000;
    const rec = new SessionReplayRecorder({ now: () => now, windowMs: 100 });
    rec.start(record);
    expect(rec.active).toBe(true);

    calls.emit(meta(800));
    calls.emit(snap(801));
    calls.emit(incr(950));
    now = 1000;
    calls.emit(incr(990));
    const buf = rec.snapshot();
    // snap(801) is the only snapshot, so it is retained as the anchor.
    expect(buf).toContainEqual(snap(801));
    expect(buf).toContainEqual(incr(990));
  });

  it('flush() submits the buffer and returns the ingest result', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi
      .fn()
      .mockResolvedValue({ replayId: 'r9', replayRef: '/uploads/replay-r9.json' });
    const rec = new SessionReplayRecorder({ now: () => 1000, submit });
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    const out = await rec.flush({ trigger: 'bug-report' });
    expect(out.replayRef).toBe('/uploads/replay-r9.json');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].meta).toEqual({ trigger: 'bug-report' });
  });

  it('forceFullSnapshot emits a fresh checkout into the buffer', () => {
    const { record, calls } = fakeRecord();
    let now = 5000;
    const takeFullSnapshot = vi.fn(() => {
      calls.emit(meta(now));
      calls.emit(snap(now));
    });
    const rec = new SessionReplayRecorder({ now: () => now, takeFullSnapshot });
    rec.start(record);
    calls.emit(snap(10));
    expect(rec.forceFullSnapshot()).toBe(true);
    expect(takeFullSnapshot).toHaveBeenCalledWith(true);
    expect(rec.snapshot()).toContainEqual(snap(5000));
  });

  it('forceFullSnapshot is a no-op (false) when no snapshot fn is wired', () => {
    const { record } = fakeRecord();
    const rec = new SessionReplayRecorder({ now: () => 1000 });
    rec.start(record); // fakeRecord exposes no takeFullSnapshot static
    expect(rec.forceFullSnapshot()).toBe(false);
  });

  it('takes one fresh checkout once the SPA mounts after a pre-mount shell', () => {
    // The recording opens on a near-empty boot shell; the app then mounts via
    // mutations. The recorder should take exactly ONE post-mount checkout so the
    // buffer holds a populated anchor early in the session.
    const { record, calls } = fakeRecord();
    let now = 1000;
    const takeFullSnapshot = vi.fn(() => {
      calls.emit(meta(now));
      calls.emit(snapEl(now, 800)); // a populated checkout
    });
    const rec = new SessionReplayRecorder({ now: () => now, takeFullSnapshot });
    rec.start(record);

    calls.emit(meta(0));
    calls.emit(snapEl(5, 16)); // pre-mount shell
    now = 1000;
    calls.emit(mut(900, 30)); // mounting… below threshold so far
    expect(takeFullSnapshot).not.toHaveBeenCalled();
    calls.emit(mut(950, 40)); // cumulative 70 >= MOUNT_NODE_THRESHOLD → checkout
    expect(takeFullSnapshot).toHaveBeenCalledTimes(1);

    // Further mutations don't trigger another checkout (one-shot).
    calls.emit(mut(1200, 200));
    expect(takeFullSnapshot).toHaveBeenCalledTimes(1);
    // The populated checkout is in the buffer.
    expect(rec.snapshot()).toContainEqual(snapEl(1000, 800));
  });

  it('detects a mount delivered as ONE add with a large subtree (not just adds.length)', () => {
    // Regression: rrweb can serialize a whole mounted container under a single
    // `adds` entry. Counting adds.length would see "1" and never fire; we must
    // count the element nodes inside the added subtree.
    const { record, calls } = fakeRecord();
    let now = 1000;
    const takeFullSnapshot = vi.fn(() => {
      calls.emit(meta(now));
      calls.emit(snapEl(now, 800));
    });
    const rec = new SessionReplayRecorder({ now: () => now, takeFullSnapshot });
    rec.start(record);

    calls.emit(meta(0));
    calls.emit(snapEl(5, 16)); // pre-mount shell
    now = 1000;
    // A single mutation add carrying a 200-element subtree (one adds entry).
    calls.emit(mutSubtree(900, 200));
    expect(takeFullSnapshot).toHaveBeenCalledTimes(1);
    expect(rec.snapshot()).toContainEqual(snapEl(1000, 800));
  });

  it('does NOT take a post-mount checkout when the recording opened populated', () => {
    // A session that started on real content needs no extra checkout — behaviour
    // is unchanged for the common case.
    const { record, calls } = fakeRecord();
    const takeFullSnapshot = vi.fn();
    const rec = new SessionReplayRecorder({ now: () => 1000, takeFullSnapshot });
    rec.start(record);

    calls.emit(meta(0));
    calls.emit(snapEl(5, 500)); // already populated
    calls.emit(mut(100, 300)); // lots of churn, but no shell → no forced checkout
    expect(takeFullSnapshot).not.toHaveBeenCalled();
  });

  it('flush() forces a fresh checkout so a stale pre-mount buffer opens on the current state', async () => {
    // Regression: the only snapshot in the buffer is a 5-minute-old, pre-mount
    // (empty #root) one because no checkout fired during a long idle. flush()
    // must force a fresh checkout and open the upload on THAT, not the stale one.
    const { record, calls } = fakeRecord();
    const submit = vi
      .fn()
      .mockResolvedValue({ replayId: 'r', replayRef: '/uploads/replay-r.json' });
    const now = 300_000;
    const takeFullSnapshot = () => {
      calls.emit(meta(now));
      calls.emit(snap(now));
    };
    const rec = new SessionReplayRecorder({
      now: () => now,
      submit,
      windowMs: 45_000,
      takeFullSnapshot,
    });
    rec.start(record);
    calls.emit(meta(4));
    calls.emit(snap(5)); // stale, pre-mount
    calls.emit(incr(6));

    const out = await rec.flush({ trigger: 'bug-report' });
    expect(out.replayRef).toBe('/uploads/replay-r.json');
    const sent = submit.mock.calls[0][0].events;
    const firstSnap = sent.find((e) => e.type === RRWEB_FULL_SNAPSHOT);
    expect(firstSnap.timestamp).toBe(300_000); // the forced checkout, not snap(5)
    expect(sent).not.toContainEqual(snap(5));
  });

  it('flush() declines a snapshot-less buffer (not replayable)', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi.fn();
    const rec = new SessionReplayRecorder({ now: () => 1000, submit, minFlushEvents: 2 });
    rec.start(record);
    calls.emit(incr(1));
    calls.emit(incr(2));
    const out = await rec.flush();
    expect(out).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('flush() returns null when the buffer is too small to be useful', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi.fn();
    const rec = new SessionReplayRecorder({ now: () => 1000, submit, minFlushEvents: 2 });
    rec.start(record);
    calls.emit(snap(2));
    const out = await rec.flush();
    expect(out).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('flush() never throws when the upload fails', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi.fn().mockRejectedValue(new Error('network'));
    const rec = new SessionReplayRecorder({ now: () => 1000, submit });
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));
    await expect(rec.flush()).resolves.toBeNull();
  });

  it('clears the active flush when a hung upload times out, so later flushes still run', async () => {
    // Regression: a hung submit used to leave the singleton stuck mid-flush
    // forever, disabling replay attachment for the rest of the page session.
    const { record, calls } = fakeRecord();
    const submit = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // hangs forever
      .mockImplementationOnce(() =>
        Promise.resolve({ replayId: 'r2', replayRef: '/uploads/replay-r2.json' }),
      );
    const rec = new SessionReplayRecorder({ now: () => 1000, submit, flushTimeoutMs: 20 });
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    const first = await rec.flush();
    expect(first).toBeNull();
    expect(rec._activeFlush).toBeNull(); // not wedged

    const second = await rec.flush();
    expect(second.replayRef).toBe('/uploads/replay-r2.json');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('shares the in-flight flush with overlapping callers (submits once)', async () => {
    // An error-triggered flush is mid-upload when a bug-report submit overlaps:
    // both must resolve to the same fresh result, not a stale lastResult.
    const { record, calls } = fakeRecord();
    let resolveSubmit;
    const submit = vi.fn(
      () =>
        new Promise((res) => {
          resolveSubmit = res;
        }),
    );
    const rec = new SessionReplayRecorder({ now: () => 1000, submit });
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    const p1 = rec.flush({ trigger: 'window.error' });
    const p2 = rec.flush({ trigger: 'bug-report' }); // overlaps the in-flight flush
    // _runFlush invokes _submit on a microtask; let it run before resolving.
    await new Promise((r) => setTimeout(r, 0));
    resolveSubmit({ replayId: 'r', replayRef: '/uploads/replay-r.json' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
    expect(r2.replayRef).toBe('/uploads/replay-r.json');
    expect(rec._activeFlush).toBeNull();
  });

  it('does not cache a timed-out flush as lastResult', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi.fn().mockImplementation(() => new Promise(() => {}));
    const rec = new SessionReplayRecorder({ now: () => 1000, submit, flushTimeoutMs: 20 });
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    await rec.flush();
    expect(rec.lastResult).toBeNull();
  });

  it('handleError throttles repeated error-triggered flushes', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi
      .fn()
      .mockResolvedValue({ replayId: 'r', replayRef: '/uploads/replay-r.json' });
    let now = 1000;
    const rec = new SessionReplayRecorder({ now: () => now, submit, errorThrottleMs: 5000 });
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    await rec.handleError({ trigger: 'window.error' });
    await rec.handleError({ trigger: 'window.error' }); // within throttle -> skipped
    expect(submit).toHaveBeenCalledTimes(1);

    now = 1000 + 6000;
    await rec.handleError({ trigger: 'window.error' });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('start() is idempotent and stop() halts recording', () => {
    const { record, calls } = fakeRecord();
    const rec = new SessionReplayRecorder({ now: () => 1000 });
    rec.start(record);
    rec.start(record); // no-op
    rec.stop();
    expect(calls.stopped).toBe(true);
    expect(rec.active).toBe(false);
  });

  it('starts rrweb with the privacy masking contract (inputs + text masked)', () => {
    let opts;
    const record = (o) => {
      opts = o;
      return () => {};
    };
    const rec = new SessionReplayRecorder({ now: () => 1000 });
    rec.start(record);

    expect(opts.maskAllInputs).toBe(true);
    expect(opts.maskInputOptions).toMatchObject({ password: true });
    // All text masked by default — Agent Hub shows prompts / terminal / secrets.
    expect(opts.maskTextSelector).toBe('*');
    expect(opts.blockClass).toBe('ah-replay-block');
    expect(opts.ignoreClass).toBe('ah-replay-ignore');
    // emit/checkout still wired and not clobbered by the spread.
    expect(typeof opts.emit).toBe('function');
    expect(opts.checkoutEveryNms).toBe(rec.windowMs);
  });

  it('the default privacy options mask inputs and all text', () => {
    expect(DEFAULT_RECORD_PRIVACY_OPTIONS.maskAllInputs).toBe(true);
    expect(DEFAULT_RECORD_PRIVACY_OPTIONS.maskTextSelector).toBe('*');
  });

  it('honours custom recordOptions while still wiring emit/checkout', () => {
    let opts;
    const record = (o) => {
      opts = o;
      return () => {};
    };
    const rec = new SessionReplayRecorder({
      now: () => 1000,
      recordOptions: { maskAllInputs: true, maskTextSelector: '*', sampling: { mousemove: false } },
    });
    rec.start(record);
    expect(opts.sampling).toEqual({ mousemove: false });
    expect(opts.maskAllInputs).toBe(true);
    expect(typeof opts.emit).toBe('function');
  });
});

describe('flushSessionReplayRef', () => {
  afterEach(() => _resetSessionReplayForTest());

  function fakeRecord() {
    const calls = { emit: null };
    const record = ({ emit }) => {
      calls.emit = emit;
      return () => {};
    };
    return { record, calls };
  }

  it('returns null when no recorder is active', async () => {
    expect(await flushSessionReplayRef()).toBeNull();
  });

  it('does not block the caller when the flush stalls — resolves null on timeout', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    rec._submit = () => new Promise(() => {}); // never resolves
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    const ref = await flushSessionReplayRef({ trigger: 'bug-report' }, 30);
    expect(ref).toBeNull();
    // The recorder must not be left wedged for the rest of the session.
    expect(rec._activeFlush).toBeNull();
  });

  it('returns the replay ref when the flush resolves in time', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    rec._submit = vi.fn().mockResolvedValue({ replayId: 'x', replayRef: '/uploads/replay-x.json' });
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    const ref = await flushSessionReplayRef({ trigger: 'bug-report' }, 1000);
    expect(ref).toBe('/uploads/replay-x.json');
  });
});

describe('flushSessionReplayRef — null-flush breadcrumbs', () => {
  let sink;
  beforeEach(() => {
    sink = vi.fn();
    setReplayBreadcrumbSink(sink);
  });
  afterEach(() => _resetSessionReplayForTest());

  function fakeRecord() {
    const calls = { emit: null };
    const record = ({ emit }) => {
      calls.emit = emit;
      return () => {};
    };
    return { record, calls };
  }

  it('reports recorder-not-initialized when no recorder exists', async () => {
    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink).toHaveBeenCalledWith({
      reason: 'recorder-not-initialized',
      trigger: 'bug-report',
    });
  });

  it('reports recorder-inactive when the recorder exists but is not recording', async () => {
    getRecorder(); // creates the singleton without starting it
    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink).toHaveBeenCalledWith({ reason: 'recorder-inactive', trigger: 'bug-report' });
  });

  it('reports buffer-too-small when fewer than minFlushEvents are buffered', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(snap(1)); // a single event — below minFlushEvents (2)

    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink).toHaveBeenCalledWith({ reason: 'buffer-too-small', trigger: 'bug-report' });
  });

  it('reports no-full-snapshot when the buffer cannot be replayed', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(incr(2)); // two events, but no full snapshot

    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink).toHaveBeenCalledWith({ reason: 'no-full-snapshot', trigger: 'bug-report' });
  });

  it('reports upload-failed when a replayable buffer yields no ref', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    rec._submit = vi.fn().mockResolvedValue(null); // ingest returns nothing usable
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    expect(await flushSessionReplayRef({ trigger: 'bug-report' }, 1000)).toBeNull();
    expect(sink).toHaveBeenCalledWith({ reason: 'upload-failed', trigger: 'bug-report' });
  });

  it('emits no breadcrumb on a successful flush', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    rec._submit = vi.fn().mockResolvedValue({ replayId: 'x', replayRef: '/uploads/replay-x.json' });
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    expect(await flushSessionReplayRef({ trigger: 'bug-report' }, 1000)).toBe(
      '/uploads/replay-x.json',
    );
    expect(sink).not.toHaveBeenCalled();
  });
});
