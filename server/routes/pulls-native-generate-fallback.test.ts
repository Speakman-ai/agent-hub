// Regression: the "Generate with AI" PR-description generator must fall back
// to another agent engine when Claude is unavailable for the acting user,
// instead of hard-failing on a hardcoded `claude-code` spawn.
//
// These mocks isolate `generatePrText` from the real engine modules so the
// test never spawns a CLI. `generatePrText` uses dynamic `import()`; vitest's
// hoisted `vi.mock` intercepts those the same as static imports.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveOneShotEngine = vi.fn();
const runOneShotPrompt = vi.fn();
const resolveSessionCliSpawnEnv = vi.fn(() => ({ HOME: '/tmp/fake-home' }));

// Partial mocks: override only the two functions generatePrText calls, keep
// every other export (NoEnginesAvailableError, userHasEngineCreds, …) real so
// transitive module loads of pulls-native.js don't break.
vi.mock('../engine-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine-resolver.js')>()),
  resolveOneShotEngine,
}));
vi.mock('../one-shot-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../one-shot-spawn.js')>()),
  runOneShotPrompt,
}));
vi.mock('../per-user-cli-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../per-user-cli-spawn.js')>()),
  resolveSessionCliSpawnEnv,
}));

const { generatePrText } = await import('./pulls-native.js');

describe('generatePrText engine fallback', () => {
  beforeEach(() => {
    resolveOneShotEngine.mockReset();
    runOneShotPrompt.mockReset();
    resolveSessionCliSpawnEnv.mockClear();
  });

  it('spawns the resolved fallback engine (not a hardcoded claude-code) when Claude is unavailable', async () => {
    // User has no Claude creds — resolver falls back to Cursor.
    resolveOneShotEngine.mockResolvedValue({
      engine: 'cursor-agent',
      model: 'cursor-default',
      fallbackUsed: true,
      fallbackFromReason: 'claude-code:no-creds',
      availability: {},
    });
    runOneShotPrompt.mockResolvedValue('TITLE: hi\nBODY:\nx');

    const out = await generatePrText('prompt', 'system', '/cwd', 'user-1');

    expect(out).toBe('TITLE: hi\nBODY:\nx');
    // Preferred is Claude, but the acting user's id is threaded so the probe
    // sees per-account creds.
    expect(resolveOneShotEngine).toHaveBeenCalledWith(expect.anything(), {
      preferred: 'claude-code',
      userId: 'user-1',
    });
    // Spawn env is built for the RESOLVED engine, not a hardcoded claude-code.
    expect(resolveSessionCliSpawnEnv).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'cursor-agent' }),
    );
    // The one-shot spawn uses the resolved engine + model.
    expect(runOneShotPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'cursor-agent', model: 'cursor-default' }),
      expect.anything(),
    );
  });

  it('uses Claude when it is available (no fallback)', async () => {
    resolveOneShotEngine.mockResolvedValue({
      engine: 'claude-code',
      model: 'claude-default',
      fallbackUsed: false,
      availability: {},
    });
    runOneShotPrompt.mockResolvedValue('TITLE: hi\nBODY:\nx');

    await generatePrText('prompt', 'system', '/cwd', 'user-1');

    expect(resolveSessionCliSpawnEnv).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude-code' }),
    );
    expect(runOneShotPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude-code' }),
      expect.anything(),
    );
  });

  it('propagates NoEnginesAvailableError when the user has no engine connected', async () => {
    const err = Object.assign(new Error('No AI engines are configured.'), {
      name: 'NoEnginesAvailableError',
    });
    resolveOneShotEngine.mockRejectedValue(err);

    await expect(generatePrText('prompt', 'system', '/cwd', null)).rejects.toMatchObject({
      name: 'NoEnginesAvailableError',
    });
    expect(runOneShotPrompt).not.toHaveBeenCalled();
  });
});
