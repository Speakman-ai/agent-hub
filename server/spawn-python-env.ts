/**
 * Keep spawned shells on a working system Python.
 *
 * node-gyp 10+ does `from packaging.version import Version`. A project
 * `.venv` (session startup, or an agent that ran `python3 -m venv`) that
 * leaks `PYTHONHOME` / `PYTHONPATH` / `VIRTUAL_ENV` into later shells
 * redirects even `/usr/bin/python3` away from dist-packages, so `npm ci`
 * dies compiling native addons (node-pty) with ModuleNotFoundError.
 *
 * Activate a venv with PATH only (the way `source .venv/bin/activate`
 * actually works). Hub-owned spawns never inherit those three vars from
 * the server process, and pin npm/node-gyp at the image Python when the
 * caller did not already choose one.
 */
import { existsSync } from 'fs';

/** Vars that relocate CPython's module search even for `/usr/bin/python3`. */
export const SPAWN_PYTHON_POISON_VARS = ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV'] as const;

const SYSTEM_PYTHON_CANDIDATES = ['/usr/bin/python3', '/usr/local/bin/python3'] as const;

export function resolveSystemPythonInterpreter(
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const candidate of SYSTEM_PYTHON_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Mutates `env` in place (callers pass a clone of `process.env`) and returns
 * it. Does not override an explicit `PYTHON` / `npm_config_python`.
 */
export function sanitizeSpawnPythonEnv(
  env: NodeJS.ProcessEnv,
  opts: { exists?: (path: string) => boolean } = {},
): NodeJS.ProcessEnv {
  for (const key of SPAWN_PYTHON_POISON_VARS) {
    delete env[key];
  }
  if (!present(env.PYTHON) && !present(env.npm_config_python)) {
    const systemPython = resolveSystemPythonInterpreter(opts.exists);
    if (systemPython) {
      env.PYTHON = systemPython;
      env.npm_config_python = systemPython;
    }
  }
  return env;
}
