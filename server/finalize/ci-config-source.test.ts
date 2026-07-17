/**
 * Unit tests for the CI config source resolver — the precedence contract
 * (committed > server-personal > server-project > none) and the shadow flag.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveCiConfig, type ResolveCiConfigDeps } from './ci-config-source.js';
import type { CiConfigParseResult } from './ci-config.js';

const OK: CiConfigParseResult = {
  ok: true,
  config: { version: 1, on: ['finalize'], steps: [{ run: 'true' }] } as never,
};
const ABSENT: CiConfigParseResult = {
  ok: false,
  error: { code: 'ci_config_absent', message: 'file not found' },
};
const INVALID: CiConfigParseResult = {
  ok: false,
  error: { code: 'yaml_parse_error', message: 'broken' },
};

const PROJECT_YAML = 'version: 1\non: [finalize]\nsteps:\n  - run: echo project\n';
const PERSONAL_YAML = 'version: 1\non: [finalize]\nsteps:\n  - run: echo personal\n';

function deps(over: Partial<ResolveCiConfigDeps>): ResolveCiConfigDeps {
  return {
    loadCommitted: vi.fn().mockResolvedValue(ABSENT),
    readServerConfig: () => null,
    ...over,
  };
}

describe('resolveCiConfig', () => {
  it('uses the committed file when present and valid', async () => {
    const r = await resolveCiConfig(deps({ loadCommitted: vi.fn().mockResolvedValue(OK) }), {
      committedPath: '/wt/.agent-hub/ci.yaml',
      hasUser: true,
    });
    expect(r.source).toBe('committed');
    expect(r.parseResult).toBe(OK);
    expect(r.shadowed).toBe(false);
  });

  it('a present-but-broken committed file is authoritative (never falls through)', async () => {
    const r = await resolveCiConfig(
      deps({
        loadCommitted: vi.fn().mockResolvedValue(INVALID),
        readServerConfig: () => PROJECT_YAML, // exists, but must be ignored
      }),
      { committedPath: '/wt/.agent-hub/ci.yaml', hasUser: true },
    );
    expect(r.source).toBe('committed');
    expect(r.parseResult).toBe(INVALID);
    // Server config exists but is shadowed by the committed file.
    expect(r.shadowed).toBe(true);
  });

  it('falls back to the project server config when committed is absent', async () => {
    const r = await resolveCiConfig(
      deps({ readServerConfig: (scope) => (scope === 'project' ? PROJECT_YAML : null) }),
      { committedPath: '/wt/.agent-hub/ci.yaml', hasUser: true },
    );
    expect(r.source).toBe('server-project');
    expect(r.parseResult?.ok).toBe(true);
    expect(r.shadowed).toBe(false);
  });

  it('prefers the personal server config over the project one', async () => {
    const readServerConfig = vi.fn((scope: 'project' | 'personal') =>
      scope === 'personal' ? PERSONAL_YAML : PROJECT_YAML,
    );
    const r = await resolveCiConfig(deps({ readServerConfig }), {
      committedPath: '/wt/.agent-hub/ci.yaml',
      hasUser: true,
    });
    expect(r.source).toBe('server-personal');
  });

  it('ignores the personal scope when there is no user', async () => {
    const readServerConfig = vi.fn((scope: 'project' | 'personal') =>
      scope === 'personal' ? PERSONAL_YAML : PROJECT_YAML,
    );
    const r = await resolveCiConfig(deps({ readServerConfig }), {
      committedPath: '/wt/.agent-hub/ci.yaml',
      hasUser: false,
    });
    expect(r.source).toBe('server-project');
    // personal was never consulted
    expect(readServerConfig).not.toHaveBeenCalledWith('personal');
  });

  it('returns none when nothing is configured', async () => {
    const r = await resolveCiConfig(deps({}), {
      committedPath: '/wt/.agent-hub/ci.yaml',
      hasUser: true,
    });
    expect(r.source).toBe('none');
    expect(r.parseResult).toBeNull();
  });
});
