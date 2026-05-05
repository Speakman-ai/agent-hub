/**
 * Spawn-time helper: turn the session owner's enabled `mcp_servers` rows
 * into the `mcpServers` map Claude Code consumes.
 *
 * Two integration points:
 *
 *   1. `.claude/settings.json` — `writeHooksConfig` (server/hooks.ts) already
 *      writes per-agent MCP servers there. We merge the per-user rows into
 *      the same map so a single config file covers both surfaces. Both
 *      sources are tagged with `_agentHub: true` so the cleanup pass can
 *      strip them without touching anything the user added by hand.
 *
 *   2. `--mcp-config` flag (future) — Claude Code also accepts a
 *      session-scoped JSON file via this CLI flag. Not used in v1; the
 *      settings.json merge path is sufficient.
 *
 * Conflict resolution: per-user rows override per-agent entries with the
 * same `name` key, on the principle that the human at the keyboard
 * outranks the agent template.
 */

import type { McpServerConfig } from './types.js';
import type { McpServerRow } from './mcp-servers-store.js';

/**
 * Convert one decrypted store row into a Claude Code MCP server entry.
 *
 * The `type` field is **required** by Claude Code's `.claude/settings.json`
 * schema for remote (http / sse) servers — without it the loader defaults
 * to stdio, finds no `command`, and silently drops the entry. We emit it
 * unconditionally (including for stdio) so the serialized config is
 * unambiguous regardless of which transport an upstream parser preferred
 * historically.
 */
export function rowToConfig(row: McpServerRow): McpServerConfig {
  if (row.transport === 'stdio') {
    return {
      type: 'stdio',
      command: row.command,
      args: row.args,
      env: { ...row.env },
      _agentHub: true,
    };
  }
  // http transport
  return {
    type: 'http',
    url: row.url,
    headers: { ...row.headers },
    _agentHub: true,
  };
}

/**
 * Build the `mcpServers` map keyed by row name. Last write wins on
 * duplicate names — callers that already have an agent-side map should
 * pass it as the `agentEntries` argument; user rows are layered on top.
 */
export function buildMcpServersMap(
  userRows: McpServerRow[],
  agentEntries?: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (agentEntries) {
    for (const [name, cfg] of Object.entries(agentEntries)) {
      out[name] = { ...cfg, _agentHub: true };
    }
  }
  for (const row of userRows) {
    if (!row.name) continue;
    out[row.name] = rowToConfig(row);
  }
  return out;
}
