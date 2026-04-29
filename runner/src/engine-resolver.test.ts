import { describe, it, expect } from 'vitest';
import {
  resolveEngineBin,
  envKeyForEngine,
  KNOWN_ENGINES,
  ENGINES_FOR_TESTING,
} from './engine-resolver.js';

describe('resolveEngineBin', () => {
  it('returns the built-in default when no override is set', () => {
    expect(resolveEngineBin('claude-code', { env: {} })).toBe('/usr/local/bin/claude');
    expect(resolveEngineBin('cursor-agent', { env: {} })).toBe('/usr/local/bin/cursor-agent');
  });

  it('honours per-engine env overrides', () => {
    expect(
      resolveEngineBin('claude-code', { env: { AGENT_HUB_RUNNER_BIN_CLAUDE_CODE: '/opt/claude' } }),
    ).toBe('/opt/claude');
    expect(
      resolveEngineBin('cursor-agent', {
        env: { AGENT_HUB_RUNNER_BIN_CURSOR_AGENT: '/opt/cursor' },
      }),
    ).toBe('/opt/cursor');
  });

  it('treats an empty-string override as absent (falls back to default)', () => {
    expect(
      resolveEngineBin('claude-code', { env: { AGENT_HUB_RUNNER_BIN_CLAUDE_CODE: '' } }),
    ).toBe('/usr/local/bin/claude');
  });

  it('returns null for unknown engines', () => {
    expect(resolveEngineBin('does-not-exist', { env: {} })).toBeNull();
  });
});

describe('envKeyForEngine', () => {
  it('upper-snake-cases dashed engine names', () => {
    expect(envKeyForEngine('claude-code')).toBe('AGENT_HUB_RUNNER_BIN_CLAUDE_CODE');
    expect(envKeyForEngine('cursor-agent')).toBe('AGENT_HUB_RUNNER_BIN_CURSOR_AGENT');
  });

  it('handles a single-word engine name', () => {
    expect(envKeyForEngine('codex')).toBe('AGENT_HUB_RUNNER_BIN_CODEX');
  });
});

describe('KNOWN_ENGINES', () => {
  it('exposes every engine the resolver knows about', () => {
    for (const engine of KNOWN_ENGINES) {
      expect(resolveEngineBin(engine, { env: {} })).not.toBeNull();
    }
  });

  it('keeps `ENGINES_FOR_TESTING` as a deprecated alias for back-compat', () => {
    expect(ENGINES_FOR_TESTING).toBe(KNOWN_ENGINES);
  });
});
