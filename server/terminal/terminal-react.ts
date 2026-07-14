/**
 * terminal-react.ts — host-mediated `tool: terminal` ReAct actions.
 *
 * Lets an agent co-observe and take a turn on the **shared PTY** that a human
 * already opened for the agent's own session: read the current terminal
 * screen/scrollback and inject a single command line — but only at an idle
 * prompt, funneled through the same single-writer queue every human keystroke
 * uses.
 *
 * Invariants (mirror the preview tool + shared-pty decisions):
 * - **Lifecycle stays human-only.** There is no op that opens or kills a PTY.
 *   The shell boots lazily when a human attaches the Terminal tab; if no live
 *   shell exists for the session the agent gets a clear "no terminal" reading,
 *   never a spawned shell. (This also sidesteps the Sysbox constraint where a
 *   terminal-first standalone env would block a later dev-server start.)
 * - **Turn-taking, idle-prompt only.** An injected command lands only when the
 *   write queue is idle (no human keystrokes mid-flight) AND the shell has been
 *   output-quiet for a quiet window (approximating "sitting at a prompt", since
 *   a shell prompt can't be parsed reliably). Otherwise inject is refused with a
 *   retryable reason so the agent can't wedge into a human's line or a running
 *   command.
 * - **One whole line through the single writer queue.** The command is enqueued
 *   as one indivisible message with exactly one trailing newline, so it can
 *   never interleave with a concurrent master write. Embedded newlines are
 *   rejected — one inject is one line.
 * - **Own session only.** The PTY is resolved from the chat session id; there is
 *   no way to address another session's terminal.
 */

import type { BrowserReActStepOutcome } from '../browser-tools.js';
import { clipUtf8StringToMaxBytes } from '../utf8-clip.js';
import {
  evaluateInjectIdle,
  type InjectAtIdleOpts,
  type InjectAtIdleResult,
} from './pty-session.js';

// Re-export the gate so callers / tests keep a single import surface for the
// tool. The predicate itself lives in pty-session.ts next to the atomic
// `injectAtIdle` reservation it backs.
export { evaluateInjectIdle };

/** Single source of truth for ReAct `tool: terminal` operations. */
export const TERMINAL_REACT_OPS = ['state', 'read', 'inject'] as const;
export type TerminalReActOp = (typeof TERMINAL_REACT_OPS)[number];
export const TERMINAL_REACT_OP_SET: ReadonlySet<string> = new Set(TERMINAL_REACT_OPS);

/** Default output-quiet window before an inject is allowed (turn-taking). */
export const DEFAULT_TERMINAL_INJECT_QUIET_WINDOW_MS = 750;
/** Byte cap for the terminal snapshot injected into continuation markdown. */
export const TERMINAL_READ_MARKDOWN_MAX_BYTES = 48_000;
/** Reject absurd single-line commands early (defense-in-depth vs the WS cap). */
export const TERMINAL_INJECT_MAX_COMMAND_BYTES = 8_192;

/** Fields parsed from `<agenthub:react>` terminal actions (see chat.ts). */
export interface TerminalReActActionInput {
  op: string;
  /** inject — the single command line to run (no embedded newlines). */
  command?: string;
}

/**
 * Read-only + single-writer view of one session's PTY the tool needs. A live
 * {@link PtySession} satisfies it structurally, so the runtime adapter is just
 * a `getSession` lookup with no stateful wrapper.
 */
export interface AgentTerminalView {
  status: string;
  isRunning: boolean;
  viewerCount: number;
  pid: number | null;
  /** Epoch ms of the last PTY output (or shell start); 0 before the shell runs. */
  lastOutputAt: number;
  /** True when no input is queued/draining/paused on the single writer queue. */
  inputQueueIdle: boolean;
  /** True when the input line holds un-submitted characters (human mid-command). */
  promptLineDirty: boolean;
  readSnapshot(): Promise<string | null>;
  /**
   * Atomic turn-taking reservation: the idle-gate check and the enqueue happen
   * in one synchronous step inside the PTY host, so a human keystroke can't
   * interleave between them. The tool never writes the PTY directly.
   */
  injectAtIdle(line: string, opts: InjectAtIdleOpts): InjectAtIdleResult;
}

export interface TerminalReactRuntime {
  /** The live PTY for `sessionId`, or undefined when none has been opened. */
  getSession(sessionId: string): AgentTerminalView | undefined;
}

export interface TerminalReActDeps {
  /** Null when no PTY host is wired (legacy deploys, some tests). */
  runtime: TerminalReactRuntime | null;
  /** Clock for the quiet-window check. Default `Date.now`. */
  now?: () => number;
  /** Output-quiet window (ms) required before an inject is allowed. */
  quietWindowMs?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────

function outcome(
  markdown: string,
  hostExit: number,
  hostDetail: string,
  summary: string,
  errorLine?: string,
): BrowserReActStepOutcome {
  return {
    markdown,
    hostExit,
    hostDetail,
    ui: { summary, ...(errorLine ? { errorLine } : {}) },
  };
}

const NO_TERMINAL_MARKDOWN = [
  '## Terminal tool',
  '',
  'No terminal shell is running for this session. The shared terminal is',
  'human-opened — ask the user to open the **Terminal** tab for this session,',
  'then retry. (This tool never spawns a shell itself.)',
  '',
  'For your own scripted commands, use your normal Bash tool — the shared',
  'terminal is for co-observation and deliberate turn-taking with the human.',
].join('\n');

/**
 * Defang untrusted terminal bytes before embedding them in the model's
 * continuation context. Terminal scrollback is fully attacker-controlled — a
 * test fixture, log line, or hostile program can print anything — so it must
 * not be able to (a) break out of the markdown code fence we wrap it in, or
 * (b) forge an Agent Hub control block / instruction the host or model would
 * act on. A zero-width space (U+200B) is stitched into each dangerous token so
 * the text still reads correctly to the model but no literal sequence survives:
 *   - runs of ``` / ~~~ (fence closers) are broken so scrollback can't escape
 *     the fence and inject free markdown;
 *   - naked `<agenthub:…>` / `</agenthub:…>` control tags and the
 *     `agenthub:ask` fenced-block trigger are neutralized so forged tags in
 *     scrollback are never parsed as real control blocks.
 */
export function defangTerminalTextForPrompt(text: string): string {
  const ZWSP = '\u200b';
  return text
    .replace(/`{3,}/g, (m) => m.split('').join(ZWSP))
    .replace(/~{3,}/g, (m) => m.split('').join(ZWSP))
    .replace(/<(\/?)(agenthub:)/gi, `<$1${ZWSP}$2`)
    .replace(/agenthub:ask/gi, `agenthub${ZWSP}:ask`);
}

/**
 * Validate the command for a single-line inject. Rejects empty/whitespace-only
 * input, embedded newlines (one inject = one line), and oversize payloads.
 */
export function validateInjectCommand(
  raw: string | undefined,
): { ok: true; command: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: 'inject requires a non-empty `command` string.' };
  }
  if (/[\r\n]/.test(raw)) {
    return {
      ok: false,
      error:
        'inject `command` must be a single line (no embedded newlines) — the ' +
        'trailing newline that runs it is added for you.',
    };
  }
  if (Buffer.byteLength(raw, 'utf8') > TERMINAL_INJECT_MAX_COMMAND_BYTES) {
    return {
      ok: false,
      error: `inject \`command\` exceeds ${TERMINAL_INJECT_MAX_COMMAND_BYTES} bytes.`,
    };
  }
  return { ok: true, command: raw };
}

// ─── Main entry ──────────────────────────────────────────────────

/**
 * Run one `tool: terminal` action for `chatSessionId`. Mirrors the
 * {@link BrowserReActStepOutcome} contract used by the `preview`/`browser`
 * tools so the chat dispatcher treats all three uniformly. Never throws for
 * expected states (no terminal, busy, bad op) — those return hostExit 1/2 with
 * markdown the model can act on.
 */
export async function runTerminalReActStep(
  chatSessionId: string,
  input: TerminalReActActionInput,
  deps: TerminalReActDeps,
): Promise<BrowserReActStepOutcome> {
  const opRaw = typeof input.op === 'string' ? input.op.trim().toLowerCase() : '';
  if (!opRaw || !TERMINAL_REACT_OP_SET.has(opRaw)) {
    return outcome(
      `## Terminal tool error\nUnsupported or missing op "${opRaw}"`,
      1,
      'bad_op',
      'Unsupported terminal action',
      opRaw ? `Unknown op "${opRaw}"` : 'Missing terminal op',
    );
  }
  const op = opRaw as TerminalReActOp;

  if (!deps.runtime) {
    return outcome(
      '## Terminal tool\nNo terminal host is available on this server, so terminal actions cannot be served.',
      2,
      'runtime_unwired',
      'Terminal host unavailable',
    );
  }

  const view = deps.runtime.getSession(chatSessionId);
  if (!view || !view.isRunning) {
    return outcome(NO_TERMINAL_MARKDOWN, 2, 'no_terminal', 'No terminal running');
  }

  const now = (deps.now ?? (() => Date.now()))();
  const quietWindowMs = deps.quietWindowMs ?? DEFAULT_TERMINAL_INJECT_QUIET_WINDOW_MS;

  if (op === 'state') {
    const gate = evaluateInjectIdle(view, now, quietWindowMs);
    const state = {
      status: view.status,
      running: view.isRunning,
      viewers: view.viewerCount,
      pid: view.pid,
      inputIdle: gate.idle,
      promptLineDirty: view.promptLineDirty,
      msSinceOutput: view.lastOutputAt > 0 ? Math.max(0, now - view.lastOutputAt) : null,
    };
    return outcome(
      [
        '## Terminal: state',
        '',
        '```json',
        JSON.stringify(state, null, 2),
        '```',
        gate.idle ? '' : `\nNot ready to inject: ${gate.reason}`,
      ]
        .join('\n')
        .trimEnd(),
      0,
      `state:${view.status}`,
      `Terminal is ${view.status}${gate.idle ? ' (idle prompt)' : ' (busy)'}`,
    );
  }

  if (op === 'read') {
    const snapshot = await view.readSnapshot();
    const body =
      snapshot && snapshot.length > 0
        ? defangTerminalTextForPrompt(
            clipUtf8StringToMaxBytes(snapshot, TERMINAL_READ_MARKDOWN_MAX_BYTES),
          )
        : '(terminal buffer is empty)';
    return outcome(
      ['## Terminal: read', '', '```text', body, '```'].join('\n'),
      0,
      'read',
      'Read terminal buffer',
    );
  }

  // op === 'inject'
  const validated = validateInjectCommand(input.command);
  if (!validated.ok) {
    return outcome(
      `## Terminal tool error\n${validated.error}`,
      1,
      'bad_command',
      'Invalid inject command',
      validated.error,
    );
  }

  // One whole line, exactly one trailing newline. The idle-gate check and the
  // enqueue happen atomically inside the PTY host (injectAtIdle) so a human
  // keystroke can't slip in between the check and the write.
  const res = view.injectAtIdle(`${validated.command}\n`, { now, quietWindowMs });
  if (!res.ok && res.deferred) {
    return outcome(
      [
        '## Terminal: inject deferred',
        '',
        `The command was **not** injected — turn-taking gate held it back.`,
        '',
        res.reason,
        '',
        'Use `{"tool":"terminal","op":"state"}` to check readiness, then retry.',
      ].join('\n'),
      1,
      'inject_busy',
      'Terminal busy — inject deferred',
      res.reason,
    );
  }
  if (!res.ok) {
    return outcome(
      `## Terminal tool error\nThe terminal did not accept the command: ${res.reason}`,
      1,
      'inject_rejected',
      'Terminal inject rejected',
      res.reason,
    );
  }

  const clipped =
    validated.command.length > 200 ? `${validated.command.slice(0, 199)}…` : validated.command;
  // The command is the agent's own text, but it can still carry a ``` run that
  // would break the echo fence — defang it the same way.
  const shown = defangTerminalTextForPrompt(clipped);
  return outcome(
    [
      '## Terminal: inject',
      '',
      'Command injected at the idle prompt (through the shared single-writer queue):',
      '',
      '```bash',
      shown,
      '```',
      '',
      'Read the result with `{"tool":"terminal","op":"read"}` once it has run.',
    ].join('\n'),
    0,
    'inject',
    'Injected terminal command',
  );
}

/**
 * Adapt a {@link PtyHost}-like registry (any `get(sessionId)` returning an
 * {@link AgentTerminalView}) into the runtime the ReAct step consumes. Uses
 * `get` (not `ensure`) so the agent never boots a shell — lifecycle stays
 * human-only.
 */
export function createTerminalReactRuntime(host: {
  get(sessionId: string): AgentTerminalView | undefined;
}): TerminalReactRuntime {
  return {
    getSession: (sessionId) => host.get(sessionId),
  };
}
