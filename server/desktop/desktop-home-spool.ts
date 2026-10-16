/**
 * Hub-side scratch space for desktop home transfers. A spool holds a copy of
 * a user's home (browser logins included) while it streams to or from the
 * home store, so it must never be lost track of.
 *
 * All spools live under one root, `<dataDir>/desktop-home-spool`, and the
 * process remembers which ones are in use. Anything else under the root is
 * a leftover: a removal that failed, or one cut short by a Hub restart (on
 * boot nothing is in use). The desktop home janitor deletes leftovers until
 * they are gone, so a copy stays findable until its deletion succeeds,
 * across restarts, without a separate record.
 */
import { mkdir, mkdtemp, readdir, rm } from 'fs/promises';
import path from 'path';

export type RemoveDir = (dir: string) => Promise<void>;

const defaultRemove: RemoveDir = (dir) => rm(dir, { recursive: true, force: true });

export interface HomeSpools {
  readonly root: string;
  /** A fresh spool directory, in use until `close`. */
  open(): Promise<{ dir: string; close: () => Promise<void> }>;
  /** Delete every spool not in use. Returns how many could not be deleted. */
  sweep(): Promise<number>;
}

export function createHomeSpools(root: string, remove: RemoveDir = defaultRemove): HomeSpools {
  const inUse = new Set<string>();
  return {
    root,
    async open() {
      await mkdir(root, { recursive: true });
      const dir = await mkdtemp(path.join(root, 'xfer-'));
      inUse.add(dir);
      return {
        dir,
        async close() {
          inUse.delete(dir);
          try {
            await remove(dir);
          } catch (err) {
            // Not in use any more, so the next sweep retries it.
            console.warn(
              `[desktop] home transfer spool ${dir} not removed yet (the janitor retries): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        },
      };
    },
    async sweep() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
      let left = 0;
      for (const name of names) {
        const dir = path.join(root, name);
        if (inUse.has(dir)) continue;
        try {
          await remove(dir);
        } catch {
          left++;
        }
      }
      return left;
    },
  };
}
