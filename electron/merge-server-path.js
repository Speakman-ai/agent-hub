/**
 * Build PATH for the Node server process spawned from Electron's main process.
 *
 * GUI launches (macOS Finder, Windows Start menu) often receive a minimal PATH.
 * Without Homebrew / Git for Windows / GitHub CLI directories, spawned agents
 * cannot find `node`, `git`, or `gh` — which breaks Codex and PR tooling.
 *
 * Manual spot-check (desktop):
 *   - Open Settings → General; confirm the "Desktop app" note appears.
 *   - In a session, run a one-liner that shells out to `which git` / `where gh`
 *     (or use Codex to run `git status`) and confirm it resolves.
 *
 * @param {string} [processPath=process.env.PATH] — existing PATH to merge after extras
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string} [platform=process.platform]
 */
import path from 'path';
import os from 'os';

export function extraPathSegmentsForPlatform(platform, env) {
  const e = env || process.env;
  if (platform === 'win32') {
    const j = path.win32.join;
    const pf = e.ProgramFiles || 'C:\\Program Files';
    const pfx86 = e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = e.LOCALAPPDATA || '';
    const userProfile = e.USERPROFILE || '';
    return [
      j(pf, 'Git', 'cmd'),
      j(pf, 'Git', 'bin'),
      j(pf, 'Git', 'mingw64', 'bin'),
      j(pf, 'GitHub CLI'),
      j(pfx86, 'Git', 'cmd'),
      j(local, 'GitHub CLI'),
      j(local, 'Programs', 'Git', 'cmd'),
      j(userProfile, 'scoop', 'shims'),
    ];
  }
  const home = e.HOME || os.homedir() || '';
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.nvm', 'versions', 'node', 'current', 'bin'),
  ];
}

/**
 * Prepend well-known dev-tool locations, then append the current PATH segments
 * (deduped, first occurrence wins). Uses `path.delimiter` so Windows gets `;`.
 */
export function mergeElectronServerPath(
  processPath = process.env.PATH,
  env = process.env,
  platform = process.platform,
) {
  // When tests pass platform=win32 on Linux/macOS, still use `;` — GUI PATH shape is OS-defined,
  // not whatever OS Vitest is running on.
  const delim = platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;
  const extras = extraPathSegmentsForPlatform(platform, env);
  const seen = new Set();
  const out = [];
  for (const seg of extras) {
    if (!seg) continue;
    const t = seg.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  if (processPath) {
    for (const seg of processPath.split(delim)) {
      const t = seg.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out.join(delim);
}
