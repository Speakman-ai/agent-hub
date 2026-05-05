/**
 * Unit tests for mcp-spawn-config.ts — row → config translation and the
 * user-row-wins-over-agent-template merge contract.
 */
import { describe, it, expect } from 'vitest';
import { rowToConfig, buildMcpServersMap } from '../mcp-spawn-config.js';
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
