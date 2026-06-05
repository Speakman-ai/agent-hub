import { describe, expect, it } from 'vitest';
import { enrichCodexFileChangeDiffs } from './codex-file-change-diff.js';
import type { StreamEvent } from './types.js';

describe('enrichCodexFileChangeDiffs', () => {
  it('adds git diff text to path-only Codex file_change results', () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_use',
        id: 'fc_1',
        tool: 'Edit',
        input: { changes: [{ path: 'client/src/App.jsx', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        toolUseId: 'fc_1',
        output: JSON.stringify([{ path: 'client/src/App.jsx', kind: 'update' }]),
        isError: false,
      },
    ];

    const [, event] = enrichCodexFileChangeDiffs(events, '/repo', {
      runGitDiff: (cwd, filePath) => {
        expect(cwd).toBe('/repo');
        expect(filePath).toBe('client/src/App.jsx');
        return '@@ -1,1 +1,1 @@\n-before\n+after\n';
      },
    });

    expect(event.type).toBe('tool_result');
    const output = JSON.parse((event as { output: string }).output);
    expect(output).toEqual([
      {
        path: 'client/src/App.jsx',
        kind: 'update',
        unified_diff: '@@ -1,1 +1,1 @@\n-before\n+after\n',
      },
    ]);
  });

  it('does not overwrite Codex results that already include patch text', () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_use',
        id: 'fc_1',
        tool: 'Edit',
        input: { changes: [{ path: 'x.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        toolUseId: 'fc_1',
        output: JSON.stringify([{ path: 'x.ts', kind: 'update', patch: '-old\n+new' }]),
        isError: false,
      },
    ];

    const [toolUse, event] = enrichCodexFileChangeDiffs(events, '/repo', {
      runGitDiff: () => {
        throw new Error('git diff should not be called');
      },
    });

    expect(toolUse).toBe(events[0]);
    expect(event).toEqual({
      type: 'tool_result',
      toolUseId: 'fc_1',
      output: JSON.stringify([{ path: 'x.ts', kind: 'update', patch: '-old\n+new' }]),
      isError: false,
    });
  });

  it('leaves path-only Codex results unchanged when git has no diff', () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_use',
        id: 'fc_1',
        tool: 'Edit',
        input: { changes: [{ path: 'x.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        toolUseId: 'fc_1',
        output: JSON.stringify([{ path: 'x.ts', kind: 'update' }]),
        isError: false,
      },
    ];

    const [toolUse, event] = enrichCodexFileChangeDiffs(events, '/repo', {
      runGitDiff: () => '',
    });

    expect(toolUse).toBe(events[0]);
    expect(event).toEqual({
      type: 'tool_result',
      toolUseId: 'fc_1',
      output: JSON.stringify([{ path: 'x.ts', kind: 'update' }]),
      isError: false,
    });
  });

  it('does not enrich unrelated JSON-array tool results with path fields', () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_result',
        toolUseId: 'search_1',
        output: JSON.stringify([{ path: 'client/src/App.jsx' }]),
        isError: false,
      },
    ];

    const [event] = enrichCodexFileChangeDiffs(events, '/repo', {
      runGitDiff: () => {
        throw new Error('git diff should not be called');
      },
    });

    expect(event).toBe(events[0]);
  });
});
