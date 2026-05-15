import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

/** Default Hub SQLite/config layout under the OS user home. */
export function defaultAgentHubDataDir(): string {
  return path.resolve(path.join(os.homedir(), '.agent-hub', 'data'));
}

export function isDefaultAgentHubDataDir(dataDir: string | null | undefined): boolean {
  if (dataDir == null || !String(dataDir).trim()) return false;
  return path.resolve(dataDir) === defaultAgentHubDataDir();
}

/**
 * `HOME` for host-wide ("global") CLI OAuth caches — `.cursor`, `.codex`,
 * `.claude`, etc. — when the Hub `dataDir` is **not** the default
 * `~/.agent-hub/data` tree (Docker `AGENT_HUB_DATA_DIR=/data`, bind mounts,
 * etc.). Caches live under `dataDir` so one volume can hold both SQLite and
 * CLI tokens across container recreation.
 *
 * When `dataDir` is the default path, returns `os.homedir()` so existing
 * desktop installs keep using the real home directory.
 *
 * When `dataDir` is missing/empty (partial test configs), returns `os.homedir()`
 * so callers match the historical `~/.codex` resolution.
 */
export function operatorCliHome(dataDir: string | null | undefined): string {
  if (dataDir == null || !String(dataDir).trim()) {
    return os.homedir();
  }
  if (isDefaultAgentHubDataDir(dataDir)) {
    return os.homedir();
  }
  return path.join(path.resolve(dataDir), 'global-cli-home');
}

export function ensureOperatorCliHome(dataDir: string | null | undefined): string {
  if (dataDir == null || !String(dataDir).trim()) {
    return os.homedir();
  }
  const home = operatorCliHome(dataDir);
  if (!isDefaultAgentHubDataDir(dataDir)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  return home;
}
