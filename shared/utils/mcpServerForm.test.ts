import { describe, it, expect } from 'vitest';
import {
  emptyMcpServerForm,
  parseArgs,
  parseEnv,
  buildServerConfig,
  isStdioConfig,
  argsToInput,
  envToInput,
  mcpConfigToForm,
  mcpServerSummary,
  type McpServerForm,
} from './mcpServerForm';

describe('parseArgs', () => {
  it('returns [] for empty / whitespace', () => {
    expect(parseArgs('')).toEqual([]);
    expect(parseArgs('   ')).toEqual([]);
  });

  it('splits a space-separated string', () => {
    expect(parseArgs('-y @modelcontextprotocol/server-filesystem /tmp')).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp',
    ]);
  });

  it('parses a JSON array', () => {
    expect(parseArgs('["-y", "pkg with space"]')).toEqual(['-y', 'pkg with space']);
  });

  it('falls back to the raw string for non-array JSON', () => {
    expect(parseArgs('42')).toEqual(['42']);
  });
});

describe('parseEnv', () => {
  it('returns {} for empty', () => {
    expect(parseEnv('')).toEqual({});
  });

  it('parses KEY=VALUE lines and ignores lines without =', () => {
    expect(parseEnv('API_KEY=sk-xxx\nOTHER=value\nnope')).toEqual({
      API_KEY: 'sk-xxx',
      OTHER: 'value',
    });
  });

  it('keeps = inside the value', () => {
    expect(parseEnv('TOKEN=a=b=c')).toEqual({ TOKEN: 'a=b=c' });
  });

  it('parses a JSON object', () => {
    expect(parseEnv('{"A":"1","B":"2"}')).toEqual({ A: '1', B: '2' });
  });

  it('does not treat a JSON array as env', () => {
    // Array JSON is not an env object → falls to line parsing → no `=` → {}
    expect(parseEnv('["A","B"]')).toEqual({});
  });
});

describe('buildServerConfig', () => {
  it('builds a stdio config with command + args', () => {
    const form: McpServerForm = {
      ...emptyMcpServerForm(),
      type: 'stdio',
      command: 'npx',
      args: '-y pkg',
    };
    expect(buildServerConfig(form)).toEqual({ command: 'npx', args: ['-y', 'pkg'] });
  });

  it('omits args when empty', () => {
    const form: McpServerForm = { ...emptyMcpServerForm(), type: 'stdio', command: 'node' };
    expect(buildServerConfig(form)).toEqual({ command: 'node' });
  });

  it('builds an sse config with url only', () => {
    const form: McpServerForm = {
      ...emptyMcpServerForm(),
      type: 'sse',
      url: 'http://localhost:8080/sse',
      command: 'ignored',
      args: 'ignored',
    };
    expect(buildServerConfig(form)).toEqual({ url: 'http://localhost:8080/sse' });
  });

  it('includes env and trimmed cwd on both types', () => {
    const form: McpServerForm = {
      ...emptyMcpServerForm(),
      type: 'stdio',
      command: 'node',
      env: 'A=1',
      cwd: '  /work  ',
    };
    expect(buildServerConfig(form)).toEqual({ command: 'node', env: { A: '1' }, cwd: '/work' });
  });
});

describe('isStdioConfig', () => {
  it('is stdio when a command is present', () => {
    expect(isStdioConfig({ command: 'node' })).toBe(true);
    expect(isStdioConfig({ url: 'http://x' })).toBe(false);
  });
});

describe('argsToInput', () => {
  it('joins simple args with spaces', () => {
    expect(argsToInput(['-y', 'pkg'])).toBe('-y pkg');
  });

  it('emits JSON when an arg contains a space', () => {
    expect(argsToInput(['-y', 'has space'])).toBe('["-y","has space"]');
  });

  it('returns empty string for undefined / empty', () => {
    expect(argsToInput(undefined)).toBe('');
    expect(argsToInput([])).toBe('');
  });
});

describe('envToInput', () => {
  it('serializes to KEY=VALUE lines', () => {
    expect(envToInput({ A: '1', B: '2' })).toBe('A=1\nB=2');
  });

  it('returns empty string for undefined', () => {
    expect(envToInput(undefined)).toBe('');
  });
});

describe('mcpConfigToForm round-trip', () => {
  it('round-trips a stdio config through form and back', () => {
    const config = { command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/work' };
    const form = mcpConfigToForm('filesystem', config);
    expect(form).toEqual({
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
      args: '-y pkg',
      url: '',
      env: 'A=1',
      cwd: '/work',
    });
    expect(buildServerConfig(form)).toEqual(config);
  });

  it('round-trips args that contain spaces', () => {
    const config = { command: 'node', args: ['--flag', 'a b'] };
    const form = mcpConfigToForm('x', config);
    expect(buildServerConfig(form)).toEqual(config);
  });

  it('maps an sse config to a url form', () => {
    const form = mcpConfigToForm('remote', { url: 'http://localhost:9000/sse' });
    expect(form.type).toBe('sse');
    expect(form.url).toBe('http://localhost:9000/sse');
    expect(buildServerConfig(form)).toEqual({ url: 'http://localhost:9000/sse' });
  });
});

describe('mcpServerSummary', () => {
  it('summarizes a stdio server as command + args', () => {
    expect(mcpServerSummary({ command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg');
  });

  it('summarizes an sse server as its url', () => {
    expect(mcpServerSummary({ url: 'http://x/sse' })).toBe('http://x/sse');
  });
});
