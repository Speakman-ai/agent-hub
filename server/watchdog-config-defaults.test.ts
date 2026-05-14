/**
 * Pins the runtime defaults for the Session Watchdog tunables. These values
 * appear in user-facing nudge frequency, so a silent regression to the older
 * tighter defaults (5 min idle / 3 min cooldown) would show up as nudges
 * firing four-times-as-often without any visible code change.
 *
 * If the defaults intentionally change, update this test in the same commit
 * so the change is reviewed explicitly.
 */
import { describe, it, expect } from 'vitest';
import config from './config.js';

describe('watchdog config defaults', () => {
  it('idleThresholdMs defaults to 20 min', () => {
    expect(config.watchdog.idleThresholdMs).toBe(20 * 60 * 1000);
  });

  it('nudgeCooldownMs defaults to 10 min', () => {
    expect(config.watchdog.nudgeCooldownMs).toBe(10 * 60 * 1000);
  });

  it('checkIntervalMs defaults to 60 s', () => {
    expect(config.watchdog.checkIntervalMs).toBe(60 * 1000);
  });

  it('maxSoftNudges defaults to 2', () => {
    expect(config.watchdog.maxSoftNudges).toBe(2);
  });

  it('cardBudgetMs defaults to 1 hour', () => {
    expect(config.watchdog.cardBudgetMs).toBe(60 * 60 * 1000);
  });

  it('nudge cooldown is shorter than the idle threshold', () => {
    // Sanity invariant: a session must be allowed to actually become idle
    // again before the next nudge fires. cooldown < threshold guarantees
    // that the cooldown gate is the binding constraint, not the idle gate.
    expect(config.watchdog.nudgeCooldownMs).toBeLessThan(config.watchdog.idleThresholdMs);
  });
});
