import { describe, expect, it } from 'vitest';
import {
  createSilenceTracker,
  dbfsToMeter,
  rmsToDbfs,
  samplesRms,
  silenceWarning,
  silenceWarningMessage,
  SILENCE_WARNING_MS,
  trackLevel,
} from './audioLevel';

function feed(levels: number[], stepMs = 100) {
  let state = createSilenceTracker(0);
  let now = 0;
  for (const db of levels) {
    now += stepMs;
    state = trackLevel(state, db, now);
  }
  return { state, now };
}

describe('audio level math', () => {
  it('computes RMS and dBFS', () => {
    expect(samplesRms([])).toBe(0);
    expect(samplesRms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
    expect(rmsToDbfs(1)).toBe(0);
    expect(rmsToDbfs(0)).toBe(-Infinity);
    expect(rmsToDbfs(0.1)).toBeCloseTo(-20);
  });

  it('maps dBFS onto a clamped 0..1 meter', () => {
    expect(dbfsToMeter(-Infinity)).toBe(0);
    expect(dbfsToMeter(-160)).toBe(0);
    expect(dbfsToMeter(-30)).toBeCloseTo(0.5);
    expect(dbfsToMeter(3)).toBe(1);
  });
});

describe('silence warning', () => {
  it('flags a take that never receives any signal (blocked mic delivers zeros)', () => {
    const samples = Array(Math.ceil(SILENCE_WARNING_MS / 100)).fill(-Infinity);
    const { state, now } = feed(samples);
    expect(silenceWarning(state, now)).toBe('no-signal');
    expect(silenceWarningMessage('no-signal')).toMatch(/microphone access/);
  });

  it('treats the iOS -160 dB floor as no signal', () => {
    const { state, now } = feed(Array(70).fill(-160));
    expect(silenceWarning(state, now)).toBe('no-signal');
  });

  it('does not warn before the grace period', () => {
    const { state, now } = feed(Array(10).fill(-Infinity));
    expect(silenceWarning(state, now)).toBeNull();
  });

  it('flags a live but quiet input after the grace period', () => {
    const { state, now } = feed(Array(70).fill(-70));
    expect(silenceWarning(state, now)).toBe('quiet');
  });

  it('clears once speech arrives and restarts the quiet clock', () => {
    const quiet = Array(70).fill(-70);
    let { state, now } = feed([...quiet, -20]);
    expect(silenceWarning(state, now)).toBeNull();
    const quietStart = now + 100;
    while (now < quietStart + SILENCE_WARNING_MS - 100) {
      now += 100;
      state = trackLevel(state, -70, now);
    }
    expect(silenceWarning(state, now)).toBeNull();
    now += 100;
    state = trackLevel(state, -70, now);
    expect(silenceWarning(state, now)).toBe('quiet');
  });

  it('keeps steady speech warning-free', () => {
    const { state, now } = feed(Array(200).fill(-25));
    expect(silenceWarning(state, now)).toBeNull();
  });
});
