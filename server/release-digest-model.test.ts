import { existsSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  RELEASE_DIGEST_MODEL,
  RELEASE_DIGEST_SYSTEM_PROMPT,
  cleanReleaseDigestOutput,
  runReleaseDigestModel,
} from './release-digest-model.js';
import type { OneShotFailoverOutcome } from './one-shot-failover.js';
import type { AppConfig } from './types.js';

const cfg = { dataDir: '/tmp/agent-hub-test' } as AppConfig;

function outcome(stdout: string, code: number | null = 0, stderr = ''): OneShotFailoverOutcome {
  return {
    engine: 'claude-code',
    model: RELEASE_DIGEST_MODEL,
    detailed: { stdout, stderr, code, timedOut: false },
    output: stdout || stderr,
    failovers: [],
  };
}

describe('runReleaseDigestModel', () => {
  it('runs on Claude Sonnet in a scratch dir without bypassed permissions', async () => {
    const resolveEngine = vi.fn(async () => ({
      engine: 'claude-code' as const,
      model: RELEASE_DIGEST_MODEL,
      fallbackUsed: false,
    }));
    let cwd = '';
    const runFailover = vi.fn(async (input: { cwd: string }) => {
      cwd = input.cwd;
      expect(existsSync(cwd)).toBe(true);
      return outcome('### Admin\n\nCost departments are dated per employee.');
    });

    const digest = await runReleaseDigestModel(
      { prompt: 'facts', cfg, userId: 'user-1' },

      { resolveEngine: resolveEngine as any, runFailover: runFailover as any },
    );

    expect(digest).toBe('### Admin\n\nCost departments are dated per employee.');
    expect(resolveEngine).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({
        userId: 'user-1',
        preferred: 'claude-code',
        preferredModel: 'claude-sonnet-5-5',
      }),
    );
    expect(runFailover).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'claude-code',
        model: 'claude-sonnet-5-5',
        prompt: 'facts',
        systemPrompt: RELEASE_DIGEST_SYSTEM_PROMPT,
        claudePermissionMode: 'default',
        userId: 'user-1',
      }),
      cfg,
    );
    expect(cwd).toContain('release-digest-');
    expect(existsSync(cwd)).toBe(false);
  });

  it('throws when the CLI run fails so the digest is held', async () => {
    await expect(
      runReleaseDigestModel(
        { prompt: 'facts', cfg, userId: 'user-1' },
        {
          resolveEngine: (async () => ({
            engine: 'claude-code',
            model: RELEASE_DIGEST_MODEL,
          })) as any,
          runFailover: async () => outcome('', 1, 'rate limited'),
        },
      ),
    ).rejects.toThrow(
      'Release digest generation failed on claude-code (claude-sonnet-5-5): rate limited',
    );
  });

  it('refuses to run without a user to own the Claude login', async () => {
    const runFailover = vi.fn();
    await expect(
      runReleaseDigestModel({ prompt: 'facts', cfg, userId: null }, { runFailover }),
    ).rejects.toThrow('needs a user');
    expect(runFailover).not.toHaveBeenCalled();
  });

  it('unwraps a whole-reply code fence', () => {
    expect(cleanReleaseDigestOutput('```markdown\n### Field\n\nDone.\n```')).toBe(
      '### Field\n\nDone.',
    );
  });
});
