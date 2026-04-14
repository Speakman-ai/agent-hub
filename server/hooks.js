/**
 * Claude Code Hooks Configuration
 *
 * Writes `.claude/settings.json` in the workspace with hooks that call back
 * to Agent Hub. Supports both system hooks (auto-commit on Stop) and
 * per-agent configured hooks for any supported event type.
 *
 * Note: System hooks only use Stop — SubagentStop fires when subagents
 * finish while the main agent is still working, causing premature commits.
 * This replaces the proc.on('close') approach for auto-commit-and-PR,
 * using Claude Code's native hook system (available since v2.1.97).
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import config from './config.js';

/**
 * Build the curl command that the hook will execute to notify Agent Hub.
 *
 * @param {string} sessionId - The Agent Hub session ID
 * @returns {string} Shell command string
 */
function buildHookCommand(sessionId) {
  // Validate sessionId format to prevent shell injection — the value is
  // interpolated into a curl command string executed via `sh -c`.
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    throw new Error(`Invalid sessionId format: ${sessionId}`);
  }

  const port = config.port || 3051;
  const baseUrl = `http://localhost:${port}`;

  // Build curl with optional API key auth.
  // Single quotes inside the command string are fine — Claude Code hooks
  // execute via `sh -c`, which handles them correctly.
  const headers = ['-H', `'Content-Type: application/json'`];
  if (config.apiKey) {
    headers.push('-H', `"X-API-Key: $AGENT_HUB_API_KEY"`);
  }

  const body = JSON.stringify({ sessionId });

  return ['curl -sf', ...headers, '-d', `'${body}'`, `${baseUrl}/api/hooks/stop`].join(' ');
}

/**
 * Supported Claude Code hook event types.
 * These correspond to the lifecycle events that Claude Code emits.
 */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'];

/**
 * Write Claude Code hooks configuration to the workspace's `.claude/settings.json`.
 *
 * Merges system hooks (auto-commit Stop) and agent-configured
 * hooks into any existing settings without overwriting other configuration.
 *
 * @param {string} cwd - The workspace directory (typically a worktree)
 * @param {string} sessionId - The Agent Hub session ID
 * @param {object} [options] - Additional options
 * @param {object} [options.agentHooks] - Agent-configured hooks keyed by event type.
 *   Each event maps to an array of { matcher, hooks: [{ type, command }] } entries.
 * @param {boolean} [options.includeSystemHooks=false] - Whether to include the
 *   auto-commit Stop hook (true for worktree sessions)
 * @param {object} [options.mcpServers] - MCP server configurations to write.
 *   Keyed by server name: { "name": { command, args?, env?, cwd?, url? } }
 */
export function writeHooksConfig(cwd, sessionId, options = {}) {
  const { agentHooks, includeSystemHooks = false, mcpServers } = options;

  const hasMcp = mcpServers && Object.keys(mcpServers).length > 0;

  // Skip if there's nothing to write
  if (!includeSystemHooks && (!agentHooks || Object.keys(agentHooks).length === 0) && !hasMcp) {
    return;
  }

  const claudeDir = path.join(cwd, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Load existing settings if present
  let settings = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Corrupted file — overwrite
    settings = {};
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // 1) Merge system hooks (auto-commit on Stop) for worktree sessions
  if (includeSystemHooks) {
    const hookCommand = buildHookCommand(sessionId);
    const agentHubHook = { type: 'command', command: hookCommand };
    const hookEntry = { matcher: '', hooks: [agentHubHook] };

    const event = 'Stop';
    const existing = settings.hooks[event] || [];
    // Remove any previous Agent Hub system hook entries.
    // Note: this filter would also remove agent-configured hooks whose command
    // happens to contain '/api/hooks/stop' — unlikely but worth noting.
    const filtered = existing.filter(
      (entry) => !entry.hooks?.some((h) => h.command?.includes('/api/hooks/stop')),
    );
    filtered.push(hookEntry);
    settings.hooks[event] = filtered;
  }

  // 2) Merge agent-configured hooks for all supported event types
  if (agentHooks && typeof agentHooks === 'object') {
    for (const event of HOOK_EVENTS) {
      const agentEntries = agentHooks[event];
      if (!Array.isArray(agentEntries) || agentEntries.length === 0) continue;

      const existing = settings.hooks[event] || [];

      // Remove previous agent-configured entries (identified by [agent-hub-agent] marker)
      const filtered = existing.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes('[agent-hub-agent]')),
      );

      // Add agent-configured entries with marker comment for later identification
      for (const entry of agentEntries) {
        if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) continue;
        filtered.push({
          matcher: entry.matcher || '',
          hooks: entry.hooks.map((h) => ({
            type: h.type || 'command',
            command: `${h.command} # [agent-hub-agent]`,
          })),
        });
      }

      settings.hooks[event] = filtered;
    }
  }

  // Clean up empty event arrays
  for (const event of Object.keys(settings.hooks)) {
    if (Array.isArray(settings.hooks[event]) && settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  // 3) Merge MCP server configurations
  if (hasMcp) {
    if (!settings.mcpServers) settings.mcpServers = {};

    // Remove previous agent-hub-managed MCP servers (identified by _agentHub marker)
    for (const name of Object.keys(settings.mcpServers)) {
      if (settings.mcpServers[name]?._agentHub) {
        delete settings.mcpServers[name];
      }
    }

    // Add agent-configured MCP servers with marker
    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      settings.mcpServers[name] = { ...serverConfig, _agentHub: true };
    }

    // Clean up empty mcpServers object
    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers;
    }
  }

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Remove Agent Hub hooks from a workspace's `.claude/settings.json`.
 * Called during worktree cleanup — not wired up yet, will be used
 * when worktree removal/pruning is implemented.
 *
 * @param {string} cwd - The workspace directory
 */
export function removeHooksConfig(cwd) {
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
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

    // Remove agent-hub-managed MCP servers
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
    // Best-effort cleanup
  }
}
