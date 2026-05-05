/**
 * Unit tests for mcp-spawn-config.ts — row → config translation, the
 * user-row-wins-over-agent-template merge contract, and the
 * `.claude/mcp-config.json` emission paired with Claude CLI's
 * `--mcp-config` flag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  rowToConfig,
  buildMcpServersMap,
  writeMcpConfigFile,
  removeMcpConfigFile,
  getMcpConfigPath,
  MCP_CONFIG_SUBDIR,
  MCP_CONFIG_FILENAME,
} from '../mcp-spawn-config.js';
import type { McpServerRow } from '../mcp-servers-store.js';
import type { McpServerConfig } from '../types.js';

function row(overrides: Partial<McpServerRow>): McpServerRow {
  return {
    id: 'mcp_test',
    userId: 'u-1',
    name: 'test',
    catalogId: null,
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    env: {},
    headers: {},
    enabled: true,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('rowToConfig', () => {
  it('translates a stdio row to {type:"stdio", command, args, env, _agentHub}', () => {
    const cfg = rowToConfig(
      row({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        env: { OPENAPI_MCP_HEADERS: 'token' },
      }),
    );
    expect(cfg).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { OPENAPI_MCP_HEADERS: 'token' },
      _agentHub: true,
    });
  });

  it('translates an http row to {type:"http", url, headers, _agentHub} (no command/args)', () => {
    const cfg = rowToConfig(
      row({
        transport: 'http',
        url: 'https://mcp.linear.app/sse',
        headers: { Authorization: 'Bearer x' },
      }),
    );
    expect(cfg).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer x' },
      _agentHub: true,
    });
    expect((cfg as McpServerConfig).command).toBeUndefined();
  });

  // Regression — the absence of `type` made Claude Code's loader default to
  // stdio, find no `command`, and silently drop the entry. See the wiki page
  // 'MCP Servers — Per-User Registry' for the failure-mode trail.
  it('always emits a transport `type` discriminator (regression: missing type drops http servers)', () => {
    const stdio = rowToConfig(row({ transport: 'stdio', command: 'x' }));
    const http = rowToConfig(row({ transport: 'http', url: 'https://x/' }));
    expect(stdio.type).toBe('stdio');
    expect(http.type).toBe('http');
  });

  it('clones env/headers (does not share reference with the row)', () => {
    const r = row({
      transport: 'stdio',
      command: 'x',
      env: { K: 'v' },
    });
    const cfg = rowToConfig(r);
    cfg.env!.K = 'mutated';
    expect(r.env.K).toBe('v');
  });
});

describe('buildMcpServersMap', () => {
  it('returns an empty map when there are no inputs', () => {
    expect(buildMcpServersMap([])).toEqual({});
  });

  it('emits agent entries with _agentHub:true tagged on', () => {
    const agentEntries: Record<string, McpServerConfig> = {
      builtin: { command: 'agent-bin', args: [] },
    };
    const out = buildMcpServersMap([], agentEntries);
    expect(out.builtin._agentHub).toBe(true);
    expect(out.builtin.command).toBe('agent-bin');
  });

  it('user rows override agent entries with the same name (user wins)', () => {
    const agentEntries: Record<string, McpServerConfig> = {
      shared: { command: 'agent-version', args: [] },
    };
    const userRow = row({
      name: 'shared',
      transport: 'stdio',
      command: 'user-version',
    });
    const out = buildMcpServersMap([userRow], agentEntries);
    expect(out.shared.command).toBe('user-version');
  });

  it('combines disjoint agent + user entries', () => {
    const agentEntries: Record<string, McpServerConfig> = {
      a: { command: 'a-bin' },
    };
    const userRow = row({
      name: 'b',
      transport: 'http',
      url: 'https://b/',
    });
    const out = buildMcpServersMap([userRow], agentEntries);
    expect(Object.keys(out).sort()).toEqual(['a', 'b']);
    expect(out.a._agentHub).toBe(true);
    expect(out.b._agentHub).toBe(true);
  });

  it('skips user rows with empty names rather than blowing up the map', () => {
    const userRow = row({ name: '', transport: 'http', url: 'https://x/' });
    const out = buildMcpServersMap([userRow]);
    expect(out).toEqual({});
  });
});

describe('writeMcpConfigFile / removeMcpConfigFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exposes the conventional .claude/mcp-config.json path', () => {
    expect(MCP_CONFIG_SUBDIR).toBe('.claude');
    expect(MCP_CONFIG_FILENAME).toBe('mcp-config.json');
    expect(getMcpConfigPath('/some/cwd')).toBe('/some/cwd/.claude/mcp-config.json');
  });

  it('writes { mcpServers: {...} } in the shape Claude Code --mcp-config expects', () => {
    const servers: Record<string, McpServerConfig> = {
      Linear: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: 'Bearer lin_api_xxx' },
        _agentHub: true,
      },
    };
    const written = writeMcpConfigFile(tmpDir, servers);
    expect(written).toBe(path.join(tmpDir, '.claude', 'mcp-config.json'));
    expect(existsSync(written!)).toBe(true);

    const parsed = JSON.parse(readFileSync(written!, 'utf-8'));
    // Top-level `mcpServers` key is REQUIRED; this is the shape the
    // `--mcp-config` flag consumes (see https://code.claude.com/docs/en/mcp).
    expect(Object.keys(parsed)).toEqual(['mcpServers']);
    expect(parsed.mcpServers.Linear.type).toBe('http');
    expect(parsed.mcpServers.Linear.url).toBe('https://mcp.linear.app/mcp');
    expect(parsed.mcpServers.Linear.headers.Authorization).toBe('Bearer lin_api_xxx');
  });

  it('returns null and writes nothing when there are no servers', () => {
    expect(writeMcpConfigFile(tmpDir, undefined)).toBeNull();
    expect(writeMcpConfigFile(tmpDir, {})).toBeNull();
    expect(existsSync(path.join(tmpDir, '.claude', 'mcp-config.json'))).toBe(false);
  });

  it('creates the .claude directory if it does not yet exist', () => {
    expect(existsSync(path.join(tmpDir, '.claude'))).toBe(false);
    writeMcpConfigFile(tmpDir, { x: { type: 'stdio', command: 'foo', args: [] } });
    expect(existsSync(path.join(tmpDir, '.claude'))).toBe(true);
  });

  it('overwrites a stale config file on subsequent writes (no merge)', () => {
    const dir = path.join(tmpDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'mcp-config.json');
    writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { Old: { type: 'stdio', command: 'x' } } }),
    );

    writeMcpConfigFile(tmpDir, {
      New: { type: 'http', url: 'https://new/', headers: {} },
    });

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['New']);
  });

  it('serializes stdio servers with command/args/env (no url field)', () => {
    const servers: Record<string, McpServerConfig> = {
      notion: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        env: { OPENAPI_MCP_HEADERS: 'token' },
        _agentHub: true,
      },
    };
    const written = writeMcpConfigFile(tmpDir, servers);
    const parsed = JSON.parse(readFileSync(written!, 'utf-8'));
    expect(parsed.mcpServers.notion.command).toBe('npx');
    expect(parsed.mcpServers.notion.args).toEqual(['-y', '@notionhq/notion-mcp-server']);
    expect(parsed.mcpServers.notion.url).toBeUndefined();
  });

  it('removeMcpConfigFile deletes the file when present and is a no-op when absent', () => {
    const written = writeMcpConfigFile(tmpDir, {
      Linear: { type: 'http', url: 'https://x/', headers: {} },
    });
    expect(existsSync(written!)).toBe(true);
    removeMcpConfigFile(tmpDir);
    expect(existsSync(written!)).toBe(false);
    // No-op call should not throw.
    expect(() => removeMcpConfigFile(tmpDir)).not.toThrow();
  });
});
