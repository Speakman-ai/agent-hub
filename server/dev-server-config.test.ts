import { describe, it, expect } from 'vitest';
import {
  parseDevServerConfig,
  DEV_SERVER_DEFAULT_START_COMMAND,
  type DevServerConfig,
} from './dev-server-config.js';

function parseOk(raw: unknown): DevServerConfig {
  const result = parseDevServerConfig(raw);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

function parseErr(raw: unknown): string {
  const result = parseDevServerConfig(raw);
  if (result.ok) throw new Error(`expected error, got ok: ${JSON.stringify(result.value)}`);
  return result.error;
}

describe('parseDevServerConfig — defaults', () => {
  it('fills all defaults from an empty object', () => {
    const value = parseOk({});
    expect(value).toEqual({
      startCommand: DEV_SERVER_DEFAULT_START_COMMAND,
      env: {},
      secretKeys: [],
      portMap: [],
    });
  });

  it('startCommand defaults to `npm run dev`', () => {
    expect(DEV_SERVER_DEFAULT_START_COMMAND).toBe('npm run dev');
    expect(parseOk({ env: { FOO: 'bar' } }).startCommand).toBe('npm run dev');
  });

  it('trims startCommand and keeps an explicit value', () => {
    expect(parseOk({ startCommand: '  yarn dev  ' }).startCommand).toBe('yarn dev');
  });

  it('promotes the first portMap entry to primary when none is marked', () => {
    const value = parseOk({
      portMap: [
        { internalPort: 3000, label: 'web' },
        { internalPort: 3001, label: 'api' },
      ],
    });
    expect(value.portMap).toEqual([
      { internalPort: 3000, label: 'web', primary: true },
      { internalPort: 3001, label: 'api' },
    ]);
  });

  it('respects an explicit primary on a non-first entry', () => {
    const value = parseOk({
      portMap: [
        { internalPort: 3000, label: 'web' },
        { internalPort: 3001, label: 'api', primary: true },
      ],
    });
    expect(value.portMap[0].primary).toBeUndefined();
    expect(value.portMap[1].primary).toBe(true);
  });
});

describe('parseDevServerConfig — full round-trip', () => {
  it('accepts a fully-populated config', () => {
    const value = parseOk({
      startCommand: 'docker compose up -d && npm run dev',
      env: { LOG_LEVEL: 'debug', API_URL: 'http://localhost:8080' },
      secretKeys: ['DATABASE_URL', 'STRIPE_KEY'],
      portMap: [{ internalPort: 5173, label: 'vite', primary: true }],
      healthPath: '/healthz',
      readyTimeoutMs: 120_000,
      cwd: 'frontend',
    });
    expect(value.secretKeys).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    expect(value.healthPath).toBe('/healthz');
    expect(value.readyTimeoutMs).toBe(120_000);
    expect(value.cwd).toBe('frontend');
  });
});

describe('parseDevServerConfig — rejections', () => {
  it('rejects non-object payloads', () => {
    expect(parseErr(null)).toContain('must be an object');
    expect(parseErr('npm run dev')).toContain('must be an object');
    expect(parseErr([])).toContain('must be an object');
  });

  it('rejects unknown fields (strict object)', () => {
    expect(parseErr({ startScript: 'npm run dev' })).toMatch(/prEnv\.devServer/);
  });

  it('rejects an empty startCommand', () => {
    expect(parseErr({ startCommand: '   ' })).toContain('startCommand');
  });

  it('rejects non-POSIX env keys', () => {
    expect(parseErr({ env: { 'BAD-KEY': 'x' } })).toMatch(/env/);
    expect(parseErr({ env: { '1LEADING': 'x' } })).toMatch(/env/);
  });

  it('rejects reserved env keys', () => {
    expect(parseErr({ env: { AGENT_HUB_URL: 'x' } })).toContain('reserved');
    expect(parseErr({ env: { PATH: 'x' } })).toContain('reserved');
    expect(parseErr({ env: { PORT: '3000' } })).toContain('reserved');
  });

  it('rejects non-string env values', () => {
    expect(parseErr({ env: { FOO: 42 } })).toMatch(/env/);
  });

  it('rejects too many env entries', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 65; i++) env[`KEY_${i}`] = 'v';
    expect(parseErr({ env })).toContain('at most 64');
  });

  it('rejects reserved / invalid / duplicate secret keys', () => {
    expect(parseErr({ secretKeys: ['AGENT_HUB_API_KEY'] })).toContain('reserved');
    expect(parseErr({ secretKeys: ['not a key'] })).toMatch(/secretKeys/);
    expect(parseErr({ secretKeys: ['DB_URL', 'DB_URL'] })).toContain('more than once');
  });

  it('rejects a key present in both env and secretKeys', () => {
    expect(parseErr({ env: { DB_URL: 'plain' }, secretKeys: ['DB_URL'] })).toContain(
      'both env and secretKeys',
    );
  });

  it('rejects plaintext-style secret entries (values are not key names)', () => {
    // A value like "sk-live-abc123..." fails the POSIX-name rule, so
    // pasting a secret VALUE where a key NAME belongs is rejected.
    expect(parseErr({ secretKeys: ['sk-live-abc123'] })).toMatch(/secretKeys/);
  });

  it('rejects out-of-range and duplicate ports', () => {
    expect(parseErr({ portMap: [{ internalPort: 0, label: 'web' }] })).toMatch(/portMap/);
    expect(parseErr({ portMap: [{ internalPort: 70000, label: 'web' }] })).toMatch(/portMap/);
    expect(parseErr({ portMap: [{ internalPort: 3000.5, label: 'web' }] })).toMatch(/portMap/);
    expect(
      parseErr({
        portMap: [
          { internalPort: 3000, label: 'a' },
          { internalPort: 3000, label: 'b' },
        ],
      }),
    ).toContain('more than once');
  });

  it('rejects multiple primary ports', () => {
    expect(
      parseErr({
        portMap: [
          { internalPort: 3000, label: 'a', primary: true },
          { internalPort: 3001, label: 'b', primary: true },
        ],
      }),
    ).toContain('at most one primary');
  });

  it('rejects an empty port label', () => {
    expect(parseErr({ portMap: [{ internalPort: 3000, label: '  ' }] })).toMatch(/portMap/);
  });

  it('rejects a healthPath that does not start with `/`', () => {
    expect(parseErr({ healthPath: 'healthz' })).toContain('healthPath');
  });

  it('rejects out-of-bounds readyTimeoutMs', () => {
    expect(parseErr({ readyTimeoutMs: 100 })).toContain('readyTimeoutMs');
    expect(parseErr({ readyTimeoutMs: 4_000_000 })).toContain('readyTimeoutMs');
    expect(parseErr({ readyTimeoutMs: 5000.5 })).toContain('readyTimeoutMs');
  });

  it('rejects absolute and escaping cwd overrides', () => {
    expect(parseErr({ cwd: '/etc' })).toContain('relative to the worktree root');
    expect(parseErr({ cwd: 'C:\\repo' })).toContain('relative to the worktree root');
    expect(parseErr({ cwd: '../sibling' })).toContain('no `..` segments');
    expect(parseErr({ cwd: 'a/../../b' })).toContain('no `..` segments');
  });

  it('accepts a nested relative cwd', () => {
    expect(parseOk({ cwd: 'apps/web' }).cwd).toBe('apps/web');
  });

  it('prefixes errors with the prEnv.devServer path', () => {
    expect(parseErr({ startCommand: '' })).toMatch(/^prEnv\.devServer\.startCommand/);
  });
});
