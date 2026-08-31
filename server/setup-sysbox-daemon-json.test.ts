import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// Guards the daemon.json merge that setup-sysbox-host.sh applies on preview
// hosts. The regression this protects against: hosts were provisioned with only
// the sysbox-runc runtime and no way to widen default-address-pools, so busy
// preview hosts exhausted Docker's stock ~31-subnet pool and every new session
// compose preview failed with "could not find an available, non-overlapping
// IPv4 address pool". The merge must add the runtime, preserve unrelated keys,
// leave pools untouched when the operator opts out, and emit the pools entry
// when a base CIDR is supplied.

const here = dirname(fileURLToPath(import.meta.url));
const jqProgram = resolve(here, '../ops/scripts/daemon-json-merge.jq');

function hasJq(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function merge(input: object, base: string, size = 24): Record<string, unknown> {
  const out = execFileSync(
    'jq',
    ['--arg', 'base', base, '--argjson', 'size', String(size), '-f', jqProgram],
    { input: JSON.stringify(input), encoding: 'utf8' },
  );
  return JSON.parse(out);
}

const SYSBOX = { path: '/usr/bin/sysbox-runc' };

describe.runIf(hasJq())('setup-sysbox-host daemon-json-merge.jq', () => {
  it('ships the merge program the setup script references', () => {
    expect(existsSync(jqProgram)).toBe(true);
  });

  it('adds the sysbox-runc runtime to an empty config', () => {
    const out = merge({}, '');
    expect(out.runtimes).toEqual({ 'sysbox-runc': SYSBOX });
  });

  it('preserves an operator-customized existing sysbox-runc entry (base off)', () => {
    const custom = { path: '/opt/sysbox-runc', runtimeArgs: ['--x'] };
    const out = merge({ runtimes: { 'sysbox-runc': custom } }, '');
    expect(out.runtimes).toEqual({ 'sysbox-runc': custom });
    expect(out).not.toHaveProperty('default-address-pools');
  });

  it('preserves a customized sysbox-runc entry while still adding pools (base on)', () => {
    const custom = { path: '/opt/sysbox-runc' };
    const out = merge({ runtimes: { 'sysbox-runc': custom } }, '10.128.0.0/9', 24);
    expect(out.runtimes).toEqual({ 'sysbox-runc': custom });
    expect(out['default-address-pools']).toEqual([{ base: '10.128.0.0/9', size: 24 }]);
  });

  it('preserves unrelated keys and sibling runtimes', () => {
    const out = merge({ 'log-driver': 'json-file', runtimes: { other: { path: '/x' } } }, '');
    expect(out['log-driver']).toBe('json-file');
    expect(out.runtimes).toEqual({ other: { path: '/x' }, 'sysbox-runc': SYSBOX });
  });

  it('leaves default-address-pools absent when opted out (base empty)', () => {
    const out = merge({}, '');
    expect(out).not.toHaveProperty('default-address-pools');
  });

  it('writes a widened default-address-pools when a base CIDR is supplied', () => {
    const out = merge({}, '10.128.0.0/9', 24);
    expect(out['default-address-pools']).toEqual([{ base: '10.128.0.0/9', size: 24 }]);
    expect(out.runtimes).toEqual({ 'sysbox-runc': SYSBOX });
  });

  it('is idempotent: re-merging its own output is a fixed point', () => {
    const once = merge({}, '10.128.0.0/9', 24);
    const twice = merge(once, '10.128.0.0/9', 24);
    expect(twice).toEqual(once);
  });

  it('overwrites a stale pool rather than appending a second entry', () => {
    const out = merge(
      { 'default-address-pools': [{ base: '172.30.0.0/16', size: 24 }] },
      '10.128.0.0/9',
      24,
    );
    expect(out['default-address-pools']).toEqual([{ base: '10.128.0.0/9', size: 24 }]);
  });
});

const validator = resolve(here, '../ops/scripts/validate-ipv4-network.py');

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Returns the canonical CIDR on success, or null when the validator rejects. */
function validateCidr(input: string): string | null {
  try {
    return execFileSync('python3', [validator, input], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// Guards the real-IP-parser validation setup-sysbox-host.sh runs BEFORE it
// rewrites /etc/docker/daemon.json. The regression: loose digits-and-dots
// checks let malformed bases (999.999.999.999/9, a host-address form, a bad
// prefix) through, get written into daemon.json, and then wedge
// `systemctl restart docker` after the live config was already replaced.
describe.runIf(hasPython())('setup-sysbox-host validate-ipv4-network.py', () => {
  it('accepts and canonicalizes a valid network base', () => {
    expect(validateCidr('10.128.0.0/9')).toBe('10.128.0.0/9');
  });

  it('canonicalizes an already-normalized base unchanged', () => {
    expect(validateCidr('172.16.0.0/12')).toBe('172.16.0.0/12');
  });

  it('rejects out-of-range octets', () => {
    expect(validateCidr('999.999.999.999/9')).toBeNull();
    expect(validateCidr('10.256.0.0/9')).toBeNull();
  });

  it('rejects a host-address form (host bits set — not a network base)', () => {
    expect(validateCidr('10.128.5.3/9')).toBeNull();
    expect(validateCidr('192.168.1.1/24')).toBeNull();
  });

  it('rejects an out-of-range or missing prefix', () => {
    expect(validateCidr('10.128.0.0/33')).toBeNull();
    expect(validateCidr('10.128.0.0')).toBeNull();
  });

  it('rejects non-IPv4 and junk input', () => {
    expect(validateCidr('fd00::/8')).toBeNull();
    expect(validateCidr('not-a-cidr')).toBeNull();
    expect(validateCidr('')).toBeNull();
  });
});

// A typed but empty --address-pool-base is a malformed opt-in, not a silent
// opt-out: the operator asked to widen the pool but gave no CIDR, so the run
// must fail loudly instead of "succeeding" without widening anything. These
// cases all `fail` during argument parsing, BEFORE the root/kernel/docker
// checks and before any side effect, so they are safe to exec at any uid.
describe('setup-sysbox-host.sh rejects a present-but-empty --address-pool-base', () => {
  const setupScript = resolve(here, '../ops/scripts/setup-sysbox-host.sh');
  function run(args: string[]): { status: number | null; out: string } {
    const r = spawnSync('bash', [setupScript, ...args], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }
  const CIDR_ERR = 'requires a CIDR value';

  it('rejects --address-pool-base with no following value', () => {
    const r = run(['--address-pool-base']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(CIDR_ERR);
  });

  it('rejects the --address-pool-base= empty form', () => {
    expect(run(['--address-pool-base=']).out).toContain(CIDR_ERR);
  });

  it('rejects an empty base flag given after another flag', () => {
    expect(run(['--verify-run', '--address-pool-base']).out).toContain(CIDR_ERR);
  });

  it('still rejects unknown flags without emitting the CIDR error', () => {
    const r = run(['--nope']);
    expect(r.status).toBe(2);
    expect(r.out).not.toContain(CIDR_ERR);
  });
});

// The host-GC session-network reaper must delete ONLY leaked Hub session
// compose networks — `session-<8-hex>_<net>` — never operator networks that
// merely start with `session-`. This exercises the exact grep the reaper runs.
describe('agenthub-network-reap.sh session-name pattern', () => {
  const RE = /^session-[0-9a-f]{8}_/;
  it('matches real per-session compose networks', () => {
    expect(RE.test('session-2c9ea319_default')).toBe(true);
    expect(RE.test('session-59167dfe_preview-postgres-data')).toBe(true);
  });
  it('does not match operator networks that merely start with session-', () => {
    for (const name of [
      'session-cache',
      'session-backup',
      'session-store_default',
      'session-2c9ea319', // no compose separator
      'session-2c9ea31_default', // 7 hex, too short
      'finalize-acme_default',
      'bridge',
    ]) {
      expect(RE.test(name)).toBe(false);
    }
  });
});
