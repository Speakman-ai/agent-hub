/**
 * Copy for the auto-resume that follows a server restart.
 *
 * A restart drains every tracked CLI child by process *group*
 * (`killAllTrackedProcessGroups` in `process-groups.ts`), so the agent's whole
 * subtree dies with it: `run_in_background` bash jobs, dev servers, test runs,
 * docker builds, and anything those spawned. Hub-owned background shells are
 * separately reaped and flipped to `failed` by the background-shell boot
 * reconcile.
 *
 * The resumed CLI cannot observe any of that. Its transcript ends with it
 * launching the work, so a prompt that only says "continue where you left off"
 * sends it straight back to tailing a log nothing is writing to, waiting on a
 * process the Hub already killed. State the kill explicitly instead.
 */

/** A Hub-owned background shell that a restart orphaned. */
export interface KilledBackgroundShell {
  id: string;
  command: string;
  label?: string | null;
}

/** Beyond this, the list is truncated with a "+N more" line. */
const MAX_LISTED_SHELLS = 10;

/** Commands can be arbitrarily long; keep the prompt readable. */
const MAX_COMMAND_CHARS = 200;

const KILLED_PROCESSES_SENTENCE =
  'The restart killed every process this session had started — background shell jobs, dev servers, test runs, builds, and anything they spawned. None of it survived.';

const DO_NOT_WAIT_SENTENCE =
  'Do not wait on, poll, or tail any of that earlier work. Re-check state directly and relaunch whatever you still need before continuing.';

function truncateCommand(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_COMMAND_CHARS) return flat;
  return `${flat.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/**
 * Render the killed-shell list, or an empty string when there is nothing to
 * list. Callers concatenate with `\n\n` and drop empties.
 */
export function formatKilledShellLines(shells: readonly KilledBackgroundShell[]): string {
  if (shells.length === 0) return '';
  const shown = shells.slice(0, MAX_LISTED_SHELLS);
  const lines = shown.map((shell) => {
    const command = truncateCommand(shell.command);
    const label = shell.label?.trim();
    return label ? `- ${label}: \`${command}\`` : `- \`${command}\``;
  });
  const remaining = shells.length - shown.length;
  if (remaining > 0) lines.push(`- …and ${remaining} more`);
  return ['Background shells killed by the restart:', ...lines].join('\n');
}

function joinSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((section) => section?.trim() ?? '')
    .filter((section) => section.length > 0)
    .join('\n\n');
}

export interface RestartResumeNoticeOptions {
  /** Assistant text streamed before the restart, if any. */
  partial?: string | null;
  killedShells?: readonly KilledBackgroundShell[];
}

/**
 * The `role=assistant` line written into the transcript so the human sees why
 * the session jumped, and what the restart took down with it.
 */
export function buildRestartResumeNotice(options: RestartResumeNoticeOptions = {}): string {
  const partial = options.partial?.trim() ?? '';
  return joinSections([
    'ℹ️ Session interrupted by server restart. Resuming automatically…',
    KILLED_PROCESSES_SENTENCE,
    formatKilledShellLines(options.killedShells ?? []),
    partial ? `Partial output before interruption:\n${partial}` : null,
  ]);
}

export interface RestartResumePromptOptions {
  /**
   * True when the engine can resume its own transcript. Without one, the
   * original task prompt is replayed instead of a "continue" instruction.
   */
  hasEngineSession: boolean;
  /** The interrupted task's original prompt, replayed when there is no engine session. */
  taskPrompt?: string | null;
  killedShells?: readonly KilledBackgroundShell[];
}

/**
 * The turn content handed to the resumed CLI. The kill statement leads, because
 * the failure mode this fixes is the agent acting on a stale belief that its
 * long-running work is still in flight.
 */
export function buildRestartResumePrompt(options: RestartResumePromptOptions): string {
  const taskPrompt = options.taskPrompt?.trim() ?? '';
  const tail = options.hasEngineSession
    ? 'Please continue where you left off. If you were in the middle of a task, pick up from where you stopped.'
    : taskPrompt || 'Please continue where you left off.';
  return joinSections([
    'The server restarted while you were working.',
    KILLED_PROCESSES_SENTENCE,
    formatKilledShellLines(options.killedShells ?? []),
    DO_NOT_WAIT_SENTENCE,
    tail,
  ]);
}
