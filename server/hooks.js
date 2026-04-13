/**
 * Claude Code Hooks Configuration
 *
 * Writes `.claude/settings.json` in the workspace with Stop/SubagentStop
 * hooks that call back to Agent Hub when Claude Code finishes work.
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
 * Write Claude Code hooks configuration to the workspace's `.claude/settings.json`.
 *
 * Merges Stop/SubagentStop hooks into any existing settings without
 * overwriting other configuration. Each hook calls back to Agent Hub's
 * `/api/hooks/stop` endpoint with the session ID.
 *
 * @param {string} cwd - The workspace directory (typically a worktree)
 * @param {string} sessionId - The Agent Hub session ID
 */
export function writeHooksConfig(cwd, sessionId) {
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

  const hookCommand = buildHookCommand(sessionId);

  const agentHubHook = {
    type: 'command',
    command: hookCommand,
  };

  // Build matcher entry — empty matcher matches all events
  const hookEntry = {
    matcher: '',
    hooks: [agentHubHook],
  };

  // Merge into settings, preserving non-Agent-Hub hooks
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const event of ['Stop', 'SubagentStop']) {
    const existing = settings.hooks[event] || [];

    // Remove any previous Agent Hub hook entries (identified by /api/hooks/stop)
    const filtered = existing.filter(
      (entry) => !entry.hooks?.some((h) => h.command?.includes('/api/hooks/stop')),
    );

    // Add our hook entry
    filtered.push(hookEntry);
    settings.hooks[event] = filtered;
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

    for (const event of ['Stop', 'SubagentStop']) {
      if (!settings.hooks[event]) continue;
      settings.hooks[event] = settings.hooks[event].filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes('/api/hooks/stop')),
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
    // Best-effort cleanup
  }
}
