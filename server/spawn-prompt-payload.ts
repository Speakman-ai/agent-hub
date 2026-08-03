/**
 * Helpers for passing oversized prompts to spawned CLI children without
 * tripping the Linux kernel's `MAX_ARG_STRLEN` cap (= `PAGE_SIZE * 32` =
 * 131072 bytes on x86_64). That cap applies per **single argv element**,
 * not to the total argv+env size — so a 200KB enriched system prompt
 * passed as a single `--system-prompt <value>` pair triggers `spawn
 * E2BIG` regardless of how small everything else is.
 *
 * Strategy by engine (see `chat.ts` for the wiring):
 *
 *   • claude-code  — uses `--system-prompt-file <path>` (documented
 *                    upstream flag). We write the enriched prompt to a
 *                    per-spawn temp file and the CLI reads it from disk.
 *   • codex-cli    — uses the `-` stdin sentinel (`codex exec -`). The
 *                    full combined prompt is piped via the child's stdin
 *                    and the positional argv carries only the sentinel.
 *   • cursor-agent — no documented file or stdin alternative. We apply
 *                    a soft cap (`SAFE_ARG_STRLEN_BYTES`) and trim the
 *                    enriched prefix when needed, emitting a `TOOL_ERROR`
 *                    so growth shows up in session-health mining.
 *   • gemini-cli   — same constraint as cursor; same cap-and-trim path.
 *
 * The 100 KB soft cap is well below the kernel's 128 KiB hard ceiling
 * but leaves ~28 KB of headroom for any flags Claude/Codex still pass
 * inline (engine-session-id, model, config paths, etc.). It is not
 * a hard wall on the agent's behalf — it's a defense against the cliff.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Linux kernel cap on a single argv element. Set to `PAGE_SIZE * 32`
 * in `fs/exec.c`. On all of Agent Hub's target hosts (x86_64 / arm64
 * with 4 KiB pages) this is exactly 131072 bytes. This is the value
 * that produces `spawn E2BIG` when exceeded.
 */
export const MAX_ARG_STRLEN_BYTES = 131072;

/**
 * Soft cap we enforce ourselves. Picked so that:
 *   • Other argv flags (model id, config path, session id) fit
 *     comfortably below the kernel ceiling even after concatenation
 *     with the prompt.
 *   • There's enough margin that the prompt builder can grow modestly
 *     (one more skill loaded, a slightly chattier daily note) without
 *     immediately re-tripping the cliff.
 *
 * If a future engine grows argv-flags that approach this margin, lower
 * the cap rather than raise it — the kernel limit is non-negotiable.
 */
export const SAFE_ARG_STRLEN_BYTES = 100_000;

/**
 * Write the enriched system prompt to a per-spawn temp file. Used by
 * the claude-code branch in `chat.ts` to pass `--system-prompt-file
 * <path>` instead of `--system-prompt <huge string>`.
 *
 * Returns the absolute path and a `cleanup()` thunk. The caller is
 * responsible for invoking `cleanup()` after the child exits — typically
 * from the `proc.on('close')` handler. Best-effort: rm failures are
 * swallowed so a stray temp file never breaks a turn.
 */
export function writeSystemPromptFile(
  enrichedPrompt: string,
  sessionId: string,
): { path: string; cleanup: () => void } {
  // mkdtempSync gives us a unique per-spawn directory. We put a single
  // file in it so the cleanup can be a simple recursive rm without
  // worrying about other tenants of `tmpdir()`.
  const dir = mkdtempSync(path.join(os.tmpdir(), `agent-hub-prompt-${sessionId.slice(0, 8)}-`));
  const filePath = path.join(dir, 'system-prompt.md');
  writeFileSync(filePath, enrichedPrompt, { encoding: 'utf8', mode: 0o600 });
  return {
    path: filePath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Soft truncation guard for engines without a file/stdin escape hatch
 * (cursor-agent, gemini-cli). Returns the prompt unchanged when below
 * the cap; otherwise trims the enriched prefix from the front (preserving
 * the user-facing tail / final prompt) and returns the trimmed result
 * with a `truncated` signal so the caller can emit `TOOL_ERROR`.
 *
 * The semantics are deliberately simple: we keep the last
 * `SAFE_ARG_STRLEN_BYTES` of the combined prompt and prefix a single
 * marker line so the agent (and any reviewer looking at the transcript)
 * knows truncation happened. We do not attempt to surgically excise
 * specific sections of the enriched prompt — that's the lazy-load
 * follow-up (option 2) tracked separately.
 *
 * @returns `{ prompt, truncated, originalBytes }` — when `truncated` is
 *          true the caller should also emit a structured `TOOL_ERROR`
 *          line so the growth pattern surfaces in session health.
 */
export function applyArgvPromptCap(
  prompt: string,
  cap: number = SAFE_ARG_STRLEN_BYTES,
): { prompt: string; truncated: boolean; originalBytes: number } {
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes <= cap) return { prompt, truncated: false, originalBytes: bytes };

  // Keep the tail: that's where the user's actual current-turn message
  // lives. Drop the head (enriched system prompt + retrieved context),
  // which is the unbounded part. Leave room for the marker prefix.
  const marker =
    `[NOTE: enriched system prompt truncated by ${bytes - cap}+ bytes to fit ` +
    `the engine's argv cap. See TOOL_ERROR log for details.]\n\n`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const keepBytes = Math.max(0, cap - markerBytes);

  // Slice by characters rather than bytes; for ASCII-heavy prompts the
  // difference is negligible, and for multi-byte characters we err on
  // the side of keeping fewer bytes (= safer) than `cap`.
  const sliceStart = Math.max(0, prompt.length - keepBytes);
  const trimmed = marker + prompt.slice(sliceStart);
  return { prompt: trimmed, truncated: true, originalBytes: bytes };
}

/**
 * Emit a structured TOOL_ERROR line covering an argv-cap truncation
 * event. Centralized here so all three call sites (cursor, gemini, and
 * any future engine that lacks file/stdin support) log the same shape.
 *
 * The v2 JSON tail uses `sev: "soft"` because truncation does not block
 * the turn — the agent still runs, just with less context. Mining this
 * tag (`argv-cap`) over time tells us whether to invest in lazy-loading
 * skill references vs continuing to grow the inline prompt.
 */
export function logArgvCapTruncation(
  engine: string,
  sessionId: string,
  originalBytes: number,
  cap: number,
): void {
  const summary = `enriched prompt ${originalBytes}B > argv cap ${cap}B; trimmed to fit`;
  const meta = JSON.stringify({
    v: 2,
    sev: 'soft',
    resolution: 'recovered',
    session: sessionId,
    tags: ['argv-cap', 'spawn', engine],
  });
  console.error(
    `TOOL_ERROR | ${new Date().toISOString()} | spawn-prompt | argv-cap-trim | warn | ${summary} | ${meta}`,
  );
}

/**
 * Header the history-bootstrap prompt opens with. Kept as a constant so
 * tests and the budget accounting agree on the exact bytes.
 */
export const HISTORY_BOOTSTRAP_HEADER = 'Previous conversation:\n';

/**
 * Smallest slice of a single message worth inlining. Below this a partial
 * message is more confusing than helpful, so the message is dropped and
 * counted in the omission notice instead.
 */
const MIN_MESSAGE_KEEP_BYTES = 2_000;

/** Fraction of a middle-truncated message's budget spent on its head. */
const MIDDLE_TRUNCATE_HEAD_RATIO = 0.4;

export interface HistoryBootstrapMessage {
  role: string;
  content: string;
}

export interface HistoryBootstrapResult {
  /**
   * Prompt to hand the engine, within `cap` — with exactly one exception:
   * when `currentTurn` alone exceeds `cap` the turn is passed through
   * untrimmed, because dropping the user's actual question is worse than
   * overshooting a soft cap the engine branch trims again.
   */
  prompt: string;
  /** True when any history content was elided to fit. */
  truncated: boolean;
  /** Prior messages left out entirely (oldest-first). */
  omittedMessages: number;
  /** Byte size of the untruncated prompt, for logging. */
  originalBytes: number;
}

function historyRoleLabel(role: string): string {
  return role === 'user' ? 'Human' : 'Assistant';
}

function renderHistoryBlock(m: HistoryBootstrapMessage): string {
  return `${historyRoleLabel(m.role)}: ${m.content}\n\n`;
}

function renderOmissionNotice(count: number): string {
  return (
    `[NOTE: ${count} earlier message${count === 1 ? '' : 's'} omitted — this conversation ` +
    `exceeded the engine's prompt budget. Ask the user for anything you need from the ` +
    `missing history rather than assuming it was never said.]\n\n`
  );
}

/**
 * Smallest prompt that still carries the current turn.
 *
 * Keeps the header and the omission notice when they fit inside `cap` so the
 * agent still learns that history was dropped; falls back to the bare current
 * turn when even that framing would overflow. Returns something larger than
 * `cap` only when `currentTurn` alone already exceeds it — the current turn is
 * never trimmed here, because losing the user's actual question is worse than
 * overshooting a soft cap the engine branch trims again.
 */
function currentTurnOnlyPrompt(currentTurn: string, omittedMessages: number, cap: number): string {
  const framed =
    HISTORY_BOOTSTRAP_HEADER + renderOmissionNotice(omittedMessages) + `Human: ${currentTurn}`;
  return Buffer.byteLength(framed, 'utf8') <= cap ? framed : currentTurn;
}

/**
 * Keep the head and the tail of an oversized message, eliding the middle.
 *
 * Head-and-tail rather than tail-only because a forwarded transcript puts
 * the forwarder's own instructions and the provenance marker at the very
 * top — dropping those is what makes an agent look like it ignored the
 * forward entirely.
 */
function truncateMessageMiddle(text: string, budget: number): string {
  let headChars = Math.floor(budget * MIDDLE_TRUNCATE_HEAD_RATIO);
  let tailChars = Math.floor(budget * (1 - MIDDLE_TRUNCATE_HEAD_RATIO));
  // Budget is bytes, the slices are characters; shrink until multi-byte
  // content stops overshooting.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (headChars + tailChars >= text.length) return text;
    const omitted = text.length - headChars - tailChars;
    const marker = `\n\n[... ${omitted} characters omitted from the middle of this message ...]\n\n`;
    const out = text.slice(0, headChars) + marker + text.slice(text.length - tailChars);
    if (Buffer.byteLength(out, 'utf8') <= budget) return out;
    headChars = Math.floor(headChars * 0.85);
    tailChars = Math.floor(tailChars * 0.85);
  }
  return '';
}

/**
 * Build the "history bootstrap" prompt sent on the first turn of a session
 * that already has stored messages but no engine session id yet (a forwarded
 * session, a pre-seeded card session, a session whose resume id was cleared).
 *
 * The current turn is never sacrificed; history is filled in newest-first up
 * to `cap`, and anything that doesn't fit is elided with a marker the agent
 * can see. Silently returning the current turn alone — the previous behavior —
 * meant a forwarded session's entire context vanished with no signal to the
 * user or the agent.
 */
export function buildHistoryBootstrapPrompt(
  priorMessages: HistoryBootstrapMessage[],
  currentTurn: string,
  cap: number = SAFE_ARG_STRLEN_BYTES,
): HistoryBootstrapResult {
  if (priorMessages.length === 0) {
    return {
      prompt: currentTurn,
      truncated: false,
      omittedMessages: 0,
      originalBytes: Buffer.byteLength(currentTurn, 'utf8'),
    };
  }

  const turnBlock = `Human: ${currentTurn}`;
  const blocks = priorMessages.map(renderHistoryBlock);
  const full = HISTORY_BOOTSTRAP_HEADER + blocks.join('') + turnBlock;
  const originalBytes = Buffer.byteLength(full, 'utf8');
  if (originalBytes <= cap) {
    return { prompt: full, truncated: false, omittedMessages: 0, originalBytes };
  }

  const reserved = Buffer.byteLength(
    HISTORY_BOOTSTRAP_HEADER + renderOmissionNotice(priorMessages.length) + turnBlock,
    'utf8',
  );
  let budget = cap - reserved;
  if (budget < MIN_MESSAGE_KEEP_BYTES) {
    // The current turn plus the framing already eats the budget — there is no
    // room left for a history slice worth reading.
    return {
      prompt: currentTurnOnlyPrompt(currentTurn, priorMessages.length, cap),
      truncated: true,
      omittedMessages: priorMessages.length,
      originalBytes,
    };
  }

  const kept: string[] = [];
  let omittedMessages = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (blockBytes <= budget) {
      kept.unshift(block);
      budget -= blockBytes;
      continue;
    }
    const partial = budget >= MIN_MESSAGE_KEEP_BYTES ? truncateMessageMiddle(block, budget) : '';
    if (partial) {
      kept.unshift(partial);
      omittedMessages = i;
    } else {
      omittedMessages = i + 1;
    }
    break;
  }

  const notice = omittedMessages > 0 ? renderOmissionNotice(omittedMessages) : '';
  const prompt = HISTORY_BOOTSTRAP_HEADER + notice + kept.join('') + turnBlock;
  if (Buffer.byteLength(prompt, 'utf8') <= cap) {
    return { prompt, truncated: true, omittedMessages, originalBytes };
  }
  // Defensive: the budget accounting above should keep us under `cap`. If a
  // future edit breaks that, drop the history rather than hand the engine an
  // oversized argv element.
  return {
    prompt: currentTurnOnlyPrompt(currentTurn, priorMessages.length, cap),
    truncated: true,
    omittedMessages: priorMessages.length,
    originalBytes,
  };
}

/**
 * Test-only helper for callers that need a deterministic temp root.
 * Returns the parent dir we'll create per-spawn subdirs under. Kept
 * here so tests don't have to second-guess the `os.tmpdir()` location.
 */
export function _getPromptTmpRoot(): string {
  const root = os.tmpdir();
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    /* tmpdir always exists */
  }
  return root;
}
