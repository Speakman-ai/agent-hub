import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clampSampleRate,
  shouldSample,
  resolveSampleRate,
  isSessionReplayEnabled,
  setSessionReplayEnabled,
  REPLAY_SAMPLE_RATE_KEY,
  pruneBuffer,
  hasFullSnapshot,
  submitReplay,
  SessionReplayRecorder,
  getRecorder,
  flushSessionReplayRef,
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
} from './sessionReplay.js';

// startRecorder() lazy-imports rrweb; stub it so the masking-mode restart path
// is deterministic and never spins up a real recorder in jsdom. record() returns
// its stop fn, matching rrweb's contract.
vi.mock('rrweb', () => ({ record: () => () => {} }));

const ev = (type, timestamp, data = {}) => ({ type, timestamp, data });
const meta = (ts) => ev(RRWEB_META, ts);
const snap = (ts) => ev(RRWEB_FULL_SNAPSHOT, ts);
const incr = (ts) => ev(3, ts);

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

describe('hasFullSnapshot', () => {
  it('detects a full snapshot anywhere in the array', () => {
    expect(hasFullSnapshot([incr(1), meta(2), snap(3)])).toBe(true);
    expect(hasFullSnapshot([incr(1), meta(2)])).toBe(false);
    expect(hasFullSnapshot([])).toBe(false);
    expect(hasFullSnapshot(null)).toBe(false);
  });
});

describe('submitReplay', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs events as JSON and returns the parsed body', async () => {
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
