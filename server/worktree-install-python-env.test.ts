/**
 * Regression: the cold host-worktree dependency install must not inherit a
 * poisoned Python environment. node-gyp 10+ imports `packaging.version`; a
 * leaked PYTHONHOME/PYTHONPATH/VIRTUAL_ENV redirects even `/usr/bin/python3`
 * away from dist-packages, so `npm ci` dies compiling native addons before any
 * sanitized chat/HostSessionEnv spawn exists. `installChildEnv` (the env
 * `setupDependencies` hands to `exec`) is built at module load from
 * `process.env`, so we poison the environment BEFORE importing worktree.js to
 * prove the sanitizer runs on this path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp', sessionEnvAdapter: 'auto' },
}));

// Poison the environment before worktree.js evaluates `installChildEnv`.
// Direct process.env mutation must happen before the import (the constant is
// captured at module load), but process.env is shared across every test file
// in this Vitest worker, so snapshot the prior values and restore them after
// this suite to keep the rest of the run order-independent.
const POISONED_KEYS = [
  'PYTHONHOME',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'PYTHON',
  'npm_config_python',
] as const;
const priorEnv: Record<string, string | undefined> = {};
for (const key of POISONED_KEYS) {
  priorEnv[key] = process.env[key];
}

process.env.PYTHONHOME = '/tmp/fake-venv';
process.env.PYTHONPATH = '/tmp/fake-venv/lib/python3/site-packages';
process.env.VIRTUAL_ENV = '/tmp/fake-venv';
delete process.env.PYTHON;
delete process.env.npm_config_python;

let installChildEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  const mod = await import('./worktree.js');
  installChildEnv = mod.__test.installChildEnv;
});

afterAll(() => {
  for (const key of POISONED_KEYS) {
    const prev = priorEnv[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
});

describe('installChildEnv Python sanitization', () => {
  it('scrubs leaked PYTHONHOME/PYTHONPATH/VIRTUAL_ENV so node-gyp keeps the system Python', () => {
    expect(installChildEnv.PYTHONHOME).toBeUndefined();
    expect(installChildEnv.PYTHONPATH).toBeUndefined();
    expect(installChildEnv.VIRTUAL_ENV).toBeUndefined();
  });

  it('still carries the install overrides alongside the sanitized Python env', () => {
    expect(installChildEnv.NODE_ENV).toBe('development');
    expect(installChildEnv.PIP_BREAK_SYSTEM_PACKAGES).toBe('1');
  });

  it('pins PYTHON/npm_config_python to a system interpreter when one exists and the caller did not choose', () => {
    // The Hub runner image ships /usr/bin/python3; if present, the sanitizer
    // pins it so node-gyp does not fall back to the scrubbed venv path.
    const hasSystemPython = existsSync('/usr/bin/python3') || existsSync('/usr/local/bin/python3');
    if (hasSystemPython) {
      expect(installChildEnv.PYTHON).toMatch(/\/python3$/);
      expect(installChildEnv.npm_config_python).toBe(installChildEnv.PYTHON);
    }
  });
});
