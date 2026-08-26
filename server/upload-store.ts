/**
 * Durable storage adapter for files exposed through `/uploads/<filename>`.
 *
 * AWS deployments already configure `artifactsBucket` for session artifacts
 * and replays. Uploads use that same private bucket under an `uploads/` prefix;
 * local installs keep writing to the configured uploads directory. The public
 * ref stays `/uploads/<filename>` in both cases, so callers and persisted
 * markdown do not need to know which backend owns the bytes.
 */
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import type { RequestHandler } from 'express';
import type { AppConfig } from './types.js';
import { getArtifactStore, type ArtifactStore } from './artifacts/artifact-store.js';

export type UploadStorageKind = 'local' | 's3';

export interface UploadStore {
  readonly kind: UploadStorageKind;
  put(filename: string, body: Buffer, contentType: string): Promise<void>;
  delete(filename: string): Promise<void>;
  presignGet(filename: string): Promise<string | null>;
}

const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeFilename(filename: string): void {
  if (!SAFE_FILENAME_RE.test(filename) || filename.includes('..')) {
    throw new Error(`invalid upload filename: ${filename}`);
  }
}

export function buildUploadKey(filename: string): string {
  assertSafeFilename(filename);
  return `uploads/${filename}`;
}

export class LocalUploadStore implements UploadStore {
  readonly kind = 'local' as const;

  constructor(private readonly root: string) {}

  private resolve(filename: string): string {
    assertSafeFilename(filename);
    return path.join(this.root, filename);
  }

  async put(filename: string, body: Buffer, _contentType: string): Promise<void> {
    const full = this.resolve(filename);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async delete(filename: string): Promise<void> {
    await rm(this.resolve(filename), { force: true });
  }

  async presignGet(_filename: string): Promise<string | null> {
    return null;
  }
}

/** S3-backed uploads with best-effort cleanup of a same-named legacy local file. */
export class ObjectUploadStore implements UploadStore {
  readonly kind = 's3' as const;

  constructor(
    private readonly objectStore: ArtifactStore,
    private readonly legacyLocalStore: LocalUploadStore,
  ) {}

  async put(filename: string, body: Buffer, contentType: string): Promise<void> {
    await this.objectStore.put(buildUploadKey(filename), body, contentType);
  }

  async delete(filename: string): Promise<void> {
    let objectError: unknown;
    try {
      await this.objectStore.delete(buildUploadKey(filename));
    } catch (err) {
      objectError = err;
    }
    // A deployment may have enabled S3 after this ref was written locally.
    // Clean both locations so replacement/deletion does not leave the legacy
    // file publicly reachable.
    await this.legacyLocalStore.delete(filename);
    if (objectError) throw objectError;
  }

  async presignGet(filename: string): Promise<string | null> {
    return this.objectStore.presignGet(buildUploadKey(filename));
  }
}

export function createUploadStore(config: AppConfig, uploadsDir: string): UploadStore {
  const local = new LocalUploadStore(uploadsDir);
  if (!config.artifactsBucket) return local;
  return new ObjectUploadStore(getArtifactStore(config), local);
}

/**
 * Fall through from the local `express.static` mount to object storage.
 * S3 objects are served with a short-lived signed redirect, keeping the bucket
 * private and avoiding buffering uploads as large as 100 MB in the Hub.
 */
export function createObjectUploadFallback(store: UploadStore): RequestHandler {
  return async (req, res, next) => {
    const filename = req.path.startsWith('/') ? req.path.slice(1) : req.path;
    if (!filename || filename.includes('/') || !SAFE_FILENAME_RE.test(filename)) {
      next();
      return;
    }
    try {
      const signedUrl = await store.presignGet(filename);
      if (!signedUrl) {
        next();
        return;
      }
      res.redirect(307, signedUrl);
    } catch (err) {
      console.error('[uploads] object-store read failed:', (err as Error).message);
      res.status(502).json({ error: 'Upload storage unavailable' });
    }
  };
}
