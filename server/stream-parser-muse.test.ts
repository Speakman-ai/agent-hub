import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { createStreamParser } from './stream-parser.js';
import type { StreamEvent } from './types.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/muse');

// Fixtures are real `muse exec --json` output from muse 1.4.6, driven by a
// local Responses-API stub so the tool calls are deterministic.
function parseFixture(name: string): StreamEvent[] {
  const parser = createStreamParser('muse-code');
  const text = readFileSync(path.join(fixtureDir, name), 'utf8');
  // Feed in uneven chunks to exercise line buffering across chunk boundaries.
  const events: StreamEvent[] = [];
  for (let i = 0; i < text.length; i += 777) events.push(...parser.feed(text.slice(i, i + 777)));
  events.push(...parser.flush());
  return events;
}

function ofType<T extends StreamEvent['type']>(events: StreamEvent[], type: T) {
  return events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === type);
}

describe('createStreamParser("muse-code")', () => {
  it('emits the Muse session id once as the system event', () => {
    const events = parseFixture('exec-bash-tool.jsonl');
    const systems = ofType(events, 'system');
    expect(systems).toHaveLength(1);
    expect(systems[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns a bash tool.result into a Bash tool_use + tool_result pair', () => {
    const events = parseFixture('exec-bash-tool.jsonl');
    const [use] = ofType(events, 'tool_use');
    const [result] = ofType(events, 'tool_result');
    expect(use).toMatchObject({ tool: 'Bash', input: { command: 'echo hi-from-tool' } });
    expect(result).toMatchObject({
      toolUseId: use.id,
      output: 'hi-from-tool\n',
      isError: false,
    });
  });

  it('streams partial text and finalizes the reply with a result', () => {
    const events = parseFixture('exec-bash-tool.jsonl');
    const partials = ofType(events, 'assistant_text').filter((e) => e.partial);
    expect(partials.map((e) => e.text).join('')).toBe('Done. The command printed hi-from-tool.');
    const final = ofType(events, 'assistant_text').filter((e) => !e.partial);
    expect(final).toEqual([
      {
        type: 'assistant_text',
        text: 'Done. The command printed hi-from-tool.',
        partial: false,
        replacesAssistantBuffer: true,
      },
    ]);
    const [result] = ofType(events, 'result');
    expect(result).toMatchObject({ isError: false, stopReason: 'completed' });
    expect(ofType(events, 'unknown')).toEqual([]);
  });

  it('maps file tools and marks a failed edit as an error', () => {
    const events = parseFixture('exec-file-tools.jsonl');
    const uses = ofType(events, 'tool_use');
    expect(uses.map((u) => [u.tool, u.input])).toEqual([
      ['Write', { file_path: 'hello.txt' }],
      ['Edit', { file_path: 'hello.txt' }],
    ]);
    const results = ofType(events, 'tool_result');
    expect(results.map((r) => r.isError)).toEqual([false, true]);
    expect(results[1].output).toContain('missing field `find`');
  });

  it('reports a rejected credential as a failed turn', () => {
    const events = parseFixture('exec-auth-failed.jsonl');
    const [result] = ofType(events, 'result');
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'muse error: your API key from META_API_KEY was rejected — update or unset it',
    );
  });

  it('keeps only the text after the last tool call as the final reply', () => {
    const parser = createStreamParser('muse-code');
    const line = (payload_type: string, payload: Record<string, unknown>) =>
      JSON.stringify({ stream: { kind: 'session', id: 's-1' }, payload_type, payload }) + '\n';
    const events = parser.feed(
      line('run.output.delta', { text: 'Let me check. ' }) +
        line('task.lifecycle.proposed', { event: { task_kind: 'tool.read_file' } }) +
        line('tool.result', {
          call_id: 'c1',
          text: 'file body',
          correlation_facts: { outcome: 'success', tool_name: 'read_file' },
        }) +
        line('run.output.delta', { text: 'All good.' }) +
        line('run.terminal.completed', { terminal: 'completed', text: 'Let me check. All good.' }),
    );
    const final = ofType(events, 'assistant_text').filter((e) => !e.partial);
    expect(final.map((e) => e.text)).toEqual(['All good.']);
    expect(ofType(events, 'tool_use')[0]).toMatchObject({ id: 'c1', tool: 'Read' });
  });

  it('extracts ask blocks from the final reply', () => {
    const parser = createStreamParser('muse-code');
    const reply =
      'Pick one.\n```agenthub:ask\n{"question":"Which?","header":"Pick","options":[{"label":"A"},{"label":"B"}]}\n```';
    const events = parser.feed(
      JSON.stringify({ payload_type: 'run.output.delta', payload: { text: reply } }) +
        '\n' +
        JSON.stringify({
          payload_type: 'run.terminal.completed',
          payload: { terminal: 'completed', text: reply },
        }) +
        '\n',
    );
    expect(ofType(events, 'ask_user_question')).toHaveLength(1);
  });
});
