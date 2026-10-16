/**
 * The `computer` ReAct tool (SPEC-6): host-executed ops against the agent's
 * persistent Linux desktop, so every engine drives it the same way through
 * `<agenthub:react>`. The op set mirrors the control daemon's (and roughly
 * Anthropic's computer-use tool) in a fixed DESKTOP_SCREEN coordinate space.
 *
 * Operands are validated with the daemon's own parser before the runtime is
 * touched, so a malformed op never boots a desktop and both backends accept
 * exactly the same input.
 */
import {
  OpValidationError,
  parseMouseLocation,
  parseOp,
  type DesktopOp,
} from './control-daemon.js';
import {
  DESKTOP_DISPLAY,
  DESKTOP_SCREEN,
  type DesktopComputerKey,
  type DesktopRuntime,
} from './desktop-runtime.js';
import {
  formatScreenshotBytes,
  resolveScreenshotDataDir,
  saveBrowserScreenshot,
} from '../browser-screenshot-store.js';

export const COMPUTER_REACT_OPS = [
  'screenshot',
  'click',
  'double_click',
  'type',
  'key',
  'scroll',
  'drag',
  'wait',
  'cursor_position',
  'exec',
] as const;
export type ComputerReactOp = (typeof COMPUTER_REACT_OPS)[number];
export const COMPUTER_REACT_OP_SET: ReadonlySet<string> = new Set(COMPUTER_REACT_OPS);

/** Per-stream cap on exec output echoed into the observation. */
export const COMPUTER_EXEC_OUTPUT_MAX_CHARS = 8_000;
const CURSOR_TIMEOUT_MS = 15_000;

export type ParsedComputerAction = { ok: true; op: DesktopOp } | { ok: false; detail: string };

/**
 * Validate a raw `{tool:'computer', ...}` action. `key` is accepted as an
 * alias for `combo` and `timeout_ms` for `timeoutMs`, since models trained on
 * other tool shapes emit them.
 */
export function parseComputerReactAction(raw: Record<string, unknown>): ParsedComputerAction {
  const op = typeof raw.op === 'string' ? raw.op.trim().toLowerCase() : '';
  if (!COMPUTER_REACT_OP_SET.has(op)) {
    return {
      ok: false,
      detail: `computer action requires op as one of: ${COMPUTER_REACT_OPS.join(', ')}`,
    };
  }
  const body: Record<string, unknown> = { ...raw, op };
  delete body.tool;
  if (body.combo === undefined && typeof raw.key === 'string') body.combo = raw.key;
  if (body.timeoutMs === undefined && raw.timeout_ms !== undefined) body.timeoutMs = raw.timeout_ms;
  try {
    return { ok: true, op: parseOp(body, DESKTOP_SCREEN) };
  } catch (err) {
    if (err instanceof OpValidationError) {
      return { ok: false, detail: `computer ${op}: ${err.message}` };
    }
    throw err;
  }
}

export interface ComputerReactContext {
  sessionId: string;
  ownerUserId: string | null;
  agentId: string;
  projectId: string | null;
}

export interface ComputerReactDeps {
  /** The active DesktopRuntime; throws when the host has none. */
  resolveRuntime: () => DesktopRuntime | Promise<DesktopRuntime>;
  dataDir?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface ComputerReactResult {
  markdown: string;
  hostExit: number;
  hostDetail: string;
  /** Absolute path of a saved screenshot, when the op produced one. */
  screenshotPath?: string;
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function clip(text: string): string {
  if (text.length <= COMPUTER_EXEC_OUTPUT_MAX_CHARS) return text;
  const dropped = text.length - COMPUTER_EXEC_OUTPUT_MAX_CHARS;
  return `[${dropped} earlier characters omitted]\n${text.slice(-COMPUTER_EXEC_OUTPUT_MAX_CHARS)}`;
}

function fence(text: string): string {
  const body = text.replace(/\n$/, '');
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}\n${body}\n${ticks}`;
}

const SURFACE_LINE = `Surface: desktop (${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height}, origin top-left)`;

function summarize(op: DesktopOp): string {
  switch (op.op) {
    case 'click':
    case 'double_click':
      return `${op.op} ${op.button} at (${op.x}, ${op.y})`;
    case 'scroll':
      return `scroll ${op.direction} ×${op.amount} at (${op.x}, ${op.y})`;
    case 'drag':
      return `drag (${op.x}, ${op.y}) → (${op.toX}, ${op.toY})`;
    case 'type':
      return `typed ${Array.from(op.text).length} character(s)`;
    case 'key':
      return `pressed ${op.combo}`;
    default:
      return op.op;
  }
}

function done(op: string, lines: string[], hostExit = 0, extra: Partial<ComputerReactResult> = {}) {
  return {
    markdown: [`## Computer: ${op}`, '', ...lines, '', SURFACE_LINE].join('\n'),
    hostExit,
    hostDetail: hostExit === 0 ? op : `${op}_failed`,
    ...extra,
  } satisfies ComputerReactResult;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one validated op against the session owner's desktop. Never throws. */
export async function runComputerReActStep(
  op: DesktopOp,
  ctx: ComputerReactContext,
  deps: ComputerReactDeps,
): Promise<ComputerReactResult> {
  if (op.op === 'wait') {
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(op.ms);
    return done('wait', [`Waited ${op.ms} ms.`]);
  }
  if (!ctx.ownerUserId || !ctx.projectId) {
    return done(
      op.op,
      [
        'This session has no owning user or project, and a desktop belongs to one (user, agent, project). The op did not run.',
      ],
      2,
    );
  }
  const key: DesktopComputerKey = {
    userId: ctx.ownerUserId,
    agentId: ctx.agentId,
    projectId: ctx.projectId,
  };
  try {
    const runtime = await deps.resolveRuntime();
    switch (op.op) {
      case 'screenshot': {
        const png = await runtime.screenshot(key);
        const dims = pngDimensions(png) ?? DESKTOP_SCREEN;
        const saved = saveBrowserScreenshot({
          sessionId: ctx.sessionId,
          dataDir: deps.dataDir ?? resolveScreenshotDataDir(),
          imageBase64: png.toString('base64'),
          mime: 'image/png',
          label: 'desktop',
        });
        if (!saved) {
          return done(
            'screenshot',
            [
              `Screenshot captured (${dims.width}x${dims.height}) but could not be written to disk, so there is no path to read.`,
            ],
            1,
          );
        }
        return done(
          'screenshot',
          [
            `Screenshot saved to \`${saved.absPath}\` (${dims.width}x${dims.height}, ${formatScreenshotBytes(saved.bytes)}, image/png).`,
            'Read that path with your file-reading tool to view the image. Click coordinates use the same pixel grid.',
          ],
          0,
          { screenshotPath: saved.absPath },
        );
      }
      case 'cursor_position': {
        const r = await runtime.exec(
          key,
          `DISPLAY=${DESKTOP_DISPLAY} xdotool getmouselocation --shell`,
          { timeoutMs: CURSOR_TIMEOUT_MS },
        );
        if (r.exitCode !== 0) {
          throw new Error(`xdotool getmouselocation failed: ${r.stderr.trim() || r.exitCode}`);
        }
        const { x, y } = parseMouseLocation(r.stdout);
        return done('cursor_position', [`Cursor is at (${x}, ${y}).`]);
      }
      case 'exec': {
        const r = await runtime.exec(key, op.command, {
          timeoutMs: op.timeoutMs,
          ...(op.cwd ? { cwd: op.cwd } : {}),
        });
        const lines = [
          r.timedOut
            ? `Command timed out after ${op.timeoutMs} ms (exit ${r.exitCode}).`
            : `Command exited ${r.exitCode}.`,
        ];
        if (r.stdout) lines.push('', 'stdout:', fence(clip(r.stdout)));
        if (r.stderr) lines.push('', 'stderr:', fence(clip(r.stderr)));
        if (!r.stdout && !r.stderr) lines.push('(no output)');
        return done('exec', lines, r.exitCode === 0 && !r.timedOut ? 0 : 1);
      }
      case 'click':
      case 'double_click':
        await runtime.input(key, { type: op.op, x: op.x, y: op.y, button: op.button });
        break;
      case 'type':
        await runtime.input(key, { type: 'type', text: op.text });
        break;
      case 'key':
        await runtime.input(key, { type: 'key', combo: op.combo });
        break;
      case 'scroll':
        await runtime.input(key, {
          type: 'scroll',
          x: op.x,
          y: op.y,
          direction: op.direction,
          amount: op.amount,
        });
        break;
      case 'drag':
        await runtime.input(key, {
          type: 'drag',
          fromX: op.x,
          fromY: op.y,
          toX: op.toX,
          toY: op.toY,
        });
        break;
    }
    return done(op.op, [`Done: ${summarize(op)}. Take a screenshot to see the result.`]);
  } catch (err) {
    return done(op.op, [`The desktop op failed: ${errorMessage(err)}`], 1);
  }
}

/** Observation for a `computer` action on an agent whose tool is switched off. */
export const COMPUTER_TOOL_DISABLED_MARKDOWN =
  '## Computer tool disabled\n\nThe `computer` tool is off for this session (it is off unless the user turns it on). Remove `tool: computer` entries from your `<agenthub:react>` block, or ask the user to turn on **Computer tool** for this session, or as the default for this agent under Settings → Agents.';

/** First-turn ReAct tool line, shown only when the agent has the tool on. */
export const COMPUTER_TOOL_PROMPT_LINE = `- \`computer\` — drive **your own persistent Linux desktop** (Xvfb + openbox + Chromium, ${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height}, origin top-left; files, downloads and app logins survive between sessions). Ops: \`screenshot\` (saves a PNG and returns its absolute path plus width x height; read the path with your file-reading tool), \`click\` / \`double_click\` (\`x\`, \`y\`, optional \`button\`: left|middle|right), \`type\` (\`text\`), \`key\` (\`combo\`, xdotool names like \`ctrl+l\` or \`Return\`; space-separate a sequence), \`scroll\` (\`x\`, \`y\`, \`direction\`: up|down|left|right, optional \`amount\` 1-50), \`drag\` (\`x\`, \`y\`, \`toX\`, \`toY\`), \`wait\` (\`ms\`, max 30000), \`cursor_position\`, \`exec\` (\`command\` run by bash inside the desktop, optional \`timeoutMs\` and absolute \`cwd\`). Example: \`{"tool":"computer","op":"click","x":640,"y":400}\`. The desktop boots on first use (can take a minute) and stops after 30 idle minutes. Take a screenshot before clicking and after anything that changes the screen; coordinates come from the screenshot's pixel grid. Request an \`approval\` before sending, submitting, deleting, purchasing or publishing from the desktop.`;

/** Follow-up-turn reminder, shown only when the agent has the tool on. */
export const COMPUTER_TOOL_REMINDER = `\n\`computer\` drives your persistent ${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height} Linux desktop: \`screenshot\`, \`click\`, \`double_click\`, \`type\`, \`key\`, \`scroll\`, \`drag\`, \`wait\`, \`cursor_position\`, \`exec\`. Screenshot first; coordinates are screenshot pixels.`;
