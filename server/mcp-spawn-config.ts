/**
 * Spawn-time helper: turn the session owner's enabled `mcp_servers` rows
 * into the `mcpServers` map Claude Code consumes.
 *
 * Emission contract (V2 — landed after the post-#778 investigation):
 *
 *   We write the merged `mcpServers` map to `<cwd>/.claude/mcp-config.json`
 *   and pair the spawn with `--mcp-config <path> --strict-mcp-config` on
 *   the Claude Code CLI. This is the only documented Claude Code MCP source
 *   that fits Agent Hub's lifecycle (per-session, ephemeral, isolated from
 *   the user's hand-edited `~/.claude.json`).
 *
 *   The previous emission path (writing into `.claude/settings.json` under
 *   the `mcpServers` key) is **not** read by Claude Code — `claude mcp list`
 *   inside such a worktree reports "No MCP servers configured" even when
 *   the JSON is structurally perfect. See wiki: "MCP Servers — Per-User
 *   Registry" for the full failure-mode trail. `writeHooksConfig` retains
 *   the *cleanup* arm so any old settings.json files written by previous
 *   versions are migrated on the next spawn.
 *
 * Conflict resolution: per-user rows override per-agent entries with the
 * same `name` key, on the principle that the human at the keyboard
 * outranks the agent template.
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import type { McpServerConfig } from './types.js';
import type { McpServerRow } from './mcp-servers-store.js';

/**
 * Subdirectory + filename for the per-session MCP config. Lives alongside
 * `.claude/settings.json` so cleanup can find both files in one place.
 */
export const MCP_CONFIG_SUBDIR = '.claude';
export const MCP_CONFIG_FILENAME = 'mcp-config.json';

/** Resolve the absolute path to the per-session MCP config file. */
export function getMcpConfigPath(cwd: string): string {
  return path.join(cwd, MCP_CONFIG_SUBDIR, MCP_CONFIG_FILENAME);
}

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

/**
 * Write the merged `mcpServers` map to `<cwd>/.claude/mcp-config.json` in
 * the shape Claude Code's `--mcp-config` flag expects:
 *
 *   { "mcpServers": { ... } }
 *
 * Returns the absolute path of the written file so the caller can pass it
 * straight to `--mcp-config`. Returns `null` when there are no servers to
 * emit (callers should then skip the flag entirely; passing an empty file
 * with `--strict-mcp-config` would unintentionally suppress whatever the
 * agent had configured at higher scopes).
 */
export function writeMcpConfigFile(
  cwd: string,
  mcpServers: Record<string, McpServerConfig> | undefined,
): string | null {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return null;
  const dir = path.join(cwd, MCP_CONFIG_SUBDIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = getMcpConfigPath(cwd);
  const payload = { mcpServers };
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return filePath;
}

/**
 * Best-effort cleanup of the per-session MCP config file. Used by session
 * teardown paths so abandoned worktrees don't leak credentials on disk.
 */
export function removeMcpConfigFile(cwd: string): void {
  const filePath = getMcpConfigPath(cwd);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    /* best-effort */
  }
}
