import { createRequire } from 'module';
import type { HostPtyFactory, HostPtyLike } from './host-session-env.js';
import { prepareNodePtySpawnHelper } from './node-pty-spawn-helper.js';

const require = createRequire(import.meta.url);

export const defaultPtyFactory: HostPtyFactory = async (opts) => {
  let mod: { spawn: (file: string, args: string[], options: object) => HostPtyLike };
  try {
    const specifier = 'node-pty';
    mod = (await import(specifier)) as unknown as typeof mod;
  } catch (err) {
    throw new Error(
      'openPty requires the native module "node-pty" (install the server dependencies). ' +
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  prepareNodePtySpawnHelper(require.resolve('node-pty'), Object.keys(require.cache));
  try {
    return mod.spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
      name: opts.name,
    });
  } catch (err) {
    throw new Error(
      `Could not start terminal command ${opts.command} in ${opts.cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
