import type {
  AskUserQuestionEvent,
  AskUserQuestionItem,
  ProgressStepEvent,
  ProgressStepStatus,
  StreamEvent,
  StreamParser,
  ToolResultImageRef,
} from './types.js';

type NormalizeFn = (raw: Record<string, unknown>) => StreamEvent[];

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** True when Edit args carry line-level diff bodies (not just `path` or empty strategy shells). */
function cursorEditArgsHaveSubstantiveDiff(input: Record<string, unknown>): boolean {
  const sr = input.strReplace as Record<string, unknown> | undefined;
  if (sr && typeof sr === 'object') {
    if (typeof sr.oldText === 'string' && sr.oldText.length > 0) return true;
    if (typeof sr.newText === 'string' && sr.newText.length > 0) return true;
  }
  const mr = input.multiStrReplace as { edits?: unknown[] } | undefined;
  if (mr?.edits && Array.isArray(mr.edits)) {
    for (const ed of mr.edits) {
      const e = ed as Record<string, unknown>;
      if (typeof e?.oldText === 'string' && e.oldText.length > 0) return true;
      if (typeof e?.newText === 'string' && e.newText.length > 0) return true;
    }
  }
  const ap = input.applyPatch as { patchContent?: string } | undefined;
  if (ap && typeof ap.patchContent === 'string' && ap.patchContent.trim()) return true;
  if (typeof input.unified_diff === 'string' && input.unified_diff.trim()) return true;
  if (input.changes && Array.isArray(input.changes) && input.changes.length > 0) return true;
  if (typeof input.old_string === 'string' && input.old_string.length > 0) return true;
  if (typeof input.oldString === 'string' && input.oldString.length > 0) return true;
  if (typeof input.new_string === 'string' && input.new_string.length > 0) return true;
  if (typeof input.newString === 'string' && input.newString.length > 0) return true;
  return false;
}

/** Line-level diff bodies for DiffView — excludes Codex `changes[]` path/kind-only rows. */
function cursorEditHasInlineDiffBody(input: Record<string, unknown>): boolean {
  const sr = input.strReplace as Record<string, unknown> | undefined;
  if (sr && typeof sr === 'object') {
    if (typeof sr.oldText === 'string' && sr.oldText.length > 0) return true;
    if (typeof sr.newText === 'string' && sr.newText.length > 0) return true;
  }
  const mr = input.multiStrReplace as { edits?: unknown[] } | undefined;
  if (mr?.edits && Array.isArray(mr.edits)) {
    for (const ed of mr.edits) {
      const e = ed as Record<string, unknown>;
      if (typeof e?.oldText === 'string' && e.oldText.length > 0) return true;
      if (typeof e?.newText === 'string' && e.newText.length > 0) return true;
    }
  }
  const ap = input.applyPatch as { patchContent?: string } | undefined;
  if (ap && typeof ap.patchContent === 'string' && ap.patchContent.trim()) return true;
  if (typeof input.unified_diff === 'string' && input.unified_diff.trim()) return true;
  if (typeof input.old_string === 'string' && input.old_string.length > 0) return true;
  if (typeof input.oldString === 'string' && input.oldString.length > 0) return true;
  if (typeof input.new_string === 'string' && input.new_string.length > 0) return true;
  if (typeof input.newString === 'string' && input.newString.length > 0) return true;
  return false;
}

function cursorFileToolHasDisplayableDiff(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName === 'Write') return cursorWriteArgsHaveSubstantiveContent(input);
  if (toolName === 'Edit') return cursorEditHasInlineDiffBody(input);
  return false;
}

/** Write args include file body text (not path-only). */
function cursorWriteArgsHaveSubstantiveContent(input: Record<string, unknown>): boolean {
  if (typeof input.fileText === 'string' && input.fileText.length > 0) return true;
  if (typeof input.content === 'string' && input.content.length > 0) return true;
  if (typeof input.contents === 'string' && input.contents.length > 0) return true;
  return false;
}

/** Edit / Write `tool_call.started` sometimes carries `{}` or a placeholder; full `args` arrive on `completed` (see Cursor stream-json docs). */
function shouldDeferCursorFileToolCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'Edit' && toolName !== 'Write') return false;
  if (Object.keys(input).length === 0) return true;
  if (toolName === 'Write') return !cursorWriteArgsHaveSubstantiveContent(input);
  return !cursorEditArgsHaveSubstantiveDiff(input);
}

function mergeCursorFileToolInput(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  return { ...a, ...b };
}

/**
 * Composer / Cursor may omit strReplace bodies from `tool_call.completed` args and
 * only attach `result.success.diffString` (see Cursor editToolCall result types).
 */
function enrichCursorEditInputFromToolResult(
  input: Record<string, unknown>,
  toolName: string,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== 'Edit' || cursorEditHasInlineDiffBody(input)) return input;
  const result = (detail.result ?? {}) as Record<string, unknown>;
  const success = result.success as Record<string, unknown> | undefined;
  if (!success || typeof success !== 'object') return input;
  const diffString = success.diffString;
  if (typeof diffString === 'string' && diffString.trim()) {
    return { ...input, unified_diff: diffString };
  }
  return input;
}

// ─── agenthub:ask fenced-block protocol ────────────────────────────────
//
// We teach Claude (via the enriched system prompt) to emit a fenced code
// block tagged `agenthub:ask` whenever it wants to ask the user a multi-
// choice question. The block contains JSON matching AskUserQuestionItem[].
// We detect these blocks in finalized assistant_text events, emit a typed
// `ask_user_question` event, and strip the block from the visible text so
// the raw JSON doesn't render in the transcript.
//
// Example block Claude would emit:
//   ```agenthub:ask
//   [{
//     "question": "Which library?",
//     "header": "Library",
//     "multiSelect": false,
//     "options": [
//       { "label": "date-fns", "description": "tree-shakable" },
//       { "label": "luxon", "description": "timezone-friendly" }
//     ]
//   }]
//   ```
//
// Answers come back as a normal user chat message containing a matching
// `agenthub:ask:answer` fenced block (handled on the client side).

import {
  extractAskBlocks as extractAskBlocksCore,
  parseAskPayload,
} from '../shared/utils/extractAskBlocks.js';

/** Fence opener / closer line (CommonMark-style: ≤3 spaces indent, 3+ ` or ~). */
function parseFenceLine(line: string): { fence: string; rest: string } | null {
  const m = line.match(/^([ \t]{0,3})([`~]{3,})(.*)$/);
  if (!m || m[1].length > 3) return null;
  return { fence: m[2], rest: m[3] ?? '' };
}

function isClosingFenceLine(
  fi: { fence: string; rest: string },
  fenceChar: '`' | '~',
  openLen: number,
): boolean {
  if (fi.fence[0] !== fenceChar) return false;
  if (fi.fence.length < openLen) return false;
  return /^[ \t]*$/.test(fi.rest);
}

function isAgenthubAskFenceInfo(rest: string): boolean {
  const t = rest
    .replace(/^[ \t]+/, '')
    .replace(/[ \t]+$/, '')
    .toLowerCase();
  return t === 'agenthub:ask' || t.startsWith('agenthub:ask ') || t.startsWith('agenthub:ask\t');
}

/**
 * Half-open character ranges `[start, end)` covering the *body* of fenced
 * code blocks whose info string is not `agenthub:ask`. Used so
 * `extractAskBlocks` does not strip documented examples that appear inside
 * ` ```typescript` / ` ```text` / etc., which used to corrupt markdown and
 * break backtick pairing in chat.
 */
export function computeLockedNonAskFenceBodyRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines = text.split('\n');
  const n = lines.length;

  type Mode =
    | { k: 'out' }
    | { k: 'locked'; ch: '`' | '~'; openLen: number; contentStart: number }
    | { k: 'ask'; ch: '`' | '~'; openLen: number };

  let mode: Mode = { k: 'out' };
  let offset = 0;

  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length;
    if (i < n - 1) offset += 1;

    const fi = parseFenceLine(line);
    if (!fi) continue;

    const ch = fi.fence[0] as '`' | '~';
    const openLen = fi.fence.length;

    if (mode.k === 'locked') {
      if (isClosingFenceLine(fi, mode.ch, mode.openLen)) {
        ranges.push({ start: mode.contentStart, end: lineStart });
        mode = { k: 'out' };
      }
      continue;
    }

    if (mode.k === 'ask') {
      if (isClosingFenceLine(fi, ch, mode.openLen)) {
        mode = { k: 'out' };
      }
      continue;
    }

    // Outside any fence — a fence line opens `agenthub:ask` or a generic block.
    if (isAgenthubAskFenceInfo(fi.rest)) {
      mode = { k: 'ask', ch, openLen };
    } else {
      const contentStart = lineStart + line.length + (i < n - 1 ? 1 : 0);
      mode = { k: 'locked', ch, openLen, contentStart };
    }
  }

  if (mode.k === 'locked') {
    ranges.push({ start: mode.contentStart, end: text.length });
  }

  return ranges;
}

export interface ExtractedAsk {
  askId: string;
  questions: AskUserQuestionItem[];
}

export interface AskExtractionResult {
  strippedText: string;
  asks: ExtractedAsk[];
}

/**
 * Pull every `agenthub:ask` fenced block out of `text`, parse the JSON
 * payload, validate the shape, and return the text with those blocks
 * removed plus an array of extracted asks. Malformed blocks are left in
 * place (so the user can still see the issue) and are not extracted.
 *
 * Exported for tests.
 */
export function extractAskBlocks(text: string): AskExtractionResult {
  if (!text.includes('agenthub:ask')) {
    return { strippedText: text, asks: [] };
  }
  const lockedBodies = computeLockedNonAskFenceBodyRanges(text);
  return extractAskBlocksCore(text, { lockedBodies }) as AskExtractionResult;
}

export { parseAskPayload };

// ─── [[STEP:...]] progress-marker protocol ─────────────────────────────
//
// Long-running sessions (reviewer, autofix, heartbeat, cron) can emit
// `[[STEP:<status>:<label>]]` markers in their assistant text to drive a
// Cursor-Bugbot–style timed checklist inside Agent Hub's chat view.
//
// Supported statuses:
//   `[[STEP:started:Gather PR context]]`
//   `[[STEP:completed:Gather PR context]]`
//   `[[STEP:failed:Gather PR context]]`
//
// The marker itself is stripped from the rendered assistant text (the same
// way agenthub:ask blocks are) so the user never sees the raw syntax — they
// see the rendered ProgressPanel instead.

// Tolerant parser — allows spaces around the colon separators and any
// visible character in the label up to the closing `]]`. Label is trimmed.
const STEP_MARKER_RE = /\[\[STEP:\s*(started|completed|failed)\s*:\s*([^\]\n]+?)\s*\]\]/gi;

export interface ExtractedStep {
  step: string;
  status: ProgressStepStatus;
}

export interface StepExtractionResult {
  strippedText: string;
  steps: ExtractedStep[];
}

/**
 * Pull every `[[STEP:status:label]]` marker out of `text`, returning the
 * stripped text and the ordered list of extracted steps. Unrecognized or
 * malformed markers are left in place.
 *
 * Exported for tests.
 */
export function extractStepMarkers(text: string): StepExtractionResult {
  if (!text.includes('[[STEP:')) {
    return { strippedText: text, steps: [] };
  }

  const steps: ExtractedStep[] = [];
  const replacements: Array<{ start: number; end: number }> = [];

  STEP_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STEP_MARKER_RE.exec(text)) !== null) {
    const status = m[1].toLowerCase() as ProgressStepStatus;
    const step = m[2].trim();
    if (!step) continue;
    steps.push({ step, status });
    replacements.push({ start: m.index, end: m.index + m[0].length });
  }

  if (replacements.length === 0) {
    return { strippedText: text, steps: [] };
  }

  let strippedText = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end } = replacements[i];
    strippedText = strippedText.slice(0, start) + strippedText.slice(end);
  }
  // Collapse blank-line runs and strip trailing whitespace left by removal.
  strippedText = strippedText
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { strippedText, steps };
}

function stepEvent(extracted: ExtractedStep): ProgressStepEvent {
  const now = Date.now();
  const base: ProgressStepEvent = {
    type: 'progress_step',
    step: extracted.step,
    status: extracted.status,
    startedAt: now,
  };
  if (extracted.status !== 'started') base.finishedAt = now;
  return base;
}

function askEvent(ask: ExtractedAsk): AskUserQuestionEvent {
  return {
    type: 'ask_user_question',
    askId: ask.askId,
    questions: ask.questions,
  };
}

export function createStreamParser(engine: string): StreamParser {
  let buffer = '';
  // Codex `file_change` items are often emitted only on `item.completed` (no
  // preceding `item.started`). Track ids that already got a tool_use so we
  // don't duplicate when both events appear.
  const codexFileChangeToolUseIssued = new Set<string>();
  // Cursor Edit/Write: defer `tool_use` until `tool_call.completed` when
  // `started` has no substantive args, so the client DiffView gets path +
  // fileText / strReplace (fixes empty diff cards in Electron + web).
  const cursorDeferredFileToolCalls = new Map<
    string,
    { tool: string; args: Record<string, unknown> }
  >();
  const cursorFileToolStartedEmitted = new Set<string>();
  /** Args emitted on `started` when we did not defer — used to upgrade on `completed`. */
  const cursorFileToolStartedInputs = new Map<string, Record<string, unknown>>();
  // Grok streaming-json is ACP JSON-RPC notifications: `agent_message_chunk`
  // text arrives as token-level deltas. We accumulate the full message so the
  // terminal stop event can run ask/step extraction over the whole thing.
  const grokAgentMessage = { text: '' };
  const normalize: NormalizeFn =
    engine === 'cursor-agent'
      ? (raw) =>
          normalizeCursor(
            raw,
            cursorDeferredFileToolCalls,
            cursorFileToolStartedEmitted,
            cursorFileToolStartedInputs,
          )
      : engine === 'gemini-cli'
        ? normalizeGemini
        : engine === 'codex-cli'
          ? (raw) => normalizeCodex(raw, codexFileChangeToolUseIssued)
          : engine === 'grok-cli'
            ? (raw) => normalizeGrok(raw, grokAgentMessage)
            : normalizeClaude;

  return {
    feed(chunk: Buffer | string): StreamEvent[] {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      const out: StreamEvent[] = [];
      for (const line of lines) {
        const events = parseLine(line, normalize);
        if (events.length) out.push(...events);
      }
      return out;
    },

    flush(): StreamEvent[] {
      const out: StreamEvent[] = [];
      if (buffer.trim()) {
        out.push(...parseLine(buffer, normalize));
        buffer = '';
      }
      if (engine === 'cursor-agent' && cursorDeferredFileToolCalls.size > 0) {
        for (const [id, { tool, args }] of cursorDeferredFileToolCalls) {
          out.push({ type: 'tool_use', id, tool, input: args });
        }
        cursorDeferredFileToolCalls.clear();
      }
      return out;
    },
  };
}

function parseLine(line: string, normalize: NormalizeFn): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [{ type: 'unknown', text: trimmed, raw: trimmed }];
  }
  try {
    const events = normalize(raw);
    // Attach the original line only to `unknown` events, which surface it for
    // debugging. Every other event already carries its parsed fields; copying
    // the whole line onto them duplicated multi-hundred-KB tool_result / image
    // payloads onto sibling events (e.g. the tiny checkpoint emitted from the
    // same JSONL line as an image read), pushing them past the session_events
    // payload cap so they persisted as an unrenderable truncation envelope.
    for (const e of events) if (e.type === 'unknown') e.raw = trimmed;
    return events;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return [{ type: 'unknown', text: `parse error: ${message}`, raw: trimmed }];
  }
}

// ─── Claude Code normalizer ────────────────────────────────────────────

function normalizeClaude(raw: Record<string, unknown>): StreamEvent[] {
  switch (raw.type) {
    case 'system':
      if (raw.subtype === 'init') {
        return [
          {
            type: 'system',
            sessionId: (raw.session_id as string) ?? null,
            model: (raw.model as string) ?? null,
            cwd: (raw.cwd as string) ?? null,
            tools: Array.isArray(raw.tools) ? (raw.tools as string[]) : [],
            gitWorktree:
              ((raw.workspace as Record<string, unknown>)?.git_worktree as boolean) ?? null,
          },
        ];
      }
      return [];

    case 'assistant': {
      const msg = raw.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
      const out: StreamEvent[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = block.text as string;
          // Extract asks first, then step markers from the stripped-of-asks text
          // so we don't accidentally parse markers nested inside a fenced ask.
          const { strippedText: afterAsk, asks } = extractAskBlocks(text);
          const { strippedText: afterSteps, steps } = extractStepMarkers(afterAsk);
          const displayText = afterSteps;
          if (asks.length > 0 || steps.length > 0) {
            if (displayText) {
              out.push({ type: 'assistant_text', text: displayText, partial: false });
            }
            for (const s of steps) out.push(stepEvent(s));
            for (const ask of asks) out.push(askEvent(ask));
          } else {
            out.push({ type: 'assistant_text', text, partial: false });
          }
        } else if (block.type === 'thinking' && block.thinking) {
          out.push({ type: 'thinking', text: block.thinking as string });
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            id: block.id as string,
            tool: block.name as string,
            input: (block.input as Record<string, unknown>) ?? {},
          });
        }
      }
      return out;
    }

    case 'user': {
      const msg = raw.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
      const out: StreamEvent[] = [];

      if (raw.uuid) {
        out.push({
          type: 'checkpoint',
          uuid: raw.uuid as string,
          turnIndex: (raw.turn_number as number) ?? null,
        });
      }

      for (const block of content) {
        if (block.type === 'tool_result') {
          const { output, images } = extractToolResult(block.content);
          out.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id as string,
            output,
            isError: block.is_error === true,
            ...(images.length > 0 ? { images } : {}),
          });
        }
      }
      return out;
    }

    case 'stream_event': {
      const ev = raw.event as Record<string, unknown> | undefined;
      if (ev?.type === 'content_block_delta') {
        const delta = ev.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          const deltaText =
            typeof delta.text === 'string' ? delta.text : JSON.stringify(delta.text ?? '');
          return [{ type: 'assistant_text', text: deltaText, partial: true }];
        }
      }
      return [];
    }

    case 'result': {
      const usage = (raw.usage as Record<string, unknown> | undefined) ?? {};
      const inputTok =
        (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined);
      const outputTok =
        (usage.output_tokens as number | undefined) ??
        (usage.completion_tokens as number | undefined);
      // Cost/turns/duration contract — important for downstream aggregation:
      //
      //   • costUsd (= total_cost_usd) is CUMULATIVE. The Anthropic Agent SDK
      //     docs describe it as "the cumulative estimated cost across all
      //     steps in that call" (https://code.claude.com/docs/en/agent-sdk/
      //     cost-tracking). In practice the Claude Code CLI sometimes emits
      //     multiple `result` events under a single parent_id (same assistant
      //     message / same CLI process); each subsequent event carries the
      //     running cumulative total, NOT just its incremental spend.
      //   • durationMs and numTurns, by contrast, are PER-EMISSION — each
      //     result event reports only its own call's duration and turn count.
      //
      // We pass through all three verbatim. Aggregators (see
      // `server/usage-aggregation.ts`) MUST take MAX(costUsd) per parent_id
      // before summing, while durationMs/numTurns can be summed directly.
      // Dropping/deduping at the parser would be lossy for UI event replay,
      // so the dedupe lives at the aggregation layer.
      return [
        {
          type: 'result',
          text: (raw.result as string) ?? '',
          durationMs: (raw.duration_ms as number) ?? null,
          costUsd: (raw.total_cost_usd as number) ?? null,
          numTurns: (raw.num_turns as number) ?? null,
          isError: raw.is_error === true,
          stopReason: (raw.stop_reason as string) ?? null,
          inputTokens: typeof inputTok === 'number' && Number.isFinite(inputTok) ? inputTok : null,
          outputTokens:
            typeof outputTok === 'number' && Number.isFinite(outputTok) ? outputTok : null,
        },
      ];
    }

    case 'rate_limit_event':
      return [
        {
          type: 'rate_limit',
          retryAfterMs: (raw.retry_after_ms as number) ?? (raw.retryAfterMs as number) ?? null,
          message: (raw.message as string) ?? null,
        },
      ];

    // Headless Claude Code (`--print`, bypassPermissions) still emits control-plane
    // frames on stdout when using stream-json + --include-partial-messages. Agent Hub
    // does not bridge stdin control responses — suppress so SessionTail stays clean.
    case 'control_request':
    case 'control_response':
    case 'sdk_control_request':
    case 'sdk_control_response':
      return [];

    // Keep-alive frames the CLI emits every 30s while a tool is still running
    // (`{type:'tool_progress', tool_use_id, tool_name, elapsed_time_seconds,
    // heartbeat:true}`). They carry no output — the tool_use block is already
    // rendered and the tool_result closes it — so a long Bash call would
    // otherwise stamp a row into the tail on every tick.
    case 'tool_progress':
      return [];

    default:
      return [{ type: 'unknown', text: `unhandled claude event: ${raw.type as string}` }];
  }
}

// ─── Cursor Agent normalizer ───────────────────────────────────────────

function normalizeCursor(
  raw: Record<string, unknown>,
  deferredFileToolCalls: Map<string, { tool: string; args: Record<string, unknown> }>,
  fileToolStartedEmitted: Set<string>,
  fileToolStartedInputs: Map<string, Record<string, unknown>>,
): StreamEvent[] {
  switch (raw.type) {
    case 'system':
      if (raw.subtype === 'init') {
        return [
          {
            type: 'system',
            sessionId: (raw.session_id as string) ?? null,
            model: (raw.model as string) ?? null,
            cwd: (raw.cwd as string) ?? null,
            tools: [],
          },
        ];
      }
      return [];

    case 'user':
      return [];

    case 'thinking':
      return [];

    case 'interaction_query': {
      // Cursor emits `interaction_query` when the CLI would prompt the user in an
      // interactive TTY. Agent Hub runs `cursor-agent` with `--print`, `--force`, and
      // no stdin for answers — the frame is informational; surfacing it as `unknown`
      // produced noisy "Unhandled Cursor event: interaction_query" rows in SessionTail.
      if (process.env.AGENT_HUB_DEBUG_CURSOR_STREAM === '1') {
        const pick =
          (typeof raw.prompt === 'string' && raw.prompt) ||
          (typeof raw.query === 'string' && raw.query) ||
          (typeof raw.message === 'string' && raw.message) ||
          (typeof raw.text === 'string' && raw.text);
        console.debug(
          `[stream-parser] cursor interaction_query ignored (headless)${pick ? `: ${pick.slice(0, 200)}` : ''}`,
        );
      }
      return [];
    }

    case 'assistant': {
      if (raw.timestamp_ms === undefined) return [];
      // Cursor stream-json + --stream-partial-output: events with BOTH
      // `timestamp_ms` and `model_call_id` are buffered flushes emitted
      // immediately before a tool call — they duplicate text already carried
      // by prior streaming deltas. Skipping prevents doubled assistant output.
      // See https://cursor.com/docs/cli/reference/output-format (stream-json).
      if (raw.model_call_id != null && String(raw.model_call_id).trim() !== '') {
        return [];
      }
      const msg = raw.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
      const out: StreamEvent[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out.push({ type: 'assistant_text', text: block.text as string, partial: true });
        }
      }
      return out;
    }

    case 'tool_call': {
      const callId = String(raw.call_id ?? '');
      const tc = (raw.tool_call ?? {}) as Record<string, Record<string, unknown>>;
      const variant = Object.keys(tc)[0];
      const detail = tc[variant] ?? {};
      const toolName = friendlyCursorToolName(variant);
      const input = (detail.args as Record<string, unknown>) ?? {};

      if (raw.subtype === 'started') {
        if (shouldDeferCursorFileToolCall(toolName, input)) {
          deferredFileToolCalls.set(callId, { tool: toolName, args: input });
          return [];
        }
        fileToolStartedEmitted.add(callId);
        fileToolStartedInputs.set(callId, input);
        return [
          {
            type: 'tool_use',
            id: callId,
            tool: toolName,
            input,
          },
        ];
      }
      if (raw.subtype === 'completed') {
        const out: StreamEvent[] = [];
        const completedArgs = (detail.args as Record<string, unknown>) ?? {};
        const enrichEdit = (input: Record<string, unknown>) =>
          enrichCursorEditInputFromToolResult(input, toolName, detail);
        const pending = deferredFileToolCalls.get(callId);
        if (pending) {
          deferredFileToolCalls.delete(callId);
          const merged = enrichEdit(mergeCursorFileToolInput(pending.args, completedArgs));
          out.push({ type: 'tool_use', id: callId, tool: pending.tool, input: merged });
        } else if (
          (toolName === 'Edit' || toolName === 'Write') &&
          !fileToolStartedEmitted.has(callId) &&
          Object.keys(completedArgs).length > 0
        ) {
          // `tool_call.started` missing but `completed` has args (CLI edge case)
          out.push({
            type: 'tool_use',
            id: callId,
            tool: toolName,
            input: enrichEdit(completedArgs),
          });
        } else {
          const earlyInput = fileToolStartedInputs.get(callId);
          const mergedCompleted = enrichEdit(
            mergeCursorFileToolInput(earlyInput ?? {}, completedArgs),
          );
          if (
            earlyInput &&
            fileToolStartedEmitted.has(callId) &&
            !cursorFileToolHasDisplayableDiff(toolName, earlyInput) &&
            cursorFileToolHasDisplayableDiff(toolName, mergedCompleted)
          ) {
            // Started with path-only / empty strReplace / changes[] metadata; completed has line bodies.
            out.push({
              type: 'tool_use',
              id: callId,
              tool: toolName,
              input: mergedCompleted,
            });
          }
        }
        fileToolStartedEmitted.delete(callId);
        fileToolStartedInputs.delete(callId);

        const result = (detail.result ?? {}) as Record<string, unknown>;
        const success = (result.success as Record<string, unknown> | null) ?? null;
        const failure = (result.failure as string | Record<string, unknown> | null) ?? null;
        // Cursor forwards MCP tool output under a `content` array; lift any
        // images out of it (and use its text) so an MCP image read renders
        // inline like Claude's instead of dumping the base64 into `output`.
        const mcpContent = (success?.content as unknown) ?? (result.content as unknown) ?? null;
        const extracted = extractToolResult(mcpContent);
        let output = '';
        let isError = false;
        if (success) {
          if (typeof success.stdout === 'string' || typeof success.stderr === 'string') {
            output =
              ((success.stdout as string) ?? '') +
              (success.stderr ? '\n[stderr]\n' + (success.stderr as string) : '');
            if (typeof success.exitCode === 'number' && success.exitCode !== 0) {
              isError = true;
            }
          } else if (Array.isArray(mcpContent)) {
            // MCP text content renders via extractToolResult; fall back to the
            // JSON dump when the array yields no text (e.g. image-only or empty)
            // so a successful result is never blank.
            output = extracted.output || JSON.stringify(success, null, 2);
          } else {
            output = JSON.stringify(success, null, 2);
          }
        } else if (failure) {
          output = typeof failure === 'string' ? failure : JSON.stringify(failure, null, 2);
          isError = true;
        } else {
          output = JSON.stringify(result, null, 2);
        }
        out.push({
          type: 'tool_result',
          toolUseId: callId,
          output,
          isError,
          ...(extracted.images.length > 0 ? { images: extracted.images } : {}),
        });
        return out;
      }
      return [];
    }

    case 'result': {
      // Cursor Agent only streams partials during the turn; the terminal
      // `assistant` snapshot (no `timestamp_ms`) is skipped to avoid doubling
      // streamed deltas. The canonical full turn text lives on `raw.result`.
      //
      // Emit one finalized `assistant_text` with `replacesAssistantBuffer` so
      // `chat.ts` sees `<handoff>`, `<delegate>`, `<agenthub:task-state>`, etc.
      // that may exist only on the result line (regression: handoffs/delegations
      // silently missing).
      //
      // When ask/step extraction consumes the entire body (`afterSteps` empty
      // but asks or steps non-empty), skip this push — an empty replace would
      // wipe streamed partial deltas while side events still fire.
      const resultText = typeof raw.result === 'string' ? raw.result : '';
      const out: StreamEvent[] = [];
      if (resultText) {
        const { strippedText: afterAsk, asks } = extractAskBlocks(resultText);
        const { strippedText: afterSteps, steps } = extractStepMarkers(afterAsk);
        const hasSideExtracts = asks.length > 0 || steps.length > 0;
        if (!hasSideExtracts || afterSteps) {
          out.push({
            type: 'assistant_text',
            text: afterSteps,
            partial: false,
            replacesAssistantBuffer: true,
          });
        }
        for (const s of steps) out.push(stepEvent(s));
        for (const ask of asks) out.push(askEvent(ask));
      }
      out.push({
        type: 'result',
        text: resultText,
        durationMs: (raw.duration_ms as number) ?? null,
        costUsd: null,
        numTurns: null,
        isError: raw.is_error === true,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
      });
      return out;
    }

    default:
      return [{ type: 'unknown', text: `unhandled cursor event: ${raw.type as string}` }];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

export interface ExtractedToolResult {
  output: string;
  images: ToolResultImageRef[];
}

/**
 * Normalize a CLI tool_result `content` into a display string plus any embedded
 * images pulled out for inline rendering. Image blocks (e.g. Claude reading a
 * PNG) previously got `JSON.stringify`-dumped straight into `output`, so a
 * single image read produced a 300KB–1MB base64 blob that blew past the
 * session_events payload cap and vanished behind a truncation envelope. We now
 * lift images into `images` (offloaded to the uploads store before persist) and
 * leave a compact `[image: <type>]` placeholder in the text.
 */
/**
 * Recognize an image content block across every CLI's tool_result shape and
 * lift it into a `ToolResultImageRef`. Returns null for non-image blocks.
 *
 * Supported shapes:
 *   - Anthropic / Claude Code: `{ type:'image', source:{ type:'base64',
 *     media_type, data } }` (or `source:{ url }`).
 *   - MCP / ACP (Codex MCP tools, grok-cli & gemini over ACP): `{ type:'image',
 *     data:'<base64>', mimeType }` — base64 + mime at the top level.
 */
function imageRefFromBlock(obj: Record<string, unknown>): ToolResultImageRef | null {
  if (obj.type !== 'image' && obj.type !== 'image_url') return null;

  // Anthropic content-block shape: bytes/URL nested under `source`.
  const src = obj.source as Record<string, unknown> | undefined;
  if (src && typeof src === 'object') {
    if (src.type === 'base64' && typeof src.data === 'string') {
      const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
      return { mediaType, dataBase64: src.data };
    }
    if (typeof src.url === 'string') {
      const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image';
      return { mediaType, url: src.url };
    }
  }

  // MCP / ACP shape: base64 `data` + `mimeType` (camelCase) at the top level.
  // Accept `media_type` as a fallback for lenient producers.
  const topMime =
    typeof obj.mimeType === 'string'
      ? obj.mimeType
      : typeof obj.media_type === 'string'
        ? (obj.media_type as string)
        : 'image/png';
  if (typeof obj.data === 'string') {
    return { mediaType: topMime, dataBase64: obj.data };
  }
  if (typeof obj.url === 'string') {
    return { mediaType: topMime === 'image/png' ? 'image' : topMime, url: obj.url };
  }
  return null;
}

export function extractToolResult(content: unknown): ExtractedToolResult {
  const images: ToolResultImageRef[] = [];
  if (typeof content === 'string') return { output: content, images };
  if (Array.isArray(content)) {
    const output = content
      .map((b: unknown) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const outer = b as Record<string, unknown>;
          // ACP (grok-cli, gemini over ACP) wraps the real ContentBlock in a
          // `ToolCallContent`: `{ type:'content', content:<ContentBlock> }`.
          const obj =
            outer.type === 'content' && outer.content && typeof outer.content === 'object'
              ? (outer.content as Record<string, unknown>)
              : outer;
          if (obj.type === 'text') return (obj.text as string) ?? '';
          const img = imageRefFromBlock(obj);
          if (img) {
            images.push(img);
            return `[image: ${img.url ?? img.mediaType}]`;
          }
        }
        return JSON.stringify(b);
      })
      .join('\n');
    return { output, images };
  }
  if (content == null) return { output: '', images };
  // MCP `CallToolResult` wraps the blocks in a `content` array (Codex MCP tools,
  // Cursor-forwarded MCP output). Recurse into it so images are lifted.
  if (typeof content === 'object' && Array.isArray((content as Record<string, unknown>).content)) {
    return extractToolResult((content as Record<string, unknown>).content);
  }
  return { output: JSON.stringify(content), images };
}

/** extractToolResult, returning the `images` spread ready for a tool_result event. */
function toolResultImagesField(
  content: unknown,
): { images: ToolResultImageRef[] } | Record<string, never> {
  const { images } = extractToolResult(content);
  return images.length > 0 ? { images } : {};
}

function stringifyToolResult(content: unknown): string {
  return extractToolResult(content).output;
}

const CURSOR_TOOL_MAP: Record<string, string> = {
  shellToolCall: 'Bash',
  readToolCall: 'Read',
  writeToolCall: 'Write',
  editToolCall: 'Edit',
  grepToolCall: 'Grep',
  globToolCall: 'Glob',
  listDirToolCall: 'List',
  webSearchToolCall: 'WebSearch',
  webFetchToolCall: 'WebFetch',
};

function friendlyCursorToolName(variant: string | undefined): string {
  if (!variant) return 'unknown';
  if (CURSOR_TOOL_MAP[variant]) return CURSOR_TOOL_MAP[variant];
  const stripped = variant.replace(/ToolCall$/, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// ─── Gemini CLI normalizer ─────────────────────────────────────────────
//
// Shape reference: https://geminicli.com/docs/cli/headless
// Gemini's stream-json output is a newline-delimited sequence of events:
//
//   { "type": "init",        "sessionId": "...", "model": "...", "cwd": "...", "tools": [...] }
//   { "type": "message",     "role": "assistant", "content": [ {type:"text", text:"..."} ] }
//   { "type": "message",     "role": "assistant", "content": [ {type:"text", text:"..."} ], "partial": true }
//   { "type": "tool_use",    "id": "...", "name": "shell", "input": { ... } }
//   { "type": "tool_result", "toolUseId": "...", "output": "...", "isError": false }
//   { "type": "error",       "message": "..." }
//   { "type": "result",      "response": "...", "stats": { durationMs, turns, costUsd } }
//
// We normalize these into the same StreamEvent shape emitted for Claude/Cursor
// so the chat UI can render Gemini sessions without any engine-aware logic.
// Ask blocks and progress-step markers are extracted from assistant text the
// same way we do for Claude.
function normalizeGemini(raw: Record<string, unknown>): StreamEvent[] {
  switch (raw.type) {
    case 'init':
      return [
        {
          type: 'system',
          sessionId: (raw.sessionId as string) ?? (raw.session_id as string) ?? null,
          model: (raw.model as string) ?? null,
          cwd: (raw.cwd as string) ?? null,
          tools: Array.isArray(raw.tools) ? (raw.tools as string[]) : [],
        },
      ];

    case 'message': {
      const role = raw.role as string | undefined;
      if (role && role !== 'assistant') return [];
      const partial = raw.partial === true;
      const content = (raw.content ?? []) as Array<Record<string, unknown>>;
      const out: StreamEvent[] = [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = block.text as string;
          if (partial) {
            out.push({ type: 'assistant_text', text, partial: true });
            continue;
          }
          // Finalized assistant text — run ask + step extraction to mirror
          // normalizeClaude's behavior so pickers render in Gemini sessions too.
          const { strippedText: afterAsk, asks } = extractAskBlocks(text);
          const { strippedText: afterSteps, steps } = extractStepMarkers(afterAsk);
          if (asks.length > 0 || steps.length > 0) {
            if (afterSteps) {
              out.push({ type: 'assistant_text', text: afterSteps, partial: false });
            }
            for (const s of steps) out.push(stepEvent(s));
            for (const ask of asks) out.push(askEvent(ask));
          } else {
            out.push({ type: 'assistant_text', text, partial: false });
          }
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          out.push({ type: 'thinking', text: block.thinking as string });
        }
      }
      return out;
    }

    case 'tool_use': {
      // Real Google gemini-cli stream-json uses `tool_name`/`tool_id`/`parameters`
      // (see google-gemini/gemini-cli PR #10883). Earlier drafts of the docs used
      // `name`/`id`/`input` / `tool`/`args`, so keep those as fallbacks for
      // forward-compat with older CLI versions and test fixtures.
      const id =
        (raw.tool_id as string) ??
        (raw.id as string) ??
        (raw.toolUseId as string) ??
        simpleHash(JSON.stringify(raw));
      const toolName =
        (raw.tool_name as string) ?? (raw.name as string) ?? (raw.tool as string) ?? 'unknown';
      const input =
        (raw.parameters as Record<string, unknown>) ??
        (raw.input as Record<string, unknown>) ??
        (raw.args as Record<string, unknown>) ??
        {};
      return [
        {
          type: 'tool_use',
          id,
          tool: toolName,
          input,
        },
      ];
    }

    case 'tool_result': {
      // Real gemini-cli pairs results via `tool_id`; older schema used `toolUseId`/`tool_use_id`.
      const toolUseId =
        (raw.tool_id as string) ?? (raw.toolUseId as string) ?? (raw.tool_use_id as string) ?? '';
      const { output, images } = extractToolResult(raw.output ?? raw.content);
      return [
        {
          type: 'tool_result',
          toolUseId,
          output,
          isError: raw.isError === true || raw.is_error === true || raw.status === 'error',
          ...(images.length > 0 ? { images } : {}),
        },
      ];
    }

    case 'error':
      return [
        {
          type: 'unknown',
          text: `gemini error: ${(raw.message as string) ?? JSON.stringify(raw)}`,
        },
      ];

    case 'result': {
      const stats = (raw.stats as Record<string, unknown> | undefined) ?? {};
      const resultText = (raw.response as string) ?? (raw.result as string) ?? '';
      // Gemini emits a single terminal `result` event (per docs). Run ask/step
      // extraction against the final response so fenced pickers render even
      // when Gemini doesn't stream the assistant text as partials first.
      const out: StreamEvent[] = [];
      if (resultText) {
        const { strippedText: afterAsk, asks } = extractAskBlocks(resultText);
        const { strippedText: afterSteps, steps } = extractStepMarkers(afterAsk);
        if (asks.length > 0 || steps.length > 0) {
          if (afterSteps) {
            out.push({ type: 'assistant_text', text: afterSteps, partial: false });
          }
          for (const s of steps) out.push(stepEvent(s));
          for (const ask of asks) out.push(askEvent(ask));
        }
      }
      const inTok =
        (stats.inputTokens as number | undefined) ??
        (stats.input_token_count as number | undefined) ??
        (stats.promptTokenCount as number | undefined);
      const outTok =
        (stats.outputTokens as number | undefined) ??
        (stats.output_token_count as number | undefined) ??
        (stats.candidatesTokenCount as number | undefined);
      out.push({
        type: 'result',
        text: resultText,
        durationMs: (stats.durationMs as number) ?? (raw.duration_ms as number) ?? null,
        costUsd: (stats.costUsd as number) ?? (raw.total_cost_usd as number) ?? null,
        numTurns: (stats.turns as number) ?? (raw.num_turns as number) ?? null,
        isError: raw.error !== undefined || raw.isError === true,
        stopReason: (raw.stopReason as string) ?? null,
        inputTokens: typeof inTok === 'number' && Number.isFinite(inTok) ? inTok : null,
        outputTokens: typeof outTok === 'number' && Number.isFinite(outTok) ? outTok : null,
      });
      return out;
    }

    default:
      return [{ type: 'unknown', text: `unhandled gemini event: ${raw.type as string}` }];
  }
}

// ─── Grok Build CLI normalizer ─────────────────────────────────────────
//
// Shape reference: xAI Grok Build CLI headless mode
// (https://docs.x.ai/build/cli/headless-scripting). `grok -p "..."
// --output-format streaming-json` emits newline-delimited JSON. Two shapes
// appear in the wild:
//
// **Native NDJSON** (grok-composer / current builds):
//   { "type":"thought", "data":"..." }  — reasoning delta
//   { "type":"text",    "data":"..." }  — assistant text delta
//   { "type":"end",     "stopReason":"EndTurn", "sessionId":"..." }
//
// **ACP JSON-RPC** (older grok-build path):
//   { "jsonrpc":"2.0", "method":"session/update", "params": {
//       "sessionId": "...",
//       "update": { "sessionUpdate":"agent_message_chunk",
//                   "content": { "type":"text", "text":"..." } } }
//
// `update.sessionUpdate` discriminator values we handle:
//   agent_message_chunk  — assistant text delta (emit partial assistant_text)
//   agent_thought_chunk  — reasoning delta       (emit thinking)
//   tool_call            — tool invocation        (emit tool_use)
//   tool_call_update     — tool status/result     (emit tool_result on terminal status)
//
// The terminal signal is either a native `{ type:"end", stopReason }` line or
// the JSON-RPC *response* to the `session/prompt` request:
// `{ "jsonrpc":"2.0", "id":<n>, "result": { "stopReason":"..." } }`.
// On that we finalize: run ask/step extraction over the accumulated message
// and emit a non-partial assistant_text (replacing the streamed buffer) plus
// a `result` event. Token deltas otherwise accumulate into `partialFallback`
// on the caller side, so text is never lost even if the terminal line is
// missing. Field names follow the ACP spec; fallbacks tolerate minor drift.

function finalizeGrokAgentMessageTurn(
  agentMessage: { text: string },
  stopReason: string | null,
  usage?: Record<string, unknown>,
): StreamEvent[] {
  const finalText = agentMessage.text;
  agentMessage.text = '';
  const out: StreamEvent[] = [];
  if (finalText) {
    const { strippedText: afterAsk, asks } = extractAskBlocks(finalText);
    const { strippedText: afterSteps, steps } = extractStepMarkers(afterAsk);
    out.push({
      type: 'assistant_text',
      text: afterSteps,
      partial: false,
      replacesAssistantBuffer: true,
    });
    for (const s of steps) out.push(stepEvent(s));
    for (const ask of asks) out.push(askEvent(ask));
  }
  const inTok =
    (usage?.inputTokens as number | undefined) ?? (usage?.input_tokens as number | undefined);
  const outTok =
    (usage?.outputTokens as number | undefined) ?? (usage?.output_tokens as number | undefined);
  const reasonLower = stopReason?.toLowerCase() ?? '';
  out.push({
    type: 'result',
    text: finalText,
    durationMs: null,
    costUsd: null,
    numTurns: null,
    isError: reasonLower === 'error' || reasonLower === 'failed',
    stopReason,
    inputTokens: typeof inTok === 'number' && Number.isFinite(inTok) ? inTok : null,
    outputTokens: typeof outTok === 'number' && Number.isFinite(outTok) ? outTok : null,
  });
  return out;
}

function grokNativeStreamChunk(raw: Record<string, unknown>): string {
  if (typeof raw.data === 'string') return raw.data;
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.content === 'string') return raw.content;
  return '';
}

function finalizeGrokError(agentMessage: { text: string }, message: string): StreamEvent[] {
  const out: StreamEvent[] = [];
  // Preserve any assistant text streamed before the error so a partial answer
  // isn't lost, and reset the buffer.
  const buffered = agentMessage.text;
  agentMessage.text = '';
  if (buffered) {
    out.push({
      type: 'assistant_text',
      text: buffered,
      partial: false,
      replacesAssistantBuffer: true,
    });
  }
  // A model-side streaming error frame must drive the normal failed-turn
  // lifecycle (sessions.last_turn_error, Finalize-automation block, transient
  // auto-retry) even when the CLI then exits cleanly. Emitting an `unknown`
  // event let the error be treated as non-terminal noise. Emit a terminal
  // `result` with isError:true whose text carries the error; chat.ts captures
  // that as the turn's streamErrorMessage exactly like the Codex
  // `turn.failed` -> result{isError} path.
  out.push({
    type: 'result',
    text: `grok error: ${message}`,
    durationMs: null,
    costUsd: null,
    numTurns: null,
    isError: true,
    stopReason: 'error',
    inputTokens: null,
    outputTokens: null,
  });
  return out;
}

function normalizeGrokNativeStream(
  raw: Record<string, unknown>,
  agentMessage: { text: string },
): StreamEvent[] | null {
  const kind = typeof raw.type === 'string' ? raw.type : undefined;
  if (!kind || raw.jsonrpc !== undefined || raw.method !== undefined || raw.result !== undefined) {
    return null;
  }
  switch (kind) {
    case 'thought': {
      const chunk = grokNativeStreamChunk(raw);
      return chunk ? [{ type: 'thinking', text: chunk }] : [];
    }
    case 'text': {
      const chunk = grokNativeStreamChunk(raw);
      if (!chunk) return [];
      agentMessage.text += chunk;
      return [{ type: 'assistant_text', text: chunk, partial: true }];
    }
    case 'end': {
      const stopReason =
        (raw.stopReason as string | undefined) ?? (raw.stop_reason as string | undefined) ?? null;
      const usage = (raw.usage as Record<string, unknown> | undefined) ?? undefined;
      return finalizeGrokAgentMessageTurn(agentMessage, stopReason, usage);
    }
    case 'error': {
      const message =
        (raw.message as string | undefined) ||
        grokNativeStreamChunk(raw) ||
        JSON.stringify(raw).slice(0, 200);
      return finalizeGrokError(agentMessage, message);
    }
    default:
      return null;
  }
}

function normalizeGrok(
  raw: Record<string, unknown>,
  agentMessage: { text: string },
): StreamEvent[] {
  const native = normalizeGrokNativeStream(raw, agentMessage);
  if (native !== null) return native;

  // Terminal JSON-RPC response: `{ id, result: { stopReason } }`.
  const result = raw.result as Record<string, unknown> | undefined;
  const isJsonRpc = raw.jsonrpc !== undefined || raw.method !== undefined || result !== undefined;
  if (result && (result.stopReason !== undefined || result.stop_reason !== undefined)) {
    const stopReason =
      (result.stopReason as string | undefined) ??
      (result.stop_reason as string | undefined) ??
      null;
    const usage = (result.usage as Record<string, unknown> | undefined) ?? undefined;
    return finalizeGrokAgentMessageTurn(agentMessage, stopReason, usage);
  }

  // JSON-RPC response carrying the new session id (`session/new` result).
  if (result && (result.sessionId !== undefined || result.session_id !== undefined)) {
    return [
      {
        type: 'system',
        sessionId: (result.sessionId as string) ?? (result.session_id as string) ?? null,
        model: (result.model as string) ?? null,
        cwd: (result.cwd as string) ?? null,
        tools: [],
      },
    ];
  }

  if (raw.method === 'session/update') {
    const params = (raw.params as Record<string, unknown> | undefined) ?? {};
    const update = (params.update as Record<string, unknown> | undefined) ?? {};
    const kind = update.sessionUpdate as string | undefined;
    const content = update.content as Record<string, unknown> | undefined;
    const contentText = typeof content?.text === 'string' ? (content.text as string) : '';

    switch (kind) {
      case 'agent_message_chunk': {
        if (!contentText) return [];
        agentMessage.text += contentText;
        return [{ type: 'assistant_text', text: contentText, partial: true }];
      }
      case 'agent_thought_chunk': {
        if (!contentText) return [];
        return [{ type: 'thinking', text: contentText }];
      }
      case 'tool_call': {
        const id =
          (update.toolCallId as string) ??
          (update.tool_call_id as string) ??
          simpleHash(JSON.stringify(update));
        const tool =
          (update.title as string) ?? (update.kind as string) ?? (update.name as string) ?? 'tool';
        const input =
          (update.rawInput as Record<string, unknown>) ??
          (update.input as Record<string, unknown>) ??
          {};
        const out: StreamEvent[] = [{ type: 'tool_use', id, tool, input }];
        // A tool_call may already carry a terminal status + output.
        const status = update.status as string | undefined;
        if (status === 'completed' || status === 'failed') {
          out.push({
            type: 'tool_result',
            toolUseId: id,
            output: stringifyToolResult(update.content),
            isError: status === 'failed',
            ...toolResultImagesField(update.content),
          });
        }
        return out;
      }
      case 'tool_call_update': {
        const id = (update.toolCallId as string) ?? (update.tool_call_id as string) ?? '';
        const status = update.status as string | undefined;
        if (status !== 'completed' && status !== 'failed') return [];
        return [
          {
            type: 'tool_result',
            toolUseId: id,
            output: stringifyToolResult(update.content),
            isError: status === 'failed',
            ...toolResultImagesField(update.content),
          },
        ];
      }
      default:
        return [];
    }
  }

  // Explicit error notification.
  if (raw.method === 'error' || raw.error !== undefined) {
    const errObj = raw.error as Record<string, unknown> | undefined;
    const message =
      (errObj?.message as string) ?? (raw.message as string) ?? JSON.stringify(raw.error ?? raw);
    return finalizeGrokError(agentMessage, message);
  }

  // Unknown JSON-RPC bookkeeping lines (handshake, request echoes) are noise.
  if (isJsonRpc) return [];
  return [{ type: 'unknown', text: `unhandled grok event: ${JSON.stringify(raw).slice(0, 200)}` }];
}

// ─── Codex CLI normalizer ──────────────────────────────────────────────
//
// Shape reference: https://developers.openai.com/codex/noninteractive.
// `codex exec --json` emits a newline-delimited event stream:
//
//   { "type": "thread.started", "thread_id": "..." }
//   { "type": "turn.started" }
//   { "type": "item.started",   "item": { "id": "...", "type": "...", ... } }
//   { "type": "item.updated",   "item": { ... } }
//   { "type": "item.completed", "item": { ... } }
//   { "type": "turn.completed", "usage": { input_tokens, output_tokens, ... } }
//   { "type": "turn.failed",    "error": { "message": "..." } }
//   { "type": "error",          "message": "..." }
//
// Item `type` values we care about:
//   agent_message      — final assistant text (emit assistant_text)
//   reasoning          — chain-of-thought (emit thinking)
//   command_execution  — shell command (emit tool_use on started, tool_result on completed)
//   file_change        — applied edits (tool_use + tool_result; often only
//                        item.completed — see normalizeCodex)
//   mcp_tool_call      — external MCP tool (tool_use + tool_result)
//   web_search         — search query (tool_use)
//   todo_list          — plan snapshot (currently ignored)
//   error              — item-level failure (unknown text)
//
// Codex does not stream token-level deltas today — agent_message arrives as a
// whole item on `item.completed`, mirroring Gemini's non-partial behavior.
function normalizeCodex(
  raw: Record<string, unknown>,
  fileChangeToolUseIssued?: Set<string>,
): StreamEvent[] {
  const type = raw.type as string | undefined;

  switch (type) {
    case 'thread.started':
      // The thread_id doubles as the resume handle: `codex exec resume <id>`.
      return [
        {
          type: 'system',
          sessionId: (raw.thread_id as string) ?? null,
          model: (raw.model as string) ?? null,
          cwd: (raw.cwd as string) ?? null,
          tools: [],
        },
      ];

    case 'turn.started':
      return [];

    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = (raw.item ?? {}) as Record<string, unknown>;
      const itemType = item.type as string | undefined;
      const id = (item.id as string) ?? '';

      switch (itemType) {
        case 'agent_message': {
          // Only emit the final text on item.completed — partial/updated items
          // would duplicate text that Codex finalizes atomically.
          if (type !== 'item.completed') return [];
          const text = typeof item.text === 'string' ? (item.text as string) : '';
          if (!text) return [];
          const { strippedText: afterAsk, asks } = extractAskBlocks(text);
          const { strippedText: afterSteps, steps } = extractStepMarkers(afterAsk);
          const out: StreamEvent[] = [];
          if (asks.length > 0 || steps.length > 0) {
            if (afterSteps) {
              out.push({ type: 'assistant_text', text: afterSteps, partial: false });
            }
            for (const s of steps) out.push(stepEvent(s));
            for (const ask of asks) out.push(askEvent(ask));
          } else {
            out.push({ type: 'assistant_text', text, partial: false });
          }
          return out;
        }

        case 'reasoning': {
          if (type !== 'item.completed') return [];
          const text = typeof item.text === 'string' ? (item.text as string) : '';
          if (!text) return [];
          return [{ type: 'thinking', text }];
        }

        case 'command_execution': {
          const command = typeof item.command === 'string' ? (item.command as string) : '';
          if (type === 'item.started') {
            return [
              {
                type: 'tool_use',
                id,
                tool: 'Bash',
                input: { command },
              },
            ];
          }
          if (type === 'item.completed') {
            const exitCode = typeof item.exit_code === 'number' ? (item.exit_code as number) : 0;
            const output =
              typeof item.aggregated_output === 'string'
                ? (item.aggregated_output as string)
                : typeof item.output === 'string'
                  ? (item.output as string)
                  : '';
            return [
              {
                type: 'tool_result',
                toolUseId: id,
                output,
                isError: exitCode !== 0 || item.status === 'failed',
              },
            ];
          }
          return [];
        }

        case 'file_change': {
          const changes = item.changes ?? [];
          if (type === 'item.started') {
            fileChangeToolUseIssued?.add(id);
            return [
              {
                type: 'tool_use',
                id,
                tool: 'Edit',
                input: { changes } as Record<string, unknown>,
              },
            ];
          }
          if (type === 'item.completed') {
            const out: StreamEvent[] = [];
            if (!fileChangeToolUseIssued?.has(id)) {
              out.push({
                type: 'tool_use',
                id,
                tool: 'Edit',
                input: { changes } as Record<string, unknown>,
              });
            }
            fileChangeToolUseIssued?.delete(id);
            out.push({
              type: 'tool_result',
              toolUseId: id,
              output: stringifyToolResult(changes),
              isError: item.status === 'failed',
            });
            return out;
          }
          return [];
        }

        case 'mcp_tool_call': {
          const server = (item.server as string) ?? 'mcp';
          const tool = (item.tool as string) ?? 'tool';
          const toolName = `${server}:${tool}`;
          if (type === 'item.started') {
            const args = (item.arguments as Record<string, unknown>) ?? {};
            return [
              {
                type: 'tool_use',
                id,
                tool: toolName,
                input: args,
              },
            ];
          }
          if (type === 'item.completed') {
            const resultContent = item.result ?? item.error ?? '';
            const output = stringifyToolResult(resultContent);
            return [
              {
                type: 'tool_result',
                toolUseId: id,
                output,
                isError: item.status === 'failed' || !!item.error,
                ...toolResultImagesField(resultContent),
              },
            ];
          }
          return [];
        }

        case 'web_search': {
          if (type !== 'item.started') return [];
          const query = (item.query as string) ?? '';
          return [
            {
              type: 'tool_use',
              id,
              tool: 'WebSearch',
              input: { query },
            },
          ];
        }

        case 'error': {
          if (type !== 'item.completed') return [];
          const msg = (item.message as string) ?? 'unknown codex item error';
          return [{ type: 'unknown', text: `codex item error: ${msg}` }];
        }

        case 'todo_list':
        default:
          return [];
      }
    }

    case 'turn.completed': {
      const usage = (raw.usage as Record<string, unknown> | undefined) ?? {};
      const inTok = usage.input_tokens as number | undefined;
      const outTok = usage.output_tokens as number | undefined;
      return [
        {
          type: 'result',
          text: '',
          durationMs: (usage.duration_ms as number) ?? null,
          costUsd: null,
          numTurns:
            typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number'
              ? 1
              : null,
          isError: false,
          stopReason: null,
          inputTokens: typeof inTok === 'number' && Number.isFinite(inTok) ? inTok : null,
          outputTokens: typeof outTok === 'number' && Number.isFinite(outTok) ? outTok : null,
        },
      ];
    }

    case 'turn.failed': {
      const err = (raw.error as Record<string, unknown> | undefined) ?? {};
      const message = (err.message as string) ?? 'codex turn failed';
      return [
        {
          type: 'result',
          text: message,
          durationMs: null,
          costUsd: null,
          numTurns: null,
          isError: true,
          stopReason: null,
        },
      ];
    }

    case 'error':
      return [{ type: 'unknown', text: `codex error: ${(raw.message as string) ?? ''}` }];

    default:
      return [{ type: 'unknown', text: `unhandled codex event: ${type ?? 'undefined'}` }];
  }
}
