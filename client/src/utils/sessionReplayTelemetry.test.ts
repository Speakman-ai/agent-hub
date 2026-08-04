/**
 * Recorder ↔ instrumentation wiring.
 *
 * The regression this guards: console/network telemetry must land in the SAME
 * buffer (and continuous sink) as rrweb's DOM events, otherwise it never
 * reaches the uploaded capture and the whole "why did the user rage-click"
 * story is missing from the replay again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionReplayRecorder, getRecorder } from './sessionReplay';
import { REPLAY_CONSOLE_TAG, RRWEB_CUSTOM_EVENT_TYPE } from './replayInstrumentation';

const stopFns: Array<() => void> = [];

afterEach(() => {
  for (const stop of stopFns.splice(0)) stop();
});

/** A record() stand-in that never touches the DOM. */
function fakeRecord() {
  return () => {};
}

describe('SessionReplayRecorder telemetry capture', () => {
  it('buffers console errors as rrweb custom events while recording', () => {
    const rec = new SessionReplayRecorder({ captureTelemetry: true, now: () => 5_000 });
    stopFns.push(() => rec.stop());
    const original = console.error;
    console.error = vi.fn();

    rec.start(fakeRecord);
    console.error('checkout failed', new TypeError('boom'));
    rec.stop();

    // stop() must restore the page's console, not leave our patch installed.
    expect(console.error).not.toBe(original);
    console.error = original;

    const custom = rec.buffer.filter((e: any) => e.type === RRWEB_CUSTOM_EVENT_TYPE);
    expect(custom).toHaveLength(1);
    expect(custom[0].data.tag).toBe(REPLAY_CONSOLE_TAG);
    expect(custom[0].data.payload.message).toContain('checkout failed');
    expect(custom[0].timestamp).toBe(5_000);
  });

  it('feeds telemetry to the continuous sink like any other event', () => {
    const rec = new SessionReplayRecorder({ captureTelemetry: true });
    stopFns.push(() => rec.stop());
    const seen: any[] = [];
    rec._continuousSink = (e: any) => seen.push(e);
    const original = console.error;
    console.error = vi.fn();

    rec.start(fakeRecord);
    console.error('stream me');
    rec.stop();
    console.error = original;

    expect(seen.some((e) => e.type === RRWEB_CUSTOM_EVENT_TYPE)).toBe(true);
  });

  it('captures nothing when telemetry is off (the unit-test default)', () => {
    const rec = new SessionReplayRecorder({});
    stopFns.push(() => rec.stop());
    const original = console.error;
    rec.start(fakeRecord);
    expect(console.error).toBe(original);
    console.error = vi.fn();
    console.error('quiet');
    console.error = original;
    rec.stop();
    expect(rec.buffer).toHaveLength(0);
  });

  it('enables telemetry on the page-level singleton recorder', () => {
    expect(getRecorder().captureTelemetry).toBe(true);
  });

  // Telemetry installation is tied to the RECORDING lifecycle, not to
  // construction: a recorder reused for a second recording (masking-mode
  // change, runtime disable/enable, bfcache resume) must capture console and
  // network again. If installation ever migrates to the constructor, the second
  // recording silently loses telemetry and this test is what catches it.
  it('reinstalls telemetry on every recording cycle, not just the first', () => {
    const rec = new SessionReplayRecorder({ captureTelemetry: true, now: () => 1 });
    stopFns.push(() => rec.stop());
    const original = console.error;

    console.error = vi.fn();
    rec.start(fakeRecord);
    console.error('first recording');
    rec.stop();
    console.error = original;

    expect(rec.buffer.filter((e: any) => e.type === RRWEB_CUSTOM_EVENT_TYPE)).toHaveLength(1);

    // Second cycle on the SAME recorder instance.
    rec.buffer = [];
    console.error = vi.fn();
    rec.start(fakeRecord);
    console.error('second recording');
    const patchedDuringSecondCycle = console.error;
    rec.stop();
    console.error = original;

    const custom = rec.buffer.filter((e: any) => e.type === RRWEB_CUSTOM_EVENT_TYPE);
    expect(custom).toHaveLength(1);
    expect(custom[0].data.payload.message).toContain('second recording');
    // The patch really was reinstalled for cycle two (not a leftover handle).
    expect(patchedDuringSecondCycle).not.toBe(original);
  });

  it('does not patch the console until recording actually starts', () => {
    const original = console.error;
    const rec = new SessionReplayRecorder({ captureTelemetry: true });
    stopFns.push(() => rec.stop());

    // Constructing a recorder must not touch page globals.
    expect(console.error).toBe(original);
    expect(rec._telemetryUninstall).toBeNull();

    rec.start(fakeRecord);
    expect(console.error).not.toBe(original);
    rec.stop();
    expect(console.error).toBe(original);
  });

  it('leaves no stale handle behind when start is called on a live recorder', () => {
    const rec = new SessionReplayRecorder({ captureTelemetry: true });
    stopFns.push(() => rec.stop());
    const original = console.error;

    rec.start(fakeRecord);
    const firstHandle = rec._telemetryUninstall;
    // `start()` on an already-active recorder is a no-op; the handle must not
    // be replaced (which would strand the first installation's subscriber).
    rec.start(fakeRecord);
    expect(rec._telemetryUninstall).toBe(firstHandle);

    rec.stop();
    expect(rec._telemetryUninstall).toBeNull();
    expect(console.error).toBe(original);
  });
});
