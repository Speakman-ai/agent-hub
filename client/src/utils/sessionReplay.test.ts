import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gunzipSync } from 'zlib';
import {
  clampSampleRate,
  shouldSample,
  resolveSampleRate,
  applyServerReplayConfig,
  getServerSampleRate,
  fetchServerReplayConfig,
  isServerMaskAllEnforced,
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
  flushSessionReplayRefWithReason,
  REPLAY_MISS_REASONS,
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
  resolveReplayIngestEndpoint,
  gzipString,
  UPLOAD_TIMEOUT_MS,
  FLUSH_TIMEOUT_MS,
  ContinuousReplayFlusher,
  submitReplayBatch,
  defaultReplayBeacon,
  KEEPALIVE_MAX_BYTES,
  takeKeepalivePrefix,
  clampContinuousFlushInterval,
  replayBatchEndpoint,
  isServerContinuousEnabled,
  getContinuousFlushIntervalMs,
  DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS,
  MIN_CONTINUOUS_FLUSH_INTERVAL_MS,
  MAX_CONTINUOUS_FLUSH_INTERVAL_MS,
  SegmentReplayFlusher,
  submitReplaySegment,
  segmentBatchEndpoint,
  SEGMENT_MAX_DURATION_MS,
  SEGMENT_MAX_RAW_BYTES,
  RumSessionManager,
  generateRumId,
  installViewChangeDetector,
  SESSION_INACTIVITY_TIMEOUT_MS,
  SESSION_MAX_DURATION_MS,
  setUser,
  setUserProperty,
  clearUser,
  getActiveUser,
  isServerSegmentedEnabled,
  SegmentedContinuousController,
  clampSegmentFlushInterval,
  getSegmentMaxDurationMs,
  MIN_SEGMENTED_FLUSH_INTERVAL_MS,
} from './sessionReplay';
import type { SegmentFlusherLike } from './sessionReplay';

// startRecorder() lazy-imports rrweb; stub it so the masking-mode restart path
// is deterministic and never spins up a real recorder in jsdom. record() returns
// its stop fn, matching rrweb's contract.
(vi as any).mock('rrweb', () => ({ record: () => () => {} }));

const ev = (type: any, timestamp: any, data: any = {}) => ({ type, timestamp, data });
const meta = (ts: any) => ev(RRWEB_META, ts);
const snap = (ts: any) => ev(RRWEB_FULL_SNAPSHOT, ts);
const incr = (ts: any) => ev(3, ts);

// A serialized rrweb DOM tree (document → html → body → `elements - 2` divs)
// carrying exactly `elements` element nodes (serialized NodeType.Element === 2).
const elemTree = (elements: any) => {
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
const snapEl = (ts: any, elements: any) =>
  ev(RRWEB_FULL_SNAPSHOT, ts, { node: elemTree(elements) });
// A mutation incremental (IncrementalSource.Mutation === 0) that adds `n` nodes.
const mut = (ts: any, n: any) =>
  ev(3, ts, { source: 0, adds: Array.from({ length: n }, () => ({})) });
// A mutation incremental that adds a SINGLE node whose serialized subtree holds
// `elements` element nodes — the shape rrweb produces when an SPA mounts a whole
// container at once (one `adds` entry, large `childNodes`).
const mutSubtree = (ts: any, elements: any) =>
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
  afterEach(() => {
    localStorage.removeItem('agent-hub-replay-sample-rate');
    applyServerReplayConfig(null);
  });

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
  it('server-delivered rate wins over a localStorage override', () => {
    localStorage.setItem('agent-hub-replay-sample-rate', '1');
    applyServerReplayConfig({ sampleRate: 0 });
    expect(resolveSampleRate()).toBe(0);
    applyServerReplayConfig({ sampleRate: 0.4 });
    expect(resolveSampleRate()).toBe(0.4);
  });
  it('falls back to localStorage when the server rate is null (unset)', () => {
    localStorage.setItem('agent-hub-replay-sample-rate', '0.3');
    applyServerReplayConfig({ sampleRate: null, continuous: false });
    expect(resolveSampleRate()).toBe(0.3);
  });
});

describe('applyServerReplayConfig / fetchServerReplayConfig', () => {
  afterEach(() => {
    applyServerReplayConfig(null);
    vi.restoreAllMocks();
  });

  it('clamps and stores a numeric server rate; null clears it', () => {
    expect(applyServerReplayConfig({ sampleRate: 5 })).toBe(1);
    expect(getServerSampleRate()).toBe(1);
    expect(applyServerReplayConfig(null)).toBeNull();
    expect(getServerSampleRate()).toBeNull();
  });

  it('treats a missing/non-numeric rate as unset (null)', () => {
    expect(applyServerReplayConfig({ continuous: true })).toBeNull();
    expect(applyServerReplayConfig({ sampleRate: 'half' })).toBeNull();
  });

  it('prefers the two-level effective rate over the flat sampleRate', () => {
    // 0.5 sessions × 0.4 replay = 0.2 effective; it must win over the flat rate.
    expect(applyServerReplayConfig({ sampleRate: 1, effectiveReplaySampleRate: 0.2 })).toBeCloseTo(
      0.2,
    );
    expect(getServerSampleRate()).toBeCloseTo(0.2);
  });

  it('falls back to the flat sampleRate when no effective nested rate is present', () => {
    // Only single-level config → the flat rate still governs (back-compat).
    expect(
      applyServerReplayConfig({ sampleRate: 0.3, effectiveReplaySampleRate: null }),
    ).toBeCloseTo(0.3);
    expect(getServerSampleRate()).toBeCloseTo(0.3);
  });

  it('fetches the policy and applies the rate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sampleRate: 0.2, continuous: false, maskAllEnforced: false }),
      }),
    );
    const rate = await fetchServerReplayConfig();
    expect(rate).toBe(0.2);
    expect(getServerSampleRate()).toBe(0.2);
  });

  it('appends the passed projectId so a project-specific rate reaches the client', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sampleRate: 0.3, continuous: false, maskAllEnforced: false }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchServerReplayConfig({ projectId: 'my-proj', endpoint: '/api/replays/config' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/replays/config?projectId=my-proj',
      expect.objectContaining({ method: 'GET', headers: {} }),
    );
  });

  it('sends the RUM token as X-RUM-Token (main cross-origin instrumentation path)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sampleRate: 0.5, continuous: true, maskAllEnforced: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const rate = await fetchServerReplayConfig({
      rumToken: 'rum_abc',
      endpoint: '/api/replays/config',
    });
    expect(rate).toBe(0.5);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/replays/config',
      expect.objectContaining({ method: 'GET', headers: { 'X-RUM-Token': 'rum_abc' } }),
    );
  });

  it('sends both the token header and the projectId query when both are given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sampleRate: 0.2 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchServerReplayConfig({
      projectId: 'p1',
      rumToken: 'rum_x',
      endpoint: '/api/replays/config',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/replays/config?projectId=p1',
      expect.objectContaining({ method: 'GET', headers: { 'X-RUM-Token': 'rum_x' } }),
    );
  });

  it('omits the projectId query and token header when none is resolvable', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sampleRate: 0.1 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchServerReplayConfig({ endpoint: '/api/replays/config' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/replays/config',
      expect.objectContaining({ method: 'GET', headers: {} }),
    );
  });

  it('applies mask-all enforcement from a continuous policy', () => {
    localStorage.setItem(MASKING_MODE_KEY, MASKING_MODES.PASSWORDS);
    // Without a server policy the per-browser passwords-only choice is honoured.
    expect(resolveMaskingMode()).toBe(MASKING_MODES.PASSWORDS);
    expect(isServerMaskAllEnforced()).toBe(false);
    // A continuous policy forces mask-all regardless of the local override.
    applyServerReplayConfig({ sampleRate: 1, continuous: true, maskAllEnforced: true });
    expect(isServerMaskAllEnforced()).toBe(true);
    expect(resolveMaskingMode()).toBe(MASKING_MODES.ALL);
    // Clearing the policy restores the local choice.
    applyServerReplayConfig(null);
    expect(isServerMaskAllEnforced()).toBe(false);
    expect(resolveMaskingMode()).toBe(MASKING_MODES.PASSWORDS);
    localStorage.removeItem(MASKING_MODE_KEY);
  });

  it('honours the Admin opt-out: continuous-on with maskAllEnforced:false does NOT force mask-all', () => {
    // Regression: the client previously OR-ed `continuous === true` into
    // enforcement, so an Admin opt-out (server resolves maskAllEnforced:false
    // while continuous stays true) was silently overridden back to mask-all.
    // The client must trust the server's resolved `maskAllEnforced` verbatim.
    localStorage.setItem(MASKING_MODE_KEY, MASKING_MODES.PASSWORDS);
    applyServerReplayConfig({ sampleRate: 1, continuous: true, maskAllEnforced: false });
    expect(isServerMaskAllEnforced()).toBe(false);
    expect(resolveMaskingMode()).toBe(MASKING_MODES.PASSWORDS);
    localStorage.removeItem(MASKING_MODE_KEY);
  });

  it('is best-effort: a failed fetch leaves the client on its default (null)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchServerReplayConfig()).toBeNull();
    expect(getServerSampleRate()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await fetchServerReplayConfig()).toBeNull();
  });

  it('is hard-bounded: a hung config request resolves to the default within the timeout', async () => {
    // fetch never settles — the timer must win so the recorder can still start.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const result = await fetchServerReplayConfig({
      endpoint: '/api/replays/config',
      timeoutMs: 20,
    });
    expect(result).toBeNull();
    expect(getServerSampleRate()).toBeNull();
  });

  it('a late-resolving fetch past the timeout does not apply the policy', async () => {
    let resolveFetch: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((r) => {
            resolveFetch = r;
          }),
      ),
    );
    const p = fetchServerReplayConfig({ endpoint: '/api/replays/config', timeoutMs: 20 });
    expect(await p).toBeNull();
    // The fetch settles only after we've already fallen back — must not apply.
    resolveFetch({ ok: true, json: async () => ({ sampleRate: 0.9 }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(getServerSampleRate()).toBeNull();
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
    expect(state!).toBe(false);
    expect(localStorage.getItem(REPLAY_SAMPLE_RATE_KEY)).toBe('0');
    expect(isSessionReplayEnabled()).toBe(false);
  });

  it('persists an on choice as "1" and reports enabled', async () => {
    localStorage.setItem(REPLAY_SAMPLE_RATE_KEY, '0');
    const state = await setSessionReplayEnabled(true);
    expect(state!).toBe(true);
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
    expect(stopped!).toBe(true);
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
    expect((opts as any).maskTextSelector).toBe('*');
    expect(opts.maskInputOptions).toEqual({ password: true });
    // Class-based opt-outs survive in every mode.
    expect(opts.unmaskTextClass).toBe('ah-replay-unmask');
  });

  it('buildRecordPrivacyOptions(passwords-only) masks only passwords, no text mask', () => {
    const opts = buildRecordPrivacyOptions(MASKING_MODES.PASSWORDS);
    expect(opts.maskAllInputs).toBe(false);
    expect((opts as any).maskTextSelector).toBeUndefined();
    expect(opts.maskInputOptions).toEqual({ password: true });
    expect(opts.blockClass).toBe('ah-replay-block');
  });

  it('an unknown mode falls back to the strict mask-all options', () => {
    const opts = buildRecordPrivacyOptions('nonsense');
    expect(opts.maskAllInputs).toBe(true);
    expect((opts as any).maskTextSelector).toBe('*');
  });

  it('DEFAULT_RECORD_PRIVACY_OPTIONS is the strict mask-all set', () => {
    expect(DEFAULT_RECORD_PRIVACY_OPTIONS!).toEqual(buildRecordPrivacyOptions(MASKING_MODES.ALL));
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
    expect(m1!).toBe(MASKING_MODES.PASSWORDS);
    expect(localStorage.getItem(MASKING_MODE_KEY)).toBe(MASKING_MODES.PASSWORDS);
    expect(isMaskAllEnabled()).toBe(false);

    const m2 = await setReplayMaskingMode(true);
    expect(m2!).toBe(MASKING_MODES.ALL);
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
    expect(stopped!).toBe(1);
  });
});

describe('REPLAY_INGEST_ENDPOINT', () => {
  it('derives from the configured bug-report endpoint origin', () => {
    // The test env sets VITE_BUG_REPORT_ENDPOINT (see vitest.config.ts), so the
    // ingest endpoint derives from it and swaps /api/bug-reports → /api/replays.
    expect(REPLAY_INGEST_ENDPOINT!).toMatch(/\/api\/replays$/);
    expect(REPLAY_INGEST_ENDPOINT!).not.toMatch(/bug-reports/);
    expect(REPLAY_INGEST_ENDPOINT!).toBe('https://hub.example.test/api/replays');
  });
});

describe('resolveReplayIngestEndpoint', () => {
  it('is empty (disabled) when nothing is configured — no phone-home default', () => {
    expect(resolveReplayIngestEndpoint({}, '')).toBe('');
    expect(resolveReplayIngestEndpoint(null, null)).toBe('');
  });

  it('prefers an explicit VITE_REPLAY_INGEST_ENDPOINT (trailing slashes stripped)', () => {
    expect(
      resolveReplayIngestEndpoint(
        { VITE_REPLAY_INGEST_ENDPOINT: 'https://r.example.test/api/replays/' },
        'https://ignored.test/api/bug-reports',
      ),
    ).toBe('https://r.example.test/api/replays');
  });

  it('derives from the bug-report endpoint when no explicit override is set', () => {
    expect(resolveReplayIngestEndpoint({}, 'https://hub.example.test/api/bug-reports')).toBe(
      'https://hub.example.test/api/replays',
    );
  });
});

describe('pruneBuffer', () => {
  it('returns the input untouched when empty', () => {
    const e: any[] = [];
    expect(pruneBuffer(e, 1000, 500)).toBe(e);
  });

  it('keeps everything when all events are within the window', () => {
    const events = [meta(900), snap(901), incr(950), incr(990)];
    const out = pruneBuffer(events, 1000, 200);
    expect(out!).toEqual(events);
  });

  it('drops events older than the window but keeps a leading snapshot+meta', () => {
    // window = 100ms, now = 1000 -> cutoff 900. Old snapshot at 850 is the
    // most-recent snapshot at/before cutoff and must survive as the anchor.
    const events = [meta(800), snap(801), incr(810), meta(849), snap(850), incr(905), incr(980)];
    const out = pruneBuffer(events, 1000, 100);
    // Anchor is the 850 snapshot, with its preceding meta(849).
    expect(out[0]).toEqual(meta(849));
    expect(out[1]).toEqual(snap(850));
    expect(out!).toHaveLength(4);
    expect(out!).not.toContainEqual(snap(801));
  });

  it('never drops the only snapshot even if it predates the window', () => {
    const events = [meta(100), snap(101), incr(990)];
    const out = pruneBuffer(events, 1000, 100);
    expect(out!).toContainEqual(snap(101));
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
    expect(out!).toContainEqual(incr(6));
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('returns a snapshot-less tail (which flush declines) when no snapshot exists', () => {
    const events = [incr(1), incr(2), incr(3), incr(4)];
    const out = pruneBuffer(events, 1000, 10_000, 2);
    expect(hasFullSnapshot(out)).toBe(false);
    expect(out!).toHaveLength(2);
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
    expect(out!).toContainEqual(incr(990));
    expect(out!).not.toContainEqual(snap(200));
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
    expect(out!).not.toContainEqual(snap(5));
    expect(out!).not.toContainEqual(incr(2522));
    expect(out!).not.toContainEqual(incr(40000));
  });

  it('falls back to the newest snapshot when every snapshot predates the window', () => {
    // No checkout inside the trailing window at all → open on the freshest
    // state available rather than the oldest stale one.
    const events = [meta(0), snap(5), incr(10), meta(100), snap(105), incr(110)];
    const out = selectFlushWindow(events, 200_000, 45_000);
    expect(out[0]).toEqual(meta(100));
    expect(out[1]).toEqual(snap(105));
    expect(out!).not.toContainEqual(snap(5));
  });

  it('returns the array unchanged when there is no full snapshot', () => {
    const events = [incr(1), incr(2), incr(3)];
    expect(selectFlushWindow(events, 1000, 100)).toBe(events);
  });

  it('returns the input unchanged for empty / non-array input', () => {
    const empty: any[] = [];
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
    expect(out!).not.toContainEqual(snapEl(5, 16));
    // … but the interactions that followed the mount are preserved.
    expect(out!).toContainEqual(incr(8000));
    expect(out!).toContainEqual(incr(12000));
  });

  it('keeps the oldest in-window snapshot when it is already populated', () => {
    // A session that opened on real content must NOT be re-anchored — we want the
    // full trailing window of context, exactly as before.
    const events = [meta(900), snapEl(905, 600), incr(950), meta(980), snapEl(985, 900)];
    const out = selectFlushWindow(events, 1000, 45000);
    expect(out[0]).toEqual(meta(900));
    expect(out[1]).toEqual(snapEl(905, 600));
    expect(out!).toContainEqual(snapEl(985, 900));
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
    expect(bytes!).toBeInstanceOf(Uint8Array);
    expect(bytes![0]).toBe(0x1f);
    expect(bytes![1]).toBe(0x8b);
    expect(gunzipSync(bytes!).toString('utf-8')).toBe(text);
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
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url!).toBe('/api/replays');
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
    const [, init] = (fetchMock as any).mock.calls[0];
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

  // Regression: heavy replays (mask-all full snapshots gzip into the multi-MB
  // range) were silently aborted by a 4 s upload ceiling, so the capture
  // recorded fine but the upload never finished and the bug report landed with
  // NO replay attached. The default upload deadline must be generous enough for
  // real payloads and is the value driving the fetch's AbortSignal.
  it('uses the generous default upload deadline for the fetch AbortSignal', async () => {
    const timeoutSpy = vi.fn(() => undefined);
    vi.stubGlobal('AbortSignal', { timeout: timeoutSpy });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ replayId: 'r3', replayRef: '/uploads/replay-r3.json' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await submitReplay({ events: [snap(1)] }, '/api/replays');
    expect(timeoutSpy).toHaveBeenCalledWith(UPLOAD_TIMEOUT_MS);
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('honors an explicit upload timeout for the fetch AbortSignal', async () => {
    const timeoutSpy = vi.fn(() => undefined);
    vi.stubGlobal('AbortSignal', { timeout: timeoutSpy });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ replayId: 'r4', replayRef: '/uploads/replay-r4.json' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await submitReplay({ events: [snap(1)] }, '/api/replays', 25_000);
    expect(timeoutSpy).toHaveBeenCalledWith(25_000);
  });

  it('keeps the flush backstop strictly above the upload deadline', () => {
    // The backstop race must never fire before the fetch's own (clean,
    // null-resolving) abort, or a slow-but-succeeding upload is dropped.
    expect(FLUSH_TIMEOUT_MS).toBeGreaterThan(UPLOAD_TIMEOUT_MS);
  });
});

describe('submitReplayBatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs the chunk to the per-id events endpoint and returns the parsed body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ replayId: 'rb', created: true }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const out = await submitReplayBatch(
      { id: 'rb', events: [snap(1)] },
      { endpointBase: '/api/replays' },
    );
    expect(out.created).toBe(true);
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe('/api/replays/rb/events');
    expect(init.method).toBe('POST');
    // No token → no X-RUM-Token header.
    expect(init.headers['X-RUM-Token']).toBeUndefined();
  });

  it('attaches X-RUM-Token when a token is supplied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ created: true }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await submitReplayBatch(
      { id: 'rb', events: [snap(1)] },
      { endpointBase: '/api/replays', rumToken: 'rum_abc' },
    );
    const [, init] = (fetchMock as any).mock.calls[0];
    expect(init.headers['X-RUM-Token']).toBe('rum_abc');
  });

  it('throws without an id', async () => {
    await expect(submitReplayBatch({ events: [snap(1)] })).rejects.toThrow(/replay id/i);
  });
});

describe('takeKeepalivePrefix', () => {
  it('returns the largest leading run that fits the budget, in order', () => {
    const big = (ts: number) => ev(3, ts, { p: 'x'.repeat(10 * 1024) }); // ~10KB each
    const events = [meta(1), snap(2), ...Array.from({ length: 10 }, (_, i) => big(100 + i))];
    const prefix = takeKeepalivePrefix(events, { trigger: 'continuous' }, KEEPALIVE_MAX_BYTES);
    // A strict, in-order prefix that still opens with the snapshot.
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(events.length);
    expect(prefix[0]).toBe(events[0]);
    expect(hasFullSnapshot(prefix)).toBe(true);
    const bytes = JSON.stringify({ events: prefix, meta: { trigger: 'continuous' } }).length;
    expect(bytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
  });

  it('always includes at least the first event (even if it alone is over budget)', () => {
    const huge = ev(2, 1, { node: { huge: 'y'.repeat(KEEPALIVE_MAX_BYTES * 2) } });
    expect(takeKeepalivePrefix([huge, incr(2)], null, KEEPALIVE_MAX_BYTES)).toEqual([huge]);
  });

  it('returns [] for an empty input', () => {
    expect(takeKeepalivePrefix([], null, KEEPALIVE_MAX_BYTES)).toEqual([]);
  });

  it('returns a prefix whose ACTUAL serialized body fits, even with multi-byte meta', () => {
    // Regression: the old overhead estimate used `metaJson.length` (UTF-16 code
    // units) and a fixed wrapper constant, so multi-byte meta was under-counted
    // and the returned prefix could still exceed the budget — the transport then
    // refused it and `flushTail` dropped the whole tail. Size against the real
    // serialized body instead.
    const fatMeta = { trigger: 'continuous', note: '☃'.repeat(500) }; // 3 UTF-8 bytes/char
    const events = [
      snap(1),
      ...Array.from({ length: 40 }, (_, i) => ev(3, 100 + i, { p: 'x'.repeat(200) })),
    ];
    const budget = 8 * 1024;
    const prefix = takeKeepalivePrefix(events, fatMeta, budget);
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix[0]).toBe(events[0]);
    // The body the caller will actually beacon must fit the budget in real UTF-8
    // bytes — this is exactly what `defaultReplayBeacon`'s size guard measures.
    const body = JSON.stringify({ events: prefix, meta: fatMeta || undefined });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(budget);
  });

  it('is maximal: appending the next event would overflow the real body', () => {
    const enc = (s: string) => new TextEncoder().encode(s).length;
    const m = { trigger: 'continuous' };
    const events = [
      snap(1),
      ...Array.from({ length: 30 }, (_, i) => ev(3, 100 + i, { p: 'z'.repeat(512) })),
    ];
    const budget = 6 * 1024;
    const prefix = takeKeepalivePrefix(events, m, budget);
    expect(enc(JSON.stringify({ events: prefix, meta: m }))).toBeLessThanOrEqual(budget);
    // We did not under-deliver: one more event would have pushed the real body over.
    if (prefix.length < events.length) {
      const oneMore = events.slice(0, prefix.length + 1);
      expect(enc(JSON.stringify({ events: oneMore, meta: m }))).toBeGreaterThan(budget);
    }
  });

  it('accounts for the wrapper exactly with no meta', () => {
    const enc = (s: string) => new TextEncoder().encode(s).length;
    const events = Array.from({ length: 20 }, (_, i) => ev(3, i, { p: 'q'.repeat(256) }));
    const budget = 4 * 1024;
    const prefix = takeKeepalivePrefix(events, null, budget);
    expect(enc(JSON.stringify({ events: prefix, meta: undefined }))).toBeLessThanOrEqual(budget);
    if (prefix.length < events.length) {
      const oneMore = events.slice(0, prefix.length + 1);
      expect(enc(JSON.stringify({ events: oneMore, meta: undefined }))).toBeGreaterThan(budget);
    }
  });
});

describe('defaultReplayBeacon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses sendBeacon (no headers) when there is no token', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(defaultReplayBeacon('/api/replays/r/events', '{"events":[]}')).toBe(true);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    // sendBeacon can't carry headers, so the token-less path must not use fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a keepalive fetch carrying X-RUM-Token when a token is present', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(defaultReplayBeacon('/api/replays/r/events', '{"events":[]}', 'rum_xyz')).toBe(true);
    // sendBeacon can't attach the token header, so the token path must use fetch.
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe('/api/replays/r/events');
    expect(init.keepalive).toBe(true);
    expect(init.headers['X-RUM-Token']).toBe('rum_xyz');
  });

  // Regression: keepalive fetch rejects ASYNC on an over-budget body (after we'd
  // have returned), so the token path must refuse oversize bodies SYNCHRONOUSLY
  // and report false — never claim a queue it can't guarantee. 5-min rrweb chunks
  // routinely exceed the keepalive budget.
  it('refuses an over-budget token body synchronously without dispatching', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const oversize = 'x'.repeat(KEEPALIVE_MAX_BYTES + 1);
    expect(defaultReplayBeacon('/api/replays/r/events', oversize, 'rum_xyz')).toBe(false);
    // No optimistic dispatch, and the headerless sendBeacon is never used for a token.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('dispatches a token body exactly at the keepalive budget', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const atLimit = 'x'.repeat(KEEPALIVE_MAX_BYTES);
    expect(defaultReplayBeacon('/api/replays/r/events', atLimit, 'rum_xyz')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('SessionReplayRecorder', () => {
  function fakeRecord() {
    const calls: Record<string, any> = { emit: null, stopped: false };
    const record = ({ emit }: any) => {
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
    expect(buf!).toContainEqual(snap(801));
    expect(buf!).toContainEqual(incr(990));
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
    expect(submit!).toHaveBeenCalledTimes(1);
    expect((submit as any).mock.calls[0][0].meta).toEqual({ trigger: 'bug-report' });
  });

  // Regression: the flush budget must drive the upload's fetch-abort deadline so
  // a heavy capture's upload isn't silently capped. With the default budget the
  // forwarded upload deadline is the generous UPLOAD_TIMEOUT_MS; a caller's
  // larger override extends it further rather than being clamped.
  it('forwards an upload timeout derived from the flush budget to submit', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi
      .fn()
      .mockResolvedValue({ replayId: 'r10', replayRef: '/uploads/replay-r10.json' });
    const rec = new SessionReplayRecorder({ now: () => 1000, submit });
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));

    await rec.flush({ trigger: 'bug-report' });
    // Default flush backstop is FLUSH_TIMEOUT_MS; the forwarded upload deadline
    // sits one margin below it, which equals UPLOAD_TIMEOUT_MS.
    expect(submit.mock.calls[0][1]).toBe(UPLOAD_TIMEOUT_MS);

    submit.mockClear();
    await rec.flush({ trigger: 'bug-report' }, { timeoutMs: 30_000 });
    expect(submit.mock.calls[0][1]).toBeGreaterThan(UPLOAD_TIMEOUT_MS);
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
    expect(takeFullSnapshot!).toHaveBeenCalledWith(true);
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
    expect(takeFullSnapshot!).not.toHaveBeenCalled();
    calls.emit(mut(950, 40)); // cumulative 70 >= MOUNT_NODE_THRESHOLD → checkout
    expect(takeFullSnapshot!).toHaveBeenCalledTimes(1);

    // Further mutations don't trigger another checkout (one-shot).
    calls.emit(mut(1200, 200));
    expect(takeFullSnapshot!).toHaveBeenCalledTimes(1);
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
    expect(takeFullSnapshot!).toHaveBeenCalledTimes(1);
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
    expect(takeFullSnapshot!).not.toHaveBeenCalled();
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
    const sent = (submit as any).mock.calls[0][0].events;
    const firstSnap = sent.find((e: any) => e.type === RRWEB_FULL_SNAPSHOT);
    expect(firstSnap.timestamp).toBe(300_000); // the forced checkout, not snap(5)
    expect(sent!).not.toContainEqual(snap(5));
  });

  it('flush() declines a snapshot-less buffer (not replayable)', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi.fn();
    const rec = new SessionReplayRecorder({ now: () => 1000, submit, minFlushEvents: 2 });
    rec.start(record);
    calls.emit(incr(1));
    calls.emit(incr(2));
    const out = await rec.flush();
    expect(out!).toBeNull();
    expect(submit!).not.toHaveBeenCalled();
  });

  it('flush() returns null when the buffer is too small to be useful', async () => {
    const { record, calls } = fakeRecord();
    const submit = vi.fn();
    const rec = new SessionReplayRecorder({ now: () => 1000, submit, minFlushEvents: 2 });
    rec.start(record);
    calls.emit(snap(2));
    const out = await rec.flush();
    expect(out!).toBeNull();
    expect(submit!).not.toHaveBeenCalled();
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
    expect(first!).toBeNull();
    expect(rec._activeFlush).toBeNull(); // not wedged

    const second = await rec.flush();
    expect(second.replayRef).toBe('/uploads/replay-r2.json');
    expect(submit!).toHaveBeenCalledTimes(2);
  });

  it('shares the in-flight flush with overlapping callers (submits once)', async () => {
    // An error-triggered flush is mid-upload when a bug-report submit overlaps:
    // both must resolve to the same fresh result, not a stale lastResult.
    const { record, calls } = fakeRecord();
    let resolveSubmit: any;
    const submit = vi.fn(
      () =>
        new Promise((res: any) => {
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
    await new Promise((r: any) => setTimeout(r, 0));
    resolveSubmit({ replayId: 'r', replayRef: '/uploads/replay-r.json' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(submit!).toHaveBeenCalledTimes(1);
    expect(r1!).toEqual(r2);
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
    expect(submit!).toHaveBeenCalledTimes(1);

    now = 1000 + 6000;
    await rec.handleError({ trigger: 'window.error' });
    expect(submit!).toHaveBeenCalledTimes(2);
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
    let opts: any;
    const record = (o: any) => {
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
    expect((DEFAULT_RECORD_PRIVACY_OPTIONS as any).maskTextSelector).toBe('*');
  });

  it('honours custom recordOptions while still wiring emit/checkout', () => {
    let opts: any;
    const record = (o: any) => {
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
    const calls: Record<string, any> = { emit: null };
    const record = ({ emit }: any) => {
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
    expect(ref!).toBeNull();
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
    expect(ref!).toBe('/uploads/replay-x.json');
  });
});

describe('flushSessionReplayRefWithReason', () => {
  afterEach(() => _resetSessionReplayForTest());

  function fakeRecord() {
    const calls: Record<string, any> = { emit: null };
    const record = ({ emit }: any) => {
      calls.emit = emit;
      return () => {};
    };
    return { record, calls };
  }

  it('returns a recognised reason and null ref when no recorder is active', async () => {
    const out = await flushSessionReplayRefWithReason({ trigger: 'bug-report' });
    expect(out.ref).toBeNull();
    expect(out.reason).toBe('recorder-not-initialized');
    expect(REPLAY_MISS_REASONS).toContain(out.reason);
  });

  it('returns recorder-inactive when the recorder exists but is not recording', async () => {
    getRecorder();
    const out = await flushSessionReplayRefWithReason({ trigger: 'bug-report' });
    expect(out).toEqual({ ref: null, reason: 'recorder-inactive' });
  });

  it('returns buffer-too-small when below minFlushEvents', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(snap(1)); // one event, below minFlushEvents (2)
    const out = await flushSessionReplayRefWithReason({ trigger: 'bug-report' });
    expect(out).toEqual({ ref: null, reason: 'buffer-too-small' });
  });

  it('returns no-full-snapshot when the buffer cannot be replayed', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(incr(2)); // no full snapshot
    const out = await flushSessionReplayRefWithReason({ trigger: 'bug-report' });
    expect(out).toEqual({ ref: null, reason: 'no-full-snapshot' });
  });

  it('returns upload-failed when a replayable buffer produces no ref', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    rec._submit = vi.fn().mockResolvedValue(null);
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));
    const out = await flushSessionReplayRefWithReason({ trigger: 'bug-report' }, 1000);
    expect(out).toEqual({ ref: null, reason: 'upload-failed' });
  });

  it('returns the ref and null reason on success', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    rec._submit = vi.fn().mockResolvedValue({ replayId: 'x', replayRef: '/uploads/replay-x.json' });
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(snap(2));
    const out = await flushSessionReplayRefWithReason({ trigger: 'bug-report' }, 1000);
    expect(out).toEqual({ ref: '/uploads/replay-x.json', reason: null });
  });
});

describe('flushSessionReplayRef — null-flush breadcrumbs', () => {
  let sink: any;
  beforeEach(() => {
    sink = vi.fn();
    setReplayBreadcrumbSink(sink);
  });
  afterEach(() => _resetSessionReplayForTest());

  function fakeRecord() {
    const calls: Record<string, any> = { emit: null };
    const record = ({ emit }: any) => {
      calls.emit = emit;
      return () => {};
    };
    return { record, calls };
  }

  it('reports recorder-not-initialized when no recorder exists', async () => {
    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink!).toHaveBeenCalledWith({
      reason: 'recorder-not-initialized',
      trigger: 'bug-report',
    });
  });

  it('reports recorder-inactive when the recorder exists but is not recording', async () => {
    getRecorder(); // creates the singleton without starting it
    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink!).toHaveBeenCalledWith({ reason: 'recorder-inactive', trigger: 'bug-report' });
  });

  it('reports buffer-too-small when fewer than minFlushEvents are buffered', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(snap(1)); // a single event — below minFlushEvents (2)

    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink!).toHaveBeenCalledWith({ reason: 'buffer-too-small', trigger: 'bug-report' });
  });

  it('reports no-full-snapshot when the buffer cannot be replayed', async () => {
    const rec = getRecorder();
    rec._now = () => 1000;
    const { record, calls } = fakeRecord();
    rec.start(record);
    calls.emit(meta(1));
    calls.emit(incr(2)); // two events, but no full snapshot

    expect(await flushSessionReplayRef({ trigger: 'bug-report' })).toBeNull();
    expect(sink!).toHaveBeenCalledWith({ reason: 'no-full-snapshot', trigger: 'bug-report' });
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
    expect(sink!).toHaveBeenCalledWith({ reason: 'upload-failed', trigger: 'bug-report' });
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
    expect(sink!).not.toHaveBeenCalled();
  });
});

describe('clampContinuousFlushInterval', () => {
  it('defaults unset / non-finite to the 5-min default', () => {
    expect(clampContinuousFlushInterval(undefined)).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampContinuousFlushInterval(null)).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampContinuousFlushInterval('soon')).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampContinuousFlushInterval(NaN)).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
  });

  it('raises a sub-minute cadence to the floor (no sub-minute on monolithic storage)', () => {
    expect(clampContinuousFlushInterval(5_000)).toBe(MIN_CONTINUOUS_FLUSH_INTERVAL_MS);
    expect(clampContinuousFlushInterval(0)).toBe(MIN_CONTINUOUS_FLUSH_INTERVAL_MS);
  });

  it('caps an excessive cadence and passes an in-range one through', () => {
    expect(clampContinuousFlushInterval(10 * 60 * 60 * 1000)).toBe(
      MAX_CONTINUOUS_FLUSH_INTERVAL_MS,
    );
    expect(clampContinuousFlushInterval(2 * 60 * 1000)).toBe(2 * 60 * 1000);
  });
});

describe('applyServerReplayConfig — continuous tier', () => {
  beforeEach(() => _resetSessionReplayForTest());
  afterEach(() => _resetSessionReplayForTest());

  it('is OFF by default and for a non-continuous policy', () => {
    expect(isServerContinuousEnabled()).toBe(false);
    applyServerReplayConfig({ sampleRate: 1, continuous: false });
    expect(isServerContinuousEnabled()).toBe(false);
    // Cadence falls back to the built-in default when the server sends none.
    expect(getContinuousFlushIntervalMs()).toBe(DEFAULT_CONTINUOUS_FLUSH_INTERVAL_MS);
  });

  it('records the opt-in and the (clamped) server cadence', () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, flushIntervalMs: 120_000 });
    expect(isServerContinuousEnabled()).toBe(true);
    expect(getContinuousFlushIntervalMs()).toBe(120_000);
  });

  it('floors a sub-minute server cadence', () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, flushIntervalMs: 5_000 });
    expect(getContinuousFlushIntervalMs()).toBe(MIN_CONTINUOUS_FLUSH_INTERVAL_MS);
  });
});

describe('ContinuousReplayFlusher', () => {
  const cmeta = (ts: any) => meta(ts);
  const csnap = (ts: any) => snap(ts);
  const cincr = (ts: any) => incr(ts);

  // A controllable interval timer: capture the scheduled callback and fire it
  // on demand, so the periodic flush is deterministic without real timers.
  function fakeInterval() {
    const state: Record<string, any> = { cb: null, ms: null, cleared: false };
    const setIntervalFn = (cb: any, ms: any) => {
      state.cb = cb;
      state.ms = ms;
      return 42; // opaque handle
    };
    const clearIntervalFn = (_h: any) => {
      state.cleared = true;
    };
    return { state, setIntervalFn, clearIntervalFn };
  }

  it('requires a replay id', () => {
    expect(() => new ContinuousReplayFlusher({} as any)).toThrow(/replayId/);
  });

  it('clamps a sub-minute cadence at construction', () => {
    const f = new ContinuousReplayFlusher({ replayId: 'abc12345', flushIntervalMs: 1_000 });
    expect(f.flushIntervalMs).toBe(MIN_CONTINUOUS_FLUSH_INTERVAL_MS);
  });

  // Regression: the chunk transport must carry the project's RUM token so the
  // creating chunk is attributed and later chunks aren't rejected 403.
  it('threads the RUM token into both the async batch upload and the beacon', async () => {
    const submitBatch = vi.fn().mockResolvedValue({ created: true });
    const beacon = vi.fn().mockReturnValue(true);
    const f = new ContinuousReplayFlusher({
      replayId: 'rtok',
      submitBatch,
      beacon,
      rumToken: 'rum_tok',
    });

    // async (interval) path forwards the token in the submit opts.
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    await f.flush('interval');
    expect(submitBatch.mock.calls[0][1].rumToken).toBe('rum_tok');

    // beacon (tail) path forwards the token as the 3rd arg.
    f.addEvent(cincr(3));
    f.flushTail('pagehide');
    expect(beacon.mock.calls[0][2]).toBe('rum_tok');
  });

  it('schedules the periodic flush at the configured cadence', () => {
    const { state, setIntervalFn, clearIntervalFn } = fakeInterval();
    const f = new ContinuousReplayFlusher({
      replayId: 'r0',
      submitBatch: vi.fn().mockResolvedValue({ created: true }),
      setIntervalFn,
      clearIntervalFn,
      flushIntervalMs: 5 * 60 * 1000,
    });
    f.start();
    expect(state.ms).toBe(5 * 60 * 1000);
    expect(typeof state.cb).toBe('function');
    f.stop();
    expect(state.cleared).toBe(true);
  });

  it('the scheduled callback triggers a flush', async () => {
    const submitBatch = vi.fn().mockResolvedValue({ created: true });
    const { state, setIntervalFn, clearIntervalFn } = fakeInterval();
    const f = new ContinuousReplayFlusher({
      replayId: 'rcb',
      submitBatch,
      setIntervalFn,
      clearIntervalFn,
    });
    f.start();
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    // The callback is fire-and-forget; invoke it, then await the buffered flush.
    await state.cb();
    await f.flush('interval');
    expect(submitBatch).toHaveBeenCalled();
  });

  it('streams a multi-flush session as appended chunks', async () => {
    const submitBatch = vi.fn().mockResolvedValue({ replayId: 'r1', created: true });
    const f = new ContinuousReplayFlusher({
      replayId: 'r1',
      submitBatch,
      flushIntervalMs: 5 * 60 * 1000,
    });

    // First window: snapshot + a couple events → creating chunk carries the snapshot.
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    f.addEvent(cincr(3));
    await f.flush('interval');

    expect(submitBatch).toHaveBeenCalledTimes(1);
    const [firstArgs, firstOpts] = submitBatch.mock.calls[0];
    expect(firstArgs.id).toBe('r1');
    expect(firstArgs.events).toHaveLength(3);
    expect(hasFullSnapshot(firstArgs.events)).toBe(true);
    // First (creating) chunk carries the continuous meta.
    expect(firstArgs.meta).toMatchObject({ trigger: 'continuous' });
    expect(firstOpts.endpointBase).toBe(REPLAY_INGEST_ENDPOINT);

    // Second window: only incrementals — appended without re-sending the snapshot,
    // and with no meta (server honors meta on the first chunk only).
    f.addEvent(cincr(4));
    f.addEvent(cincr(5));
    await f.flush('interval');

    expect(submitBatch).toHaveBeenCalledTimes(2);
    const secondArgs = submitBatch.mock.calls[1][0];
    expect(secondArgs.events).toHaveLength(2);
    expect(hasFullSnapshot(secondArgs.events)).toBe(false);
    expect(secondArgs.meta).toBeNull();

    // Nothing buffered → the next flush is a no-op.
    await f.flush('interval');
    expect(submitBatch).toHaveBeenCalledTimes(2);
  });

  it('does not ship a snapshot-less creating chunk (waits for a snapshot)', async () => {
    const submitBatch = vi.fn().mockResolvedValue({ replayId: 'r2', created: true });
    const f = new ContinuousReplayFlusher({ replayId: 'r2', submitBatch });
    // Only incrementals so far → no creating chunk can be sent.
    f.addEvent(cincr(1));
    f.addEvent(cincr(2));
    expect(await f.flush('interval')).toBeNull();
    expect(submitBatch).not.toHaveBeenCalled();

    // Snapshot arrives → the next flush creates the replay with the snapshot.
    f.addEvent(csnap(3));
    await f.flush('interval');
    expect(submitBatch).toHaveBeenCalledTimes(1);
    expect(hasFullSnapshot(submitBatch.mock.calls[0][0].events)).toBe(true);
  });

  it('retains the creating chunk until confirmed (keeps the only snapshot)', async () => {
    const submitBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ replayId: 'r3', created: true });
    const f = new ContinuousReplayFlusher({ replayId: 'r3', submitBatch });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    // Creating chunk is sent as a COPY and `_pending` is NOT drained until the
    // server confirms — a failed (or unload-killed) upload leaves the snapshot
    // in place rather than relying on a catch that may never run.
    expect(await f.flush('interval')).toBeNull(); // failed, snapshot retained
    expect(f._pending.length).toBe(2);
    expect(f._created).toBe(false);
    // Retry succeeds and still carries the snapshot; only then is `_pending` cleared.
    await f.flush('interval');
    expect(submitBatch).toHaveBeenCalledTimes(2);
    expect(hasFullSnapshot(submitBatch.mock.calls[1][0].events)).toBe(true);
    expect(f._created).toBe(true);
    expect(f._pending.length).toBe(0);
  });

  it('clears only the confirmed creating events, keeping ones queued mid-flight', async () => {
    let resolveCreate: any;
    const create = new Promise((r) => {
      resolveCreate = r;
    });
    const submitBatch = vi.fn().mockReturnValue(create.then(() => ({ created: true })));
    const f = new ContinuousReplayFlusher({ replayId: 'r3b', submitBatch });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    const inflight = f.flush('interval'); // creating: sends copy of [meta, snap]
    // Events arrive while the creating upload is in flight.
    f.addEvent(cincr(3));
    f.addEvent(cincr(4));
    resolveCreate();
    await inflight;
    // Confirmed: the two sent events are dropped, the two queued behind stay.
    expect(f._created).toBe(true);
    expect(f._pending.map((e: any) => e.timestamp)).toEqual([3, 4]);
  });

  it('flushTail beacons the pending tail synchronously on tab close', () => {
    const beacon = vi.fn().mockReturnValue(true);
    const submitBatch = vi.fn();
    const f = new ContinuousReplayFlusher({ replayId: 'r4', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    f.addEvent(cincr(3));

    expect(f.flushTail('pagehide')).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0];
    expect(url).toBe(replayBatchEndpoint('r4'));
    const parsed = JSON.parse(body);
    expect(parsed.events).toHaveLength(3);
    expect(hasFullSnapshot(parsed.events)).toBe(true);
    // Beacon path does not also fire the async transport.
    expect(submitBatch).not.toHaveBeenCalled();
    // Tail drained the buffer.
    expect(f._pending.length).toBe(0);
  });

  it('retains the batch (no unsafe async) when the beacon is unavailable on a terminal flush', async () => {
    const beacon = vi.fn().mockReturnValue(false); // no usable unload transport
    const submitBatch = vi.fn().mockResolvedValue({ replayId: 'r5', created: true });
    const f = new ContinuousReplayFlusher({ replayId: 'r5', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));

    expect(f.flushTail('pagehide')).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    // A terminal flush must NOT fall back to the non-unload-safe async fetch — it
    // would be killed on discard. The batch (incl. the snapshot) is retained in
    // memory instead, not lost.
    expect(submitBatch).not.toHaveBeenCalled();
    expect(hasFullSnapshot(f._pending)).toBe(true);
  });

  it('is a no-op when nothing is buffered', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    const submitBatch = vi.fn();
    const f = new ContinuousReplayFlusher({ replayId: 'r6', submitBatch, beacon });
    expect(await f.flush('interval')).toBeNull();
    expect(f.flushTail('pagehide')).toBe(false);
    expect(submitBatch).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  // Regression: a bare flush() short-circuits to the in-flight `_flushing`
  // promise without draining a newly-pending tail, so a non-terminal flush that
  // overlaps an in-flight interval flush could drop the tail. `_drainAfterInflight`
  // (used by the non-terminal + disable paths) must chain a flush AFTER the
  // in-flight one. (Terminal flushes never use this async path — see the
  // unload-safe beacon tests below.)
  it('does not lose the tail when a non-terminal flush overlaps an in-flight interval flush', async () => {
    let resolveSlow: any;
    const slow = new Promise((r) => {
      resolveSlow = r;
    });
    const submitBatch = vi
      .fn()
      .mockResolvedValueOnce({ created: true }) // creating chunk (fast)
      .mockReturnValueOnce(slow.then(() => ({ created: false }))) // interval chunk (slow)
      .mockResolvedValue({ created: false }); // chained tail
    const f = new ContinuousReplayFlusher({ replayId: 'r7', submitBatch });

    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    await f.flush('interval');
    expect(f._created).toBe(true);
    expect(submitBatch).toHaveBeenCalledTimes(1);

    // A periodic flush is now in flight (its submit is held open).
    f.addEvent(cincr(3));
    const inflight = f.flush('interval');
    expect(submitBatch).toHaveBeenCalledTimes(2);

    // Tail events arrive while that flush is in flight; a non-terminal flush
    // (tab backgrounded) must chain past the in-flight one, not drop them.
    f.addEvent(cincr(4));
    f.addEvent(cincr(5));
    expect(f.flushTail('visibilitychange')).toBe(false);
    expect(submitBatch).toHaveBeenCalledTimes(2); // waits out the in-flight flush

    resolveSlow();
    await inflight;
    await new Promise((r) => setTimeout(r, 0));

    // The chained flush drained the re-queued tail.
    expect(submitBatch).toHaveBeenCalledTimes(3);
    const tail = submitBatch.mock.calls[2][0];
    expect(tail.events.map((e: any) => e.timestamp)).toEqual([4, 5]);
    expect(f._pending.length).toBe(0);
  });

  // Same hazard via the snapshot-less first-chunk branch: the creating flush is
  // in flight, tail events (no snapshot) arrive, tab closes. The chained drain
  // must send them once the creating chunk completes (so _created flips true).
  it('defers a terminal flush with no snapshot yet to the confirmed path', async () => {
    const submitBatch = vi.fn().mockResolvedValue({ created: true });
    const beacon = vi.fn().mockReturnValue(true);
    const f = new ContinuousReplayFlusher({ replayId: 'r9', submitBatch, beacon });

    // Only incrementals so far — no full snapshot, so there is no valid first
    // chunk to beacon. A terminal pagehide must NOT beacon a snapshot-less batch.
    f.addEvent(cincr(1));
    f.addEvent(cincr(2));
    expect(f.flushTail('pagehide')).toBe(false);
    expect(beacon).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 0));
    // The confirmed async path also no-ops without a snapshot — nothing is sent
    // and the capture stays uncreated until a snapshot is recorded.
    expect(submitBatch).not.toHaveBeenCalled();
    expect(f._created).toBe(false);
  });

  // Regression for the reviewer's race: on a normal close browsers commonly fire
  // `visibilitychange: hidden` (non-terminal) THEN `pagehide` (terminal). For an
  // uncreated capture the non-terminal flush must NOT drain the only snapshot
  // into an async upload that unload will kill — otherwise the immediately
  // following terminal beacon finds `_pending` empty and the first continuous
  // chunk is lost for sessions that close before the first interval.
  it('keeps the creating snapshot for a pagehide that follows a visibilitychange flush', async () => {
    let resolveCreate: any;
    const create = new Promise((r) => {
      resolveCreate = r;
    });
    const submitBatch = vi.fn().mockReturnValue(create.then(() => ({ created: true })));
    const beacon = vi.fn().mockReturnValue(true);
    const f = new ContinuousReplayFlusher({ replayId: 'rseq', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));

    // visibilitychange (non-terminal) → confirmed async flush sends a COPY.
    expect(f.flushTail('visibilitychange')).toBe(false);
    await Promise.resolve();
    expect(submitBatch).toHaveBeenCalledTimes(1);
    // The snapshot is NOT drained while creation is unconfirmed.
    expect(hasFullSnapshot(f._pending)).toBe(true);

    // pagehide follows immediately (the async upload would be killed on unload).
    // The terminal beacon still has the snapshot to send.
    expect(f.flushTail('pagehide')).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(hasFullSnapshot(JSON.parse(beacon.mock.calls[0][1]).events)).toBe(true);

    resolveCreate();
    await new Promise((r) => setTimeout(r, 0));
  });

  // Regression: sendBeacon only confirms the browser QUEUED the request, not that
  // the server accepted it. A non-terminal `visibilitychange: hidden` of an
  // uncreated capture must NOT optimistically flip `_created` (and discard the
  // only snapshot) off a beacon enqueue — a returning tab would then emit
  // snapshot-less appends the server rejects, with no snapshot left to recover.
  it('does not create off an unconfirmed beacon on a non-terminal visibility flush', async () => {
    const beacon = vi.fn().mockReturnValue(true); // "queued" — but unconfirmed
    const submitBatch = vi.fn().mockResolvedValue({ created: true });
    const f = new ContinuousReplayFlusher({ replayId: 'rv', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));

    // Non-terminal: a backgrounded tab can return → must use the confirmed path.
    expect(f.flushTail('visibilitychange')).toBe(false);
    expect(beacon).not.toHaveBeenCalled();

    // The confirmed async path creates the replay for real and only then flips.
    await new Promise((r) => setTimeout(r, 0));
    expect(submitBatch).toHaveBeenCalledTimes(1);
    expect(hasFullSnapshot(submitBatch.mock.calls[0][0].events)).toBe(true);
    expect(f._created).toBe(true);
  });

  it('retains the snapshot when a non-terminal flush cannot confirm creation', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    const submitBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('dropped')) // first attempt: no server 2xx
      .mockResolvedValueOnce({ created: true }); // later flush confirms
    const f = new ContinuousReplayFlusher({ replayId: 'rv2', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));

    expect(f.flushTail('visibilitychange')).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    // Creation NOT confirmed → still uncreated, snapshot retained for retry.
    expect(f._created).toBe(false);
    expect(hasFullSnapshot(f._pending)).toBe(true);

    // A later (e.g. interval) flush recovers using the retained snapshot.
    await f.flush('interval');
    expect(f._created).toBe(true);
    expect(submitBatch).toHaveBeenCalledTimes(2);
    expect(hasFullSnapshot(submitBatch.mock.calls[1][0].events)).toBe(true);
  });

  // A TERMINAL `pagehide` of an uncreated capture still beacons the creating
  // chunk best-effort — the document is unloading, an async fetch can't finish,
  // and the tab won't return, so an unconfirmed enqueue can't strand a later flush.
  it('beacons the creating chunk on a terminal pagehide', () => {
    const beacon = vi.fn().mockReturnValue(true);
    const submitBatch = vi.fn();
    const f = new ContinuousReplayFlusher({ replayId: 'rterm', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));

    expect(f.flushTail('pagehide')).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(hasFullSnapshot(JSON.parse(beacon.mock.calls[0][1]).events)).toBe(true);
    expect(submitBatch).not.toHaveBeenCalled();
  });

  // A size-aware beacon mock mirroring defaultReplayBeacon's keepalive budget:
  // accepts a body within KEEPALIVE_MAX_BYTES, refuses (false) when over.
  const sizedBeacon = () =>
    vi.fn((_url: any, body: any) => String(body).length <= KEEPALIVE_MAX_BYTES);
  // A ~10KB incremental event (ASCII padding so byte length ≈ string length).
  const bigIncr = (ts: any) => ev(3, ts, { p: 'x'.repeat(10 * 1024) });

  // Regression: an oversized terminal tail must stay on the UNLOAD-SAFE transport.
  // The fallback to a normal async `fetch` (`_drainAfterInflight`) is killed on
  // document unload, silently losing the batch. Instead flushTail beacons the
  // largest budget-sized prefix and drops the remainder (accepted tail loss).
  it('beacons a budget-sized prefix for an oversized terminal tail and never touches async', async () => {
    const beacon = sizedBeacon();
    const submitBatch = vi.fn().mockResolvedValue({ created: true });
    const f = new ContinuousReplayFlusher({ replayId: 'rov', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    await f.flush('interval'); // create the replay
    expect(f._created).toBe(true);
    submitBatch.mockClear();

    // ~100KB of incremental tail — far over the keepalive budget.
    for (let i = 0; i < 10; i++) f.addEvent(bigIncr(100 + i));

    expect(f.flushTail('pagehide')).toBe(true);
    // Whole batch attempted (refused, over budget) then a budget-sized prefix.
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(beacon.mock.calls[1][1].length).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    // The unsafe async transport is NEVER used on a terminal flush.
    expect(submitBatch).not.toHaveBeenCalled();
    // Remainder dropped (accepted unload tail loss); buffer cleared.
    expect(f._pending.length).toBe(0);
  });

  it('keeps the snapshot in the prefix for an oversized uncreated terminal tail', () => {
    const beacon = sizedBeacon();
    const submitBatch = vi.fn();
    const f = new ContinuousReplayFlusher({ replayId: 'rov2', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2)); // small snapshot
    for (let i = 0; i < 10; i++) f.addEvent(bigIncr(100 + i));

    expect(f.flushTail('pagehide')).toBe(true);
    expect(submitBatch).not.toHaveBeenCalled();
    // The prefix that was actually beaconed is a VALID creating chunk (has snapshot).
    const lastBody = beacon.mock.calls[beacon.mock.calls.length - 1][1];
    expect(hasFullSnapshot(JSON.parse(lastBody).events)).toBe(true);
    expect(f._created).toBe(true);
  });

  it('retains (no junk, no async) when the snapshot alone overflows the budget', () => {
    const beacon = sizedBeacon();
    const submitBatch = vi.fn();
    const f = new ContinuousReplayFlusher({ replayId: 'rov3', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(ev(2, 2, { node: { huge: 'y'.repeat(KEEPALIVE_MAX_BYTES) } })); // snapshot > budget
    f.addEvent(ev(3, 3, {}));

    expect(f.flushTail('pagehide')).toBe(false);
    // Never beacons a snapshot-less first chunk, never falls to async.
    expect(submitBatch).not.toHaveBeenCalled();
    // The batch (incl. the snapshot) is retained in memory, not lost.
    expect(hasFullSnapshot(f._pending)).toBe(true);
  });

  // Regression: a *persisted* pagehide (bfcache) can resume, so it is forwarded
  // as { terminal: false }. An uncreated capture must then take the confirmed
  // async path — not an optimistic beacon-create that would strand the capture
  // if the bfcache page resumes and the beacon was never accepted server-side.
  it('uses the confirmed path for a persisted (bfcache) pagehide', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    const submitBatch = vi.fn().mockResolvedValue({ created: true });
    const f = new ContinuousReplayFlusher({ replayId: 'rbf', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));

    expect(f.flushTail('pagehide', { terminal: false })).toBe(false);
    expect(beacon).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(submitBatch).toHaveBeenCalledTimes(1);
    expect(hasFullSnapshot(submitBatch.mock.calls[0][0].events)).toBe(true);
    expect(f._created).toBe(true);
  });

  // Regression: a non-terminal flush of an ALREADY-CREATED capture must not
  // beacon-and-drain either. The beacon only confirms enqueue; if it is dropped
  // while the tab merely backgrounds and later resumes, those drained incremental
  // events are lost for nothing. Non-terminal → confirmed async path.
  it('does not optimistically drain a created capture on a non-terminal flush', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    const submitBatch = vi.fn().mockResolvedValue({ created: true });
    const f = new ContinuousReplayFlusher({ replayId: 'rcnt', submitBatch, beacon });

    // Create the replay first.
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    await f.flush('interval');
    expect(f._created).toBe(true);
    submitBatch.mockClear();

    // Incremental tail + a non-terminal visibilitychange (tab backgrounded).
    f.addEvent(cincr(3));
    f.addEvent(cincr(4));
    expect(f.flushTail('visibilitychange', { terminal: false })).toBe(false);
    // Must NOT beacon (enqueue-only) the incremental tail on a live page.
    expect(beacon).not.toHaveBeenCalled();

    // The confirmed async path delivers them instead.
    await new Promise((r) => setTimeout(r, 0));
    expect(submitBatch).toHaveBeenCalledTimes(1);
    expect(submitBatch.mock.calls[0][0].events.map((e: any) => e.timestamp)).toEqual([3, 4]);
  });

  // And when that confirmed flush fails, the created tail is RETAINED (re-queued)
  // for the next attempt rather than lost — the whole point of avoiding the
  // enqueue-only beacon while the page is alive.
  it('retains a created tail when a non-terminal confirmed flush fails', async () => {
    const submitBatch = vi
      .fn()
      .mockResolvedValueOnce({ created: true }) // creating chunk
      .mockRejectedValueOnce(new Error('dropped')) // the non-terminal tail flush
      .mockResolvedValueOnce({ created: false }); // retry
    const beacon = vi.fn().mockReturnValue(true);
    const f = new ContinuousReplayFlusher({ replayId: 'rcnt2', submitBatch, beacon });
    f.addEvent(cmeta(1));
    f.addEvent(csnap(2));
    await f.flush('interval');

    f.addEvent(cincr(3));
    expect(f.flushTail('visibilitychange', { terminal: false })).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    // Delivery failed → the event is retained, not lost.
    expect(f._pending.map((e: any) => e.timestamp)).toEqual([3]);

    // A later flush recovers it.
    await f.flush('interval');
    expect(submitBatch.mock.calls[2][0].events.map((e: any) => e.timestamp)).toEqual([3]);
    expect(f._pending.length).toBe(0);
  });
});

describe('continuous capture wiring (opted-out no-op)', () => {
  beforeEach(() => _resetSessionReplayForTest());
  afterEach(() => _resetSessionReplayForTest());

  it('starts NO continuous flusher when the project has not opted in', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: false });
    await setSessionReplayEnabled(true);
    const { getContinuousFlusher } = await import('./sessionReplay');
    expect(getContinuousFlusher()).toBeNull();
  });

  it('starts a continuous flusher when the project opts in', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, flushIntervalMs: 120_000 });
    await setSessionReplayEnabled(true);
    const { getContinuousFlusher } = await import('./sessionReplay');
    const flusher = getContinuousFlusher();
    expect(flusher).not.toBeNull();
    expect(flusher.active).toBe(true);
    expect(flusher.flushIntervalMs).toBe(120_000);
    // Disabling tears it down.
    await setSessionReplayEnabled(false);
    expect(getContinuousFlusher()).toBeNull();
  });

  // Regression for the listener wiring: the pagehide handler must read
  // event.persisted and forward terminality accordingly (persisted = bfcache =
  // non-terminal), rather than always treating pagehide as terminal.
  it('forwards pagehide terminality from event.persisted', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true });
    await setSessionReplayEnabled(true);
    const { getContinuousFlusher } = await import('./sessionReplay');
    const flusher = getContinuousFlusher();
    expect(flusher).not.toBeNull();
    const spy = vi.spyOn(flusher, 'flushTail');

    const persisted: any = new Event('pagehide');
    persisted.persisted = true;
    window.dispatchEvent(persisted);
    expect(spy).toHaveBeenCalledWith('pagehide', { terminal: false });

    spy.mockClear();
    const discarded: any = new Event('pagehide');
    discarded.persisted = false;
    window.dispatchEvent(discarded);
    expect(spy).toHaveBeenCalledWith('pagehide', { terminal: true });
  });

  // Regression: a runtime disable happens while the page is ALIVE, so the final
  // buffered batch must be flushed with confirmation — not left to a
  // fire-and-forget async flush that the immediate teardown would orphan.
  // setSessionReplayEnabled(false) must AWAIT the flush before resolving.
  it('awaits the final confirmed flush before tearing down on disable', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true });
    await setSessionReplayEnabled(true);
    const mod = await import('./sessionReplay');
    const flusher = mod.getContinuousFlusher();
    expect(flusher).not.toBeNull();

    let resolveSubmit: any;
    const submit = new Promise((r) => {
      resolveSubmit = r;
    });
    const submitBatch = vi.fn().mockReturnValue(submit.then(() => ({ created: true })));
    flusher._submitBatch = submitBatch;
    // Buffer a creating chunk (as if the recorder had emitted it).
    flusher.addEvent(meta(1));
    flusher.addEvent(snap(2));

    let resolved = false;
    const disabling = mod.setSessionReplayEnabled(false).then(() => {
      resolved = true;
    });
    await Promise.resolve();

    // The final flush is in flight and disable has NOT resolved yet.
    expect(submitBatch).toHaveBeenCalledTimes(1);
    expect(hasFullSnapshot(submitBatch.mock.calls[0][0].events)).toBe(true);
    expect(resolved).toBe(false);

    resolveSubmit();
    await disabling;
    expect(resolved).toBe(true);
    expect(mod.getContinuousFlusher()).toBeNull();
  });
});

describe('segmentBatchEndpoint', () => {
  it('builds the session/view/index append URL and encodes components', () => {
    expect(segmentBatchEndpoint('s1', 'v1', 0, '/api/replays')).toBe(
      '/api/replays/sessions/s1/views/v1/segments/0',
    );
    // index is floored to a non-negative integer.
    expect(segmentBatchEndpoint('s', 'v', 3.9, '/api/replays')).toBe(
      '/api/replays/sessions/s/views/v/segments/3',
    );
    expect(segmentBatchEndpoint('s', 'v', -5, '/api/replays')).toBe(
      '/api/replays/sessions/s/views/v/segments/0',
    );
    // id components are URL-encoded.
    expect(segmentBatchEndpoint('a/b', 'v 1', 0, '/api/replays')).toBe(
      '/api/replays/sessions/a%2Fb/views/v%201/segments/0',
    );
  });
});

describe('submitReplaySegment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs the segment to the session/view/index endpoint and returns the parsed body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ segmentId: 'seg1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await submitReplaySegment(
      { sessionId: 's1', viewId: 'v1', indexInView: 0, events: [snap(1)] },
      { endpointBase: '/api/replays' },
    );
    expect(out.segmentId).toBe('seg1');
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe('/api/replays/sessions/s1/views/v1/segments/0');
    expect(init.method).toBe('POST');
    expect(init.headers['X-RUM-Token']).toBeUndefined();
  });

  it('attaches X-RUM-Token when a token is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await submitReplaySegment(
      { sessionId: 's1', viewId: 'v1', indexInView: 1, events: [incr(2)] },
      { endpointBase: '/api/replays', rumToken: 'rum_seg' },
    );
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe('/api/replays/sessions/s1/views/v1/segments/1');
    expect(init.headers['X-RUM-Token']).toBe('rum_seg');
  });

  it('throws on missing ids / empty events, and on a non-2xx response', async () => {
    await expect(
      submitReplaySegment({ viewId: 'v', indexInView: 0, events: [snap(1)] }),
    ).rejects.toThrow(/sessionId/);
    await expect(
      submitReplaySegment({ sessionId: 's', indexInView: 0, events: [snap(1)] }),
    ).rejects.toThrow(/viewId/);
    await expect(
      submitReplaySegment({ sessionId: 's', viewId: 'v', indexInView: 0, events: [] }),
    ).rejects.toThrow(/No replay events/);

    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      submitReplaySegment({ sessionId: 's', viewId: 'v', indexInView: 0, events: [snap(1)] }),
    ).rejects.toThrow(/nope/);
  });
});

describe('SegmentReplayFlusher', () => {
  const smeta = (ts: any) => meta(ts);
  const ssnap = (ts: any) => snap(ts);
  const sincr = (ts: any) => incr(ts);

  it('requires a sessionId and a viewId', () => {
    expect(() => new SegmentReplayFlusher({ viewId: 'v' } as any)).toThrow(/sessionId/);
    expect(() => new SegmentReplayFlusher({ sessionId: 's' } as any)).toThrow(/viewId/);
  });

  it('exposes the default Datadog segment constants', () => {
    expect(SEGMENT_MAX_DURATION_MS).toBe(5_000);
    expect(SEGMENT_MAX_RAW_BYTES).toBeGreaterThan(0);
  });

  it('rolls over on the ~5s duration bound', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(smeta(0));
    f.addEvent(ssnap(0)); // view-opening segment now holds a snapshot
    f.addEvent(sincr(100));
    expect(submitSegment).not.toHaveBeenCalled(); // still within the window

    t = 5_001; // cross the ~5s bound
    f.addEvent(sincr(5_001));
    await f.settle();

    expect(submitSegment).toHaveBeenCalledTimes(1);
    const [arg, opts] = submitSegment.mock.calls[0];
    expect(arg.sessionId).toBe('s1');
    expect(arg.viewId).toBe('v1');
    expect(arg.indexInView).toBe(0);
    expect(hasFullSnapshot(arg.events)).toBe(true);
    expect(opts.endpointBase).toBe(REPLAY_INGEST_ENDPOINT);
    // After a confirmed view-opening flush the next segment is index 1.
    expect(f.indexInView).toBe(1);
  });

  it('rolls over on the ~60KB byte bound', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => 0, // freeze time so only the byte bound can fire
      maxBytes: 200,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    // Pad an incremental past the tiny byte budget.
    f.addEvent(ev(3, 1, { blob: 'x'.repeat(500) }));
    await f.settle();

    expect(submitSegment).toHaveBeenCalledTimes(1);
    expect(submitSegment.mock.calls[0][0].indexInView).toBe(0);
    expect(hasFullSnapshot(submitSegment.mock.calls[0][0].events)).toBe(true);
  });

  it('does not roll over a view-opening segment that has no snapshot yet', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    // Only incrementals; the ~5s bound is crossed but no snapshot is present.
    f.addEvent(sincr(0));
    t = 10_000;
    f.addEvent(sincr(10_000));
    await f.settle();
    expect(submitSegment).not.toHaveBeenCalled();
    // An explicit flush is likewise a no-op without a snapshot.
    expect(await f.flush('manual')).toBeNull();
    expect(submitSegment).not.toHaveBeenCalled();
  });

  it('flushes on view change: the new view opens at index 0 with a fresh snapshot', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let f!: SegmentReplayFlusher;
    // requestSnapshot mimics rrweb emitting a fresh checkout into the flusher.
    const requestSnapshot = vi.fn(() => f.addEvent(ssnap(1_000)));
    f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => 0,
      setIntervalFn: null,
      requestSnapshot,
    });

    // View v1: snapshot + an incremental (well within the window).
    f.addEvent(ssnap(0));
    f.addEvent(sincr(10));

    // Route change → new view v2.
    await f.notifyViewChange('v2');

    // The outgoing view v1 was flushed as its index-0 opening segment.
    expect(submitSegment).toHaveBeenCalledTimes(1);
    const first = submitSegment.mock.calls[0][0];
    expect(first.viewId).toBe('v1');
    expect(first.indexInView).toBe(0);
    expect(hasFullSnapshot(first.events)).toBe(true);

    // The flusher is now on view v2, index 0, and requested a fresh snapshot.
    expect(f.viewId).toBe('v2');
    expect(f.indexInView).toBe(0);
    expect(requestSnapshot).toHaveBeenCalledWith('v2');

    // Flushing v2 sends its own snapshot-carrying opening segment.
    f.addEvent(sincr(1_010));
    await f.flush('manual');
    expect(submitSegment).toHaveBeenCalledTimes(2);
    const second = submitSegment.mock.calls[1][0];
    expect(second.viewId).toBe('v2');
    expect(second.indexInView).toBe(0);
    expect(hasFullSnapshot(second.events)).toBe(true);
  });

  it('appends incremental segments within a view without a snapshot after index 0', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000)); // rollover → index 0 flushed
    await f.settle();
    expect(f.indexInView).toBe(1);

    // Next window: incrementals only → index 1 append, no snapshot.
    f.addEvent(sincr(6_500));
    t = 12_000;
    f.addEvent(sincr(12_000));
    await f.settle();

    expect(submitSegment).toHaveBeenCalledTimes(2);
    const second = submitSegment.mock.calls[1][0];
    expect(second.indexInView).toBe(1);
    expect(hasFullSnapshot(second.events)).toBe(false);
    expect(second.meta).toBeNull(); // meta rides only the view-opening segment
    expect(f.indexInView).toBe(2);
  });

  it('beacons the current segment on a terminal page-exit (unload tail)', () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    const beacon = vi.fn().mockReturnValue(true);
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      beacon,
      endpointBase: '/api/replays',
      rumToken: 'rum_tail',
      now: () => 0,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    f.addEvent(sincr(10));

    const queued = f.flushTail('pagehide');
    expect(queued).toBe(true);
    // Beacon transport (not the async submit) carried the tail.
    expect(submitSegment).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body, token] = beacon.mock.calls[0];
    expect(url).toBe('/api/replays/sessions/s1/views/v1/segments/0');
    expect(token).toBe('rum_tail');
    const parsed = JSON.parse(body);
    expect(hasFullSnapshot(parsed.events)).toBe(true);
    // Terminal beacon advanced the index off the unconfirmed enqueue.
    expect(f.indexInView).toBe(1);
  });

  it('takes the confirmed async path on a NON-terminal page-exit (no optimistic beacon)', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    const beacon = vi.fn().mockReturnValue(true);
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      beacon,
      now: () => 0,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    f.addEvent(sincr(10));

    const queued = f.flushTail('visibilitychange', { terminal: false });
    expect(queued).toBe(false);
    await f.settle();
    // Drained via the confirmed transport, never beaconed.
    await Promise.resolve();
    expect(beacon).not.toHaveBeenCalled();
    expect(submitSegment).toHaveBeenCalledTimes(1);
    expect(submitSegment.mock.calls[0][0].indexInView).toBe(0);
  });

  it('does not terminally beacon a snapshot-less view-opening segment', () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    const beacon = vi.fn().mockReturnValue(true);
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      beacon,
      now: () => 0,
      setIntervalFn: null,
    });
    f.addEvent(sincr(10)); // no snapshot on the opening segment
    const queued = f.flushTail('pagehide');
    expect(queued).toBe(false);
    expect(beacon).not.toHaveBeenCalled();
  });

  it('threads the RUM token into the async segment upload', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      rumToken: 'rum_tok',
      now: () => 0,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    f.addEvent(sincr(10));
    await f.flush('manual');
    expect(submitSegment.mock.calls[0][1].rumToken).toBe('rum_tok');
  });

  it('re-queues an incremental segment whose upload failed (order preserved)', async () => {
    const submitSegment = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // index 0 succeeds
      .mockRejectedValueOnce(new Error('network')) // index 1 fails
      .mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle(); // index 0 flushed OK
    expect(f.indexInView).toBe(1);

    f.addEvent(sincr(6_100));
    await f.flush('manual'); // index 1 fails → re-queued, index NOT advanced
    expect(f.indexInView).toBe(1);

    f.addEvent(sincr(6_200));
    await f.flush('manual'); // retry index 1 with both events, in order
    const retry = submitSegment.mock.calls[submitSegment.mock.calls.length - 1][0];
    expect(retry.indexInView).toBe(1);
    expect(retry.events.map((e: any) => e.timestamp)).toEqual([6_100, 6_200]);
    expect(f.indexInView).toBe(2);
  });

  it('the idle timer flushes a segment that crossed the duration bound with no new events', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const state: Record<string, any> = { cb: null, ms: null, cleared: false };
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      idleCheckMs: 1_000,
      setIntervalFn: (cb: any, ms: any) => {
        state.cb = cb;
        state.ms = ms;
        return 7;
      },
      clearIntervalFn: () => {
        state.cleared = true;
      },
    });
    f.start();
    expect(state.ms).toBe(1_000);
    f.addEvent(ssnap(0));
    f.addEvent(sincr(10));
    // No further events; time passes past the ~5s bound and the idle tick fires.
    t = 6_000;
    await state.cb();
    await f.settle();
    expect(submitSegment).toHaveBeenCalledTimes(1);
    f.stop();
    expect(state.cleared).toBe(true);
  });

  // rrweb-shaped click on a target node id, and a DOM mutation.
  const sclick = (ts: any, id: any) => ev(3, ts, { source: 2, type: 2, id });
  const smut = (ts: any) => ev(3, ts, { source: 0, adds: [] });

  it('stamps action + frustration counts into the flushed segment meta', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    // Four clicks on the SAME element within 1s → one rage burst; no mutation
    // follows so each also matures as a dead click.
    f.addEvent(sclick(0, 42));
    f.addEvent(sclick(100, 42));
    f.addEvent(sclick(200, 42));
    f.addEvent(sclick(300, 42));
    // Advance well past the ~5s bound AND the dead-click maturity window.
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle();

    expect(submitSegment).toHaveBeenCalledTimes(1);
    const meta0 = submitSegment.mock.calls[0][0].meta;
    expect(meta0.actionCount).toBe(4);
    // 1 rage burst + 4 dead clicks.
    expect(meta0.frustrationByType).toEqual({ rage: 1, dead: 4, error: 0 });
    expect(meta0.frustrationCount).toBe(5);
  });

  it('classifies a click followed by a JS error as an error click via notifyError', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    f.addEvent(sclick(0, 7));
    f.addEvent(smut(10)); // DOM changed → not a dead click
    f.notifyError(50); // JS error right after → error click
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle();

    const meta0 = submitSegment.mock.calls[0][0].meta;
    expect(meta0.frustrationByType).toEqual({ rage: 0, dead: 0, error: 1 });
    expect(meta0.actionCount).toBe(1);
  });

  it('omits count fields from a click-free segment (meta shape unchanged)', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    f.addEvent(sincr(100));
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle();

    const meta0 = submitSegment.mock.calls[0][0].meta;
    expect(meta0).not.toHaveProperty('actionCount');
    expect(meta0).not.toHaveProperty('frustrationCount');
    expect(meta0).toMatchObject({ trigger: 'continuous', storage: 'segmented' });
  });

  it('force-finalizes a pending dead click into the tail on view change', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      requestSnapshot: () => {},
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    // A click that has NOT yet matured (well within the dead-click window)...
    f.addEvent(sclick(10, 9));
    t = 100;
    // ...view change closes the view: the pending click force-finalizes as dead
    // and rides the outgoing view's tail segment meta.
    await f.notifyViewChange('v2');
    const lastCall = submitSegment.mock.calls[submitSegment.mock.calls.length - 1][0];
    expect(lastCall.viewId).toBe('v1');
    expect(lastCall.meta.frustrationByType).toEqual({ rage: 0, dead: 1, error: 0 });
  });

  it('re-sends the same frustration counts when a segment submit fails and retries', async () => {
    // The counts are drained only AFTER a confirmed submit, so a failed segment
    // that is retried must carry the same action/frustration counts, not zeros.
    const submitSegment = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // index 0 (creating) succeeds
      .mockRejectedValueOnce(new Error('network')) // index 1 fails
      .mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    // Opening segment flushes clean at index 0 (no clicks yet).
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle();
    expect(f.indexInView).toBe(1);
    const creatingCall = submitSegment.mock.calls[0][0];
    expect(creatingCall.meta).not.toHaveProperty('frustrationCount');

    // Now an incremental segment carrying a rage burst of 4 same-element clicks
    // (> the threshold of 3; all matured well before flush time), whose FIRST
    // submit fails.
    for (let i = 0; i < 4; i++) f.addEvent(sclick(6_010 + i * 10, 42));
    t = 12_000;
    await f.flush('manual'); // index 1 fails → re-queued, counts NOT committed
    expect(f.indexInView).toBe(1);
    const failedCall = submitSegment.mock.calls[1][0];
    expect(failedCall.meta.frustrationByType).toEqual({ rage: 1, dead: 4, error: 0 });

    // Retry: the same counts must still be present (not zeroed by the failed drain).
    await f.flush('manual');
    const retryCall = submitSegment.mock.calls[submitSegment.mock.calls.length - 1][0];
    expect(retryCall.indexInView).toBe(1);
    expect(retryCall.meta.actionCount).toBe(4);
    expect(retryCall.meta.frustrationByType).toEqual({ rage: 1, dead: 4, error: 0 });
    expect(retryCall.meta.frustrationCount).toBe(5);
    expect(f.indexInView).toBe(2);
  });

  it('does NOT force a sub-window click to dead on a resumable visibilitychange', async () => {
    // pagehide/visibilitychange are resumable (bfcache/tab return), so a click
    // whose DOM-mutation window has not yet elapsed must be left PENDING, not
    // mis-flagged as a dead click — otherwise clicking then backgrounding the
    // tab would systematically inflate dead_click.
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle(); // opening segment (index 0) flushed clean
    submitSegment.mockClear();

    // A click only 40ms before a NON-terminal visibilitychange tail flush.
    f.addEvent(sclick(6_010, 42));
    t = 6_050;
    f.flushTail('visibilitychange', { terminal: false });
    await f.settle();

    // The click is counted as an action, but NOT force-finalized as dead — it is
    // still pending, free to mature (or be cancelled by a mutation) on resume.
    const meta = submitSegment.mock.calls[submitSegment.mock.calls.length - 1][0].meta;
    expect(meta.actionCount).toBe(1);
    expect(meta.frustrationByType).toEqual({ rage: 0, dead: 0, error: 0 });
    expect(meta.frustrationCount).toBe(0);

    // Later, past the dead-click window with still no mutation, it matures dead.
    t = 6_010 + 5_000;
    f.addEvent(sincr(t));
    await f.flush('manual');
    const laterMeta = submitSegment.mock.calls[submitSegment.mock.calls.length - 1][0].meta;
    expect(laterMeta.frustrationByType).toEqual({ rage: 0, dead: 1, error: 0 });
  });

  it('does not drop a click that lands DURING an in-flight submit (peek/commit race)', async () => {
    // The regression: matureAndPeek snapshots counts BEFORE await submitSegment,
    // but events keep arriving on the emit callback while the promise is pending.
    // Commit must subtract only the peeked snapshot, not zero live state, or the
    // mid-flight click is silently dropped. A truly async submit is required —
    // synchronous mocks never interleave the await.
    let f!: SegmentReplayFlusher;
    let injected = false;
    const submitSegment = vi.fn().mockImplementation(async (payload: any) => {
      // On the incremental (index 1) submit, simulate a fresh click landing on
      // the rrweb emit callback WHILE this submit is in flight.
      if (payload.indexInView === 1 && !injected) {
        injected = true;
        f.addEvent(sclick(12_010, 99));
      }
      return { ok: true };
    });
    let t = 0;
    f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle(); // opening segment (index 0) flushed
    expect(f.indexInView).toBe(1);

    // Incremental segment carrying one dead click, matured by t=12000.
    f.addEvent(sclick(6_010, 42));
    t = 12_000;
    await f.flush('manual'); // peeks {action:1,dead:1}; the 99 click lands mid-submit
    expect(f.indexInView).toBe(2);

    // The mid-flight click survived the commit (subtract-snapshot, not zero) and
    // is carried into the NEXT segment once it matures.
    t = 18_000;
    await f.flush('manual');
    const lastMeta = submitSegment.mock.calls[submitSegment.mock.calls.length - 1][0].meta;
    expect(lastMeta.actionCount).toBe(1);
    expect(lastMeta.frustrationByType).toEqual({ rage: 0, dead: 1, error: 0 });
  });
});

describe('setUser / setUserProperty / clearUser', () => {
  afterEach(() => clearUser());

  it('starts with no active identity', () => {
    expect(getActiveUser()).toBeNull();
  });

  it('setUser stores standard fields and custom attributes together', () => {
    setUser({ id: 'u1', name: 'Ada', email: 'ada@example.com', plan: 'pro' });
    expect(getActiveUser()).toEqual({
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      plan: 'pro',
    });
  });

  it('setUser drops null/undefined values and clears on an empty identity', () => {
    setUser({ id: 'u1', name: null, email: undefined });
    expect(getActiveUser()).toEqual({ id: 'u1' });
    setUser({ id: null });
    expect(getActiveUser()).toBeNull();
    setUser('nope');
    expect(getActiveUser()).toBeNull();
  });

  it('setUser replaces the prior identity wholesale', () => {
    setUser({ id: 'u1', plan: 'pro' });
    setUser({ id: 'u2' });
    expect(getActiveUser()).toEqual({ id: 'u2' });
  });

  it('setUserProperty adds/updates a single key while keeping the rest', () => {
    setUser({ id: 'u1' });
    setUserProperty('plan', 'pro');
    expect(getActiveUser()).toEqual({ id: 'u1', plan: 'pro' });
    setUserProperty('plan', 'enterprise');
    expect(getActiveUser()).toEqual({ id: 'u1', plan: 'enterprise' });
  });

  it('setUserProperty with a null value removes that key; removing the last clears', () => {
    setUser({ id: 'u1', plan: 'pro' });
    setUserProperty('plan', null);
    expect(getActiveUser()).toEqual({ id: 'u1' });
    setUserProperty('id', undefined);
    expect(getActiveUser()).toBeNull();
    setUserProperty('', 'x'); // empty key is a no-op
    expect(getActiveUser()).toBeNull();
  });

  it('getActiveUser returns a copy that cannot mutate the live identity', () => {
    setUser({ id: 'u1' });
    const snapshot = getActiveUser()!;
    snapshot.id = 'tampered';
    expect(getActiveUser()).toEqual({ id: 'u1' });
  });

  it('clearUser drops attribution', () => {
    setUser({ id: 'u1' });
    clearUser();
    expect(getActiveUser()).toBeNull();
  });
});

describe('SegmentReplayFlusher — forward-only user attribution', () => {
  const ssnap = (ts: any) => snap(ts);
  const sincr = (ts: any) => incr(ts);
  afterEach(() => clearUser());

  it('stamps usr onto the view-opening segment alongside the segment meta', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    setUser({ id: 'u1', email: 'ada@example.com' });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000)); // rollover → index 0 flushed
    await f.settle();

    const meta0 = submitSegment.mock.calls[0][0].meta;
    expect(meta0.storage).toBe('segmented');
    expect(meta0.usr).toEqual({ id: 'u1', email: 'ada@example.com' });
  });

  it('stamps usr onto incremental (index > 0) segments too', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    setUser({ id: 'u1' });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000)); // index 0
    await f.settle();
    f.addEvent(sincr(6_500));
    t = 12_000;
    f.addEvent(sincr(12_000)); // index 1
    await f.settle();

    const meta1 = submitSegment.mock.calls[1][0].meta;
    expect(submitSegment.mock.calls[1][0].indexInView).toBe(1);
    expect(meta1).toEqual({ usr: { id: 'u1' } });
  });

  it('is forward-only: a segment emitted before setUser carries no usr; the next one does', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    // Index 0 flushes while anonymous.
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle();
    expect(submitSegment.mock.calls[0][0].meta.usr).toBeUndefined();

    // Identify mid-session; the NEXT segment picks it up (no backfill of index 0).
    setUser({ id: 'u1' });
    f.addEvent(sincr(6_500));
    t = 12_000;
    f.addEvent(sincr(12_000));
    await f.settle();
    expect(submitSegment.mock.calls[1][0].meta).toEqual({ usr: { id: 'u1' } });
  });

  it('clearUser stops attribution on later segments', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    setUser({ id: 'u1' });
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      now: () => t,
      setIntervalFn: null,
    });
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000)); // index 0 with usr
    await f.settle();
    expect(submitSegment.mock.calls[0][0].meta.usr).toEqual({ id: 'u1' });

    clearUser();
    f.addEvent(sincr(6_500));
    t = 12_000;
    f.addEvent(sincr(12_000)); // index 1, now anonymous
    await f.settle();
    expect(submitSegment.mock.calls[1][0].meta).toBeNull();
  });

  it('reads identity from an injected resolveUser at flush time', async () => {
    const submitSegment = vi.fn().mockResolvedValue({ ok: true });
    let current: any = null;
    let t = 0;
    const f = new SegmentReplayFlusher({
      sessionId: 's1',
      viewId: 'v1',
      submitSegment,
      resolveUser: () => current,
      now: () => t,
      setIntervalFn: null,
    });
    current = { id: 'injected' };
    f.addEvent(ssnap(0));
    t = 6_000;
    f.addEvent(sincr(6_000));
    await f.settle();
    expect(submitSegment.mock.calls[0][0].meta.usr).toEqual({ id: 'injected' });
  });
});

describe('generateRumId', () => {
  it('matches the server id charset and is reasonably unique', () => {
    const idRe = /^[A-Za-z0-9._-]{8,200}$/;
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = generateRumId();
      expect(id).toMatch(idRe);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it('falls back to a valid id when crypto.randomUUID is unavailable', () => {
    // `crypto` is a getter-only global in jsdom — stub it to force the fallback.
    vi.stubGlobal('crypto', undefined);
    try {
      const id = generateRumId();
      expect(id).toMatch(/^[A-Za-z0-9._-]{8,200}$/);
      expect(id.startsWith('rum-')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('RumSessionManager', () => {
  // Deterministic id minter — sequential so distinctness is observable.
  const counterIds = () => {
    let n = 0;
    return () => `id-${++n}`;
  };

  it('mints a session.id and view.id on first activity', () => {
    let t = 1_000;
    const m = new RumSessionManager({ now: () => t, generateId: counterIds() });
    expect(m.sessionId).toBeNull();
    expect(m.viewId).toBeNull();

    const ctx = m.notifyActivity();
    expect(ctx.sessionId).toBe('id-1');
    expect(ctx.viewId).toBe('id-2');
    expect(ctx.sessionChanged).toBe(true);
    expect(ctx.viewChanged).toBe(true);
    // The session and view differ.
    expect(ctx.sessionId).not.toBe(ctx.viewId);
    expect(m.sessionId).toBe('id-1');
    expect(m.viewId).toBe('id-2');
  });

  it('keeps the same session while activity stays inside the inactivity window', () => {
    let t = 0;
    const m = new RumSessionManager({ now: () => t, generateId: counterIds() });
    const first = m.notifyActivity();

    // Advance just under the timeout, repeatedly — the session must persist.
    t += SESSION_INACTIVITY_TIMEOUT_MS - 1;
    const again = m.notifyActivity();
    expect(again.sessionChanged).toBe(false);
    expect(again.viewChanged).toBe(false);
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.viewId).toBe(first.viewId);

    // Each activity refreshes the clock, so another sub-timeout gap still holds.
    t += SESSION_INACTIVITY_TIMEOUT_MS - 1;
    const third = m.notifyActivity();
    expect(third.sessionChanged).toBe(false);
    expect(third.sessionId).toBe(first.sessionId);
  });

  it('rolls over to a fresh session.id after 15-min inactivity', () => {
    let t = 0;
    const m = new RumSessionManager({ now: () => t, generateId: counterIds() });
    const first = m.notifyActivity();
    expect(first.sessionId).toBe('id-1');

    // Cross the inactivity timeout with no activity → next activity mints fresh.
    t += SESSION_INACTIVITY_TIMEOUT_MS;
    const rolled = m.notifyActivity();
    expect(rolled.sessionChanged).toBe(true);
    expect(rolled.viewChanged).toBe(true);
    expect(rolled.sessionId).not.toBe(first.sessionId);
    expect(rolled.sessionId).toBe('id-3');
    expect(rolled.viewId).toBe('id-4');
  });

  it('rolls over to a fresh session.id after 4h continuous duration, even while active', () => {
    let t = 0;
    const m = new RumSessionManager({ now: () => t, generateId: counterIds() });
    const first = m.notifyActivity();

    // Stay continuously active (refresh well inside the inactivity window) right
    // up to the 4h cap — the max-duration bound must still end the session.
    const step = SESSION_INACTIVITY_TIMEOUT_MS - 1;
    let last = first;
    while (t < SESSION_MAX_DURATION_MS) {
      t += step;
      last = m.notifyActivity();
    }
    // The step that crossed the 4h cap minted a fresh session.
    expect(last.sessionChanged).toBe(true);
    expect(last.sessionId).not.toBe(first.sessionId);
  });

  it('mints a new view.id on navigation under the same session', () => {
    let t = 0;
    const m = new RumSessionManager({ now: () => t, generateId: counterIds() });
    const first = m.notifyActivity();

    t += 100;
    const nav = m.notifyViewChange();
    expect(nav.sessionChanged).toBe(false);
    expect(nav.viewChanged).toBe(true);
    expect(nav.sessionId).toBe(first.sessionId); // same session
    expect(nav.viewId).not.toBe(first.viewId); // new view
    expect(m.viewId).toBe(nav.viewId);

    // A second navigation mints yet another view under the same session.
    t += 100;
    const nav2 = m.notifyViewChange();
    expect(nav2.sessionId).toBe(first.sessionId);
    expect(nav2.viewId).not.toBe(nav.viewId);
  });

  it('navigation after expiry rolls the session and does not double-mint the view', () => {
    let t = 0;
    const gen = counterIds();
    const m = new RumSessionManager({ now: () => t, generateId: gen });
    const first = m.notifyActivity(); // id-1 session, id-2 view

    t += SESSION_INACTIVITY_TIMEOUT_MS; // expire
    const nav = m.notifyViewChange();
    expect(nav.sessionChanged).toBe(true);
    expect(nav.viewChanged).toBe(true);
    expect(nav.sessionId).not.toBe(first.sessionId);
    // Fresh session's opening view (id-4), NOT an extra minted view — exactly two
    // ids consumed by the rollover (session + opening view).
    expect(nav.sessionId).toBe('id-3');
    expect(nav.viewId).toBe('id-4');
  });

  it('peek() reports current ids without registering activity or rolling over', () => {
    let t = 0;
    const m = new RumSessionManager({ now: () => t, generateId: counterIds() });
    expect(m.peek()).toEqual({ sessionId: null, viewId: null });
    m.notifyActivity();

    // Advance past the timeout, but peek() must NOT roll the session.
    t += SESSION_INACTIVITY_TIMEOUT_MS * 2;
    const peeked = m.peek();
    expect(peeked.sessionId).toBe('id-1');
    expect(peeked.viewId).toBe('id-2');
  });

  it('reset() returns to the unstarted state', () => {
    const m = new RumSessionManager({ generateId: counterIds() });
    m.notifyActivity();
    expect(m.sessionId).not.toBeNull();
    m.reset();
    expect(m.sessionId).toBeNull();
    expect(m.viewId).toBeNull();
  });

  it('uses the Datadog default constants when none are injected', () => {
    expect(SESSION_INACTIVITY_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(SESSION_MAX_DURATION_MS).toBe(4 * 60 * 60 * 1000);
    const m = new RumSessionManager({});
    expect(m.inactivityTimeoutMs).toBe(SESSION_INACTIVITY_TIMEOUT_MS);
    expect(m.maxDurationMs).toBe(SESSION_MAX_DURATION_MS);
  });
});

describe('installViewChangeDetector', () => {
  const path = () => window.location.pathname + window.location.search + window.location.hash;

  afterEach(() => {
    // Return to a known route so cross-test URL state can't leak.
    window.history.replaceState(null, '', '/');
  });

  it('fires on pushState and replaceState when the URL changes', () => {
    window.history.replaceState(null, '', '/start');
    const seen: string[] = [];
    const uninstall = installViewChangeDetector((url: string) => seen.push(url));
    try {
      window.history.pushState(null, '', '/a');
      window.history.replaceState(null, '', '/b');
      window.history.pushState(null, '', '/c?q=1');
      expect(seen).toHaveLength(3);
      expect(seen[0]).toMatch(/\/a$/);
      expect(seen[1]).toMatch(/\/b$/);
      expect(seen[2]).toMatch(/\/c\?q=1$/);
    } finally {
      uninstall();
    }
  });

  it('fires exactly once on a popstate whose URL differs from the last-seen route', () => {
    window.history.replaceState(null, '', '/base');
    const seen: string[] = [];
    const uninstall = installViewChangeDetector((url: string) => seen.push(url));
    try {
      // A popstate at the SAME url as install → deduped, no fire.
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(seen).toHaveLength(0);

      // Simulate a browser back/forward: the URL diverges out-of-band (the
      // patched history methods are NOT involved), then exactly one popstate is
      // dispatched. Setting location.hash updates href synchronously; whether
      // jsdom's own hashchange fires sync or async, the URL-change dedup means
      // exactly one callback lands — no dependence on event ordering.
      window.location.hash = '#section';
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('#section');
    } finally {
      uninstall();
    }
  });

  it('ignores a history write that does not change the URL', () => {
    window.history.replaceState(null, '', '/same');
    const seen: string[] = [];
    const uninstall = installViewChangeDetector((url: string) => seen.push(url));
    try {
      // Same URL, different state object — must NOT count as a navigation.
      window.history.replaceState({ x: 1 }, '', '/same');
      expect(seen).toHaveLength(0);
      window.history.pushState(null, '', '/next');
      expect(seen).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  it('restores patched history methods and stops firing after uninstall', () => {
    const beforePush = window.history.pushState;
    const beforeReplace = window.history.replaceState;
    const seen: string[] = [];
    const uninstall = installViewChangeDetector((url: string) => seen.push(url));
    expect(window.history.pushState).not.toBe(beforePush);
    uninstall();
    expect(window.history.pushState).toBe(beforePush);
    expect(window.history.replaceState).toBe(beforeReplace);

    // No more callbacks after uninstall.
    window.history.pushState(null, '', '/after');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(seen).toHaveLength(0);
  });

  it('never lets a throwing consumer break navigation', () => {
    const uninstall = installViewChangeDetector(() => {
      throw new Error('boom');
    });
    try {
      expect(() => window.history.pushState(null, '', '/throws')).not.toThrow();
      expect(path()).toContain('/throws');
    } finally {
      uninstall();
    }
  });

  it('returns a noop uninstall and does not throw when history is unavailable', () => {
    const orig = window.history;
    try {
      Object.defineProperty(window, 'history', { value: undefined, configurable: true });
      const uninstall = installViewChangeDetector(() => {});
      expect(typeof uninstall).toBe('function');
      expect(() => uninstall()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'history', { value: orig, configurable: true });
    }
  });
});

describe('applyServerReplayConfig — segmented tier', () => {
  beforeEach(() => _resetSessionReplayForTest());
  afterEach(() => _resetSessionReplayForTest());

  it('reports segmented only when the policy sets continuous + segmented', () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, segmented: true });
    expect(isServerSegmentedEnabled()).toBe(true);
    // segmented without continuous is meaningless — never on.
    applyServerReplayConfig({ sampleRate: 1, continuous: false, segmented: true });
    expect(isServerSegmentedEnabled()).toBe(false);
    // continuous without segmented is the monolithic tier.
    applyServerReplayConfig({ sampleRate: 1, continuous: true });
    expect(isServerSegmentedEnabled()).toBe(false);
    applyServerReplayConfig(null);
    expect(isServerSegmentedEnabled()).toBe(false);
  });

  it('keeps a server-delivered sub-minute cadence as the segment duration bound (not floored to 60s)', () => {
    // A segmented project's sub-minute flushIntervalMs must NOT be re-floored to
    // the monolithic 60s minimum on the client — it maps to the segment duration.
    applyServerReplayConfig({
      sampleRate: 1,
      continuous: true,
      segmented: true,
      flushIntervalMs: 8_000,
    });
    expect(getSegmentMaxDurationMs()).toBe(8_000);
  });

  it('defaults the segment duration bound to ~5s when the segmented cadence is unset', () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, segmented: true });
    // The server delivers a flushIntervalMs (defaulting to the ~5s segmented
    // default), so an unset segmented cadence resolves to SEGMENT_MAX_DURATION_MS.
    expect(getSegmentMaxDurationMs()).toBe(SEGMENT_MAX_DURATION_MS);
    // With no config at all it also falls back to the 5s default.
    applyServerReplayConfig(null);
    expect(getSegmentMaxDurationMs()).toBe(SEGMENT_MAX_DURATION_MS);
  });
});

describe('clampSegmentFlushInterval', () => {
  it('defaults unset / non-finite to the ~5s segment duration', () => {
    expect(clampSegmentFlushInterval(null)).toBe(SEGMENT_MAX_DURATION_MS);
    expect(clampSegmentFlushInterval(undefined)).toBe(SEGMENT_MAX_DURATION_MS);
    expect(clampSegmentFlushInterval(NaN)).toBe(SEGMENT_MAX_DURATION_MS);
  });

  it('raises a below-floor value to the 1s segmented floor (not the 60s monolithic floor)', () => {
    expect(clampSegmentFlushInterval(10)).toBe(MIN_SEGMENTED_FLUSH_INTERVAL_MS);
    // A 5s cadence is valid on the segmented path (would be floored to 60s on monolithic).
    expect(clampSegmentFlushInterval(5_000)).toBe(5_000);
  });

  it('caps an excessive cadence to the ceiling', () => {
    expect(clampSegmentFlushInterval(10 * 60 * 60 * 1000)).toBe(MAX_CONTINUOUS_FLUSH_INTERVAL_MS);
  });
});

describe('SegmentedContinuousController', () => {
  it('mints session/view ids, flushes the outgoing view on navigation, and rolls the session over', async () => {
    let clock = 1000;
    let idn = 0;
    const manager = new RumSessionManager({
      now: () => clock,
      generateId: () => `id${idn++}`,
    });

    const submitted: any[] = [];
    const submitSegment = vi.fn(async (payload: any) => {
      submitted.push(payload);
      return { segmentId: `seg${submitted.length}` };
    });

    // Fake recorder whose forceFullSnapshot re-enters the controller sink with a
    // Meta + FullSnapshot, exactly as rrweb's checkout does in production.
    let controller: any;
    const recorder = {
      forceFullSnapshot: vi.fn(() => {
        controller.handleEvent(meta(clock));
        controller.handleEvent(snap(clock));
      }),
    };

    controller = new SegmentedContinuousController({
      recorder,
      sessionManager: manager,
      endpointBase: '/api/replays',
      createFlusher: (opts: any) =>
        new SegmentReplayFlusher({
          ...opts,
          submitSegment,
          now: () => clock,
          // No real timers — the test drives rollovers explicitly.
          setIntervalFn: null,
          clearIntervalFn: null,
        }) as unknown as SegmentFlusherLike,
    });

    // init mints the opening session (id0) + view (id1) and builds the flusher.
    controller.init();
    controller.start();
    const flusher0 = controller.flusher;
    expect(flusher0.sessionId).toBe('id0');
    expect(flusher0.viewId).toBe('id1');
    expect(flusher0.indexInView).toBe(0);

    // Opening view: the snapshot + one interaction (as rrweb emits at start).
    controller.handleEvent(meta(clock));
    controller.handleEvent(snap(clock));
    controller.handleEvent(incr(clock));

    // Navigate: mints a fresh view (id2) under the SAME session, flushing the
    // outgoing view's opening segment to (id0, id1, 0).
    await controller.handleViewChange();
    expect(submitSegment).toHaveBeenCalledTimes(1);
    expect(submitted[0].sessionId).toBe('id0');
    expect(submitted[0].viewId).toBe('id1');
    expect(submitted[0].indexInView).toBe(0);
    expect(hasFullSnapshot(submitted[0].events)).toBe(true);
    // Same flusher, now on the new view; requestSnapshot re-opened index 0.
    expect(controller.flusher).toBe(flusher0);
    expect(controller.flusher.viewId).toBe('id2');
    expect(controller.flusher.indexInView).toBe(0);
    expect(recorder.forceFullSnapshot).toHaveBeenCalled();

    // Session rollover: advance past the inactivity timeout, then feed an event.
    // The manager expires the session and mints a FRESH session + view, and the
    // controller REBUILDS the flusher for the new session.
    clock += SESSION_INACTIVITY_TIMEOUT_MS + 1;
    controller.handleEvent(incr(clock));
    expect(controller.flusher).not.toBe(flusher0);
    expect(controller.flusher.sessionId).toBe('id3');
    expect(controller.flusher.sessionId).not.toBe('id0');
    expect(controller.flusher.viewId).toBe('id4');
    controller.stop();
  });

  it('rebuilds for a fresh session when navigation happens after expiry', async () => {
    let clock = 5000;
    let idn = 0;
    const manager = new RumSessionManager({ now: () => clock, generateId: () => `v${idn++}` });
    const submitSegment = vi.fn(async () => ({ segmentId: 'x' }));
    let controller: any;
    const recorder = { forceFullSnapshot: vi.fn(() => controller.handleEvent(snap(clock))) };
    controller = new SegmentedContinuousController({
      recorder,
      sessionManager: manager,
      endpointBase: '/api/replays',
      createFlusher: (opts: any) =>
        new SegmentReplayFlusher({
          ...opts,
          submitSegment,
          now: () => clock,
          setIntervalFn: null,
        }) as unknown as SegmentFlusherLike,
    });
    controller.init();
    const first = controller.flusher;
    expect(first.sessionId).toBe('v0');

    // Navigate AFTER the session has expired → a fresh session, not just a view.
    clock += SESSION_MAX_DURATION_MS + 1;
    const ret = controller.handleViewChange();
    // Session-change branch rebuilds rather than rolling the view, so it returns null.
    expect(ret).toBeNull();
    expect(controller.flusher).not.toBe(first);
    expect(controller.flusher.sessionId).toBe('v2');
    expect(controller.flusher.sessionId).not.toBe('v0');
    controller.stop();
  });
});

describe('segmented continuous wiring (startRecorder)', () => {
  beforeEach(() => _resetSessionReplayForTest());
  afterEach(() => _resetSessionReplayForTest());

  it('wires a SegmentedContinuousController with minted ids when the project opts into the segmented tier', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, segmented: true });
    await setSessionReplayEnabled(true);
    const mod = await import('./sessionReplay');
    const controller = mod.getSegmentController()!;
    expect(controller).not.toBeNull();
    expect(controller).toBeInstanceOf(SegmentedContinuousController);
    // The monolithic accessor returns the same controller (uniform tail-flush path).
    expect(mod.getContinuousFlusher()).toBe(controller);
    const flusher = controller.flusher!;
    expect(flusher).not.toBeNull();
    expect(typeof flusher.sessionId).toBe('string');
    expect(flusher.sessionId.length).toBeGreaterThan(0);
    expect(typeof flusher.viewId).toBe('string');
    expect(flusher.viewId.length).toBeGreaterThan(0);
    expect(flusher.indexInView).toBe(0);
    // The segmented cadence maps to the flusher's segment duration bound.
    expect(flusher.maxDurationMs).toBe(getSegmentMaxDurationMs());

    // A navigation drives the controller's view-change path.
    const spy = vi.spyOn(controller, 'handleViewChange').mockImplementation(() => null);
    window.history.pushState({}, '', `/seg-nav-${Date.now()}`);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    // Disabling tears down the controller and uninstalls the view-change detector.
    await setSessionReplayEnabled(false);
    expect(mod.getSegmentController()).toBeNull();
    expect(mod.getContinuousFlusher()).toBeNull();
  });

  it('threads a project-configured segmented cadence into the segment duration bound', async () => {
    applyServerReplayConfig({
      sampleRate: 1,
      continuous: true,
      segmented: true,
      flushIntervalMs: 12_000,
    });
    await setSessionReplayEnabled(true);
    const mod = await import('./sessionReplay');
    const flusher = mod.getSegmentController()!.flusher!;
    // The Admin-configured 12s cadence governs segment rollover — not the
    // hardcoded 5s default (this is the behavior the server floor-lift enables).
    expect(flusher.maxDurationMs).toBe(12_000);
    await setSessionReplayEnabled(false);
  });

  it('feeds uncaught errors to the live segment flusher (error-click classification)', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, segmented: true });
    await setSessionReplayEnabled(true);
    const mod = await import('./sessionReplay');
    const controller = mod.getSegmentController()!;
    const spy = vi.spyOn(controller, 'notifyError');
    // A throttled record-on-error flush still forwards the error to the flusher.
    await mod.getRecorder().handleError({ trigger: 'window.error' });
    expect(spy).toHaveBeenCalledTimes(1);
    await setSessionReplayEnabled(false);
  });

  it('keeps a SINGLE view-change detector across a masking-mode restart (no leaked duplicate)', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true, segmented: true });
    await setSessionReplayEnabled(true);
    const mod = await import('./sessionReplay');
    const controller = mod.getSegmentController()!;
    expect(controller).not.toBeNull();

    // A masking-mode change restarts the recorder WITHOUT tearing down the
    // continuous stream (the flusher/controller is preserved), so startRecorder
    // re-enters with a truthy _continuousFlusher and re-runs the detector wiring.
    await mod.setReplayMaskingMode(false);
    // Same controller instance survives the restart.
    expect(mod.getSegmentController()).toBe(controller);

    // Exactly ONE active detector must remain: a single SPA navigation fires
    // handleViewChange once, not twice (a leaked first detector would double it).
    const spy = vi.spyOn(controller, 'handleViewChange').mockImplementation(() => null);
    window.history.pushState({}, '', `/mask-restart-nav-${Date.now()}`);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    await setSessionReplayEnabled(false);
  });

  it('wires the MONOLITHIC flusher (not the controller) when segmented is off', async () => {
    applyServerReplayConfig({ sampleRate: 1, continuous: true });
    await setSessionReplayEnabled(true);
    const mod = await import('./sessionReplay');
    expect(mod.getSegmentController()).toBeNull();
    const flusher = mod.getContinuousFlusher();
    expect(flusher).not.toBeNull();
    expect(flusher).toBeInstanceOf(ContinuousReplayFlusher);
    await setSessionReplayEnabled(false);
  });
});
