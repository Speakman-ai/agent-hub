import type { StreamEvent, StreamParser } from './types.js';

type NormalizeFn = (raw: Record<string, unknown>) => StreamEvent[];

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
          out.push({ type: 'assistant_text', text: block.text as string, partial: false });
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

    case 'result':
      return [
        {
          type: 'result',
          text: (raw.result as string) ?? '',
          durationMs: (raw.duration_ms as number) ?? null,
          costUsd: null,
          numTurns: null,
          isError: raw.is_error === true,
          stopReason: null,
        },
      ];

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
