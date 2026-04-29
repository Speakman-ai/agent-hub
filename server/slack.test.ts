import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadSlackConfig } from './slack.js';

describe('loadSlackConfig', () => {
  let tmpDir: string;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'slack-config-test-'));
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup races
    }
  });

  it('returns empty accounts and stays silent when the file is missing (ENOENT)', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.json');

    const result = loadSlackConfig(missingPath);

    expect(result).toEqual({ accounts: [] });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('returns empty accounts and logs an error when the file is malformed JSON', () => {
    const badPath = path.join(tmpDir, 'slack-config.json');
    writeFileSync(badPath, '{ this is not valid json', 'utf-8');

    const result = loadSlackConfig(badPath);

    expect(result).toEqual({ accounts: [] });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [prefix, message] = consoleErrorSpy.mock.calls[0] as [string, string];
    expect(prefix).toBe('Failed to load slack-config.json:');
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });

  it('parses and returns a valid Slack config', () => {
    const goodPath = path.join(tmpDir, 'slack-config.json');
    const cfg = {
      accounts: [
        {
          name: 'team-a',
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          agentId: 'agent-1',
        },
      ],
    };
    writeFileSync(goodPath, JSON.stringify(cfg), 'utf-8');

    const result = loadSlackConfig(goodPath);

    expect(result).toEqual(cfg);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs an error for non-ENOENT filesystem failures (e.g. EACCES on a directory)', () => {
    // Reading a directory raises EISDIR — exercises the non-ENOENT branch
    // without depending on platform-specific permission semantics.
    const dirAsFile = tmpDir;

    const result = loadSlackConfig(dirAsFile);

    expect(result).toEqual({ accounts: [] });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [prefix] = consoleErrorSpy.mock.calls[0] as [string, string];
    expect(prefix).toBe('Failed to load slack-config.json:');
    // Touch chmod import to keep the linter happy if we ever switch to a
    // permission-based test on POSIX.
    void chmodSync;
  });
});
