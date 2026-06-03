/**
 * worktree-bundle-s3.ts — S3-backed BundleStore for the cross-host runner fleet.
 *
 * IMPORTANT: This module imports the AWS SDK and is intended for the HUB side
 * only. The runner agent must NOT import it — the agent downloads the bundle via
 * the presigned `getUrl` carried on the WorktreeRef using a plain `fetch`, so its
 * esbuild bundle stays SDK-free and lean. Keep all `@aws-sdk/*` imports confined
 * here (and out of `worktree-bundle.ts`, which the agent does import).
 */
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import type { BundleStore } from './worktree-bundle.js';

export interface S3BundleStoreOptions {
  bucket: string;
  region?: string;
  /** Presigned GET URL lifetime handed to fleet agents. Default 1h. */
  presignTtlSeconds?: number;
  /** Injectable for tests. */
  client?: S3Client;
}

/**
 * Uploads bundles to S3 and presigns GET URLs so a credential-free fleet agent
 * can fetch them. The Hub's instance/task role needs s3:PutObject + s3:GetObject
 * on the bucket (GetObject so the presigned URL it mints is actually valid).
 */
export class S3BundleStore implements BundleStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignTtlSeconds: number;

  constructor(opts: S3BundleStoreOptions) {
    this.bucket = opts.bucket;
    this.presignTtlSeconds = opts.presignTtlSeconds ?? 3600;
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
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async get(key: string, destPath: string): Promise<void> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 get ${key} returned no body`);
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(res.Body as Readable, createWriteStream(destPath));
  }

  async presignGet(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.presignTtlSeconds,
    });
  }
}
