/**
 * Watch-loop policy tests.
 *
 * The regression this guards: a session that parks work in a background shell,
 * ends its turn, and is never heard from again. The wake decision is where that
 * either gets fixed or reintroduced, so each branch is pinned here — especially
 * the ones that *don't* wake, since a silent `drop` is exactly what the bug
 * looked like.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_WAKES_PER_SESSION,
  MIN_WAKE_INTERVAL_MS,
  buildBackgroundShellWakePrompt,
  buildWakeCapNotice,
  buildWatchTurnEndNotice,
  planBackgroundShellWake,
  type WatchedShellSummary,
  type WakePromptShell,
} from './background-shell-watch.js';

function shell(over: Partial<WatchedShellSummary> = {}): WatchedShellSummary {
  return {
    id: 'shell-1',
    label: 'prod build',
    command: 'npm run build',
    status: 'exited',
    exit_code: 0,
    ...over,
  };
}

function plan(over: Partial<Parameters<typeof planBackgroundShellWake>[0]> = {}) {
  return planBackgroundShellWake({
    finishedShells: [shell()],
    sessionGone: false,
    sessionBusy: false,
    priorWakes: 0,
    lastWakeAtMs: null,
    nowMs: 1_000_000,
    ...over,
  });
}

describe('planBackgroundShellWake', () => {
  it('wakes on a clean completion for an idle session', () => {
    expect(plan()).toEqual({ action: 'wake', reason: 'wake', notifyHuman: false });
  });

  it('wakes for a failed shell too — a broken build is exactly what the agent must hear', () => {
    const decision = plan({ finishedShells: [shell({ status: 'failed', exit_code: 1 })] });
    expect(decision.action).toBe('wake');
  });

  it('drops when nothing finished', () => {
    expect(plan({ finishedShells: [] })).toMatchObject({
      action: 'drop',
      reason: 'nothing_finished',
    });
  });

  it('drops for a deleted session rather than resurrecting it', () => {
    expect(plan({ sessionGone: true })).toMatchObject({ action: 'drop', reason: 'session_gone' });
  });

  it('drops while Finalize is in flight rather than waking a new process', () => {
    expect(plan({ sessionFinalizing: true })).toMatchObject({
      action: 'drop',
      reason: 'session_finalizing',
    });
  });

  it('drops a finalizing session even if it is also busy or inside the coalescing window', () => {
    const decision = plan({
      sessionFinalizing: true,
      sessionBusy: true,
      lastWakeAtMs: 1_000_000 - 1,
      nowMs: 1_000_000,
    });
    expect(decision).toMatchObject({ action: 'drop', reason: 'session_finalizing' });
  });

  it('defers instead of colliding with an in-flight turn', () => {
    expect(plan({ sessionBusy: true })).toMatchObject({
      action: 'defer',
      reason: 'session_busy',
    });
  });

  it('defers inside the coalescing window so a burst becomes one wake', () => {
    const decision = plan({
      lastWakeAtMs: 1_000_000 - (MIN_WAKE_INTERVAL_MS - 1),
      nowMs: 1_000_000,
    });
    expect(decision).toMatchObject({ action: 'defer', reason: 'coalescing' });
  });

  it('wakes again once the coalescing window has elapsed', () => {
    const decision = plan({
      lastWakeAtMs: 1_000_000 - MIN_WAKE_INTERVAL_MS,
      nowMs: 1_000_000,
    });
    expect(decision.action).toBe('wake');
  });

  it('coalescing takes precedence over busy, so a busy retry cannot bypass the pacing', () => {
    const decision = plan({
      sessionBusy: true,
      lastWakeAtMs: 1_000_000 - 1,
      nowMs: 1_000_000,
    });
    expect(decision.reason).toBe('coalescing');
  });

  it('gives up and tells the human once the wake budget is spent', () => {
    const decision = plan({ priorWakes: MAX_WAKES_PER_SESSION });
    expect(decision).toEqual({
      action: 'drop',
      reason: 'wake_cap_reached',
      notifyHuman: true,
    });
  });

  it('checks the cap before the coalescing window so a runaway loop still terminates', () => {
    const decision = plan({
      priorWakes: MAX_WAKES_PER_SESSION,
      lastWakeAtMs: 1_000_000 - 1,
      nowMs: 1_000_000,
    });
    expect(decision.reason).toBe('wake_cap_reached');
  });
});

describe('buildBackgroundShellWakePrompt', () => {
  function withLogs(over: Partial<WakePromptShell> = {}): WakePromptShell {
    return { ...shell(), logTail: ['line one', 'line two'], ...over };
  }

  it('names the shell, its outcome, and its output', () => {
    const text = buildBackgroundShellWakePrompt([withLogs()]);
    expect(text).toContain('prod build');
    expect(text).toContain('npm run build');
    expect(text).toContain('finished successfully (exit 0)');
    expect(text).toContain('line two');
  });

  it('reports a non-zero exit explicitly', () => {
    const text = buildBackgroundShellWakePrompt([withLogs({ status: 'failed', exit_code: 2 })]);
    expect(text).toContain('failed (exit 2)');
  });

  it('distinguishes a signal kill from a non-zero exit', () => {
    const text = buildBackgroundShellWakePrompt([withLogs({ status: 'failed', exit_code: null })]);
    expect(text).toContain('killed by a signal');
  });

  it('tells the agent it is a new process so it does not poll a dead handle', () => {
    expect(buildBackgroundShellWakePrompt([withLogs()])).toContain('new process');
  });

  it('mentions shells that are still running and promises another wake', () => {
    const text = buildBackgroundShellWakePrompt(
      [withLogs()],
      [shell({ id: 'shell-2', label: 'e2e', status: 'running' })],
    );
    expect(text).toContain('Still running');
    expect(text).toContain('e2e');
  });

  it('says nothing about still-running work when there is none', () => {
    expect(buildBackgroundShellWakePrompt([withLogs()])).not.toContain('Still running');
  });

  it('summarizes the overflow rather than listing every shell', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      withLogs({ id: `shell-${i}`, label: `job ${i}` }),
    );
    const text = buildBackgroundShellWakePrompt(many);
    expect(text).toContain('4 more finished shell(s)');
  });

  it('notes when a command produced no output', () => {
    expect(buildBackgroundShellWakePrompt([withLogs({ logTail: [] })])).toContain(
      'no output captured',
    );
  });
});

describe('buildWatchTurnEndNotice', () => {
  it('is empty when nothing is being watched, so callers can concatenate freely', () => {
    expect(buildWatchTurnEndNotice([])).toBe('');
  });

  it('promises the session will resume on its own', () => {
    const text = buildWatchTurnEndNotice([shell({ status: 'running' })]);
    expect(text).toContain('resume automatically');
    expect(text).toContain('prod build');
  });
});

describe('buildWakeCapNotice', () => {
  it('tells the human the loop stopped and their shells were left alone', () => {
    const text = buildWakeCapNotice([shell()]);
    expect(text).toContain(String(MAX_WAKES_PER_SESSION));
    expect(text).toContain('were not affected');
  });
});
