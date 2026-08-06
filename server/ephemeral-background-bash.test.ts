/**
 * Regression coverage for "Runs don't survive" (support ticket a441b013).
 *
 * An agent parked a ~5 minute containerized pytest run in a native
 * `run_in_background: true` Bash shell, called ScheduleWakeup, and came back to
 * a dead handle: "The previous run was killed when the process was torn down."
 * Nothing told it that would happen, and nothing told it afterwards either — it
 * had to diagnose the teardown itself and re-launch detached inside Docker.
 *
 * The first-message prompt section that states this up-front is covered by
 * `background-shell-prompt-guidance.test.ts`. What these tests pin is the other
 * half: when a turn ends with background shells *still outstanding*, the next
 * turn's content leads with the fact that they are gone — and, just as
 * important, stays quiet about shells the agent already resolved.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  EPHEMERAL_BASH_TTL_MS,
  MAX_EPHEMERAL_BASH_RECOVERY_TURNS,
  MAX_TRACKED_EPHEMERAL_SESSIONS,
  MAX_TRACKED_EPHEMERAL_SHELLS,
  buildEphemeralBackgroundBashHaltNotice,
  buildEphemeralBackgroundBashNotice,
  buildEphemeralBackgroundBashRecoveryPrompt,
  planEphemeralBackgroundBashRecovery,
  clearEphemeralBackgroundBash,
  isBackgroundBashToolUse,
  isTerminalBashOutputStatus,
  noteBashOutputToolUse,
  noteEphemeralBackgroundBashToolResult,
  noteKillShellToolUse,
  parseBackgroundShellId,
  peekEphemeralBackgroundBash,
  recordEphemeralBackgroundBash,
  _resetEphemeralBackgroundBashForTesting,
  _trackedEphemeralBackgroundBashForTesting,
  _trackedSessionCountForTesting,
} from './ephemeral-background-bash.js';

const SESSION = 'session-ae462683';

beforeEach(() => {
  _resetEphemeralBackgroundBashForTesting();
});

/** Launch a background shell and resolve its handle, as a real turn would. */
function launch(sessionId: string, toolUseId: string, command: string, shellId?: string): void {
  recordEphemeralBackgroundBash(sessionId, toolUseId, { command, run_in_background: true });
  if (shellId) {
    noteEphemeralBackgroundBashToolResult(
      sessionId,
      toolUseId,
      `Command running in background with ID: ${shellId}`,
      false,
    );
  }
}

describe('isBackgroundBashToolUse', () => {
  it('matches a Bash call with run_in_background true', () => {
    expect(isBackgroundBashToolUse('Bash', { command: 'npm test', run_in_background: true })).toBe(
      true,
    );
  });

  it('ignores foreground Bash calls', () => {
    expect(isBackgroundBashToolUse('Bash', { command: 'npm test' })).toBe(false);
    expect(isBackgroundBashToolUse('Bash', { command: 'npm test', run_in_background: false })).toBe(
      false,
    );
  });

  it('does not treat a truthy non-boolean flag as a background shell', () => {
    // Engines other than claude-code do not send the flag at all; a stray
    // string must not manufacture a notice about a shell that never existed.
    expect(
      isBackgroundBashToolUse('Bash', { command: 'npm test', run_in_background: 'true' }),
    ).toBe(false);
  });

  it('ignores other tools and empty commands', () => {
    expect(isBackgroundBashToolUse('Read', { command: 'x', run_in_background: true })).toBe(false);
    expect(isBackgroundBashToolUse('Bash', { command: '   ', run_in_background: true })).toBe(
      false,
    );
    expect(isBackgroundBashToolUse('Bash', null)).toBe(false);
  });
});

describe('parseBackgroundShellId', () => {
  it('reads the common launch-result shapes', () => {
    expect(parseBackgroundShellId('Command running in background with ID: bash_1')).toBe('bash_1');
    expect(parseBackgroundShellId('<shell_id>abc-123</shell_id>')).toBe('abc-123');
    expect(parseBackgroundShellId('started bash_42 ok')).toBe('bash_42');
  });

  it('returns null when nothing identifiable is present', () => {
    expect(parseBackgroundShellId('ok')).toBeNull();
    expect(parseBackgroundShellId('')).toBeNull();
  });
});

describe('isTerminalBashOutputStatus', () => {
  it('treats anything but running as terminal', () => {
    expect(isTerminalBashOutputStatus('<status>completed</status>')).toBe(true);
    expect(isTerminalBashOutputStatus('<status>failed</status>')).toBe(true);
    expect(isTerminalBashOutputStatus('<status>killed</status>')).toBe(true);
  });

  it('treats a running shell, or no status at all, as still outstanding', () => {
    expect(isTerminalBashOutputStatus('<status>running</status>')).toBe(false);
    expect(isTerminalBashOutputStatus('some output')).toBe(false);
    expect(isTerminalBashOutputStatus('')).toBe(false);
  });
});

describe('peek is non-destructive', () => {
  // Reviewer finding: a destructive read here loses the warning entirely when
  // the spawn that was supposed to carry it fails (bad cwd, engine auth,
  // ENOENT). The retry that finally works must still get the explanation.
  it('keeps the records so a failed spawn can retry', () => {
    launch(SESSION, 'toolu_1', 'npm test');
    expect(peekEphemeralBackgroundBash(SESSION)).toHaveLength(1);
    expect(peekEphemeralBackgroundBash(SESSION)).toHaveLength(1);
  });

  it('clears only when explicitly told the turn started', () => {
    launch(SESSION, 'toolu_1', 'npm test');
    clearEphemeralBackgroundBash(SESSION);
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([]);
  });

  it('does not leak internal fields to the notice builder', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([
      { command: 'npm test', description: null },
    ]);
  });
});

describe('shells the agent already resolved are not warned about', () => {
  // Reviewer finding: warning about a command that finished inside the turn
  // pushes the agent to redo completed work.
  it('drops a shell whose BashOutput poll reported completion', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    noteBashOutputToolUse(SESSION, 'toolu_2', { bash_id: 'bash_1' });
    noteEphemeralBackgroundBashToolResult(
      SESSION,
      'toolu_2',
      '<status>completed</status>\n<exit_code>0</exit_code>',
      false,
    );
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([]);
  });

  it('keeps a shell whose poll says it is still running', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    noteBashOutputToolUse(SESSION, 'toolu_2', { bash_id: 'bash_1' });
    noteEphemeralBackgroundBashToolResult(
      SESSION,
      'toolu_2',
      '<status>running</status>\npartial…',
      false,
    );
    expect(peekEphemeralBackgroundBash(SESSION)).toHaveLength(1);
  });

  it('drops a shell the agent killed outright', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    noteKillShellToolUse(SESSION, { shell_id: 'bash_1' });
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([]);
  });

  it('resolves only the polled shell, leaving siblings outstanding', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    launch(SESSION, 'toolu_2', 'npm run build', 'bash_2');
    noteBashOutputToolUse(SESSION, 'toolu_3', { bash_id: 'bash_1' });
    noteEphemeralBackgroundBashToolResult(SESSION, 'toolu_3', '<status>completed</status>', false);
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([
      { command: 'npm run build', description: null },
    ]);
  });

  it('attaches the shell handle from the launch result', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_7');
    expect(_trackedEphemeralBackgroundBashForTesting(SESSION)[0].shellId).toBe('bash_7');
  });

  it('still reports a shell whose handle could not be parsed', () => {
    // Conservative direction: a *successful* launch we could not parse a handle
    // for really is running, so it stays reported rather than going silent.
    launch(SESSION, 'toolu_1', 'npm test');
    noteEphemeralBackgroundBashToolResult(SESSION, 'toolu_1', 'ok', false);
    expect(peekEphemeralBackgroundBash(SESSION)).toHaveLength(1);
  });

  it('ignores BashOutput polls for a session with nothing tracked', () => {
    noteBashOutputToolUse(SESSION, 'toolu_1', { bash_id: 'bash_1' });
    noteEphemeralBackgroundBashToolResult(SESSION, 'toolu_1', '<status>completed</status>', false);
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([]);
  });
});

// Reviewer finding: a rejected launch (denied permission, invalid command)
// comes back with no parseable shell id — the same shape as a successful launch
// we failed to parse. Treating them alike warns about a shell that never
// existed and sends the agent off to "recover" work that never started. The
// `is_error` flag is what separates them.
describe('rejected launches are not tracked', () => {
  it('discards a launch whose tool_result is an error', () => {
    launch(SESSION, 'toolu_1', 'rm -rf /');
    noteEphemeralBackgroundBashToolResult(
      SESSION,
      'toolu_1',
      'Permission to use Bash with command rm -rf / has been denied.',
      true,
    );
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([]);
    expect(_trackedSessionCountForTesting()).toBe(0);
  });

  it('discards only the rejected launch, leaving healthy siblings', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    launch(SESSION, 'toolu_2', 'not-a-command');
    noteEphemeralBackgroundBashToolResult(SESSION, 'toolu_2', 'command not found', true);
    expect(peekEphemeralBackgroundBash(SESSION)).toEqual([
      { command: 'npm test', description: null },
    ]);
  });

  it('keeps a successful launch that merely looks terse', () => {
    // Same unparseable output as the error case, but not flagged as an error.
    launch(SESSION, 'toolu_1', 'npm test');
    noteEphemeralBackgroundBashToolResult(SESSION, 'toolu_1', 'command not found', false);
    expect(peekEphemeralBackgroundBash(SESSION)).toHaveLength(1);
  });

  it('does not resurrect a shell when a later BashOutput errors', () => {
    // An errored poll says nothing about whether the shell is alive, so the
    // error handling must stay scoped to launches.
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    noteBashOutputToolUse(SESSION, 'toolu_2', { bash_id: 'bash_1' });
    noteEphemeralBackgroundBashToolResult(SESSION, 'toolu_2', 'no such shell', true);
    expect(peekEphemeralBackgroundBash(SESSION)).toHaveLength(1);
  });
});

describe('record bookkeeping', () => {
  it('keeps sessions isolated', () => {
    launch('a', 'toolu_1', 'build-a');
    launch('b', 'toolu_2', 'build-b');
    expect(peekEphemeralBackgroundBash('a')).toEqual([{ command: 'build-a', description: null }]);
    expect(peekEphemeralBackgroundBash('b')).toEqual([{ command: 'build-b', description: null }]);
  });

  it('caps tracked shells per session', () => {
    for (let i = 0; i < MAX_TRACKED_EPHEMERAL_SHELLS + 10; i += 1) {
      launch(SESSION, `toolu_${i}`, `job-${i}`);
    }
    expect(_trackedEphemeralBackgroundBashForTesting(SESSION)).toHaveLength(
      MAX_TRACKED_EPHEMERAL_SHELLS,
    );
  });

  it('ignores blank commands and blank session ids', () => {
    recordEphemeralBackgroundBash(SESSION, 'toolu_1', { command: '  ', run_in_background: true });
    recordEphemeralBackgroundBash('', 'toolu_2', { command: 'npm test', run_in_background: true });
    expect(_trackedEphemeralBackgroundBashForTesting(SESSION)).toHaveLength(0);
    expect(peekEphemeralBackgroundBash('')).toEqual([]);
  });

  it('forgets a session once its last shell resolves', () => {
    launch(SESSION, 'toolu_1', 'npm test', 'bash_1');
    noteKillShellToolUse(SESSION, { shell_id: 'bash_1' });
    expect(_trackedSessionCountForTesting()).toBe(0);
  });
});

describe('registry stays bounded', () => {
  // Reviewer finding: an in-memory registry cleaned up only on session teardown
  // accumulates command strings for every abandoned session.
  it('expires records past the TTL instead of warning about them', () => {
    const t0 = 1_000_000;
    recordEphemeralBackgroundBash(
      SESSION,
      'toolu_1',
      { command: 'npm test', run_in_background: true },
      t0,
    );
    expect(peekEphemeralBackgroundBash(SESSION, t0 + EPHEMERAL_BASH_TTL_MS - 1)).toHaveLength(1);
    expect(peekEphemeralBackgroundBash(SESSION, t0 + EPHEMERAL_BASH_TTL_MS + 1)).toEqual([]);
    expect(_trackedSessionCountForTesting()).toBe(0);
  });

  it('sweeps expired sessions on the next write', () => {
    const t0 = 1_000_000;
    recordEphemeralBackgroundBash(
      'stale',
      'toolu_1',
      { command: 'old', run_in_background: true },
      t0,
    );
    recordEphemeralBackgroundBash(
      'fresh',
      'toolu_2',
      { command: 'new', run_in_background: true },
      t0 + EPHEMERAL_BASH_TTL_MS + 1,
    );
    expect(_trackedSessionCountForTesting()).toBe(1);
    expect(peekEphemeralBackgroundBash('fresh', t0 + EPHEMERAL_BASH_TTL_MS + 1)).toHaveLength(1);
  });

  it('caps the number of tracked sessions, evicting the oldest', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_TRACKED_EPHEMERAL_SESSIONS + 25; i += 1) {
      recordEphemeralBackgroundBash(
        `session-${i}`,
        `toolu_${i}`,
        { command: `job-${i}`, run_in_background: true },
        t0 + i,
      );
    }
    expect(_trackedSessionCountForTesting()).toBe(MAX_TRACKED_EPHEMERAL_SESSIONS);
    expect(peekEphemeralBackgroundBash('session-0', t0)).toEqual([]);
    expect(
      peekEphemeralBackgroundBash(`session-${MAX_TRACKED_EPHEMERAL_SESSIONS + 24}`, t0),
    ).toHaveLength(1);
  });
});

describe('buildEphemeralBackgroundBashNotice', () => {
  it('is empty when the previous turn left nothing outstanding', () => {
    expect(buildEphemeralBackgroundBashNotice([])).toBe('');
  });

  it('names the unreachable shells and points at bg.sh', () => {
    const notice = buildEphemeralBackgroundBashNotice([
      { command: 'docker exec dwgskip-app pytest dwg_parse', description: 'Run regression test' },
    ]);
    expect(notice).toContain('Run regression test');
    expect(notice).toContain('docker exec dwgskip-app pytest dwg_parse');
    expect(notice).toContain('bg.sh start');
    // The exact failure from the report: the agent kept waiting on the run.
    expect(notice).toMatch(/Do not wait on, tail, or poll/);
  });

  // We cannot see a command that completed just before the CLI exited, so the
  // copy must not assert the work died — that would send the agent to redo it.
  it('claims unreachability, not that the work was killed', () => {
    const notice = buildEphemeralBackgroundBashNotice([{ command: 'npm test' }]);
    expect(notice).toContain('no longer reachable');
    expect(notice).toMatch(/before assuming the work did or did not finish/);
    expect(notice).toMatch(/relaunch only what is actually still missing/);
  });

  // The reported session's *second* mistake: after losing the shell it retried
  // with `docker exec -d`, which dies for the same reason.
  it('rules out the detach workarounds by name', () => {
    const notice = buildEphemeralBackgroundBashNotice([{ command: 'npm test' }]);
    expect(notice).toContain('nohup');
    expect(notice).toContain('setsid');
    expect(notice).toMatch(/detaching inside a container/i);
  });

  it('uses singular / plural phrasing', () => {
    expect(buildEphemeralBackgroundBashNotice([{ command: 'a' }])).toContain(
      'A background Bash shell you started in a previous turn is',
    );
    expect(buildEphemeralBackgroundBashNotice([{ command: 'a' }, { command: 'b' }])).toContain(
      '2 background Bash shells you started in a previous turn are',
    );
  });

  it('truncates long commands and collapses whitespace', () => {
    const notice = buildEphemeralBackgroundBashNotice([
      { command: `npm test ${'x'.repeat(500)}\n  --verbose` },
    ]);
    expect(notice).toContain('…');
    expect(notice).not.toContain('\n  --verbose');
    const commandLine = notice.split('\n').find((l) => l.startsWith('- `'))!;
    expect(commandLine.length).toBeLessThan(200);
  });

  it('summarises the overflow instead of listing every shell', () => {
    const shells = Array.from({ length: 12 }, (_, i) => ({ command: `job-${i}` }));
    const notice = buildEphemeralBackgroundBashNotice(shells);
    expect(notice).toContain('…and 4 more');
    expect(notice).not.toContain('job-11');
  });
});

/**
 * Support ticket d6e1f89f: an agent ended its turn with "I'll wait for the
 * background task notification rather than poll". No notification was coming,
 * so the session sat idle for five hours and read as dead. The turn that leaves
 * shells outstanding is the one that has to be continued.
 */
describe('planEphemeralBackgroundBashRecovery', () => {
  const base = {
    outstandingShells: 1,
    autoContinuing: false,
    turnErrored: false,
    chainCancelled: false,
    priorRecoveryTurns: 0,
  };

  it('recovers a clean turn that left a shell outstanding', () => {
    expect(planEphemeralBackgroundBashRecovery(base)).toEqual({
      recover: true,
      notifyHuman: false,
      reason: 'recover',
    });
  });

  it('leaves a turn with no outstanding shells alone', () => {
    const decision = planEphemeralBackgroundBashRecovery({ ...base, outstandingShells: 0 });
    expect(decision.recover).toBe(false);
    expect(decision.notifyHuman).toBe(false);
    expect(decision.reason).toBe('no_outstanding_shells');
  });

  // A Stop is the user asking for silence. Continuing anyway would restart the
  // very run they just killed.
  it('never continues after a Stop, even with shells outstanding', () => {
    const decision = planEphemeralBackgroundBashRecovery({ ...base, chainCancelled: true });
    expect(decision.recover).toBe(false);
    expect(decision.notifyHuman).toBe(false);
    expect(decision.reason).toBe('chain_cancelled');
  });

  it('defers to a turn that is already scheduling its own continuation', () => {
    expect(planEphemeralBackgroundBashRecovery({ ...base, autoContinuing: true }).reason).toBe(
      'already_continuing',
    );
    expect(planEphemeralBackgroundBashRecovery({ ...base, turnErrored: true }).reason).toBe(
      'turn_errored',
    );
  });

  // Otherwise an agent that re-launches a background shell every time it is
  // warned about one keeps the session spinning for its whole life.
  it('gives up after the cap and hands the problem to the human', () => {
    const decision = planEphemeralBackgroundBashRecovery({
      ...base,
      priorRecoveryTurns: MAX_EPHEMERAL_BASH_RECOVERY_TURNS,
    });
    expect(decision.recover).toBe(false);
    expect(decision.notifyHuman).toBe(true);
    expect(decision.reason).toBe('cap_reached');
  });

  // Cancel outranks the cap: a Stop must never produce a system message about
  // work the user deliberately killed.
  it('prefers the cancel verdict over the cap', () => {
    const decision = planEphemeralBackgroundBashRecovery({
      ...base,
      chainCancelled: true,
      priorRecoveryTurns: 99,
    });
    expect(decision.notifyHuman).toBe(false);
    expect(decision.reason).toBe('chain_cancelled');
  });
});

describe('recovery + halt copy', () => {
  it('tells the agent no notification is coming and names the durable surface', () => {
    const prompt = buildEphemeralBackgroundBashRecoveryPrompt();
    expect(prompt).toContain('No completion notification is coming');
    expect(prompt).toContain('bg.sh start');
  });

  it('names the lost commands for the human', () => {
    const notice = buildEphemeralBackgroundBashHaltNotice([
      { command: 'docker exec app pytest   dwg_parse' },
    ]);
    expect(notice).toContain('docker exec app pytest dwg_parse');
    expect(notice).toContain('no completion notification is coming');
  });

  it('summarises the overflow rather than listing every shell', () => {
    const notice = buildEphemeralBackgroundBashHaltNotice(
      Array.from({ length: 12 }, (_, i) => ({ command: `job-${i}` })),
    );
    expect(notice).toContain('…and 4 more');
    expect(notice).not.toContain('job-11');
  });
});
