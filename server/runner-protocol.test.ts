/**
 * Pure-unit tests for the runner protocol parser + version check. No
 * filesystem, no DB — these belong in `shared/` but live here so the
 * server's vitest config picks them up without a separate runner.
 */
import { describe, it, expect } from 'vitest';
import {
  RUNNER_PROTOCOL_VERSION,
  isCompatibleVersion,
  parseRunnerInbound,
  parseRunnerOutbound,
} from '../shared/runner-protocol.js';

describe('parseRunnerInbound', () => {
  it('parses a valid auth frame', () => {
    const raw = JSON.stringify({
      type: 'auth',
      runnerId: 'r1',
      token: 'tok',
      version: '1.0.0',
    });
    const out = parseRunnerInbound(raw);
    expect(out).toEqual({
      type: 'auth',
      runnerId: 'r1',
      token: 'tok',
      version: '1.0.0',
      capabilities: undefined,
    });
  });

  it('parses an auth frame with valid capabilities', () => {
    const raw = JSON.stringify({
      type: 'auth',
      runnerId: 'r1',
      token: 'tok',
      version: '1.0.0',
      capabilities: { os: 'linux', arch: 'x64', engines: ['claude'] },
    });
    const out = parseRunnerInbound(raw);
    expect(out?.type).toBe('auth');
    if (out?.type === 'auth') {
      expect(out.capabilities).toEqual({ os: 'linux', arch: 'x64', engines: ['claude'] });
    }
  });

  it('drops capabilities when fields are wrong types', () => {
    const raw = JSON.stringify({
      type: 'auth',
      runnerId: 'r1',
      token: 'tok',
      version: '1.0.0',
      capabilities: { os: 123 },
    });
    const out = parseRunnerInbound(raw);
    expect(out?.type).toBe('auth');
    if (out?.type === 'auth') {
      expect(out.capabilities).toBeUndefined();
    }
  });

  it('parses a pong frame', () => {
    const out = parseRunnerInbound(
      JSON.stringify({ type: 'pong', id: 'p1', ts: '2026-01-01T00:00:00Z' }),
    );
    expect(out).toEqual({ type: 'pong', id: 'p1', ts: '2026-01-01T00:00:00Z' });
  });

  it('returns null for unknown type', () => {
    // `spawn` is a valid OUTBOUND type but never inbound — rejecting it
    // here also pins the inbound/outbound directionality split.
    expect(parseRunnerInbound(JSON.stringify({ type: 'spawn', id: 's1' }))).toBeNull();
    expect(parseRunnerInbound(JSON.stringify({ type: 'mystery' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseRunnerInbound('{not json')).toBeNull();
  });

  it('returns null for non-object payload', () => {
    expect(parseRunnerInbound(JSON.stringify('hi'))).toBeNull();
    expect(parseRunnerInbound(JSON.stringify(42))).toBeNull();
    expect(parseRunnerInbound(JSON.stringify(null))).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    // missing token
    expect(
      parseRunnerInbound(JSON.stringify({ type: 'auth', runnerId: 'r1', version: '1.0.0' })),
    ).toBeNull();
    // missing id on pong
    expect(parseRunnerInbound(JSON.stringify({ type: 'pong', ts: 'x' }))).toBeNull();
  });

  it('handles Buffer input (the typical ws callback shape)', () => {
    const buf = Buffer.from(JSON.stringify({ type: 'pong', id: 'b1', ts: 'now' }), 'utf8');
    const out = parseRunnerInbound(buf);
    expect(out?.type).toBe('pong');
  });
});

describe('isCompatibleVersion', () => {
  it('accepts identical versions', () => {
    expect(isCompatibleVersion(RUNNER_PROTOCOL_VERSION)).toBe(true);
  });

  it('accepts same major, different minor/patch', () => {
    expect(isCompatibleVersion('1.5.99', '1.0.0')).toBe(true);
    expect(isCompatibleVersion('1.0.0', '1.5.99')).toBe(true);
  });

  it('rejects different major versions', () => {
    expect(isCompatibleVersion('2.0.0', '1.0.0')).toBe(false);
    expect(isCompatibleVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('rejects empty / malformed versions', () => {
    expect(isCompatibleVersion('', '1.0.0')).toBe(false);
  });
});

// ─── Phase 2 — process lifecycle messages ────────────────────────────

describe('parseRunnerInbound — Phase 2 result/stream/exit', () => {
  it('parses a successful result frame with pid', () => {
    const out = parseRunnerInbound(
      JSON.stringify({ type: 'result', id: 's1', ok: true, pid: 4242 }),
    );
    expect(out).toEqual({ type: 'result', id: 's1', ok: true, pid: 4242 });
  });

  it('parses a failed result frame with errorCode + error', () => {
    const out = parseRunnerInbound(
      JSON.stringify({
        type: 'result',
        id: 's1',
        ok: false,
        errorCode: 'binary_not_found',
        error: 'claude: command not found',
      }),
    );
    expect(out).toEqual({
      type: 'result',
      id: 's1',
      ok: false,
      errorCode: 'binary_not_found',
      error: 'claude: command not found',
    });
  });

  it('rejects result with unknown errorCode', () => {
    const out = parseRunnerInbound(
      JSON.stringify({ type: 'result', id: 's1', ok: false, errorCode: 'kaboom' }),
    );
    expect(out).toBeNull();
  });

  it('rejects result with non-finite pid', () => {
    const out = parseRunnerInbound(
      JSON.stringify({ type: 'result', id: 's1', ok: true, pid: 'not-a-number' }),
    );
    expect(out).toBeNull();
  });

  it('parses a stream frame', () => {
    const out = parseRunnerInbound(
      JSON.stringify({
        type: 'stream',
        id: 's1',
        channel: 'stdout',
        data: 'hello\n',
        seq: 0,
      }),
    );
    expect(out).toEqual({
      type: 'stream',
      id: 's1',
      channel: 'stdout',
      data: 'hello\n',
      seq: 0,
    });
  });

  it('rejects stream with invalid channel', () => {
    const out = parseRunnerInbound(
      JSON.stringify({ type: 'stream', id: 's1', channel: 'fd3', data: 'x', seq: 0 }),
    );
    expect(out).toBeNull();
  });

  it('rejects stream with negative or non-integer seq', () => {
    expect(
      parseRunnerInbound(
        JSON.stringify({ type: 'stream', id: 's1', channel: 'stdout', data: 'x', seq: -1 }),
      ),
    ).toBeNull();
    expect(
      parseRunnerInbound(
        JSON.stringify({ type: 'stream', id: 's1', channel: 'stdout', data: 'x', seq: 1.5 }),
      ),
    ).toBeNull();
  });

  it('parses an exit frame with code', () => {
    const out = parseRunnerInbound(
      JSON.stringify({ type: 'exit', id: 's1', code: 0, signal: null }),
    );
    expect(out).toEqual({ type: 'exit', id: 's1', code: 0, signal: null });
  });

  it('parses an exit frame killed by signal (code null)', () => {
    const out = parseRunnerInbound(
      JSON.stringify({ type: 'exit', id: 's1', code: null, signal: 'SIGKILL' }),
    );
    expect(out).toEqual({ type: 'exit', id: 's1', code: null, signal: 'SIGKILL' });
  });

  it('treats missing signal on exit as null', () => {
    const out = parseRunnerInbound(JSON.stringify({ type: 'exit', id: 's1', code: 1 }));
    expect(out).toEqual({ type: 'exit', id: 's1', code: 1, signal: null });
  });

  it('rejects exit with non-integer code', () => {
    const out = parseRunnerInbound(JSON.stringify({ type: 'exit', id: 's1', code: 1.5 }));
    expect(out).toBeNull();
  });
});

describe('parseRunnerOutbound — server → runner', () => {
  it('parses a registered frame', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({
        type: 'registered',
        runnerId: 'r1',
        serverVersion: '1.1.0',
        connectedAt: '2026-01-01T00:00:00Z',
      }),
    );
    expect(out).toEqual({
      type: 'registered',
      runnerId: 'r1',
      serverVersion: '1.1.0',
      connectedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('parses an auth_error frame', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({ type: 'auth_error', code: 'bad_token', message: 'nope' }),
    );
    expect(out).toEqual({ type: 'auth_error', code: 'bad_token', message: 'nope' });
  });

  it('rejects auth_error with unknown code', () => {
    expect(
      parseRunnerOutbound(JSON.stringify({ type: 'auth_error', code: 'kaboom', message: 'x' })),
    ).toBeNull();
  });

  it('parses a ping frame', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({ type: 'ping', id: 'p1', ts: '2026-01-01T00:00:00Z' }),
    );
    expect(out).toEqual({ type: 'ping', id: 'p1', ts: '2026-01-01T00:00:00Z' });
  });

  it('parses a minimal spawn frame', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({
        type: 'spawn',
        id: 's1',
        engine: 'claude-code',
        args: ['--print', '--output-format=stream-json'],
        sessionId: 'sess-1',
      }),
    );
    expect(out).toEqual({
      type: 'spawn',
      id: 's1',
      engine: 'claude-code',
      args: ['--print', '--output-format=stream-json'],
      sessionId: 'sess-1',
    });
  });

  it('parses a spawn frame with workspace, env, and stdin', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({
        type: 'spawn',
        id: 's1',
        engine: 'claude-code',
        args: [],
        sessionId: 'sess-1',
        env: { FOO: 'bar' },
        stdin: 'hello',
        workspace: {
          repoUrl: 'https://github.com/example/repo.git',
          branch: 'feature/x',
          baseRef: 'main',
        },
      }),
    );
    expect(out).toEqual({
      type: 'spawn',
      id: 's1',
      engine: 'claude-code',
      args: [],
      sessionId: 'sess-1',
      env: { FOO: 'bar' },
      stdin: 'hello',
      workspace: {
        repoUrl: 'https://github.com/example/repo.git',
        branch: 'feature/x',
        baseRef: 'main',
      },
    });
  });

  it('rejects spawn with non-string args', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({
        type: 'spawn',
        id: 's1',
        engine: 'claude-code',
        args: ['ok', 42],
        sessionId: 'sess-1',
      }),
    );
    expect(out).toBeNull();
  });

  it('rejects spawn with non-string env values', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({
        type: 'spawn',
        id: 's1',
        engine: 'claude-code',
        args: [],
        sessionId: 'sess-1',
        env: { OK: 'yes', BAD: 1 },
      }),
    );
    expect(out).toBeNull();
  });

  it('rejects spawn workspace missing required fields', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({
        type: 'spawn',
        id: 's1',
        engine: 'claude-code',
        args: [],
        sessionId: 'sess-1',
        workspace: { repoUrl: 'x' /* branch missing */ },
      }),
    );
    expect(out).toBeNull();
  });

  it('parses a cancel frame with default signal', () => {
    const out = parseRunnerOutbound(JSON.stringify({ type: 'cancel', id: 's1' }));
    expect(out).toEqual({ type: 'cancel', id: 's1' });
  });

  it('parses a cancel frame with explicit signal', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({ type: 'cancel', id: 's1', signal: 'SIGKILL' }),
    );
    expect(out).toEqual({ type: 'cancel', id: 's1', signal: 'SIGKILL' });
  });

  it('rejects cancel with bogus signal', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({ type: 'cancel', id: 's1', signal: 'SIGSILLY' }),
    );
    expect(out).toBeNull();
  });

  it('parses a stdin frame', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({ type: 'stdin', id: 's1', data: 'chunk', end: false }),
    );
    expect(out).toEqual({ type: 'stdin', id: 's1', data: 'chunk', end: false });
  });

  it('parses a stdin frame closing the stream', () => {
    const out = parseRunnerOutbound(
      JSON.stringify({ type: 'stdin', id: 's1', data: '', end: true }),
    );
    expect(out).toEqual({ type: 'stdin', id: 's1', data: '', end: true });
  });

  it('returns null for an inbound type leaking into outbound', () => {
    // `pong` is INBOUND, must not parse here.
    expect(parseRunnerOutbound(JSON.stringify({ type: 'pong', id: 'x', ts: 'x' }))).toBeNull();
    // `result` is INBOUND, must not parse here either.
    expect(parseRunnerOutbound(JSON.stringify({ type: 'result', id: 'x', ok: true }))).toBeNull();
  });

  it('returns null for malformed JSON / non-object payloads', () => {
    expect(parseRunnerOutbound('{nope')).toBeNull();
    expect(parseRunnerOutbound(JSON.stringify(7))).toBeNull();
    expect(parseRunnerOutbound(JSON.stringify(null))).toBeNull();
  });

  it('handles Buffer input', () => {
    const buf = Buffer.from(JSON.stringify({ type: 'ping', id: 'p1', ts: 'now' }), 'utf8');
    const out = parseRunnerOutbound(buf);
    expect(out?.type).toBe('ping');
  });
});

describe('RUNNER_PROTOCOL_VERSION — Phase 3 bump', () => {
  it('is a 1.x minor bump so 1.0 / 1.1 runners stay compatible', () => {
    expect(RUNNER_PROTOCOL_VERSION).toBe('1.2.0');
    expect(isCompatibleVersion('1.0.0', RUNNER_PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleVersion('1.1.0', RUNNER_PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleVersion(RUNNER_PROTOCOL_VERSION, '1.0.0')).toBe(true);
  });
});

describe('RunnerCapabilities — Phase 3 role/pr/port fields', () => {
  it('accepts role/pr/port on the auth frame', () => {
    const frame = {
      type: 'auth',
      runnerId: 'r1',
      token: 't',
      version: '1.2.0',
      capabilities: {
        engines: ['claude-code'],
        role: 'pr-preview',
        pr: 685,
        port: 8080,
      },
    };
    const parsed = parseRunnerInbound(JSON.stringify(frame));
    expect(parsed?.type).toBe('auth');
    if (parsed?.type !== 'auth') return;
    expect(parsed.capabilities?.role).toBe('pr-preview');
    expect(parsed.capabilities?.pr).toBe(685);
    expect(parsed.capabilities?.port).toBe(8080);
  });

  it('accepts auth frames that omit role (1.1.x backward-compat)', () => {
    const frame = {
      type: 'auth',
      runnerId: 'r1',
      token: 't',
      version: '1.1.0',
      capabilities: { engines: ['claude-code'] },
    };
    const parsed = parseRunnerInbound(JSON.stringify(frame));
    expect(parsed?.type).toBe('auth');
    if (parsed?.type !== 'auth') return;
    expect(parsed.capabilities?.role).toBeUndefined();
  });

  it('drops capabilities with unknown role rather than failing the auth frame', () => {
    // isCapabilities returns false → auth still parses, capabilities drop to undefined.
    const frame = {
      type: 'auth',
      runnerId: 'r1',
      token: 't',
      version: '1.2.0',
      capabilities: { role: 'gpu-only' },
    };
    const parsed = parseRunnerInbound(JSON.stringify(frame));
    expect(parsed?.type).toBe('auth');
    if (parsed?.type !== 'auth') return;
    expect(parsed.capabilities).toBeUndefined();
  });

  it('rejects negative or non-integer pr / port', () => {
    const bad = [
      { capabilities: { role: 'pr-preview', pr: -1 } },
      { capabilities: { role: 'pr-preview', pr: 1.5 } },
      { capabilities: { port: 99999 } },
      { capabilities: { port: -80 } },
    ];
    for (const { capabilities } of bad) {
      const parsed = parseRunnerInbound(
        JSON.stringify({
          type: 'auth',
          runnerId: 'r1',
          token: 't',
          version: '1.2.0',
          capabilities,
        }),
      );
      expect(parsed?.type).toBe('auth');
      if (parsed?.type !== 'auth') continue;
      // Bad fields cause the entire capabilities object to drop to undefined.
      expect(parsed.capabilities).toBeUndefined();
    }
  });
});
