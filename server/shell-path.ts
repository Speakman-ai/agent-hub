import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

/**
 * Login-shell PATH resolver.
 *
 * Agent Hub spawns CLI processes (claude, cursor-agent, aws, gh, etc.) with
 * `{ ...process.env }` as the child env. `process.env.PATH` is captured when
 * the server process started (typically by PM2 or an npm script), so any PATH
 * mutations that happen *after* server start — e.g. a user installing the
 * AWS CLI, or adding `~/.local/bin` to `~/.bashrc` — are invisible to spawned
 * agents until the server itself restarts.
 *
 * This module captures the *login shell's* PATH at startup by running
 * `$SHELL -lic 'printf %s "$PATH"'`, caches the result, and merges it (deduped)
 * with the current `process.env.PATH` whenever `buildSpawnEnv` is called. It
 * also exposes `refreshShellPath()` so a running server can pick up new CLIs
 * without a restart.
 */

// Fallback directories that should almost always be on a developer's PATH.
// Used if the login-shell lookup fails (headless containers, minimal images).
// Computed once — depends only on os.homedir() which is fixed for process lifetime.
const FALLBACK_DIRS: string[] = (() => {
  const home = os.homedir();
  return [
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    '/snap/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, 'go', 'bin'),
  ];
})();

function detectLoginShell(): string {
  if (process.env.SHELL && process.env.SHELL.trim().length > 0) {
    return process.env.SHELL;
  }
  // Conservative default — most dev images ship bash.
  return '/bin/bash';
}

// Sentinels wrap the PATH value so we can extract it cleanly even when the
// shell's rc files print banners, MOTD, or plugin-load messages to stdout.
const PATH_START_SENTINEL = '__AH_PATH_START__';
const PATH_END_SENTINEL = '__AH_PATH_END__';

/**
 * Extract the PATH value between sentinels. Exported for testing.
 */
export function extractPathFromShellOutput(out: string): string | null {
  const re = new RegExp(`${PATH_START_SENTINEL}([\\s\\S]*?)${PATH_END_SENTINEL}`);
  const m = re.exec(out);
  return m ? m[1] : null;
}

/**
 * Run the login shell to capture its resolved PATH. Returns null on failure
 * (e.g. shell missing, init script throws, 2 second timeout).
 */
export function readLoginShellPath(shell: string = detectLoginShell()): string | null {
  try {
    // `-l` runs as a login shell (sources /etc/profile + ~/.profile / ~/.bash_profile),
    // `-i` runs interactively (sources ~/.bashrc / ~/.zshrc), `-c` runs a command.
    // Sentinels around the value let us ignore any banner text that rc files
    // print to stdout (oh-my-zsh load messages, nvm "use" echoes, etc.).
    const cmd = `printf "${PATH_START_SENTINEL}%s${PATH_END_SENTINEL}" "$PATH"`;
    const out = execFileSync(shell, ['-lic', cmd], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const extracted = extractPathFromShellOutput(out);
    if (!extracted) return null;
    const trimmed = extracted.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Merge multiple PATH-like strings into one, preserving first-seen order and
 * dropping duplicates. Empty segments are discarded.
 */
export function mergePaths(...pathStrings: (string | undefined | null)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pathStrings) {
    if (!p) continue;
    for (const seg of p.split(path.delimiter)) {
      const s = seg.trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out.join(path.delimiter);
}

interface CachedShellPath {
  value: string | null;
  source: 'login-shell' | 'fallback' | 'uninitialized';
  capturedAt: number;
}

let cache: CachedShellPath = { value: null, source: 'uninitialized', capturedAt: 0 };

/**
 * Prime the cache. Called once at server startup and again whenever a caller
 * invokes `refreshShellPath()`. Safe to call from import-time code — any
 * failure is swallowed and we fall back to the fallback directory list.
 */
export function refreshShellPath(): CachedShellPath {
  const loginPath = readLoginShellPath();
  if (loginPath) {
    cache = { value: loginPath, source: 'login-shell', capturedAt: Date.now() };
  } else {
    cache = {
      value: mergePaths(...FALLBACK_DIRS),
      source: 'fallback',
      capturedAt: Date.now(),
    };
  }
  return cache;
}

export function getCachedShellPath(): CachedShellPath {
  if (cache.source === 'uninitialized') {
    return refreshShellPath();
  }
  return cache;
}

/**
 * Return the PATH value that should be injected into child processes:
 * a union of `process.env.PATH` (front — wins for ties) and the login-shell
 * PATH (back — contributes any extra dirs added by shell rc files).
 *
 * Putting `process.env.PATH` first preserves PM2 / ecosystem.config.cjs
 * overrides; putting the shell PATH second means newly-installed CLIs in
 * `~/.local/bin`, `/snap/bin`, etc. become visible after a refresh.
 */
export function resolveSpawnPath(processPath: string | undefined = process.env.PATH): string {
  const cached = getCachedShellPath();
  return mergePaths(processPath, cached.value, ...FALLBACK_DIRS);
}
