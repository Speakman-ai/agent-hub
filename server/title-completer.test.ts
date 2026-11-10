import { describe, expect, it, vi } from 'vitest';
import { createCliTitleCompleter } from './title-completer.js';
import type { AppConfig } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({ resolveSessionCliSpawnEnv: vi.fn(() => ({})) }));

const cfg = {} as AppConfig;
const resolveEngine = vi.fn(async () => ({ engine: 'claude-code', model: 'claude-haiku-4-6' }));

function outcome(output: string, code: number | null = 0, timedOut = false) {
  return {
    engine: 'claude-code',
    model: 'claude-haiku-4-6',
    output,
    failovers: [],
    detailed: { stdout: output, stderr: '', code, timedOut },
  };
}

describe('createCliTitleCompleter', () => {
  it('returns null without a user to run as', () => {
    expect(createCliTitleCompleter(cfg, null)).toBeNull();
  });

  it("runs the prompt on the user's engine with the untrusted-input rule", async () => {
    const runFailover = vi.fn(async (_input: unknown) => outcome('Fix login race\n'));
    const complete = createCliTitleCompleter(cfg, 'user-1', {
      resolveEngine: resolveEngine as never,
      runFailover: runFailover as never,
    });
    await expect(complete!({ system: 'Title it.', content: 'hello' })).resolves.toBe(
      'Fix login race',
    );
    const input = runFailover.mock.calls[0][0] as Record<string, unknown>;
    expect(input.userId).toBe('user-1');
    expect(input.claudePermissionMode).toBe('default');
    expect(String(input.systemPrompt)).toContain('not instructions');
  });

  it('returns null when the run fails or times out', async () => {
    for (const o of [outcome('x', 1), outcome('x', 0, true)]) {
      const complete = createCliTitleCompleter(cfg, 'user-1', {
        resolveEngine: resolveEngine as never,
        runFailover: vi.fn(async () => o) as never,
      });
      await expect(complete!({ system: 's', content: 'c' })).resolves.toBeNull();
    }
  });

  it('swallows engine resolution errors', async () => {
    const complete = createCliTitleCompleter(cfg, 'user-1', {
      resolveEngine: vi.fn(async () => {
        throw new Error('no engines');
      }) as never,
      runFailover: vi.fn() as never,
    });
    await expect(complete!({ system: 's', content: 'c' })).resolves.toBeNull();
  });
});
