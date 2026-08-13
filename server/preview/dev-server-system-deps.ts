/**
 * System-level (OS) dependency install for the managed dev-server.
 *
 * Projects that run under `prEnv.devServer` sometimes need native libraries
 * that pip/npm cannot supply — the canonical case is Python `Wand`, which is a
 * ctypes binding to ImageMagick's `libMagickWand` and crashes at import with
 * "MagickWand shared library not found" unless `imagemagick` /
 * `libmagickwand-dev` are installed at the OS level.
 *
 * `devServer.aptPackages` names those packages. This module turns them into an
 * `apt-get install` command and runs it **inside the session's SessionEnv,
 * before `startCommand`** — but only when the env is a per-session container
 * (`sysbox` or `container`), where root is confined to that container and the
 * filesystem it mutates dies with the session. On the `host` backend the
 * install is refused with a loud warning: apt needs root and would mutate the
 * shared Hub host, the exact unsafe thing this whole feature exists to avoid.
 *
 * The command builder is pure and independently tested; the package names are
 * charset-validated upstream by `dev-server-config.ts`, so no shell
 * metacharacter can reach the interpolated command here.
 */

import type {
  SessionEnv,
  SessionEnvExit,
  SessionEnvKind,
  SessionEnvProcess,
} from '../session-env/session-env.js';

/** Stream label used for system-deps log lines in the preview log tail. */
export const SYSTEM_DEPS_PROCESS_NAME = 'system-deps';

/**
 * Build the `apt-get` command that installs `packages`, or `null` when there
 * is nothing to install. `apt-get update` and `install` share one `sh -c`
 * invocation (an unversioned `install` without a preceding `update` is a
 * common cache-staleness footgun). `--no-install-recommends` keeps the layer
 * lean; `DEBIAN_FRONTEND=noninteractive` avoids tzdata-style prompts hanging
 * the boot. Package names are pre-validated (see `APT_PACKAGE_RE`).
 *
 * The container backends exec as a non-root sudoer (`runner`), so apt is
 * elevated at runtime rather than at build time: `id -u` decides, which keeps
 * the one command correct on an image that execs as root and on one that does
 * not. `env` carries `DEBIAN_FRONTEND` through sudo — a bare `VAR=x sudo …`
 * assignment does not survive sudo's environment reset.
 */
export function buildAptInstallCommand(packages: readonly string[]): string | null {
  if (packages.length === 0) return null;
  const list = packages.join(' ');
  return (
    `apt_sudo=''; [ "$(id -u)" -eq 0 ] || apt_sudo='sudo -n'; ` +
    `$apt_sudo apt-get update && ` +
    `$apt_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${list}`
  );
}

export type SystemDepsSkipReason = 'no-packages' | 'host-backend';

/**
 * Backends that can run `apt-get` safely. The predicate keys on the property
 * that actually makes the install safe — root is confined to a container whose
 * filesystem is discarded with the session — rather than naming a single
 * backend. `container` was added after this module shipped; gating on
 * `kind === 'sysbox'` alone silently skipped the install on every Hub whose
 * host lacks the sysbox runtime, which is the common deployment.
 */
function canInstallSystemDeps(kind: SessionEnvKind): boolean {
  switch (kind) {
    case 'sysbox':
    case 'container':
    case 'firecracker':
      return true;
    case 'host':
      return false;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export interface InstallSystemDepsResult {
  /** True only when the apt command actually ran to completion in the env. */
  ran: boolean;
  /** Why the install did not run (mutually exclusive with `ran: true`). */
  skipped?: SystemDepsSkipReason;
  /** Exit result of the apt process when `ran` is true. */
  exit?: SessionEnvExit;
}

export interface InstallSystemDepsOpts {
  env: SessionEnv;
  aptPackages: readonly string[];
  /**
   * Env for the apt process — the same non-secret env + resolved project
   * secrets the dev server itself gets, so an install that needs registry /
   * proxy credentials or `APT_*` from `prEnv.devServer` can use them.
   */
  spawnEnv?: Record<string, string>;
  /** Per-line sink so callers can tee apt output into the preview log tail. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  logger?: { warn: (msg: string) => void };
}

function splitLines(chunk: string): string[] {
  return chunk.split('\n').filter((line) => line.length > 0);
}

function waitForExit(
  proc: SessionEnvProcess,
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<SessionEnvExit> {
  return new Promise((resolve) => {
    // Track every subscription so we can dispose them once the process exits.
    // Without this, repeated preview starts leak stdout/stderr/exit listeners
    // (and their closures) onto the retained process records after apt exits.
    const unsubs: Array<() => void> = [];
    let settled = false;
    const disposeAll = () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // A backend whose unsubscribe throws must not mask the exit.
        }
      }
      unsubs.length = 0;
    };

    if (onLine) {
      unsubs.push(
        proc.onStdout((chunk) => {
          for (const line of splitLines(chunk)) onLine(line, 'stdout');
        }),
      );
      unsubs.push(
        proc.onStderr((chunk) => {
          for (const line of splitLines(chunk)) onLine(line, 'stderr');
        }),
      );
    }

    // `onExit` fires the callback synchronously when the process has ALREADY
    // exited — before it returns its unsubscribe fn. So the callback must not
    // assume the exit unsub is registered yet: it disposes whatever is in
    // `unsubs` (stdout/stderr) and sets `settled`. The exit unsub is then
    // handled after the call returns, based on whether the callback already
    // ran (sync/already-exited) or not (async — dispose it with the rest).
    const exitUnsub = proc.onExit((result) => {
      settled = true;
      disposeAll();
      resolve(result);
    });
    if (settled) {
      // Already-exited path: the callback ran during registration and disposed
      // stdout/stderr; the exit listener already fired and won't fire again, so
      // just release its subscription too.
      try {
        exitUnsub();
      } catch {
        // ignore — nothing left to mask.
      }
    } else {
      unsubs.push(exitUnsub);
    }
  });
}

/**
 * Install `aptPackages` inside `env` (when safe) and resolve with the outcome.
 * Never throws for a skip; callers decide whether a non-zero apt exit should
 * fail the dev-server start.
 */
export async function installDevServerSystemDeps(
  opts: InstallSystemDepsOpts,
): Promise<InstallSystemDepsResult> {
  const command = buildAptInstallCommand(opts.aptPackages);
  if (command === null) return { ran: false, skipped: 'no-packages' };

  if (!canInstallSystemDeps(opts.env.kind)) {
    const msg =
      `[${SYSTEM_DEPS_PROCESS_NAME}] skipped apt install of ` +
      `${opts.aptPackages.length} package(s) — this session runs on the ` +
      `"${opts.env.kind}" backend, which cannot install OS packages safely ` +
      `(apt needs root and would mutate the shared host). Run the Hub with ` +
      `a per-session container backend, or bake these packages into a ` +
      `compose image.`;
    opts.logger?.warn(msg);
    opts.onLine?.(msg, 'stderr');
    return { ran: false, skipped: 'host-backend' };
  }

  opts.onLine?.(
    `[${SYSTEM_DEPS_PROCESS_NAME}] installing: ${opts.aptPackages.join(', ')}`,
    'stdout',
  );
  const proc = opts.env.spawn(command, {
    name: `dev-server-system-deps:${opts.env.sessionId}`,
    env: opts.spawnEnv,
  });
  const exit = await waitForExit(proc, opts.onLine);
  return { ran: true, exit };
}

/** Human-readable summary of a non-zero / errored apt exit for error messages. */
export function describeSystemDepsExit(exit: SessionEnvExit): string {
  if (exit.error) return `apt failed to spawn: ${exit.error.message}`;
  if (exit.signal) return `apt killed by signal ${exit.signal}`;
  return `apt-get exited with code ${exit.code ?? 'unknown'}`;
}
