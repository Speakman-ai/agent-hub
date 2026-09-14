import { accessSync, chmodSync, constants, statSync } from 'fs';
import path from 'path';

/** Repair the macOS launcher shipped without an execute bit by some node-pty packages. */
export function prepareNodePtySpawnHelper(
  moduleEntry: string,
  loadedModules: string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'darwin') return;
  const packageRoot = path.resolve(path.dirname(moduleEntry), '..');
  // Use the loaded binding: a broken build/Release may have fallen back to a prebuild.
  const native = loadedModules.find(
    (file) => file.startsWith(`${packageRoot}${path.sep}`) && path.basename(file) === 'pty.node',
  );
  if (!native) return;
  const helper = path.join(path.dirname(native), 'spawn-helper');
  try {
    const info = statSync(helper);
    if (!info.isFile()) throw new Error('launcher is not a file');
    if (!(info.mode & 0o100)) chmodSync(helper, info.mode | 0o100);
    accessSync(helper, constants.X_OK);
  } catch (err) {
    throw new Error(
      `Cannot execute the macOS terminal launcher at ${helper}. Reinstall the server terminal dependencies or restore the launcher's execute permission. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
