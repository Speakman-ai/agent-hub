import { describe, expect, it } from 'vitest';
import {
  resolveSystemPythonInterpreter,
  sanitizeSpawnPythonEnv,
  SPAWN_PYTHON_POISON_VARS,
} from './spawn-python-env.js';

describe('resolveSystemPythonInterpreter', () => {
  it('prefers /usr/bin/python3 when it exists', () => {
    expect(resolveSystemPythonInterpreter((p) => p === '/usr/bin/python3')).toBe(
      '/usr/bin/python3',
    );
  });

  it('falls back to /usr/local/bin/python3', () => {
    expect(resolveSystemPythonInterpreter((p) => p === '/usr/local/bin/python3')).toBe(
      '/usr/local/bin/python3',
    );
  });

  it('returns null when neither candidate exists', () => {
    expect(resolveSystemPythonInterpreter(() => false)).toBeNull();
  });
});

describe('sanitizeSpawnPythonEnv', () => {
  it('strips PYTHONHOME, PYTHONPATH, and VIRTUAL_ENV', () => {
    const env = sanitizeSpawnPythonEnv(
      {
        PYTHONHOME: '/wt/.venv',
        PYTHONPATH: '/wt/.venv/lib/python3.11/site-packages',
        VIRTUAL_ENV: '/wt/.venv',
        PATH: '/usr/bin',
      },
      { exists: () => false },
    );
    for (const key of SPAWN_PYTHON_POISON_VARS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('pins npm/node-gyp at the system interpreter when unset', () => {
    const env = sanitizeSpawnPythonEnv(
      { PATH: '/usr/bin' },
      { exists: (p) => p === '/usr/bin/python3' },
    );
    expect(env.PYTHON).toBe('/usr/bin/python3');
    expect(env.npm_config_python).toBe('/usr/bin/python3');
  });

  it('does not override an explicit PYTHON', () => {
    const env = sanitizeSpawnPythonEnv(
      { PYTHON: '/opt/custom/python3', PATH: '/usr/bin' },
      { exists: (p) => p === '/usr/bin/python3' },
    );
    expect(env.PYTHON).toBe('/opt/custom/python3');
    expect(env.npm_config_python).toBeUndefined();
  });

  it('does not override an explicit npm_config_python', () => {
    const env = sanitizeSpawnPythonEnv(
      { npm_config_python: '/opt/custom/python3', PATH: '/usr/bin' },
      { exists: (p) => p === '/usr/bin/python3' },
    );
    expect(env.npm_config_python).toBe('/opt/custom/python3');
    expect(env.PYTHON).toBeUndefined();
  });
});
