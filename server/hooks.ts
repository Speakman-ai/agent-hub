import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import config from './config.js';
import type { AppConfig, HookConfig, HookEntry, McpServerConfig } from './types.js';

interface ClaudeSettings {
  hooks?: Record<string, SettingsHookEntry[]>;
  // Retained as an optional field purely so the cleanup pass in
  // `removeHooksConfig` can still strip stale `_agentHub`-tagged entries
  // that were written by previous versions. The new write path lives in
  // `mcp-spawn-config.ts::writeMcpConfigFile()` which emits a separate
  // `.claude/mcp-config.json` file paired with the Claude CLI's
  // `--mcp-config` flag — the only documented Claude Code MCP source.
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

interface SettingsHookEntry {
  matcher: string;
  hooks: SettingsHookItem[];
}

interface SettingsHookItem {
  type: string;
  command: string;
}

interface WriteHooksOptions {
  agentHooks?: Record<string, HookConfig[]>;
  includeSystemHooks?: boolean;
}

function buildHookCommand(sessionId: string): string {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    throw new Error(`Invalid sessionId format: ${sessionId}`);
  }

  const cfg = config as AppConfig;
  const port = cfg.port || 3051;
  const baseUrl = `http://localhost:${port}`;

  const headers = ['-H', `'Content-Type: application/json'`];
  if (cfg.apiKey) {
    headers.push('-H', `"X-API-Key: $AGENT_HUB_API_KEY"`);
  }

  const body = JSON.stringify({ sessionId });

  return ['curl -sf', ...headers, '-d', `'${body}'`, `${baseUrl}/api/hooks/stop`].join(' ');
}

/**
 * Marker embedded in the PreToolUse format-guard command so cleanup code can
 * identify and remove just this hook, without stepping on agent-provided hooks
 * or the Stop hook.
 */
const FORMAT_GUARD_MARKER = '[agent-hub-format-guard]';

/**
 * Build the PreToolUse Bash-matcher command that blocks `git commit`
 * invocations when the repo fails `npm run format:check`.
 *
 * Claude Code passes the about-to-run tool call as a JSON payload on **stdin**
 * (there is no `CLAUDE_TOOL_INPUT` env var — see
 * https://code.claude.com/docs/en/hooks). We pull `.tool_input.command` out of
 * that payload with `jq`, and only run the format check when the command
 * string contains `git commit`, so every other Bash call (ls, npm test, etc.)
 * is unaffected. Claude Code treats **exit code 2** as a block, so we map
 * `format:check` failure onto `exit 2`. Covers the worktrees-without-husky
 * gap, and also the case where an agent bypasses husky with `--no-verify`.
 *
 * If `jq` isn't on PATH we fail open (the guard is a no-op) — we don't want
 * to block every Bash call on a tooling gap; Layer 1 (husky in worktrees) is
 * still doing its job.
 */
function buildFormatGuardCommand(): string {
  return [
    'input=$(cat)',
    'if command -v jq >/dev/null 2>&1; then ' +
      "cmd=$(printf '%s' \"$input\" | jq -r '.tool_input.command // empty'); " +
      'else cmd=""; fi',
    `case "$cmd" in *'git commit'*) ` +
      'cd "$CLAUDE_PROJECT_DIR" && npm run format:check || exit 2 ;; esac',
    `# ${FORMAT_GUARD_MARKER}`,
  ].join('; ');
}

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
] as const;

export function writeHooksConfig(
  cwd: string,
  sessionId: string,
  options: WriteHooksOptions = {},
): void {
  const { agentHooks, includeSystemHooks = false } = options;

  if (!includeSystemHooks && (!agentHooks || Object.keys(agentHooks).length === 0)) {
    return;
  }

  const claudeDir = path.join(cwd, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  let settings: ClaudeSettings = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    }
  } catch {
    settings = {};
  }

  // Migrate stale `mcpServers` blocks written by older versions. Claude
  // Code never read this field; carrying it forward just leaks a stale
  // (and credential-bearing) snapshot. New emissions go to
  // `.claude/mcp-config.json` via `writeMcpConfigFile()`.
  if (settings.mcpServers) {
    for (const name of Object.keys(settings.mcpServers)) {
      if (settings.mcpServers[name]?._agentHub) {
        delete settings.mcpServers[name];
      }
    }
    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers;
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  if (includeSystemHooks) {
    const hookCommand = buildHookCommand(sessionId);
    const agentHubHook: SettingsHookItem = { type: 'command', command: hookCommand };
    const hookEntry: SettingsHookEntry = { matcher: '', hooks: [agentHubHook] };

    const event = 'Stop';
    const existing = settings.hooks[event] || [];
    const filtered = existing.filter(
      (entry) => !entry.hooks?.some((h) => h.command?.includes('/api/hooks/stop')),
    );
    filtered.push(hookEntry);
    settings.hooks[event] = filtered;

    // PreToolUse Bash guard — blocks `git commit` if `npm run format:check`
    // fails. Defense-in-depth for the case where `.husky/` isn't wired up
    // (worktrees skipping `npm install`) or an agent passes `--no-verify`.
    const formatGuard: SettingsHookItem = {
      type: 'command',
      command: buildFormatGuardCommand(),
    };
    const formatGuardEntry: SettingsHookEntry = { matcher: 'Bash', hooks: [formatGuard] };

    const preEvent = 'PreToolUse';
    const preExisting = settings.hooks[preEvent] || [];
    const preFiltered = preExisting.filter(
      (entry) => !entry.hooks?.some((h) => h.command?.includes(FORMAT_GUARD_MARKER)),
    );
    preFiltered.push(formatGuardEntry);
    settings.hooks[preEvent] = preFiltered;
  }

  if (agentHooks && typeof agentHooks === 'object') {
    for (const event of HOOK_EVENTS) {
      const agentEntries = agentHooks[event];
      if (!Array.isArray(agentEntries) || agentEntries.length === 0) continue;

      const existing = settings.hooks[event] || [];

      const filtered = existing.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes('[agent-hub-agent]')),
      );

      for (const entry of agentEntries) {
        if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) continue;
        filtered.push({
          matcher: entry.matcher || '',
          hooks: entry.hooks.map((h: HookEntry) => ({
            type: h.type || 'command',
            command: `${h.command} # [agent-hub-agent]`,
          })),
        });
      }

      settings.hooks[event] = filtered;
    }
  }

  for (const event of Object.keys(settings.hooks)) {
    if (Array.isArray(settings.hooks[event]) && settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

export function removeHooksConfig(cwd: string): void {
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    if (!settings.hooks) return;

    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event].filter(
        (entry) =>
          !entry.hooks?.some(
            (h) =>
              h.command?.includes('/api/hooks/stop') ||
              h.command?.includes('[agent-hub-agent]') ||
              h.command?.includes(FORMAT_GUARD_MARKER),
          ),
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    if (settings.mcpServers) {
      for (const name of Object.keys(settings.mcpServers)) {
        if (settings.mcpServers[name]?._agentHub) {
          delete settings.mcpServers[name];
        }
      }
      if (Object.keys(settings.mcpServers).length === 0) {
        delete settings.mcpServers;
      }
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch {
    /* Best-effort cleanup */
  }
}
