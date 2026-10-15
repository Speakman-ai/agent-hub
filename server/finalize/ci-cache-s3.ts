/**
 * S3 CacheStore for the ci.yaml `cache:` feature (see ci-cache.ts).
 *
 * Hub-side only, like worktree-bundle-s3.ts: the Hub presigns GET/PUT URLs and
 * the job container moves the bytes with curl, so the runner-agent bundle stays
 * free of the AWS SDK and the fleet never holds credentials. The Hub role needs
 * s3:GetObject + s3:PutObject on the bucket's objects and s3:ListBucket on the
 * bucket for the cache prefix (existence checks and restore-keys matching both
 * list).
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CacheStore } from './ci-cache.js';

/**
 * Upper bound on a restore-keys listing (1,000 keys per page). S3 lists keys by
 * name, not by age, so the newest match is only known once the listing is
 * complete. Hitting the bound is reported as a lookup failure, never answered
 * with the newest of a partial listing.
 */
export const MAX_LIST_PAGES = 50;

export class CacheListingTooLargeError extends Error {}

export interface S3CacheStoreOptions {
  bucket: string;
  region?: string;
  /** Presigned URL lifetime. The step uses it seconds after minting. */
  presignTtlSeconds?: number;
  /** Client for listing calls. Injectable for tests. */
  client?: S3Client;
  /** Static credentials for the presigning client (tests); default chain otherwise. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

export class S3CacheStore implements CacheStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttl: number;
  private readonly presignClient: S3Client;

  constructor(opts: S3CacheStoreOptions) {
    this.bucket = opts.bucket;
    this.ttl = opts.presignTtlSeconds ?? 3600;
    this.client = opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
    // Presigning gets its own client so its checksum mode is guaranteed. Since
    // SDK 3.729 the default (WHEN_SUPPORTED) signs a CRC32 of the body into a
    // presigned PutObject URL; with no body at presign time that is the empty
    // body's checksum, and S3 rejects the real archive curl uploads.
    // WHEN_REQUIRED leaves the checksum out, and the curl upload carries none.
    // Response validation is off for the same reason: curl, not the SDK,
    // consumes these URLs, so the GET needs no x-amz-checksum-mode.
    this.presignClient = new S3Client({
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Existence via a prefix listing rather than HeadObject. The Hub's
   * ListBucket grant is conditioned on `s3:prefix`, and HeadObject carries no
   * prefix, so a missing key would come back 403 and be indistinguishable from
   * a real authorization failure. A listing scoped to the exact key returns an
   * empty page for a miss and still throws on genuine access errors. Keys sort
   * lexicographically, so with MaxKeys=1 the exact key, if present, is first.
   */
  async exists(objectKey: string, signal?: AbortSignal): Promise<boolean> {
    const res = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: objectKey, MaxKeys: 1 }),
      signal ? { abortSignal: signal } : {},
    );
    return res.Contents?.[0]?.Key === objectKey;
  }

  async newestWithPrefix(objectKeyPrefix: string, signal?: AbortSignal): Promise<string | null> {
    let newest: { key: string; at: number } | null = null;
    let token: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: objectKeyPrefix,
          ContinuationToken: token,
        }),
        signal ? { abortSignal: signal } : {},
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const at = obj.LastModified?.getTime() ?? 0;
        if (!newest || at > newest.at) newest = { key: obj.Key, at };
      }
      if (!res.IsTruncated) return newest?.key ?? null;
      if (!res.NextContinuationToken) break;
      token = res.NextContinuationToken;
    }
    throw new CacheListingTooLargeError(
      `restore-keys prefix matches more than ${MAX_LIST_PAGES * 1000} cache entries, so the ` +
        'newest cannot be determined; use a more specific restore-keys prefix',
    );
  }

  presignGet(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: this.ttl },
    );
  }

  /**
   * Conditional PUT: `If-None-Match: *` is signed into the URL, so the upload
   * only succeeds when the key does not exist yet (S3 answers 412, or 409 for a
   * concurrent in-flight write). Cache entries are immutable once written.
   */
  presignPut(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, IfNoneMatch: '*' }),
      { expiresIn: this.ttl, signableHeaders: new Set(['if-none-match']) },
    );
  }
}

/** Cache store from `FINALIZE_CACHE_BUCKET`, or null when unset. */
export function resolveCacheStore(env: NodeJS.ProcessEnv = process.env): CacheStore | null {
  const bucket = env.FINALIZE_CACHE_BUCKET?.trim();
  if (!bucket) return null;
  return new S3CacheStore({
    bucket,
    region:
      env.FINALIZE_CACHE_BUCKET_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
  });
}
