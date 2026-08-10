/**
 * Regression coverage for: a subagent's entire final report being spliced into
 * the parent agent's chat message.
 *
 * Claude Code is spawned with `--verbose`, which interleaves sidechain frames
 * (from inner subagents the CLI spawned via its own `Task`/`Agent` tool) into
 * the same stream-json output as the parent turn. The only marker is
 * `parent_tool_use_id`. The parser ignored it, so every inner assistant message
 * arrived as an ordinary top-level `assistant_text` and was folded into the
 * parent's reply text and rendered as top-level chat.
 */
import { describe, it, expect } from 'vitest';
import { createStreamParser } from './stream-parser.js';
import { applyAssistantTextChunk } from './assistant-stream-buffer.js';
import { isSidechainStreamEvent } from '../shared/utils/sidechainStreamEvents.js';
import type { StreamEvent } from './types.js';

function feed(lines: Array<Record<string, unknown>>): StreamEvent[] {
  const parser = createStreamParser('claude-code');
  const out: StreamEvent[] = [];
  for (const line of lines) out.push(...parser.feed(`${JSON.stringify(line)}\n`));
  out.push(...parser.flush());
  return out;
}

function assistantFrame(text: string, parentToolUseId?: string) {
  return {
    type: 'assistant',
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: { content: [{ type: 'text', text }] },
  };
}

describe('claude sidechain frames', () => {
  it('tags assistant text from an inner subagent with its parent tool_use id', () => {
    const [event] = feed([assistantFrame('Subagent report body', 'toolu_task_1')]).filter(
      (e) => e.type === 'assistant_text',
    );
    expect(event.parentToolUseId).toBe('toolu_task_1');
    expect(isSidechainStreamEvent(event)).toBe(true);
  });

  it('leaves the parent turn untagged', () => {
    const [event] = feed([assistantFrame("The parent agent's own reply")]).filter(
      (e) => e.type === 'assistant_text',
    );
    expect(event.parentToolUseId).toBeUndefined();
    expect(isSidechainStreamEvent(event)).toBe(false);
  });

  it('tags every event kind a sidechain frame can produce, not just text', () => {
    const events = feed([
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_task_1',
        message: {
          content: [
            { type: 'thinking', thinking: 'inner reasoning' },
            { type: 'tool_use', id: 'inner_1', name: 'Grep', input: { pattern: 'x' } },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: 'toolu_task_1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'inner_1', content: 'match' }],
        },
      },
    ]);

    const kinds = ['thinking', 'tool_use', 'tool_result'];
    for (const kind of kinds) {
      const found = events.filter((e) => e.type === kind);
      expect(found.length, `expected a ${kind} event`).toBeGreaterThan(0);
      for (const e of found) expect(isSidechainStreamEvent(e)).toBe(true);
    }
  });

  it('tags partial text deltas from a sidechain', () => {
    const events = feed([
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_task_1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk' } },
      },
    ]).filter((e) => e.type === 'assistant_text');
    expect(events).toHaveLength(1);
    expect(events[0].partial).toBe(true);
    expect(isSidechainStreamEvent(events[0])).toBe(true);
  });

  it('treats an empty parent_tool_use_id as a parent frame', () => {
    const [event] = feed([assistantFrame('parent text', '')]).filter(
      (e) => e.type === 'assistant_text',
    );
    expect(isSidechainStreamEvent(event)).toBe(false);
  });

  it('keeps the subagent report out of the parent message text', () => {
    // Mirrors the accumulation in chat.ts: fold only untagged assistant_text.
    const events = feed([
      assistantFrame('Here is the short answer.'),
      assistantFrame('A three thousand word research report.', 'toolu_task_1'),
      assistantFrame(' Done.'),
    ]).filter((e) => e.type === 'assistant_text');

    let state = { finalText: '', partialFallback: '' };
    for (const event of events) {
      if (isSidechainStreamEvent(event)) continue;
      state = applyAssistantTextChunk(state, event.text, event.partial).next;
    }

    expect(state.finalText).toBe('Here is the short answer. Done.');
    expect(state.finalText).not.toContain('research report');
  });
});
