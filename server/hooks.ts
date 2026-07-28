import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import config from './config.js';
import type { AppConfig, HookConfig, HookEntry } from './types.js';

interface ClaudeSettings {
  hooks?: Record<string, SettingsHookEntry[]>;
  // Agent Hub no longer writes MCP servers anywhere. The field survives
  // only so the cleanup pass below can strip `_agentHub`-tagged entries
  // out of settings.json files written before the MCP registry was
  // removed; drop it once those worktrees have aged out.
  mcpServers?: Record<string, { _agentHub?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remove only MCP entries that the retired Agent Hub writer marked as its
 * own. User-managed entries in either Claude file must survive the migration.
 */
function scrubAgentHubMcpServers(value: JsonRecord): boolean {
  const servers = value.mcpServers;
  if (!isJsonRecord(servers)) return false;

  let changed = false;
  for (const [name, server] of Object.entries(servers)) {
    if (isJsonRecord(server) && server._agentHub === true) {
      delete servers[name];
      changed = true;
    }
  }

  if (changed && Object.keys(servers).length === 0) {
    delete value.mcpServers;
  }
  return changed;
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
 * looks like a real `git commit` invocation (not a substring inside curl -d
 * text), so every other Bash call is unaffected. Claude Code treats **exit
 * code 2** as a block, so we map `format:check` failure onto `exit 2`.
 *
 * Fail-open when jq/grep are missing, when the project root has no
 * package.json, or when package.json does not define a `format:check` script
 * (monorepos with npm only in subdirs must not ENOENT-block commits).
 */
function buildFormatGuardCommand(): string {
  return [
    'input=$(cat)',
    'if command -v jq >/dev/null 2>&1; then ' +
      "cmd=$(printf '%s' \"$input\" | jq -r '.tool_input.command // empty'); " +
      'else cmd=""; fi',
    'is_gc=0',
    'if [ -n "$cmd" ] && command -v grep >/dev/null 2>&1; then ' +
      "if printf '%s' \"$cmd\" | grep -Eq '(^|[;&|][[:space:]]*)git[[:space:]]+commit([[:space:]]|$|-)'; then is_gc=1; fi; " +
      'fi',
    'if [ "$is_gc" = 1 ]; then ' +
      'root="$CLAUDE_PROJECT_DIR"; ' +
      'if [ -f "$root/package.json" ] && grep -q \'"format:check"\' "$root/package.json" 2>/dev/null; then ' +
      'cd "$root" && npm run format:check || exit 2; ' +
      'fi; ' +
      'fi',
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

  // Strip only stale entries written by older Agent Hub versions. User-owned
  // MCP entries in settings.json must survive the removal migration.
  scrubAgentHubMcpServers(settings);

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

/**
 * Scrub a `.claude/mcp-config.json` left behind by the removed MCP spawn path.
 *
 * The retired `writeMcpConfigFile()` wrote the merged server map — including
 * decrypted `env` values and `Authorization` headers — to this file in the
 * session cwd, and nothing ever deleted it: the module's own
 * `removeMcpConfigFile` had no production caller. So on any install that
 * configured a server, every worktree that ever spawned a claude-code
 * session still holds a plaintext credential file that no code reads any
 * more. Deleting the writer doesn't clean those up; this does.
 *
 * Only entries carrying the unambiguous `_agentHub: true` marker are removed.
 * This preserves a user-managed file at the conventional path, including its
 * unmarked MCP entries and any other top-level settings. Best-effort and
 * idempotent — a missing file, invalid JSON, or permissions error must never
 * interfere with a spawn.
 */
export function removeStaleMcpConfigFile(cwd: string): void {
  try {
    const mcpConfigPath = path.join(cwd, '.claude', 'mcp-config.json');
    if (!existsSync(mcpConfigPath)) return;

    const payload = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as unknown;
    if (!isJsonRecord(payload) || !scrubAgentHubMcpServers(payload)) return;

    if (isJsonRecord(payload.mcpServers) && Object.keys(payload.mcpServers).length > 0) {
      writeFileSync(mcpConfigPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    } else {
      delete payload.mcpServers;
      if (Object.keys(payload).length > 0) {
        writeFileSync(mcpConfigPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      } else {
        unlinkSync(mcpConfigPath);
      }
    }
  } catch {
    /* Best-effort cleanup */
  }
}

/**
 * Scrub Agent Hub's marked MCP entries from a project's settings.json during
 * the boot migration, even when the project has not started another session.
 */
export function removeStaleMcpSettingsFile(cwd: string): void {
  try {
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown;
    if (!isJsonRecord(settings) || !scrubAgentHubMcpServers(settings)) return;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch {
    /* Best-effort cleanup */
  }
}

/**
 * Best-effort cleanup for every known project/worktree cwd. Kept separate
 * from the single-cwd helper so startup migrations can sweep persisted
 * session worktrees without duplicating the unlink/error handling.
 */
export function removeStaleMcpConfigFiles(cwds: Iterable<string>): void {
  for (const cwd of new Set(cwds)) {
    if (cwd) {
      removeStaleMcpConfigFile(cwd);
      removeStaleMcpSettingsFile(cwd);
    }
  }
}

export function removeHooksConfig(cwd: string): void {
  removeStaleMcpConfigFile(cwd);

  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    const scrubbedMcpServers = scrubAgentHubMcpServers(settings);
    if (!settings.hooks) {
      if (scrubbedMcpServers) {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      }
      return;
    }

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

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch {
    /* Best-effort cleanup */
  }
}
