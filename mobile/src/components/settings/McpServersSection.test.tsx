import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives rendered as host string tags so react-dom/server can serialize
// the tree without a native runtime (mobile test env is `node`). Matches the
// LinkTodoModal / PromoteTodoModal test pattern.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../../utils/api', () => ({ api: { getMcpServers: vi.fn(() => new Promise(() => {})) } }));

import McpServersSection, {
  McpServerRow,
  saveMcpServer,
  removeMcpServer,
  type McpServersApi,
  type McpServerMap,
} from './McpServersSection';
import { emptyMcpServerForm, type McpServerForm } from '@shared/utils/mcpServerForm';

function stdioForm(over: Partial<McpServerForm> = {}): McpServerForm {
  return { ...emptyMcpServerForm(), type: 'stdio', command: 'npx', args: '-y pkg', ...over };
}

/** A fake api that records calls and returns the merged map it is seeded with. */
function makeApi(returnMap: McpServerMap = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const api: McpServersApi = {
    getMcpServers: vi.fn((...args: any[]) => {
      calls.push({ method: 'getMcpServers', args });
      return Promise.resolve({ mcpServers: returnMap });
    }),
    updateMcpServer: vi.fn((...args: any[]) => {
      calls.push({ method: 'updateMcpServer', args });
      return Promise.resolve({ mcpServers: returnMap });
    }),
    deleteMcpServer: vi.fn((...args: any[]) => {
      calls.push({ method: 'deleteMcpServer', args });
      return Promise.resolve({ mcpServers: returnMap });
    }),
  };
  return { api, calls };
}

describe('McpServersSection — collapsed shell', () => {
  it('renders the collapsed header without crashing and hides the body', () => {
    const html = renderToStaticMarkup(<McpServersSection agentId="a1" />);
    expect(html).toContain('MCP Servers');
    expect(html).not.toContain('Add MCP Server');
  });
});

describe('saveMcpServer (add / edit flow)', () => {
  it('adds a stdio server: calls updateMcpServer with the trimmed name + built config', async () => {
    const merged: McpServerMap = { filesystem: { command: 'npx', args: ['-y', 'pkg'] } };
    const { api } = makeApi(merged);

    const map = await saveMcpServer(api, 'agent-1', 'filesystem', stdioForm({ env: 'A=1', cwd: '/w' }));

    expect(api.updateMcpServer).toHaveBeenCalledTimes(1);
    expect(api.updateMcpServer).toHaveBeenCalledWith('agent-1', 'filesystem', {
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      cwd: '/w',
    });
    // Returns the freshly merged map from the server response.
    expect(map).toEqual(merged);
  });

  it('adds an sse server: sends only the url in the config', async () => {
    const { api } = makeApi();
    await saveMcpServer(
      api,
      'agent-1',
      'remote',
      { ...emptyMcpServerForm(), type: 'sse', url: 'http://localhost:9000/sse' },
    );
    expect(api.updateMcpServer).toHaveBeenCalledWith('agent-1', 'remote', {
      url: 'http://localhost:9000/sse',
    });
  });

  it('edits an existing server: PUTs the same name with the updated config', async () => {
    const { api } = makeApi();
    await saveMcpServer(api, 'agent-1', 'github', stdioForm({ command: 'node', args: '' }));
    expect(api.updateMcpServer).toHaveBeenCalledWith('agent-1', 'github', { command: 'node' });
  });

  it('falls back to an empty map when the response omits mcpServers', async () => {
    const api: McpServersApi = {
      getMcpServers: vi.fn(),
      updateMcpServer: vi.fn(() => Promise.resolve({})),
      deleteMcpServer: vi.fn(),
    };
    expect(await saveMcpServer(api, 'a', 'n', stdioForm())).toEqual({});
  });
});

describe('removeMcpServer (delete flow)', () => {
  it('calls deleteMcpServer with the server name and returns the merged map', async () => {
    const merged: McpServerMap = { kept: { url: 'http://x/sse' } };
    const { api } = makeApi(merged);
    const map = await removeMcpServer(api, 'agent-1', 'filesystem');
    expect(api.deleteMcpServer).toHaveBeenCalledWith('agent-1', 'filesystem');
    expect(map).toEqual(merged);
  });

  it('falls back to an empty map when the response omits mcpServers', async () => {
    const api: McpServersApi = {
      getMcpServers: vi.fn(),
      updateMcpServer: vi.fn(),
      deleteMcpServer: vi.fn(() => Promise.resolve({})),
    };
    expect(await removeMcpServer(api, 'a', 'n')).toEqual({});
  });
});

describe('McpServerRow — renders an existing server', () => {
  const noop = () => undefined;

  it('renders a stdio server: name, transport, command summary, env keys', () => {
    const html = renderToStaticMarkup(
      <McpServerRow
        name="filesystem"
        config={{ command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'sk', TOKEN: 't' } }}
        confirmingDelete={false}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('filesystem');
    expect(html).toContain('stdio');
    expect(html).toContain('npx -y pkg');
    expect(html).toContain('env: API_KEY, TOKEN');
    expect(html).toContain('Edit');
    expect(html).toContain('Delete');
  });

  it('renders an sse server with its url and no env line', () => {
    const html = renderToStaticMarkup(
      <McpServerRow
        name="remote"
        config={{ url: 'http://localhost:9000/sse' }}
        confirmingDelete={false}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('remote');
    expect(html).toContain('sse');
    expect(html).toContain('http://localhost:9000/sse');
    expect(html).not.toContain('env:');
  });

  it('shows the two-step delete confirmation label when confirming', () => {
    const html = renderToStaticMarkup(
      <McpServerRow
        name="x"
        config={{ command: 'node' }}
        confirmingDelete
        onEdit={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('Confirm');
  });
});
