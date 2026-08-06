/**
 * Watch-loop decisions and copy for Hub-owned background shells.
 *
 * The failure this exists for: an agent parks a long build in a background
 * shell, ends its turn, and the session goes idle forever. Nothing was
 * watching, so no completion ever arrives and — from the outside — the session
 * looks like it crashed mid-thought.
 *
 * `BackgroundShellRuntime` already owns those processes in the long-lived Hub
 * process and knows the exact moment each one goes terminal. This module is
 * the policy layer on top: given what just finished and what the session is
 * doing right now, decide whether to wake it, wait, or stay quiet — and build
 * the text of the wake.
 *
 * Deliberately IO-free. Every decision here is a pure function of its input so
 * the interesting cases (a busy session, a burst of simultaneous completions,
 * a shell that finishes instantly and could ping-pong) are unit-testable
 * without a database, a process, or a clock.
 */

/** The subset of a shell row the watch policy and its copy actually read. */
export interface WatchedShellSummary {
  id: string;
  label: string | null;
  command: string;
  status: 'running' | 'exited' | 'failed' | 'stopped';
  exit_code: number | null;
}

/**
 * Wakes allowed per session before the loop gives up and tells the human
 * instead. Reached only by a pathological cycle — a wake turn that starts a
 * shell that finishes immediately, waking the turn that starts the next one.
 * Well above any legitimate build/test/deploy sequence.
 */
export const MAX_WAKES_PER_SESSION = 20;

/**
 * Minimum gap between two wakes for one session. Doubles as the coalescing
 * window: shells that finish within it are reported by a single wake rather
 * than one turn each.
 */
export const MIN_WAKE_INTERVAL_MS = 15_000;

/**
 * How long a session must go without a wake before its budget resets.
 *
 * The cap is aimed at a runaway loop, which by construction keeps waking every
 * {@link MIN_WAKE_INTERVAL_MS} and so never reaches this idle gap. A session
 * that legitimately parks one long build an hour does, and gets a fresh budget
 * — otherwise a long-lived session would eventually stop resuming for no
 * reason the user could see.
 */
export const WAKE_BUDGET_IDLE_RESET_MS = 10 * 60_000;

/** Log lines quoted per shell in the wake prompt. */
export const WAKE_LOG_TAIL_LINES = 40;

/** Beyond this the copy summarizes the remainder as a count. */
const MAX_LISTED_SHELLS = 8;

/** Commands can be arbitrarily long; keep injected text readable. */
const MAX_COMMAND_CHARS = 160;

export type BackgroundShellWakeAction = 'wake' | 'defer' | 'drop';

export type BackgroundShellWakeReason =
  | 'nothing_finished'
  | 'session_gone'
  | 'wake_cap_reached'
  | 'coalescing'
  | 'session_busy'
  | 'wake';

export interface BackgroundShellWakeDecision {
  action: BackgroundShellWakeAction;
  reason: BackgroundShellWakeReason;
  /**
   * Tell the human the loop has stopped watching. True only for
   * `wake_cap_reached` — every other non-waking outcome either retries later
   * or is an intentional silence.
   */
  notifyHuman: boolean;
}

export interface PlanBackgroundShellWakeInput {
  /** Armed shells that reached a terminal status and have not been reported. */
  finishedShells: readonly WatchedShellSummary[];
  /** The session no longer exists, or was archived. */
  sessionGone: boolean;
  /** A chat turn is in flight — starting another would collide with it. */
  sessionBusy: boolean;
  /** Wakes already dispatched for this session. */
  priorWakes: number;
  /** When the last wake was dispatched, or null if none yet. */
  lastWakeAtMs: number | null;
  nowMs: number;
}

/**
 * Decide what to do with a batch of finished watched shells.
 *
 * `defer` means "ask again later" — the caller keeps the batch pending and
 * re-plans on its next tick, so deferred completions accumulate rather than
 * being lost. `drop` is terminal for the batch.
 */
export function planBackgroundShellWake(
  input: PlanBackgroundShellWakeInput,
): BackgroundShellWakeDecision {
  const decide = (
    action: BackgroundShellWakeAction,
    reason: BackgroundShellWakeReason,
    notifyHuman = false,
  ): BackgroundShellWakeDecision => ({ action, reason, notifyHuman });

  if (input.finishedShells.length === 0) return decide('drop', 'nothing_finished');
  if (input.sessionGone) return decide('drop', 'session_gone');
  if (input.priorWakes >= MAX_WAKES_PER_SESSION) {
    return decide('drop', 'wake_cap_reached', true);
  }
  if (
    input.lastWakeAtMs !== null &&
    input.nowMs - input.lastWakeAtMs < MIN_WAKE_INTERVAL_MS &&
    input.nowMs >= input.lastWakeAtMs
  ) {
    return decide('defer', 'coalescing');
  }
  if (input.sessionBusy) return decide('defer', 'session_busy');
  return decide('wake', 'wake');
}

function truncateCommand(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_COMMAND_CHARS) return flat;
  return `${flat.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

function shellTitle(shell: WatchedShellSummary): string {
  const label = shell.label?.trim();
  return label
    ? `${label} (\`${truncateCommand(shell.command)}\`)`
    : `\`${truncateCommand(shell.command)}\``;
}

function outcomeOf(shell: WatchedShellSummary): string {
  switch (shell.status) {
    case 'exited':
      return 'finished successfully (exit 0)';
    case 'failed':
      return shell.exit_code == null
        ? 'failed (killed by a signal or never started)'
        : `failed (exit ${shell.exit_code})`;
    case 'stopped':
      return 'was stopped from the Agent Hub UI';
    default:
      return 'is still running';
  }
}

/** Cap the quoted output so one chatty command can't dominate the wake turn. */
function formatLogTail(lines: readonly string[]): string {
  if (lines.length === 0) return '_(no output captured)_';
  const shown = lines.slice(-WAKE_LOG_TAIL_LINES);
  const omitted = lines.length - shown.length;
  const header = omitted > 0 ? `…${omitted} earlier line(s) omitted\n` : '';
  return ['```', `${header}${shown.join('\n')}`, '```'].join('\n');
}

export interface WakePromptShell extends WatchedShellSummary {
  logTail: readonly string[];
}

/**
 * The turn content delivered when watched work completes.
 *
 * Two things it must do, both learned from the ephemeral-bash notice: state
 * plainly that this is a *new process* so the agent doesn't try to poll a
 * handle it no longer has, and give it the output up front so the wake is
 * actionable rather than an invitation to go re-run everything.
 */
export function buildBackgroundShellWakePrompt(
  finished: readonly WakePromptShell[],
  stillRunning: readonly WatchedShellSummary[] = [],
): string {
  const subject =
    finished.length === 1
      ? 'A background shell you started has finished'
      : `${finished.length} background shells you started have finished`;

  const sections = finished.slice(0, MAX_LISTED_SHELLS).map((shell) => {
    return [`**${shellTitle(shell)}** — ${outcomeOf(shell)}`, formatLogTail(shell.logTail)].join(
      '\n\n',
    );
  });
  const omitted = finished.length - Math.min(finished.length, MAX_LISTED_SHELLS);
  if (omitted > 0) {
    sections.push(`…and ${omitted} more finished shell(s); use \`bg.sh list\` to see them.`);
  }

  const parts = [
    `${subject}. Agent Hub woke this session to hand you the results — you are now in a **new process**, so previous \`BashOutput\` handles and shell ids from the launching turn are gone. The output below is what was captured.`,
    sections.join('\n\n'),
  ];

  if (stillRunning.length > 0) {
    const names = stillRunning
      .slice(0, MAX_LISTED_SHELLS)
      .map((shell) => `- ${shellTitle(shell)}`)
      .join('\n');
    const more = stillRunning.length - Math.min(stillRunning.length, MAX_LISTED_SHELLS);
    parts.push(
      [
        `Still running (you will be woken again when ${stillRunning.length === 1 ? 'it finishes' : 'they finish'}):`,
        more > 0 ? `${names}\n- …and ${more} more` : names,
      ].join('\n'),
    );
  }

  parts.push(
    'Continue the work this shell was part of: act on the result above, and if more long-running work is needed start it with `bg.sh start --label "<label>" <command>` and end your turn — you will be woken again. Do not poll or sleep-loop waiting for it.',
  );

  return parts.join('\n\n');
}

/**
 * Transcript line written when a turn ends with watched shells still running.
 *
 * Without it the session simply stops talking, which is indistinguishable from
 * the crash this whole feature exists to fix. This says the silence is
 * expected and temporary.
 */
export function buildWatchTurnEndNotice(shells: readonly WatchedShellSummary[]): string {
  if (shells.length === 0) return '';
  const shown = shells.slice(0, MAX_LISTED_SHELLS).map((shell) => `- ${shellTitle(shell)}`);
  const more = shells.length - shown.length;
  if (more > 0) shown.push(`- …and ${more} more`);
  const noun = shells.length === 1 ? 'shell' : 'shells';
  const verb = shells.length === 1 ? 'it finishes' : 'they finish';
  return [
    `⏳ Watching ${shells.length} background ${noun}. This session will resume automatically when ${verb}:`,
    shown.join('\n'),
  ].join('\n\n');
}

/**
 * Transcript line written when the wake budget is exhausted. The loop stops
 * here, so the human has to know it is now on them.
 */
export function buildWakeCapNotice(shells: readonly WatchedShellSummary[]): string {
  const shown = shells.slice(0, MAX_LISTED_SHELLS).map((shell) => `- ${shellTitle(shell)}`);
  const more = shells.length - shown.length;
  if (more > 0) shown.push(`- …and ${more} more`);
  return [
    `⚠️ Stopped watching background shells for this session after ${MAX_WAKES_PER_SESSION} automatic wakes. The most recent completions were:`,
    shown.join('\n'),
    'This cap exists to stop a wake loop from running away. Send a message to continue — the shells themselves were not affected.',
  ].join('\n\n');
}
