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
    expect(parseRunnerInbound(JSON.stringify({ type: 'spawn' }))).toBeNull();
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
