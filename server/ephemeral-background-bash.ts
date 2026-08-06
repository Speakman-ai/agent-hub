/**
 * Native `run_in_background` Bash shells: tracking and the next-turn notice.
 *
 * Agent Hub spawns a **fresh CLI process per turn** (`server/chat.ts`). A Bash
 * shell the agent starts with `run_in_background: true` is a grandchild of that
 * process and its `BashOutput` handle registry lives inside it, so once the turn
 * ends the shell is unreachable and no later turn can poll, tail, or reap it.
 *
 * The CLI's own Bash tool description says the opposite ("keeps running across
 * turns"), which is true for a plain terminal `claude` and false under the Hub.
 * Agents act on that description, park a long build or test run in a background
 * shell, schedule a wakeup, and come back to nothing — burning the wall-clock
 * they were trying to save.
 *
 * The first-message prompt section that states this up-front, and points at
 * `bg.sh`, lives in `buildEnrichedPrompt` ("Long-Running Commands — Start Them
 * as Hub-Owned Background Shells"). This module is the *after the fact* half:
 * {@link buildEphemeralBackgroundBashNotice} names the shells that are gone at
 * the top of the next turn, for the agent that already made the mistake. Same
 * shape as `restart-resume-notice.ts`, which solves the identical problem for
 * the server-restart case.
 *
 * Only shells still **outstanding** are reported. A shell the agent watched to
 * completion via `BashOutput`, or killed with `KillShell`, is dropped as soon as
 * we see that in the stream — warning about work that already finished would
 * push the agent to redo it, which is worse than staying quiet.
 *
 * The registry is in-memory on purpose: it only ever needs to survive from the
 * turn that started a shell to the turn immediately after, and a server restart
 * is already covered by the restart-resume notice (which states that *every*
 * process the session started is dead). It is bounded on both axes — a TTL per
 * session and a cap on tracked sessions — so an abandoned session cannot pin
 * command strings in memory for the life of the process.
 */

/** One native background Bash shell observed in a `tool_use` stream event. */
export interface EphemeralBackgroundBash {
  command: string;
  /** Claude Code's `description` field for the Bash call, when present. */
  description?: string | null;
}

interface TrackedShell extends EphemeralBackgroundBash {
  /** The `tool_use` id of the launching Bash call, used to match its result. */
  toolUseId: string;
  /** The CLI's own handle (e.g. `bash_1`), parsed from the launch result. */
  shellId: string | null;
}

/** A `tool_use` whose result we still want to inspect. */
type PendingToolUse = { kind: 'launch' } | { kind: 'poll'; shellId: string };

interface SessionRecord {
  shells: TrackedShell[];
  pending: Map<string, PendingToolUse>;
  updatedAtMs: number;
}

/**
 * Per-session cap. A turn that spawns more background shells than this is
 * already pathological; the notice reports the overflow as a count rather than
 * growing without bound.
 */
export const MAX_TRACKED_EPHEMERAL_SHELLS = 20;

/**
 * Sessions tracked at once. Well above any plausible concurrent-session count,
 * so this only ever trims genuinely abandoned records.
 */
export const MAX_TRACKED_EPHEMERAL_SESSIONS = 500;

/**
 * A record older than this can no longer be about "the previous turn" in any
 * useful sense, so it is dropped rather than warned about.
 */
export const EPHEMERAL_BASH_TTL_MS = 6 * 60 * 60 * 1000;

/** Beyond this the notice lists a "+N more" line instead of every command. */
const MAX_LISTED_SHELLS = 8;

/** Commands can be arbitrarily long; keep the injected notice readable. */
const MAX_COMMAND_CHARS = 160;

/** Bound the pending-result map so a turn full of tool calls can't grow it without limit. */
const MAX_PENDING_TOOL_USES = 64;

const registry = new Map<string, SessionRecord>();

/**
 * Drop expired records, then trim the oldest if still over the session cap.
 * Called on every write, which is the only path that can grow the registry.
 */
function sweep(nowMs: number): void {
  for (const [sessionId, record] of registry) {
    if (nowMs - record.updatedAtMs > EPHEMERAL_BASH_TTL_MS) registry.delete(sessionId);
  }
  if (registry.size <= MAX_TRACKED_EPHEMERAL_SESSIONS) return;
  const oldestFirst = Array.from(registry.entries()).sort(
    (a, b) => a[1].updatedAtMs - b[1].updatedAtMs,
  );
  const excess = registry.size - MAX_TRACKED_EPHEMERAL_SESSIONS;
  for (let i = 0; i < excess; i += 1) registry.delete(oldestFirst[i][0]);
}

function touch(sessionId: string, nowMs: number): SessionRecord {
  const existing = registry.get(sessionId);
  if (existing) {
    existing.updatedAtMs = nowMs;
    return existing;
  }
  const created: SessionRecord = { shells: [], pending: new Map(), updatedAtMs: nowMs };
  registry.set(sessionId, created);
  return created;
}

/** Forget a session once it holds neither shells nor pending lookups. */
function dropIfEmpty(sessionId: string, record: SessionRecord): void {
  if (record.shells.length === 0 && record.pending.size === 0) registry.delete(sessionId);
}

function rememberPending(record: SessionRecord, toolUseId: string, pending: PendingToolUse): void {
  if (record.pending.size >= MAX_PENDING_TOOL_USES) {
    // Drop the oldest insertion — Map preserves insertion order.
    const oldest = record.pending.keys().next();
    if (!oldest.done) record.pending.delete(oldest.value);
  }
  record.pending.set(toolUseId, pending);
}

/**
 * True when a `tool_use` event is a Bash call that asked for a background
 * shell. Engines other than claude-code do not expose the flag, so anything
 * without a literal `true` is treated as foreground.
 */
export function isBackgroundBashToolUse(
  tool: string,
  input: Record<string, unknown> | null | undefined,
): boolean {
  if (tool !== 'Bash') return false;
  if (!input || typeof input !== 'object') return false;
  if (input.run_in_background !== true) return false;
  return typeof input.command === 'string' && input.command.trim().length > 0;
}

/**
 * Pull the CLI's shell handle out of a background-launch tool result. The exact
 * wording is not a stable contract, so several shapes are accepted; when none
 * match the shell simply stays un-identified and can only be resolved by the
 * turn ending (the conservative direction — we warn rather than go silent).
 */
export function parseBackgroundShellId(output: string): string | null {
  if (typeof output !== 'string' || !output) return null;
  const tagged = output.match(/<shell_id>\s*([A-Za-z0-9_-]+)\s*<\/shell_id>/i);
  if (tagged) return tagged[1];
  const labelled = output.match(/\b(?:shell|bash)?\s*id[:=]\s*([A-Za-z0-9_-]+)/i);
  if (labelled) return labelled[1];
  const bareHandle = output.match(/\b(bash_[A-Za-z0-9]+)\b/);
  return bareHandle ? bareHandle[1] : null;
}

/**
 * True when a `BashOutput` result reports a shell that is no longer running.
 * Anything other than an explicit `running` status is treated as terminal, so a
 * new status word the CLI adds later resolves the shell instead of leaving a
 * stale warning behind.
 */
export function isTerminalBashOutputStatus(output: string): boolean {
  if (typeof output !== 'string' || !output) return false;
  const status = output.match(/<status>\s*([A-Za-z_]+)\s*<\/status>/i);
  if (!status) return false;
  return status[1].toLowerCase() !== 'running';
}

/**
 * Record a background Bash shell started during the current turn. Silently caps
 * at {@link MAX_TRACKED_EPHEMERAL_SHELLS} entries per session.
 */
export function recordEphemeralBackgroundBash(
  sessionId: string,
  toolUseId: string,
  input: Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): void {
  if (!sessionId) return;
  const command = typeof input?.command === 'string' ? input.command.trim() : '';
  if (!command) return;
  const record = touch(sessionId, nowMs);
  // After the insert, so the cap counts this session too. `touch` stamped it
  // with `nowMs`, making it the newest — the sweep can never evict it.
  sweep(nowMs);
  if (record.shells.length >= MAX_TRACKED_EPHEMERAL_SHELLS) return;
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  record.shells.push({
    command,
    description: description || null,
    toolUseId: toolUseId || '',
    shellId: null,
  });
  if (toolUseId) rememberPending(record, toolUseId, { kind: 'launch' });
}

/**
 * Remember a `BashOutput` poll so its result can resolve the shell it targets.
 * No-op unless we are already tracking a background shell for this session.
 */
export function noteBashOutputToolUse(
  sessionId: string,
  toolUseId: string,
  input: Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !toolUseId) return;
  const record = registry.get(sessionId);
  if (!record || record.shells.length === 0) return;
  const shellId = typeof input?.bash_id === 'string' ? input.bash_id.trim() : '';
  if (!shellId) return;
  record.updatedAtMs = nowMs;
  rememberPending(record, toolUseId, { kind: 'poll', shellId });
}

/**
 * A `KillShell` call resolves its target immediately — the agent knows the
 * shell is gone, so a next-turn warning about it is noise.
 */
export function noteKillShellToolUse(
  sessionId: string,
  input: Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): void {
  if (!sessionId) return;
  const record = registry.get(sessionId);
  if (!record) return;
  const shellId = typeof input?.shell_id === 'string' ? input.shell_id.trim() : '';
  if (!shellId) return;
  record.updatedAtMs = nowMs;
  record.shells = record.shells.filter((shell) => shell.shellId !== shellId);
  dropIfEmpty(sessionId, record);
}

/**
 * Feed a `tool_result` back in. Resolves the shell handle for a launch, and
 * drops a shell whose `BashOutput` poll reported a terminal status.
 *
 * `isError` is the structured signal that separates the two ways a launch can
 * come back without a parseable handle. A **rejected** launch (denied
 * permission, invalid command, the tool erroring out) never produced a shell at
 * all, so the record is discarded — warning about it next turn would send the
 * agent chasing work that was never started. A **successful** launch whose
 * handle we simply could not parse stays tracked, since it really is running
 * and really will become unreachable.
 */
export function noteEphemeralBackgroundBashToolResult(
  sessionId: string,
  toolUseId: string,
  output: string,
  isError: boolean,
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !toolUseId) return;
  const record = registry.get(sessionId);
  if (!record) return;
  const pending = record.pending.get(toolUseId);
  if (!pending) return;
  record.pending.delete(toolUseId);
  record.updatedAtMs = nowMs;

  if (pending.kind === 'launch') {
    if (isError) {
      record.shells = record.shells.filter((shell) => shell.toolUseId !== toolUseId);
      dropIfEmpty(sessionId, record);
      return;
    }
    const shellId = parseBackgroundShellId(output);
    if (shellId) {
      const shell = record.shells.find((s) => s.toolUseId === toolUseId);
      if (shell) shell.shellId = shellId;
    }
    return;
  }

  if (isTerminalBashOutputStatus(output)) {
    record.shells = record.shells.filter((shell) => shell.shellId !== pending.shellId);
  }
  dropIfEmpty(sessionId, record);
}

/**
 * Read a session's outstanding shells **without** clearing them. The caller
 * builds the notice from this and only clears once the turn it belongs to has
 * actually started — a spawn that fails must not swallow the warning.
 */
export function peekEphemeralBackgroundBash(
  sessionId: string,
  nowMs: number = Date.now(),
): EphemeralBackgroundBash[] {
  if (!sessionId) return [];
  const record = registry.get(sessionId);
  if (!record || record.shells.length === 0) return [];
  if (nowMs - record.updatedAtMs > EPHEMERAL_BASH_TTL_MS) {
    registry.delete(sessionId);
    return [];
  }
  return record.shells.map(({ command, description }) => ({ command, description }));
}

/**
 * Drop a session's records. Called once a turn has successfully spawned (the
 * notice for those shells has been delivered) and on session archive/delete.
 */
export function clearEphemeralBackgroundBash(sessionId: string): void {
  registry.delete(sessionId);
}

function truncateCommand(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_COMMAND_CHARS) return flat;
  return `${flat.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/**
 * The block prepended to the next turn's CLI content. Empty string when the
 * previous turn left no outstanding background shells, so callers can
 * concatenate unconditionally.
 *
 * The copy deliberately claims only that the shells are **unreachable**, not
 * that their work was killed: we cannot see whether a command completed just
 * before the CLI exited, and telling an agent its finished work died would send
 * it off to redo it.
 */
export function buildEphemeralBackgroundBashNotice(
  shells: readonly EphemeralBackgroundBash[],
): string {
  if (shells.length === 0) return '';
  const shown = shells.slice(0, MAX_LISTED_SHELLS);
  const lines = shown.map((shell) => {
    const command = truncateCommand(shell.command);
    const label = shell.description?.trim();
    return label ? `- ${label}: \`${command}\`` : `- \`${command}\``;
  });
  const remaining = shells.length - shown.length;
  if (remaining > 0) lines.push(`- …and ${remaining} more`);
  const subject =
    shells.length === 1
      ? 'A background Bash shell you started in a previous turn is'
      : `${shells.length} background Bash shells you started in a previous turn are`;
  return [
    `⚠️ ${subject} no longer reachable. The CLI process that owned ${shells.length === 1 ? 'it' : 'them'} has exited:`,
    lines.join('\n'),
    'This turn is a new process: `BashOutput` cannot poll them and any output you had not already read is gone. Do not wait on, tail, or poll them. Check the underlying state directly (files, git, containers, the database) before assuming the work did or did not finish, and relaunch only what is actually still missing.',
    'Do not retry with `nohup`, `disown`, `setsid`, or by detaching inside a container — none of those survive either. Use a Hub-owned background shell: `bg.sh start --label "<label>" <command>`. Those are **watched by default**: the Hub wakes this session and hands you the output when the command finishes, so start the work and end your turn rather than polling. `bg.sh status <id>` / `bg.sh logs <id>` still work in any later turn.',
  ].join('\n\n');
}

/**
 * How many recovery continuations a single user turn may trigger. One is
 * enough: the recovery turn carries the notice, so an agent that parks work in
 * another ephemeral shell right after reading it is not going to be talked out
 * of it by a second identical nudge, and an unbounded count would let two
 * turns ping-pong for the life of the session.
 */
export const MAX_EPHEMERAL_BASH_RECOVERY_TURNS = 1;

export type EphemeralBashRecoveryReason =
  | 'recover'
  | 'no_outstanding_shells'
  | 'already_continuing'
  | 'turn_errored'
  | 'chain_cancelled'
  | 'cap_reached';

export interface EphemeralBashRecoveryDecision {
  /** Dispatch a recovery continuation for this session. */
  recover: boolean;
  /**
   * Tell the human the parked work is gone. True only when we are giving up
   * (`cap_reached`) — every other non-recovering reason either continues the
   * turn anyway or is the user's own Stop.
   */
  notifyHuman: boolean;
  reason: EphemeralBashRecoveryReason;
}

/**
 * Decide what to do when a turn closes with native background shells still
 * outstanding.
 *
 * The failure this exists for: an agent starts a long build with
 * `run_in_background: true`, writes "I'll wait for the completion
 * notification", and ends the turn. No notification is ever coming — the shell
 * died with the CLI process — so the session parks on `waiting_for_user_input`
 * and looks, to the human, exactly like it crashed. The existing notice only
 * lands on the *next* turn, which may be hours away.
 *
 * Continuing the turn ourselves delivers that notice immediately, so the agent
 * relaunches under `bg.sh` (or verifies the work landed) instead of the session
 * going silent.
 */
export function planEphemeralBackgroundBashRecovery(input: {
  outstandingShells: number;
  /** The turn is already scheduling another turn (ReAct chain / error retry). */
  autoContinuing: boolean;
  /** The turn ended on an engine error — that path owns its own retry. */
  turnErrored: boolean;
  /** A Stop landed. The user asked for silence; give them silence. */
  chainCancelled: boolean;
  /** Recovery continuations already spent on this user turn. */
  priorRecoveryTurns: number;
}): EphemeralBashRecoveryDecision {
  const deny = (reason: EphemeralBashRecoveryReason): EphemeralBashRecoveryDecision => ({
    recover: false,
    notifyHuman: false,
    reason,
  });
  if (input.outstandingShells <= 0) return deny('no_outstanding_shells');
  if (input.chainCancelled) return deny('chain_cancelled');
  if (input.autoContinuing) return deny('already_continuing');
  if (input.turnErrored) return deny('turn_errored');
  if (input.priorRecoveryTurns >= MAX_EPHEMERAL_BASH_RECOVERY_TURNS) {
    return { recover: false, notifyHuman: true, reason: 'cap_reached' };
  }
  return { recover: true, notifyHuman: false, reason: 'recover' };
}

/**
 * Content for the recovery continuation. Deliberately short: the turn content
 * is already led by {@link buildEphemeralBackgroundBashNotice}, which names the
 * commands. This half only has to kill the "I'll wait for the notification"
 * plan, which is the actual bug.
 */
export function buildEphemeralBackgroundBashRecoveryPrompt(): string {
  return [
    'Your turn ended while background Bash shells were still running, so they were reaped with the turn. **No completion notification is coming** — nothing is watching them, and waiting for one would leave this session idle indefinitely.',
    'Continue now: verify directly whether the work landed (files, git, containers, the database), then relaunch anything still missing with `bg.sh start --label "<label>" <command>` and report what you found. Do not end this turn waiting on a `run_in_background` shell.',
    'A `bg.sh` shell **is** watched: the Hub owns the process, so it survives the turn and wakes this session with the output when it finishes. Relaunching there is what turns "I will wait for the result" into something that actually happens.',
  ].join('\n\n');
}

/**
 * Transcript notice for the human once recovery is exhausted. Without it the
 * session simply stops mid-thought, which is what "sessions keep dying" looked
 * like from the outside.
 */
export function buildEphemeralBackgroundBashHaltNotice(
  shells: readonly EphemeralBackgroundBash[],
): string {
  const shown = shells
    .slice(0, MAX_LISTED_SHELLS)
    .map((s) => `- \`${truncateCommand(s.command)}\``);
  const remaining = shells.length - shown.length;
  if (remaining > 0) shown.push(`- …and ${remaining} more`);
  const noun = shells.length === 1 ? 'shell' : 'shells';
  return [
    `⚠️ This turn ended with ${shells.length} background Bash ${noun} still running. They were reaped with the turn's CLI process and their output is gone:`,
    shown.join('\n'),
    'The agent was already asked once to relaunch them as Hub-owned background shells and did not. Send a message to continue, or re-run the work yourself — no completion notification is coming.',
  ].join('\n\n');
}

/** Test-only: drop all tracked state. */
export function _resetEphemeralBackgroundBashForTesting(): void {
  registry.clear();
}

/** Test-only: outstanding shells for a session, with internal fields. */
export function _trackedEphemeralBackgroundBashForTesting(
  sessionId: string,
): readonly TrackedShell[] {
  return registry.get(sessionId)?.shells ?? [];
}

/** Test-only: how many sessions the registry currently holds. */
export function _trackedSessionCountForTesting(): number {
  return registry.size;
}
