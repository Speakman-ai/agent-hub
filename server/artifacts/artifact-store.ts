/**
 * artifact-store.ts — storage backend for session artifacts (agent-generated
 * documents: PDFs, scripts, reports, …).
 *
 * Two backends, selected by config (see `getArtifactStore`):
 *   - `S3ArtifactStore`  — used when `config.artifactsBucket` is set. The AWS
 *     SDK import is confined to the sibling `artifact-store-s3.ts` (hub-only;
 *     mirrors the `worktree-bundle-s3.ts` SDK-isolation note). This is a
 *     hub-side module, so the SDK import here is fine.
 *   - `LocalArtifactStore` — default. Writes bytes under
 *     `<dataDir>/artifacts/<key>` so dev / single-host installs work with zero
 *     AWS configuration.
 *
 * Bytes never round-trip through a worktree: the route reads the upload body
 * into a Buffer and hands it straight to `put`. Downloads stream back via
 * `getBuffer`. The DB (`artifacts` table) is the metadata index — the store
 * is content-addressed only by the opaque `key` we mint.
 */
import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import path from 'path';
import type { AppConfig } from '../types.js';
import { S3ArtifactStore } from './artifact-store-s3.js';

export type ArtifactStorageKind = 'local' | 's3';

export interface ArtifactStore {
  readonly kind: ArtifactStorageKind;
  /** Upload `body` under `key`, tagging it with `contentType`. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Read the full object back into memory. Throws if the key is missing. */
  getBuffer(key: string): Promise<Buffer>;
  /** Remove the object. Missing keys are a no-op (idempotent delete). */
  delete(key: string): Promise<void>;
  /**
   * Mint a short-lived URL a browser can GET directly (S3 only). Returns null
   * when the backend can't presign (local store) — callers then stream the
   * bytes through the Hub instead.
   */
  presignGet(key: string): Promise<string | null>;
}

/**
 * Build the storage key for an artifact. Server-controlled inputs only
 * (session id + generated artifact id), so the key can never traverse outside
 * the artifacts root. We still defensively reject separators.
 */
export function buildArtifactKey(sessionId: string, artifactId: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe(sessionId)}/${safe(artifactId)}`;
}

/** Local-filesystem store rooted at `<dataDir>/artifacts`. */
export class LocalArtifactStore implements ArtifactStore {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private resolve(key: string): string {
    // Keys are server-minted (see buildArtifactKey) but resolve + containment
    // check anyway so a malformed key can never escape the root.
    const full = path.resolve(this.root, key);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (full !== this.root && !full.startsWith(rootWithSep)) {
      throw new Error(`artifact key escapes storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async getBuffer(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async presignGet(_key: string): Promise<string | null> {
    return null;
  }
}

/**
 * Where an artifact's bytes physically live. Persisted per-row (storage_kind +
 * storage_bucket/region) so reads resolve the ORIGINAL backend even after the
 * Hub's current config changes (local→S3, bucket swap, rollback). Without this,
 * existing artifacts would become unreadable on any storage reconfiguration.
 */
export interface ArtifactLocation {
  storage_kind: string;
  storage_bucket?: string | null;
  storage_region?: string | null;
}

/**
 * Thrown when an artifact's recorded backend cannot be reconstructed (e.g. an
 * S3-backed row whose bucket is neither recorded on the row nor configured).
 * Routes map this to a 5xx with a migration hint rather than a generic 500.
 */
export class ArtifactStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactStoreUnavailableError';
  }
}

// Cache stores by a backend signature so we reuse S3 clients across requests.
const storeCache = new Map<string, ArtifactStore>();

function localStoreFor(dataDir: string): ArtifactStore {
  const sig = `local:${dataDir}`;
  let s = storeCache.get(sig);
  if (!s) {
    s = new LocalArtifactStore(path.join(dataDir, 'artifacts'));
    storeCache.set(sig, s);
  }
  return s;
}

function s3StoreFor(bucket: string, region: string | null | undefined): ArtifactStore {
  const sig = `s3:${bucket}:${region ?? ''}`;
  let s = storeCache.get(sig);
  if (!s) {
    s = new S3ArtifactStore({ bucket, region: region ?? undefined });
    storeCache.set(sig, s);
  }
  return s;
}

/**
 * The store to write NEW uploads to, per the Hub's current config: S3 when
 * `artifactsBucket` is set, else the local dir. Callers persist the resulting
 * `kind` plus the bucket/region so reads can later resolve the same backend.
 */
export function getArtifactStore(config: AppConfig): ArtifactStore {
  return config.artifactsBucket
    ? s3StoreFor(config.artifactsBucket, config.artifactsBucketRegion)
    : localStoreFor(config.dataDir);
}

/**
 * The store an EXISTING artifact lives in, resolved from its recorded backend
 * rather than the current config. For S3 rows we prefer the bucket/region
 * stamped on the row at upload time, falling back to the current config only
 * for legacy rows written before those columns existed. A row that claims S3
 * but has no resolvable bucket throws `ArtifactStoreUnavailableError`.
 */
export function getArtifactStoreForLocation(
  loc: ArtifactLocation,
  config: AppConfig,
): ArtifactStore {
  if (loc.storage_kind === 'local') {
    return localStoreFor(config.dataDir);
  }
  if (loc.storage_kind === 's3') {
    const bucket = loc.storage_bucket || config.artifactsBucket;
    if (!bucket) {
      throw new ArtifactStoreUnavailableError(
        'Artifact is stored in S3 but no bucket is recorded on the row or configured ' +
          '(artifactsBucket). Set the original bucket via AGENT_HUB_ARTIFACTS_BUCKET / ' +
          'config.json `artifactsBucket` to read legacy rows, or re-upload the artifact.',
      );
    }
    return s3StoreFor(bucket, loc.storage_region ?? config.artifactsBucketRegion);
  }
  throw new ArtifactStoreUnavailableError(`Unknown artifact storage backend: ${loc.storage_kind}`);
}

/** Test-only: drop memoized stores so a new config takes effect. */
export function resetArtifactStoreCache(): void {
  storeCache.clear();
}
