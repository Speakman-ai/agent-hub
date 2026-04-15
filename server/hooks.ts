import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import config from './config.js';
import type { AppConfig, HookConfig, HookEntry, McpServerConfig } from './types.js';

interface ClaudeSettings {
  hooks?: Record<string, SettingsHookEntry[]>;
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
  mcpServers?: Record<string, McpServerConfig>;
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
  const { agentHooks, includeSystemHooks = false, mcpServers } = options;

  const hasMcp = mcpServers != null && Object.keys(mcpServers).length > 0;

  if (!includeSystemHooks && (!agentHooks || Object.keys(agentHooks).length === 0) && !hasMcp) {
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

  if (hasMcp && mcpServers) {
    if (!settings.mcpServers) settings.mcpServers = {};

    for (const name of Object.keys(settings.mcpServers)) {
      if (settings.mcpServers[name]?._agentHub) {
        delete settings.mcpServers[name];
      }
    }

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      settings.mcpServers[name] = { ...serverConfig, _agentHub: true };
    }

    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers;
    }
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
              h.command?.includes('/api/hooks/stop') || h.command?.includes('[agent-hub-agent]'),
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
