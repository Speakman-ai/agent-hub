import { describe, it, expect, vi } from 'vitest';
import { parseArgs, parseConnections, main } from '../../scripts/nango-call.mjs';

function captureStreams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('nango-call.mjs — parseArgs', () => {
  it('requires --app and --path', () => {
    expect(parseArgs([]).error).toMatch(/--app/);
    expect(parseArgs(['--app', 'slack']).error).toMatch(/--path/);
  });

  it('parses a typical POST invocation', () => {
    const a = parseArgs([
      '--app',
      'slack',
      '--path',
      'chat.postMessage',
      '--method',
      'POST',
      '--body',
      '{"channel":"C1"}',
    ]);
    expect(a.error).toBeNull();
    expect(a.app).toBe('slack');
    expect(a.path).toBe('chat.postMessage');
    expect(a.method).toBe('POST');
    expect(a.body).toBe('{"channel":"C1"}');
  });

  it('rejects unsupported methods', () => {
    const a = parseArgs(['--app', 's', '--path', 'p', '--method', 'TRACE']);
    expect(a.error).toMatch(/unsupported method/);
  });

  it('repeats --query and --header into arrays', () => {
    const a = parseArgs([
      '--app',
      's',
      '--path',
      'p',
      '--query',
      'a=1',
      '--query',
      'b=2',
      '--header',
      'X-Foo: bar',
    ]);
    expect(a.query).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(a.headers).toEqual([['X-Foo', 'bar']]);
  });

  it('rejects malformed --query and --header', () => {
    expect(parseArgs(['--app', 's', '--path', 'p', '--query', 'noequals']).error).toMatch(
      /key=value/,
    );
    expect(parseArgs(['--app', 's', '--path', 'p', '--header', 'nocolon']).error).toMatch(
      /Name: value/,
    );
  });
});

describe('nango-call.mjs — parseConnections', () => {
  it('returns {} for missing / non-JSON / non-object input', () => {
    expect(parseConnections(undefined)).toEqual({});
    expect(parseConnections('')).toEqual({});
    expect(parseConnections('not json')).toEqual({});
    expect(parseConnections('[1,2,3]')).toEqual({});
    expect(parseConnections('null')).toEqual({});
  });

  it('round-trips a normal map', () => {
    expect(parseConnections('{"slack":"conn_abc","gmail":"conn_def"}')).toEqual({
      slack: 'conn_abc',
      gmail: 'conn_def',
    });
  });
});

describe('nango-call.mjs — main', () => {
  it('exits 2 when NANGO_SECRET_KEY is unset', async () => {
    const s = captureStreams();
    const code = await main({
      argv: ['--app', 'slack', '--path', 'chat.postMessage'],
      env: {},
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/NANGO_SECRET_KEY/);
  });

  it('exits 2 when the requested app is not in NANGO_CONNECTIONS_JSON', async () => {
    const s = captureStreams();
    const code = await main({
      argv: ['--app', 'github', '--path', 'user'],
      env: {
        NANGO_SECRET_KEY: 'nango_abc',
        NANGO_CONNECTIONS_JSON: '{"slack":"conn_abc"}',
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/no connected 'github'/);
    expect(s.err()).toMatch(/Connected apps: slack/);
  });

  it('forwards method, headers, query, and body through the proxy', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify({ ok: true, url, init }),
      };
    });
    const s = captureStreams();
    const code = await main({
      argv: [
        '--app',
        'slack',
        '--path',
        '/chat.postMessage',
        '--method',
        'POST',
        '--body',
        '{"channel":"C1","text":"hi"}',
        '--query',
        'pretty=1',
        '--header',
        'X-Trace-Id: abc',
      ],
      env: {
        NANGO_SECRET_KEY: 'nango_abc',
        NANGO_PROVIDER_BASE: 'https://api.nango.dev',
        NANGO_CONNECTIONS_JSON: '{"slack":"conn_abc"}',
      },
      stdout: s.stdout,
      stderr: s.stderr,
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('https://api.nango.dev/proxy/chat.postMessage?pretty=1');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer nango_abc');
    expect(init.headers['Connection-Id']).toBe('conn_abc');
    expect(init.headers['Provider-Config-Key']).toBe('slack');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Trace-Id']).toBe('abc');
    expect(init.body).toBe('{"channel":"C1","text":"hi"}');
  });

  it('honors a custom NANGO_PROVIDER_BASE (self-hosted)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
    }));
    const s = captureStreams();
    await main({
      argv: ['--app', 'slack', '--path', 'auth.test'],
      env: {
        NANGO_SECRET_KEY: 'nango_abc',
        NANGO_PROVIDER_BASE: 'https://nango.internal.example.com/',
        NANGO_CONNECTIONS_JSON: '{"slack":"conn_abc"}',
      },
      stdout: s.stdout,
      stderr: s.stderr,
      fetchImpl,
    });
    const [calledUrl] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('https://nango.internal.example.com/proxy/auth.test');
  });

  it('returns exit code 1 on a non-2xx response (body still printed)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => 'application/json' },
      text: async () => '{"error":"invalid_auth"}',
    }));
    const s = captureStreams();
    const code = await main({
      argv: ['--app', 'slack', '--path', 'auth.test'],
      env: {
        NANGO_SECRET_KEY: 'nango_abc',
        NANGO_CONNECTIONS_JSON: '{"slack":"conn_abc"}',
      },
      stdout: s.stdout,
      stderr: s.stderr,
      fetchImpl,
    });
    expect(code).toBe(1);
    expect(s.out()).toMatch(/invalid_auth/);
  });

  it('exits 3 when fetch throws (transport failure)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const s = captureStreams();
    const code = await main({
      argv: ['--app', 'slack', '--path', 'auth.test'],
      env: {
        NANGO_SECRET_KEY: 'nango_abc',
        NANGO_CONNECTIONS_JSON: '{"slack":"conn_abc"}',
      },
      stdout: s.stdout,
      stderr: s.stderr,
      fetchImpl,
    });
    expect(code).toBe(3);
    expect(s.err()).toMatch(/ECONNREFUSED/);
  });

  it('never prints the secret key in errors', async () => {
    const s = captureStreams();
    await main({
      argv: ['--app', 'unknown', '--path', 'p'],
      env: {
        NANGO_SECRET_KEY: 'super-secret-do-not-leak',
        NANGO_CONNECTIONS_JSON: '{"slack":"conn_abc"}',
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    const all = s.out() + s.err();
    expect(all).not.toContain('super-secret-do-not-leak');
  });
});
