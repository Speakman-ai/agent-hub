/**
 * Regression test for the silent-catch bug in `resolveSessionCliSpawnEnv`.
 *
 * Pre-fix the function caught and silently dropped any error raised by the
 * per-user CLI auth lookup, leaving operators with no visibility into a
 * spawn that fell back to host config because the user-store lookup failed.
 * This test mocks the user-store to throw and asserts the structured
 * `TOOL_ERROR | per-user-cli-auth | spawn lookup` line is logged with the
 * session id threaded through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('./users-store.js', () => ({
  getUserClaudeAuth: vi.fn(() => {
    throw new Error('synthetic store outage');
  }),
  getUserCodexAuth: vi.fn(() => null),
  getUserCursorAuth: vi.fn(() => null),
  getUserGeminiAuth: vi.fn(() => null),
}));

const { resolveSessionCliSpawnEnv } = await import('./per-user-cli-spawn.js');

describe('resolveSessionCliSpawnEnv error reporting', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'per-user-cli-spawn-err-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a TOOL_ERROR | per-user-cli-auth line when the user-store lookup throws', () => {
    const cfg = {
      dataDir,
      claudeBin: '/bin/false',
      cursorBin: '/bin/false',
      codexBin: '/bin/false',
      geminiBin: '/bin/false',
    } as unknown as Parameters<typeof resolveSessionCliSpawnEnv>[0]['cfg'];

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const env = resolveSessionCliSpawnEnv({
        cfg,
        ownerId: null,
        credsOwnerId: 'user-xyz',
        sessionId: 'session-abc',
      });
      // Spawn still proceeds (host config remains the safety net).
      expect(env).toBeDefined();

      const matched = errorSpy.mock.calls.find(
        (args) =>
          typeof args[0] === 'string' &&
          args[0].includes('TOOL_ERROR |') &&
          args[0].includes('per-user-cli-auth | spawn lookup'),
      );
      expect(matched, 'expected per-user-cli-auth TOOL_ERROR line').toBeDefined();
      const line = String(matched![0]);
      expect(line).toContain('synthetic store outage');
      expect(line).toContain('"session":"session-abc"');
      expect(line).toContain('"sev":"soft"');
      expect(line).toContain('"resolution":"recovered"');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs session:null when caller did not provide a sessionId', () => {
    const cfg = {
      dataDir,
      claudeBin: '/bin/false',
      cursorBin: '/bin/false',
      codexBin: '/bin/false',
      geminiBin: '/bin/false',
    } as unknown as Parameters<typeof resolveSessionCliSpawnEnv>[0]['cfg'];

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      resolveSessionCliSpawnEnv({
        cfg,
        ownerId: null,
        credsOwnerId: 'user-xyz',
      });
      const matched = errorSpy.mock.calls.find(
        (args) =>
          typeof args[0] === 'string' && args[0].includes('per-user-cli-auth | spawn lookup'),
      );
      expect(matched).toBeDefined();
      expect(String(matched![0])).toContain('"session":null');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
