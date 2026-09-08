import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  createCodexFileChangeEventHandler,
  enrichCodexFileChangeDiffs,
} from './codex-file-change-diff.js';
import { HostWorktreeIo } from './session-env/worktree-io.js';
import { createStreamParser } from './stream-parser.js';
import type { StreamEvent } from './types.js';

describe('enrichCodexFileChangeDiffs', () => {
  it('adds git diff text to path-only Codex file_change results', async () => {
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

    const [, event] = await enrichCodexFileChangeDiffs(events, '/repo', {
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

  it('uses the HEAD file diff so staged-only changes still render', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'agent-hub-codex-diff-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

    try {
      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test User']);
      writeFileSync(path.join(repo, 'f.ts'), 'before\n');
      git(['add', 'f.ts']);
      git(['commit', '-m', 'init']);
      writeFileSync(path.join(repo, 'f.ts'), 'after\n');
      git(['add', 'f.ts']);

      const events: StreamEvent[] = [
        {
          type: 'tool_use',
          id: 'fc_1',
          tool: 'Edit',
          input: { changes: [{ path: 'f.ts', kind: 'update' }] },
        },
        {
          type: 'tool_result',
          toolUseId: 'fc_1',
          output: JSON.stringify([{ path: 'f.ts', kind: 'update' }]),
          isError: false,
        },
      ];

      const [, event] = await enrichCodexFileChangeDiffs(events, repo);

      expect(event.type).toBe('tool_result');
      const output = JSON.parse((event as { output: string }).output);
      expect(output[0].unified_diff).toContain('-before');
      expect(output[0].unified_diff).toContain('+after');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not overwrite Codex results that already include patch text', async () => {
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

    const [toolUse, event] = await enrichCodexFileChangeDiffs(events, '/repo', {
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

  it('leaves path-only Codex results unchanged when git has no diff', async () => {
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

    const [toolUse, event] = await enrichCodexFileChangeDiffs(events, '/repo', {
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

  it('does not enrich unrelated JSON-array tool results with path fields', async () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_result',
        toolUseId: 'search_1',
        output: JSON.stringify([{ path: 'client/src/App.jsx' }]),
        isError: false,
      },
    ];

    const [event] = await enrichCodexFileChangeDiffs(events, '/repo', {
      runGitDiff: () => {
        throw new Error('git diff should not be called');
      },
    });

    expect(event).toBe(events[0]);
  });
});

function fileChangeEvents(filePath: string, kind = 'add'): StreamEvent[] {
  const changes = [{ path: filePath, kind }];
  return [
    { type: 'tool_use', id: 'fc_guest', tool: 'Edit', input: { changes } },
    { type: 'tool_result', toolUseId: 'fc_guest', output: JSON.stringify(changes), isError: false },
  ];
}

describe('Codex diffs from the live worktree', () => {
  it.each(['/workspace/backend/research/test.py', 'research/test.py'])(
    'recovers new file contents from guest IO for %s',
    async (filePath) => {
      const guest = mkdtempSync(path.join(tmpdir(), 'codex-guest-'));
      try {
        mkdirSync(path.join(guest, 'backend/research'), { recursive: true });
        writeFileSync(
          path.join(guest, 'backend/research/test.py'),
          'def test_annotation():\n    assert True\n',
        );
        const io = new HostWorktreeIo(guest);
        const readFile = vi.spyOn(io, 'readFile');
        const [, result] = await enrichCodexFileChangeDiffs(
          fileChangeEvents(filePath),
          '/workspace/backend',
          { worktreeIo: io, worktreeRoot: '/workspace' },
        );
        expect(result.type).toBe('tool_result');
        if (result.type !== 'tool_result') throw new Error('missing result');
        expect(JSON.parse(result.output)[0].content).toContain('def test_annotation():');
        expect(readFile).toHaveBeenCalledWith('backend/research/test.py');
      } finally {
        rmSync(guest, { recursive: true, force: true });
      }
    },
  );

  it('does not recover a workspace diff for a failed edit', async () => {
    const runGitDiff = vi.fn(() => '@@ -1 +1 @@\n-unrelated old\n+unrelated new\n');
    const events = fileChangeEvents('f.ts', 'update');
    Object.assign(events[1], { isError: true });
    const result = await enrichCodexFileChangeDiffs(events, '/repo', { runGitDiff });
    expect(result[1]).toEqual(events[1]);
    expect(runGitDiff).not.toHaveBeenCalled();
  });
});

describe('Codex diff recovery boundaries', () => {
  it.each(['update', 'delete'])(
    'recovers a tracked %s from the live guest checkout',
    async (kind) => {
      const guest = mkdtempSync(path.join(tmpdir(), 'codex-guest-tracked-'));
      const git = (args: string[]) => execFileSync('git', args, { cwd: guest, stdio: 'ignore' });
      try {
        git(['init']);
        git(['config', 'user.email', 'test@example.com']);
        git(['config', 'user.name', 'Test User']);
        writeFileSync(path.join(guest, 'file.ts'), 'before\n');
        git(['add', '.']);
        git(['commit', '-m', 'baseline']);
        if (kind === 'delete') rmSync(path.join(guest, 'file.ts'));
        else writeFileSync(path.join(guest, 'file.ts'), 'after\n');
        const [, result] = await enrichCodexFileChangeDiffs(
          fileChangeEvents('/workspace/file.ts', kind),
          '/workspace/backend',
          { worktreeIo: new HostWorktreeIo(guest), worktreeRoot: '/workspace' },
        );
        if (result.type !== 'tool_result') throw new Error('missing result');
        const change = JSON.parse(result.output)[0];
        expect(change.unified_diff).toContain('-before');
        if (kind === 'update') expect(change.unified_diff).toContain('+after');
      } finally {
        rmSync(guest, { recursive: true, force: true });
      }
    },
  );

  it.each(['/workspace-other/secrets', '../../secrets', '/etc/passwd'])(
    'never reads a path outside the live checkout: %s',
    async (filePath) => {
      const io = { git: vi.fn(), readFile: vi.fn(), stat: vi.fn() };
      const events = fileChangeEvents(filePath);
      expect(
        await enrichCodexFileChangeDiffs(events, '/workspace/backend', {
          worktreeIo: io,
          worktreeRoot: '/workspace',
        }),
      ).toEqual(events);
      expect(io.git).not.toHaveBeenCalled();
      expect(io.stat).not.toHaveBeenCalled();
      expect(io.readFile).not.toHaveBeenCalled();
    },
  );

  it('preserves supplied content without reading the checkout', async () => {
    const io = { git: vi.fn(), readFile: vi.fn(), stat: vi.fn() };
    const events = fileChangeEvents('file.ts');
    Object.assign(events[1], {
      output: JSON.stringify([{ path: 'file.ts', kind: 'add', content: 'original' }]),
    });
    expect(await enrichCodexFileChangeDiffs(events, '/workspace', { worktreeIo: io })).toEqual(
      events,
    );
    expect(io.git).not.toHaveBeenCalled();
    expect(io.readFile).not.toHaveBeenCalled();
  });

  it('does not read oversized additions or attach binary content', async () => {
    const io = {
      git: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
      stat: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'file', size: 1024 * 1024 })
        .mockResolvedValueOnce({ kind: 'file', size: 3 }),
      readFile: vi.fn().mockResolvedValue(Buffer.from([65, 0, 66])),
    };
    const events = fileChangeEvents('file.bin');
    expect(await enrichCodexFileChangeDiffs(events, '/workspace', { worktreeIo: io })).toEqual(
      events,
    );
    expect(io.readFile).not.toHaveBeenCalled();
    expect(await enrichCodexFileChangeDiffs(events, '/workspace', { worktreeIo: io })).toEqual(
      events,
    );
  });

  it('keeps the stream usable when guest git and reads fail', async () => {
    const events = fileChangeEvents('file.ts');
    const io = {
      git: vi.fn().mockRejectedValue(new Error('offline')),
      stat: vi.fn().mockRejectedValue(new Error('offline')),
      readFile: vi.fn(),
    };
    expect(await enrichCodexFileChangeDiffs(events, '/workspace', { worktreeIo: io })).toEqual(
      events,
    );
  });
});

describe('Codex file change event ordering', () => {
  it('drains completed-only and split events before later text and turn completion', async () => {
    let finishDiff!: (diff: string) => void;
    const diff = new Promise<string>((resolve) => {
      finishDiff = resolve;
    });
    const runGitDiff = vi
      .fn()
      .mockReturnValueOnce(diff)
      .mockResolvedValue('@@ -1 +1 @@\n-old\n+new\n');
    const received: StreamEvent[] = [];
    const handler = createCodexFileChangeEventHandler(
      '/workspace',
      (event) => received.push(event),
      { runGitDiff },
    );
    const parser = createStreamParser('codex-cli');
    const feed = (value: unknown) =>
      handler.enqueue(parser.feed(Buffer.from(JSON.stringify(value) + '\n')));
    feed({
      type: 'item.completed',
      item: {
        id: 'first',
        type: 'file_change',
        changes: [{ path: '/workspace/f.ts', kind: 'update' }],
        status: 'completed',
      },
    });
    feed({
      type: 'item.started',
      item: { id: 'second', type: 'file_change', changes: [{ path: 'f.ts', kind: 'update' }] },
    });
    feed({
      type: 'item.completed',
      item: {
        id: 'second',
        type: 'file_change',
        changes: [{ path: 'f.ts', kind: 'update' }],
        status: 'completed',
      },
    });
    feed({ type: 'item.completed', item: { id: 'text', type: 'agent_message', text: 'Finished' } });
    handler.enqueue(parser.flush());
    let drained = false;
    const completion = handler.drain().then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(runGitDiff).toHaveBeenCalledTimes(1));
    expect(drained).toBe(false);
    expect(received).toEqual([]);
    finishDiff('@@ -1 +1 @@\n-before\n+after\n');
    await completion;
    expect(received.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'assistant_text',
    ]);
    expect(received[1]).toMatchObject({
      toolUseId: 'first',
      output: expect.stringContaining('+after'),
    });
    expect(received[3]).toMatchObject({
      toolUseId: 'second',
      output: expect.stringContaining('+new'),
    });
    expect(drained).toBe(true);
  });
});
