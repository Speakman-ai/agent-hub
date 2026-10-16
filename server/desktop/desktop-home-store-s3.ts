/**
 * S3 desktop home store (Hub side only; the runner agent never imports the
 * AWS SDK).
 *
 * Deletes remove data for good, on versioned buckets too. A plain
 * DeleteObject there only adds a delete marker and keeps every stored
 * version recoverable, which would leave a deleted profile's home (browser
 * logins included) behind. So deletes list every version and delete marker
 * (ListObjectVersions) and delete each by VersionId. On an unversioned
 * bucket the same calls see the single `null` version. A version that can't
 * be removed (Object Lock, MFA delete, missing permission) fails the delete,
 * so the caller keeps its record and can retry.
 *
 * The Hub role needs s3:PutObject, s3:GetObject, s3:ListBucket,
 * s3:ListBucketVersions, s3:DeleteObject and s3:DeleteObjectVersion.
 */
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import path from 'path';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { DesktopHomeStore } from './desktop-home-store.js';

export class S3DesktopHomeStore implements DesktopHomeStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: { bucket: string; region?: string; client?: S3Client }) {
    this.bucket = opts.bucket;
    this.client = opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
  }

  async put(key: string, filePath: string): Promise<void> {
    const { size } = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: 'application/gzip',
      }),
    );
  }

  async get(key: string, destPath: string): Promise<boolean> {
    let body: Readable;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return false;
      body = res.Body as Readable;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return false;
      throw err;
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(body, createWriteStream(destPath));
    return true;
  }

  async delete(key: string): Promise<void> {
    // Missing key: nothing listed, nothing to do, which is what `delete` promises.
    await this.purge(key, (k) => k === key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.purge(prefix, (k) => k.startsWith(prefix));
  }

  /** Delete every version and delete marker of the keys under `prefix` that `match`. */
  private async purge(prefix: string, match: (key: string) => boolean): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const objects = [...(list.Versions ?? []), ...(list.DeleteMarkers ?? [])]
        .filter((v): v is { Key: string; VersionId?: string } => !!v.Key && match(v.Key))
        .map((v) => ({ Key: v.Key, ...(v.VersionId ? { VersionId: v.VersionId } : {}) }));
      // DeleteObjects takes at most 1000 objects; a page lists at most 1000
      // versions plus delete markers, so chunk.
      for (let i = 0; i < objects.length; i += 1000) {
        const res = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects.slice(i, i + 1000), Quiet: true },
          }),
        );
        // DeleteObjects answers 200 even when some objects failed; Quiet mode
        // still lists the failures in Errors.
        const failed = res.Errors ?? [];
        if (failed.length) {
          const first = failed[0];
          throw new Error(
            `could not delete ${failed.length} desktop home object version(s) under ${prefix}: ` +
              `${first.Key ?? '?'}: ${first.Code ?? 'error'} ${first.Message ?? ''}`.trim(),
          );
        }
      }
      keyMarker = list.IsTruncated ? list.NextKeyMarker : undefined;
      versionIdMarker = list.IsTruncated ? list.NextVersionIdMarker : undefined;
    } while (keyMarker);
  }
}
