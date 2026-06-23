/**
 * Dev-only data directory for the embedded server.
 *
 * Must match the server default in `server/config.ts` (`~/.agent-hub/data`)
 * when `AGENT_HUB_DATA_DIR` is unset so OAuth and SQLite state survive switching
 * between `npm run dev:server` and Electron dev (`electron:dev`).
 */
import os from 'os';
import path from 'path';

export function resolveElectronDevUserDataDir(env = process.env, homedirFn = os.homedir) {
  const explicit = env.AGENT_HUB_DATA_DIR?.trim();
  if (explicit) return explicit;
  return path.join(homedirFn(), '.agent-hub', 'data');
}
