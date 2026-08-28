/**
 * chat-image-staging.ts — resolve a chat attachment to a readable host path.
 *
 * Attachments are uploaded through `/api/upload` and stored by the configured
 * `UploadStore`: the local uploads dir on single-host installs, or S3 (an
 * `uploads/` prefix in the artifacts bucket) whenever `artifactsBucket` is set.
 * The chat turn stages each attachment into the session worktree's
 * `.agent-hub-images` dir so the CLI can Read it. On S3-backed deployments the
 * bytes never touch the local uploads dir, so staging must hydrate them from
 * the store instead of assuming a local file — otherwise every chat image is
 * silently dropped and the model only sees the `(image attached)` caption.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { assertSafeFilename, type UploadStore } from './upload-store.js';

/**
 * Return a readable host path for `filename`, hydrating the local uploads dir
 * from the durable store when only a remote (S3) copy exists.
 *
 * Throws when the upload cannot be found in any backend, or when the store read
 * fails, so callers surface a staging error instead of silently dropping the
 * attachment.
 */
export async function ensureLocalUpload(
  store: UploadStore,
  uploadsDir: string,
  filename: string,
): Promise<string> {
  assertSafeFilename(filename);
  const localPath = path.join(uploadsDir, filename);
  if (existsSync(localPath)) return localPath;

  const bytes = await store.getBytes(filename);
  if (!bytes) {
    throw new Error(`attachment not found in upload storage: ${filename}`);
  }
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(localPath, bytes);
  return localPath;
}
