/**
 * Stream-JSON parser for Claude Code and Cursor Agent CLIs.
 *
 * Both CLIs support `--output-format stream-json` which emits one JSON object
 * per line on stdout. The shapes differ between engines, so this module
 * normalizes them into a single event vocabulary that the rest of the app
 * can render uniformly.
 *
 * Normalized event shape:
 *   {
 *     type: 'system' | 'assistant_text' | 'thinking' | 'tool_use' |
 *           'tool_result' | 'result' | 'error' | 'unknown',
 *     ...type-specific fields,
 *     raw: <original line> // for debugging / forward compat
 *   }
 *
 * Type-specific fields:
 *   system        : { sessionId, model, cwd, tools }
 *   assistant_text: { text, partial }
 *   thinking      : { text }
 *   tool_use      : { id, tool, input }
 *   tool_result   : { toolUseId, output, isError }
 *   result        : { text, durationMs, costUsd, isError, numTurns }
 *   error         : { message }
 *
 * Usage:
 *   const parser = createStreamParser('claude-code');
 *   proc.stdout.on('data', (chunk) => {
 *     for (const event of parser.feed(chunk)) {
 *       // persist + broadcast
 *     }
 *   });
 *   proc.on('close', () => {
 *     for (const event of parser.flush()) { ... }
 *   });
 */

export function createStreamParser(engine) {
  let buffer = '';
  const normalize = engine === 'cursor-agent' ? normalizeCursor : normalizeClaude;

  return {
    /**
     * Feed a chunk of stdout. Returns an array of normalized events.
     * Handles partial lines split across chunks.
     */
    feed(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // The last element may be a partial line — keep it for the next feed.
      buffer = lines.pop() ?? '';
      const out = [];
      for (const line of lines) {
        const events = parseLine(line, normalize);
        if (events.length) out.push(...events);
      }
      return out;
    },

    /**
     * Flush any remaining buffered content. Call once on process close.
     */
    flush() {
      if (!buffer.trim()) return [];
      const events = parseLine(buffer, normalize);
      buffer = '';
      return events;
    },
  };
}

function parseLine(line, normalize) {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // Not JSON — could be a log line on stderr that ended up on stdout, or
    // a partial chunk at EOF. Surface as a generic 'unknown' so we don't lose it.
    return [{ type: 'unknown', text: trimmed, raw: trimmed }];
  }
  try {
    const events = normalize(raw);
    // Attach the raw line to every emitted event for forensics.
    for (const e of events) e.raw = trimmed;
    return events;
  } catch (err) {
    return [{ type: 'unknown', text: `parse error: ${err.message}`, raw: trimmed }];
  }
}

// ─── Claude Code normalizer ────────────────────────────────────────────

function normalizeClaude(raw) {
  switch (raw.type) {
    case 'system':
      if (raw.subtype === 'init') {
        return [
          {
            type: 'system',
            sessionId: raw.session_id ?? null,
            model: raw.model ?? null,
            cwd: raw.cwd ?? null,
            tools: Array.isArray(raw.tools) ? raw.tools : [],
            gitWorktree: raw.workspace?.git_worktree ?? null,
          },
        ];
      }
      return [];

    case 'assistant': {
      // assistant.message.content is an array of blocks: text, thinking, tool_use
      const content = raw.message?.content ?? [];
      const out = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out.push({ type: 'assistant_text', text: block.text, partial: false });
        } else if (block.type === 'thinking' && block.thinking) {
          out.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            id: block.id,
            tool: block.name,
            input: block.input ?? {},
          });
        }
      }
      return out;
    }

    case 'user': {
      // user.message.content has tool_result blocks (after the model called a tool)
      const content = raw.message?.content ?? [];
      const out = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          out.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            output: stringifyToolResult(block.content),
            isError: block.is_error === true,
          });
        }
      }
      return out;
    }

    case 'stream_event': {
      // Fine-grained Anthropic-API delta events. We only care about text deltas
      // for live streaming; the canonical record comes from `assistant` events.
      const ev = raw.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const deltaText =
          typeof ev.delta.text === 'string' ? ev.delta.text : JSON.stringify(ev.delta.text ?? '');
        return [{ type: 'assistant_text', text: deltaText, partial: true }];
      }
      return [];
    }

    case 'result':
      return [
        {
          type: 'result',
          text: raw.result ?? '',
          durationMs: raw.duration_ms ?? null,
          costUsd: raw.total_cost_usd ?? null,
          numTurns: raw.num_turns ?? null,
          isError: raw.is_error === true,
          stopReason: raw.stop_reason ?? null,
        },
      ];

    case 'rate_limit_event':
      return []; // Not user-facing

    default:
      return [{ type: 'unknown', text: `unhandled claude event: ${raw.type}` }];
  }
}

// ─── Cursor Agent normalizer ───────────────────────────────────────────

function normalizeCursor(raw) {
  switch (raw.type) {
    case 'system':
      if (raw.subtype === 'init') {
        return [
          {
            type: 'system',
            sessionId: raw.session_id ?? null,
            model: raw.model ?? null,
            cwd: raw.cwd ?? null,
            tools: [],
          },
        ];
      }
      return [];

    case 'user':
      // Cursor echoes the initial user prompt as a `user` event. We don't need
      // to surface this — the chat already knows the user message — so skip it.
      return [];

    case 'thinking':
      // Cursor emits thinking events during model reasoning. Silently skip —
      // these are internal chain-of-thought and not user-facing content.
      return [];

    case 'assistant': {
      // Cursor emits multiple assistant events during streaming, plus a final
      // consolidated one without a `timestamp_ms` field. Skip the final to
      // avoid duplicating text.
      if (raw.timestamp_ms === undefined) return [];
      const content = raw.message?.content ?? [];
      const out = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out.push({ type: 'assistant_text', text: block.text, partial: true });
        }
      }
      return out;
    }

    case 'tool_call': {
      // Cursor's tool calls are nested, e.g. tool_call.shellToolCall, with
      // `started` (input only) and `completed` (input + result) subtypes.
      const callId = raw.call_id;
      const tc = raw.tool_call ?? {};
      const variant = Object.keys(tc)[0]; // e.g. 'shellToolCall'
      const detail = tc[variant] ?? {};
      const toolName = friendlyCursorToolName(variant);
      const input = detail.args ?? {};

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
        const result = detail.result ?? {};
        const success = result.success ?? null;
        const failure = result.failure ?? null;
        let output = '';
        let isError = false;
        if (success) {
          // Shell-style results
          if (typeof success.stdout === 'string' || typeof success.stderr === 'string') {
            output =
              (success.stdout ?? '') + (success.stderr ? '\n[stderr]\n' + success.stderr : '');
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
          text: raw.result ?? '',
          durationMs: raw.duration_ms ?? null,
          costUsd: null, // Cursor doesn't report cost in result
          numTurns: null,
          isError: raw.is_error === true,
          stopReason: null,
        },
      ];

    default:
      return [{ type: 'unknown', text: `unhandled cursor event: ${raw.type}` }];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Tool results in Claude can be either a string or an array of content blocks.
 * Normalize to a string for storage/display.
 */
function stringifyToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text ?? '';
        return JSON.stringify(b);
      })
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

/**
 * Map Cursor's nested tool variant key (e.g. 'shellToolCall') to a friendly
 * name that matches Claude Code's tool names where possible.
 */
function friendlyCursorToolName(variant) {
  if (!variant) return 'unknown';
  const map = {
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
  if (map[variant]) return map[variant];
  // Strip the trailing "ToolCall" and capitalize.
  const stripped = variant.replace(/ToolCall$/, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
