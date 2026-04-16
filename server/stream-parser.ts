import type {
  AskUserQuestionEvent,
  AskUserQuestionItem,
  ProgressStepEvent,
  ProgressStepStatus,
  StreamEvent,
  StreamParser,
} from './types.js';

type NormalizeFn = (raw: Record<string, unknown>) => StreamEvent[];

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

    // Stable-ish id: hash-lite of the payload. Not cryptographic — only used
    // for React keys and dedup across re-parses of the same message.
    const askId = 'ask-' + simpleHash(payload);
    asks.push({ askId, questions });
    replacements.push({ start: match.index, end: match.index + match[0].length });
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
    const header = typeof q.header === 'string' ? q.header : null;
    const multiSelect = q.multiSelect === true;
    const options = Array.isArray(q.options) ? q.options : null;

    if (!question || !header || !options || options.length < 2 || options.length > 4) return null;

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
  const normalize: NormalizeFn = engine === 'cursor-agent' ? normalizeCursor : normalizeClaude;

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
      if (!buffer.trim()) return [];
      const events = parseLine(buffer, normalize);
      buffer = '';
      return events;
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

    case 'result':
      return [
        {
          type: 'result',
          text: (raw.result as string) ?? '',
          durationMs: (raw.duration_ms as number) ?? null,
          costUsd: (raw.total_cost_usd as number) ?? null,
          numTurns: (raw.num_turns as number) ?? null,
          isError: raw.is_error === true,
          stopReason: (raw.stop_reason as string) ?? null,
        },
      ];

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

function normalizeCursor(raw: Record<string, unknown>): StreamEvent[] {
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

    case 'assistant': {
      if (raw.timestamp_ms === undefined) return [];
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
      const callId = raw.call_id as string;
      const tc = (raw.tool_call ?? {}) as Record<string, Record<string, unknown>>;
      const variant = Object.keys(tc)[0];
      const detail = tc[variant] ?? {};
      const toolName = friendlyCursorToolName(variant);
      const input = (detail.args as Record<string, unknown>) ?? {};

      if (raw.subtype === 'started') {
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
        return [
          {
            type: 'tool_result',
            toolUseId: callId,
            output,
            isError,
          },
        ];
      }
      return [];
    }

    case 'result': {
      // Cursor Agent only streams partials during the turn (no finalized
      // assistant_text event). The full assistant message lands on `raw.result`.
      // If it contains any agenthub:ask fenced blocks, extract them here so the
      // picker renders in Cursor sessions too — mirroring the Claude path.
      const resultText = typeof raw.result === 'string' ? raw.result : '';
      const out: StreamEvent[] = [];
      if (resultText) {
        const { strippedText: afterAsk, asks } = extractAskBlocks(resultText);
        const { strippedText: afterSteps, steps } = extractStepMarkers(afterAsk);
        if (asks.length > 0 || steps.length > 0) {
          // Emit a finalized assistant_text with the stripped text so chat.ts
          // sets `finalText`, which replaces the raw-fence partialFallback on
          // both the persisted message and the broadcasted stream content.
          if (afterSteps) {
            out.push({ type: 'assistant_text', text: afterSteps, partial: false });
          }
          for (const s of steps) out.push(stepEvent(s));
          for (const ask of asks) out.push(askEvent(ask));
        }
      }
      out.push({
        type: 'result',
        text: resultText,
        durationMs: (raw.duration_ms as number) ?? null,
        costUsd: null,
        numTurns: null,
        isError: raw.is_error === true,
        stopReason: null,
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
