/**
 * artifact-store-s3.ts — S3-backed ArtifactStore. The only artifacts module
 * that imports the AWS SDK (hub-side; see artifact-store.ts header).
 *
 * The Hub's instance/task role needs s3:PutObject + s3:GetObject + s3:DeleteObject
 * on the bucket (GetObject so presigned download URLs it mints are valid).
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import type { ArtifactStore, PresignGetOptions } from './artifact-store.js';

export interface S3ArtifactStoreOptions {
  bucket: string;
  region?: string;
  /** Presigned GET URL lifetime. Default 15 min. */
  presignTtlSeconds?: number;
  /** Injectable for tests. */
  client?: S3Client;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class S3ArtifactStore implements ArtifactStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignTtlSeconds: number;

  constructor(opts: S3ArtifactStoreOptions) {
    this.bucket = opts.bucket;
    this.presignTtlSeconds = opts.presignTtlSeconds ?? 15 * 60;
    this.client = opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType || 'application/octet-stream',
      }),
    );
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 get ${key} returned no body`);
    return streamToBuffer(res.Body as Readable);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignGet(key: string, opts?: PresignGetOptions): Promise<string | null> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Override the stored (possibly stale/generic) metadata so the direct
        // download carries the reconciled type/disposition — otherwise an
        // older object stored as application/octet-stream would still serve as
        // that generic type via the redirect.
        ResponseContentType: opts?.responseContentType,
        ResponseContentDisposition: opts?.responseContentDisposition,
      }),
      { expiresIn: this.presignTtlSeconds },
    );
  }
}
