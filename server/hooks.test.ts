import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';

vi.mock('./config.js', () => ({
  default: { port: 3051, apiKey: 'test-key' },
}));

const { writeHooksConfig, removeHooksConfig } = await import('./hooks.js');

interface HookItem {
  type: string;
  command: string;
}
interface HookEntry {
  matcher: string;
  hooks: HookItem[];
}

describe('writeHooksConfig — PreToolUse format guard', () => {
  let tmpDir: string;
  const sessionId = '5ab50586-7579-4af1-b4f3-b437ce4a7635';

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function readSettings() {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    return JSON.parse(readFileSync(settingsPath, 'utf-8'));
  }

  function getFormatGuardCommand(): string {
    const settings = readSettings();
    const entries: HookEntry[] = settings.hooks?.PreToolUse || [];
    const entry = entries.find((e) =>
      e.hooks.some((h) => h.command.includes('[agent-hub-format-guard]')),
    );
    if (!entry) throw new Error('format guard entry not found');
    return entry.hooks[0].command;
  }

  /**
   * Create a scratch "project" dir with a package.json whose `format:check`
   * script resolves to `scriptResult` ('pass' → exit 0, 'fail' → exit 1).
   * The hook should map a failing `format:check` onto exit code 2 (block).
   */
  function makeProjectDir(scriptResult: 'pass' | 'fail'): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hooks-project-'));
    const body = scriptResult === 'pass' ? 'true' : 'false';
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'scratch',
        version: '0.0.0',
        scripts: { 'format:check': body },
      }),
    );
    return dir;
  }

  function runHook(command: string, stdinJson: string, projectDir: string) {
    return spawnSync('bash', ['-c', command], {
      input: stdinJson,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      encoding: 'utf-8',
      timeout: 20_000,
    });
  }

  it('writes a PreToolUse Bash-matcher entry tagged as the format guard', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });

    const settings = readSettings();
    const preEntries: HookEntry[] = settings.hooks.PreToolUse;
    expect(preEntries).toHaveLength(1);
    expect(preEntries[0].matcher).toBe('Bash');
    expect(preEntries[0].hooks[0].command).toContain('[agent-hub-format-guard]');
  });

  it('exits 0 (allows) when the bash command is not `git commit`', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    // `format:check` would FAIL here — but it should never run because the
    // guard only triggers on `git commit`.
    const projectDir = makeProjectDir('fail');

    const result = runHook(
      cmd,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }),
      projectDir,
    );

    expect(result.status).toBe(0);
  });

  it('exits 0 (allows) when the stdin payload has no tool_input.command', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    const projectDir = makeProjectDir('fail');

    const result = runHook(cmd, JSON.stringify({ tool_name: 'Bash' }), projectDir);

    expect(result.status).toBe(0);
  });

  it('exits 0 (allows) on `git commit` when format:check passes', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    const projectDir = makeProjectDir('pass');

    const result = runHook(
      cmd,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "wip"' },
      }),
      projectDir,
    );

    expect(result.status).toBe(0);
  });

  it('exits 0 (allows) on `cd dir && git commit` when format:check passes', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    const projectDir = makeProjectDir('pass');

    const result = runHook(
      cmd,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'cd subdir && git commit -m "wip"' },
      }),
      projectDir,
    );

    expect(result.status).toBe(0);
  });

  it('exits 0 (allows) on `git commit` when root package.json has no format:check script', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hooks-no-fmt-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'frontend-only', version: '0.0.0', scripts: { test: 'true' } }),
    );

    const result = runHook(
      cmd,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "wip"' },
      }),
      dir,
    );

    expect(result.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 (allows) on `git commit` when there is no root package.json', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hooks-no-pkg-'));

    const result = runHook(
      cmd,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "wip"' },
      }),
      dir,
    );

    expect(result.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not treat `git commit` substring inside unrelated bash as a commit', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    const projectDir = makeProjectDir('fail');

    const result = runHook(
      cmd,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command:
            'curl -sS -d \'{"content":"blocked on git commit step"}\' http://127.0.0.1:3051/api/x',
        },
      }),
      projectDir,
    );

    expect(result.status).toBe(0);
  });

  it('exits 2 (blocks) on `git commit` when format:check fails', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const cmd = getFormatGuardCommand();
    const projectDir = makeProjectDir('fail');

    const result = runHook(
      cmd,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git commit --no-verify -m "bypass"' },
      }),
      projectDir,
    );

    // Claude Code treats exit code 2 as a hard block (per
    // https://code.claude.com/docs/en/hooks).
    expect(result.status).toBe(2);
  });

  it('still writes the Stop hook alongside the PreToolUse guard', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });

    const settings = readSettings();
    expect(settings.hooks?.Stop).toBeDefined();
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('/api/hooks/stop');
  });

  it('does not write the format guard when includeSystemHooks is false', () => {
    writeHooksConfig(tmpDir, sessionId, {
      includeSystemHooks: false,
      agentHooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    });

    const settings = readSettings();
    const preEntries: HookEntry[] = settings.hooks.PreToolUse;
    const hasFormatGuard = preEntries.some((e) =>
      e.hooks.some((h) => h.command.includes('[agent-hub-format-guard]')),
    );
    expect(hasFormatGuard).toBe(false);
  });

  it('dedupes the format guard across repeated writes', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });

    const settings = readSettings();
    const preEntries: HookEntry[] = settings.hooks.PreToolUse;
    const guardCount = preEntries.filter((e) =>
      e.hooks.some((h) => h.command.includes('[agent-hub-format-guard]')),
    ).length;
    expect(guardCount).toBe(1);
  });

  it('removeHooksConfig strips the format guard', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    removeHooksConfig(tmpDir);

    const settings = readSettings();
    const preEntries: HookEntry[] = settings.hooks?.PreToolUse || [];
    const hasFormatGuard = preEntries.some((e) =>
      e.hooks.some((h) => h.command.includes('[agent-hub-format-guard]')),
    );
    expect(hasFormatGuard).toBe(false);
  });

  // --- Regression: Claude Code does not read mcpServers from settings.json. ---
  // The previous emission path wrote per-user MCP servers into
  // .claude/settings.json::mcpServers, which the Claude Code loader
  // silently ignored (verified via `claude mcp list`). The new path lives
  // in mcp-spawn-config.ts::writeMcpConfigFile() + the CLI's
  // `--mcp-config` flag. These tests pin the new contract:
  //   1. writeHooksConfig must not write a `mcpServers` block (its API
  //      no longer accepts one).
  //   2. Stale `_agentHub`-tagged blocks left behind by older versions
  //      get scrubbed on the next write.

  it('never writes mcpServers into settings.json (the API no longer accepts it)', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const settings = readSettings();
    expect(settings.mcpServers).toBeUndefined();
  });

  it('migrates a stale _agentHub-tagged mcpServers block out of settings.json', () => {
    // Simulate an existing settings.json written by a pre-fix version.
    const claudeDir = path.join(tmpDir, '.claude');
    if (!existsSync(claudeDir)) {
      // mkdirSync needed because writeHooksConfig only creates it on demand.
      // Easier to just invoke writeHooksConfig once first to seed the dir.
    }
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const seed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    seed.mcpServers = {
      Linear: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: 'Bearer leaked' },
        _agentHub: true,
      },
      // A user-added entry (no _agentHub tag) must survive the migration.
      UserAdded: { type: 'stdio', command: 'their-bin' },
    };
    writeFileSync(settingsPath, JSON.stringify(seed, null, 2));

    // Re-run writeHooksConfig (e.g. on the next session start). The stale
    // _agentHub-tagged entry should be scrubbed; user-added entries stay.
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const after = readSettings();
    expect(after.mcpServers).toBeDefined();
    expect(after.mcpServers.Linear).toBeUndefined();
    expect(after.mcpServers.UserAdded).toBeDefined();
    expect(after.mcpServers.UserAdded.command).toBe('their-bin');
  });

  it('removes the mcpServers block entirely when migration leaves it empty', () => {
    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const seed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    seed.mcpServers = {
      Linear: {
        type: 'http',
        url: 'https://x/',
        headers: {},
        _agentHub: true,
      },
    };
    writeFileSync(settingsPath, JSON.stringify(seed, null, 2));

    writeHooksConfig(tmpDir, sessionId, { includeSystemHooks: true });
    const after = readSettings();
    expect(after.mcpServers).toBeUndefined();
  });
});
