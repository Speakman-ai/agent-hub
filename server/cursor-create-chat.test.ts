import { describe, it, expect, vi } from 'vitest';
import { createCursorChatBounded, CURSOR_CREATE_CHAT_TIMEOUT_MS } from './cursor-create-chat.js';

const BIN = '/usr/local/bin/cursor-agent';
const BASE = { cwd: '/tmp/worktree', env: { HOME: '/tmp/home' } };

/** Stand-in for `execFile` that invokes the callback with a canned result. */
function fakeExec(result: {
  err?: NodeJS.ErrnoException & { killed?: boolean };
  stdout?: string;
  stderr?: string;
}) {
  return vi.fn((_bin: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
    (cb as (e: unknown, o: string, s: string) => void)(
      result.err ?? null,
      result.stdout ?? '',
      result.stderr ?? '',
    );
    return {} as never;
  }) as never;
}

describe('createCursorChatBounded', () => {
  it('returns the minted chat id', async () => {
    const exec = fakeExec({ stdout: '4eb8cc22-8067-4d3f-b94c-aa2e4f86b054\n' });
    await expect(createCursorChatBounded(BIN, { ...BASE, exec })).resolves.toBe(
      '4eb8cc22-8067-4d3f-b94c-aa2e4f86b054',
    );
  });

  // Regression: the previous implementation passed no `timeout`, so a wedged
  // `cursor-agent create-chat` (reproduced with an expired OAuth token — the
  // process sat sleeping for 12+ minutes) left the awaiting turn unsettled
  // forever: no assistant message, no error, session stuck "thinking".
  it('passes a bounded timeout to the exec so a wedged CLI cannot hang a turn', async () => {
    const exec = fakeExec({ stdout: 'abc\n' });
    await createCursorChatBounded(BIN, { ...BASE, exec });
    const opts = (exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as {
      timeout?: number;
      killSignal?: string;
      cwd?: string;
    };
    expect(opts.timeout).toBe(CURSOR_CREATE_CHAT_TIMEOUT_MS);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.killSignal).toBe('SIGKILL');
    expect(opts.cwd).toBe('/tmp/worktree');
  });

  it('honours an explicit timeoutMs override', async () => {
    const exec = fakeExec({ stdout: 'abc\n' });
    await createCursorChatBounded(BIN, { ...BASE, timeoutMs: 1234, exec });
    const opts = (exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as {
      timeout?: number;
    };
    expect(opts.timeout).toBe(1234);
  });

  it('rejects with a timeout-specific message when the CLI is killed', async () => {
    const killed = Object.assign(new Error('Command failed'), { killed: true });
    const exec = fakeExec({ err: killed });
    await expect(
      createCursorChatBounded(BIN, { ...BASE, timeoutMs: 60_000, exec }),
    ).rejects.toThrow(/timed out after 60000ms/);
  });

  it('surfaces stderr for a plain (non-timeout) failure', async () => {
    const exec = fakeExec({
      err: Object.assign(new Error('exit 1'), { killed: false }),
      stderr: 'Authentication required.',
    });
    await expect(createCursorChatBounded(BIN, { ...BASE, exec })).rejects.toThrow(
      /cursor create-chat failed: Authentication required\./,
    );
  });

  it('rejects when the CLI prints no id', async () => {
    const exec = fakeExec({ stdout: '   \n' });
    await expect(createCursorChatBounded(BIN, { ...BASE, exec })).rejects.toThrow(/returned no id/);
  });
});
