/**
 * Where fleet desktops keep their home between runs. A fleet runner is not
 * the same box twice, so on stop the agent uploads a tarball of the home
 * (through the Hub) and the next run restores it.
 *
 *   - AGENT_HUB_DESKTOP_HOME_BUCKET set: S3 (desktop-home-store-s3.ts). Use a
 *     bucket without an expiry rule; the Finalize worktree bucket expires
 *     objects after two days and must not be reused.
 *   - else a local directory: AGENT_HUB_DESKTOP_HOME_DIR, default
 *     `<dataDir>/desktop-homes`.
 *
 * Keys are `<computerId>/<jobId>-<attemptId>.tar.gz`: every upload attempt
 * writes its own object, so a stale attempt can only ever delete itself.
 * Deleting a computer deletes its prefix.
 */
import { copyFile, mkdir, rm, stat } from 'fs/promises';
import path from 'path';

export interface DesktopHomeStore {
  put(key: string, filePath: string): Promise<void>;
  /** Copy `key` to `destPath`. False when the key does not exist. */
  get(key: string, destPath: string): Promise<boolean>;
  /** Delete exactly `key`. No-op when it does not exist. */
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split('/').some((p) => p === '..' || p === '.')) {
    throw new Error(`invalid desktop home key: ${key}`);
  }
}

export class LocalDirDesktopHomeStore implements DesktopHomeStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, key);
  }

  async put(key: string, filePath: string): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(filePath, dest);
  }

  async get(key: string, destPath: string): Promise<boolean> {
    const src = this.resolve(key);
    try {
      await stat(src);
    } catch (err) {
      // Only a confirmed absence is "missing"; anything else (permissions,
      // I/O) must fail the restore rather than read as an empty home.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(src, destPath);
    return true;
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }
}

export function homeSnapshotKey(computerId: string, jobId: string, attemptId: string): string {
  return `${computerId}/${jobId}-${attemptId}.tar.gz`;
}

export async function resolveDesktopHomeStore(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): Promise<DesktopHomeStore> {
  const bucket = env.AGENT_HUB_DESKTOP_HOME_BUCKET?.trim();
  if (bucket) {
    // Lazy so the AWS SDK only loads when the bucket is configured.
    const { S3DesktopHomeStore } = await import('./desktop-home-store-s3.js');
    return new S3DesktopHomeStore({
      bucket,
      region: env.AGENT_HUB_DESKTOP_HOME_BUCKET_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION,
    });
  }
  return new LocalDirDesktopHomeStore(
    env.AGENT_HUB_DESKTOP_HOME_DIR?.trim() || path.join(dataDir, 'desktop-homes'),
  );
}
