/**
 * HOME directory for spawns when no per-user `userId` is set ("global" /
 * host-wide CLI auth), or when `ensurePerUserHome` fails.
 *
 * If `dataDir` is the default `~/.agent-hub/data`, we keep `HOME` at the real
 * home dir so existing desktop token paths keep working. Otherwise we use
 * `<dataDir>/operator-cli-home` so Docker and other overridden data dirs
 * persist `.cursor` / `.codex` caches on the same volume as the database.
 */
import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

function resolvedDefaultDataDir(): string {
  return path.resolve(path.join(os.homedir(), '.agent-hub', 'data'));
}

export function operatorCliHomePath(dataDir: string): string {
  const resolvedData = path.resolve(dataDir);
  if (resolvedData === resolvedDefaultDataDir()) {
    return os.homedir();
  }
  return path.join(resolvedData, 'operator-cli-home');
}

export function ensureOperatorCliHome(dataDir: string): string {
  const home = operatorCliHomePath(dataDir);
  if (path.resolve(home) !== path.resolve(os.homedir())) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  return home;
}
