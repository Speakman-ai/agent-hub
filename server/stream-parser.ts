import type {
  AskUserQuestionEvent,
  AskUserQuestionItem,
  ProgressStepEvent,
  ProgressStepStatus,
  StreamEvent,
  StreamParser,
} from './types.js';

type NormalizeFn = (raw: Record<string, unknown>) => StreamEvent[];

/** Edit / Write `tool_call.started` sometimes carries `{}` or a placeholder; full `args` arrive on `completed` (see Cursor stream-json docs). */
function shouldDeferCursorFileToolCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'Edit' && toolName !== 'Write') return false;
  if (Object.keys(input).length === 0) return true;
  if (toolName === 'Write') {
    if (typeof input.fileText === 'string' && input.fileText.length > 0) return false;
    if (typeof input.content === 'string' && input.content.length > 0) return false;
    if (typeof input.contents === 'string' && input.contents.length > 0) return false;
    return true;
  }
  // Edit
  if (input.strReplace || input.multiStrReplace || input.applyPatch) return false;
  if (typeof input.unified_diff === 'string' && input.unified_diff.trim()) return false;
  if (input.changes && Array.isArray(input.changes)) return false;
  if (typeof input.old_string === 'string' || typeof input.oldString === 'string') return false;
  if (typeof input.new_string === 'string' || typeof input.newString === 'string') return false;
  return true;
}

function mergeCursorFileToolInput(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  return { ...a, ...b };
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

const ASK_FENCE_RE = /```agenthub:ask\s*\n([\s\S]*?)\n?```/g;

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

function askMatchOverlapsLockedBody(
  start: number,
  end: number,
  locked: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  for (const r of locked) {
    if (start < r.end && end > r.start) return true;
  }
  return false;
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
  const asks: ExtractedAsk[] = [];
  let strippedText = text;

  // Reset regex state for each call (the /g flag is stateful across calls).
  ASK_FENCE_RE.lastIndex = 0;
  const replacements: Array<{ start: number; end: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = ASK_FENCE_RE.exec(text)) !== null) {
    const payload = match[1].trim();
    const questions = parseAskPayload(payload);
    if (!questions) continue; // malformed — leave in place

    const start = match.index;
    const end = start + match[0].length;
    if (askMatchOverlapsLockedBody(start, end, lockedBodies)) {
      continue;
    }

    // Stable-ish id: hash-lite of the payload. Not cryptographic — only used
    // for React keys and dedup across re-parses of the same message.
    const askId = 'ask-' + simpleHash(payload);
    asks.push({ askId, questions });
    replacements.push({ start, end });
  }

  if (replacements.length === 0) {
    return { strippedText: text, asks: [] };
  }

  // Build stripped text by excluding the replaced ranges. Walk in reverse so
  // indices stay valid.
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end } = replacements[i];
    strippedText = strippedText.slice(0, start) + strippedText.slice(end);
  }
  // Collapse any blank-line runs left behind by block removal.
  strippedText = strippedText.replace(/\n{3,}/g, '\n\n').trim();

  return { strippedText, asks };
}

function parseAskPayload(raw: string): AskUserQuestionItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Accept either a bare array of questions or an object with a `questions`
  // array (matches Claude's native AskUserQuestion tool input shape).
  const list: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown>)?.questions;
  if (!Array.isArray(list) || list.length === 0 || list.length > 4) return null;

  const out: AskUserQuestionItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const q = item as Record<string, unknown>;

    const question = typeof q.question === 'string' ? q.question : null;
    if (!question) return null;
    // `header` is a short chip in the UI (≤12 chars). Models sometimes omit it or
    // send a blank string; default from the question so we still extract a picker.
    const headerRaw = typeof q.header === 'string' ? q.header.trim() : '';
    const header = (
      headerRaw ? headerRaw : question.replace(/\s+/g, ' ').trim() || 'Question'
    ).slice(0, 12);
    const multiSelect = q.multiSelect === true;
    const options = Array.isArray(q.options) ? q.options : null;

    if (!options || options.length < 2 || options.length > 4) return null;

    const validOptions: AskUserQuestionItem['options'] = [];
    for (const opt of options) {
      if (!opt || typeof opt !== 'object') return null;
      const o = opt as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label : null;
      if (!label) return null;
      // `description` is recommended but not required — a single option with a
      // missing description should not invalidate the whole picker. Default to
      // empty string; the UI hides empty descriptions.
      const description = typeof o.description === 'string' ? o.description : '';
      const preview = typeof o.preview === 'string' ? o.preview : undefined;
      validOptions.push(preview ? { label, description, preview } : { label, description });
    }

    out.push({ question, header, multiSelect, options: validOptions });
  }

  return out;
}

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

function simpleHash(s: string): string {
  // Tiny non-crypto hash; deterministic for a given payload.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
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
  const normalize: NormalizeFn =
    engine === 'cursor-agent'
      ? (raw) => normalizeCursor(raw, cursorDeferredFileToolCalls, cursorFileToolStartedEmitted)
      : engine === 'gemini-cli'
        ? normalizeGemini
        : engine === 'codex-cli'
          ? (raw) => normalizeCodex(raw, codexFileChangeToolUseIssued)
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
    for (const e of events) e.raw = trimmed;
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
          out.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id as string,
            output: stringifyToolResult(block.content),
            isError: block.is_error === true,
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

    default:
      return [{ type: 'unknown', text: `unhandled claude event: ${raw.type as string}` }];
  }
}

// ─── Cursor Agent normalizer ───────────────────────────────────────────

function normalizeCursor(
  raw: Record<string, unknown>,
  deferredFileToolCalls: Map<string, { tool: string; args: Record<string, unknown> }>,
  fileToolStartedEmitted: Set<string>,
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
        const pending = deferredFileToolCalls.get(callId);
        if (pending) {
          deferredFileToolCalls.delete(callId);
          const merged = mergeCursorFileToolInput(pending.args, completedArgs);
          out.push({ type: 'tool_use', id: callId, tool: pending.tool, input: merged });
        } else if (
          (toolName === 'Edit' || toolName === 'Write') &&
          !fileToolStartedEmitted.has(callId) &&
          Object.keys(completedArgs).length > 0
        ) {
          // `tool_call.started` missing but `completed` has args (CLI edge case)
          out.push({ type: 'tool_use', id: callId, tool: toolName, input: completedArgs });
        }
        fileToolStartedEmitted.delete(callId);

        const result = (detail.result ?? {}) as Record<string, unknown>;
        const success = (result.success as Record<string, unknown> | null) ?? null;
        const failure = (result.failure as string | Record<string, unknown> | null) ?? null;
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

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
          return ((b as Record<string, unknown>).text as string) ?? '';
        return JSON.stringify(b);
      })
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
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
      const output = stringifyToolResult(raw.output ?? raw.content);
      return [
        {
          type: 'tool_result',
          toolUseId,
          output,
          isError: raw.isError === true || raw.is_error === true || raw.status === 'error',
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
            const output = stringifyToolResult(item.result ?? item.error ?? '');
            return [
              {
                type: 'tool_result',
                toolUseId: id,
                output,
                isError: item.status === 'failed' || !!item.error,
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
