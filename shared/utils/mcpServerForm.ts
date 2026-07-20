/**
 * mcpServerForm.ts — the single, canonical form <-> config translation for a
 * per-agent MCP server entry, shared by the web client (`McpServersSection` in
 * SettingsPage) and mobile (`McpServersSection` settings component). Both
 * surfaces edit the same free-form text inputs (args as a space-separated
 * string or JSON array, env as `KEY=VALUE` lines or JSON) and persist the same
 * `McpServerConfig` shape, so the parse/serialize logic must live in exactly
 * one place or the two clients will drift.
 *
 * Everything here is PURE (strings in → config out, config in → form out) so it
 * is trivially unit-testable without React, a DB, or the network.
 */

export type McpTransport = 'stdio' | 'sse';

/** The editable form model backing the add / edit inputs on both clients. */
export interface McpServerForm {
  name: string;
  type: McpTransport;
  command: string;
  args: string;
  url: string;
  env: string;
  cwd: string;
}

/** The persisted server config (subset of the server `McpServerConfig`). */
export interface McpServerConfigShape {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
}

/** A fresh, empty add-server form. */
export function emptyMcpServerForm(): McpServerForm {
  return { name: '', type: 'stdio', command: '', args: '', url: '', env: '', cwd: '' };
}

/**
 * Parse the free-form arguments input. Accepts a JSON array (`["-y", "pkg"]`)
 * or a space-separated string (`-y pkg`). A non-array JSON value falls back to
 * treating the raw string as a single argument.
 */
export function parseArgs(argsStr: string): string[] {
  if (!argsStr.trim()) return [];
  try {
    const parsed = JSON.parse(argsStr);
    return Array.isArray(parsed) ? parsed : [argsStr];
  } catch {
    return argsStr.split(/\s+/).filter(Boolean);
  }
}

/**
 * Parse the free-form environment input. Accepts a JSON object or one
 * `KEY=VALUE` pair per line. Lines without `=` are ignored.
 */
export function parseEnv(envStr: string): Record<string, string> {
  if (!envStr.trim()) return {};
  try {
    const parsed = JSON.parse(envStr);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to KEY=VALUE parsing
  }
  const env: Record<string, string> = {};
  for (const line of envStr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
  }
  return env;
}

/**
 * Build the persisted `McpServerConfig` from an edited form. `stdio` servers
 * carry `command` + optional `args`; `sse` servers carry `url`. `env` and
 * `cwd` apply to both and are omitted when empty.
 */
export function buildServerConfig(form: McpServerForm): McpServerConfigShape {
  const config: McpServerConfigShape = {};
  if (form.type === 'stdio') {
    config.command = form.command;
    const args = parseArgs(form.args);
    if (args.length) config.args = args;
  } else {
    config.url = form.url;
  }
  const env = parseEnv(form.env);
  if (Object.keys(env).length) config.env = env;
  if (form.cwd?.trim()) config.cwd = form.cwd.trim();
  return config;
}

/** A saved config is `stdio` iff it carries a `command`. */
export function isStdioConfig(config: McpServerConfigShape): boolean {
  return !!config.command;
}

/**
 * Serialize an `args` array back to the input string: a plain space-join,
 * unless any single arg contains whitespace (which space-join would corrupt),
 * in which case a JSON array is emitted so it round-trips through `parseArgs`.
 */
export function argsToInput(args: string[] | undefined): string {
  if (!args || !args.length) return '';
  return args.some((a) => a.includes(' ')) ? JSON.stringify(args) : args.join(' ');
}

/** Serialize an `env` map back to `KEY=VALUE` lines for the textarea. */
export function envToInput(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Build the edit form for an existing saved server config. */
export function mcpConfigToForm(name: string, config: McpServerConfigShape): McpServerForm {
  return {
    name,
    type: isStdioConfig(config) ? 'stdio' : 'sse',
    command: config.command || '',
    args: argsToInput(config.args),
    url: config.url || '',
    env: envToInput(config.env),
    cwd: config.cwd || '',
  };
}

/** One-line summary of a saved server for a list row. */
export function mcpServerSummary(config: McpServerConfigShape): string {
  if (isStdioConfig(config)) {
    return `${config.command}${config.args?.length ? ' ' + config.args.join(' ') : ''}`;
  }
  return config.url || '';
}
