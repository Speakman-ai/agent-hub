import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  LocalArtifactStore,
  buildArtifactKey,
  getArtifactStore,
  getArtifactStoreForLocation,
  ArtifactStoreUnavailableError,
  resetArtifactStoreCache,
} from './artifact-store.js';
import type { AppConfig } from '../types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'artifact-store-test-'));
  resetArtifactStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetArtifactStoreCache();
});

describe('buildArtifactKey', () => {
  it('namespaces by session and sanitizes separators', () => {
    expect(buildArtifactKey('sess-1', 'art-1')).toBe('sess-1/art-1');
    expect(buildArtifactKey('a/b', 'c/d')).toBe('a_b/c_d');
  });

  it('replaces path-traversal slashes so a key cannot escape its namespace', () => {
    const key = buildArtifactKey('../../etc', 'passwd');
    expect(key).not.toContain('../');
    expect(key.startsWith('.._.._etc/')).toBe(true);
  });
});

describe('LocalArtifactStore', () => {
  it('round-trips bytes through put/getBuffer', async () => {
    const store = new LocalArtifactStore(root);
    const key = buildArtifactKey('sess-1', 'art-1');
    const body = Buffer.from('hello artifact');
    await store.put(key, body, 'text/plain');
    const back = await store.getBuffer(key);
    expect(back.toString()).toBe('hello artifact');
  });

  it('delete removes the object and is idempotent', async () => {
    const store = new LocalArtifactStore(root);
    const key = buildArtifactKey('sess-1', 'art-2');
    await store.put(key, Buffer.from('x'), 'text/plain');
    expect(existsSync(path.join(root, key))).toBe(true);
    await store.delete(key);
    expect(existsSync(path.join(root, key))).toBe(false);
    // second delete must not throw
    await store.delete(key);
  });

  it('local store cannot presign', async () => {
    const store = new LocalArtifactStore(root);
    expect(await store.presignGet('k')).toBeNull();
  });

  it('rejects a key that escapes the storage root', async () => {
    const store = new LocalArtifactStore(root);
    await expect(store.getBuffer('../escape')).rejects.toThrow(/escapes storage root/);
  });
});

describe('getArtifactStore', () => {
  const baseConfig = (overrides: Partial<AppConfig>): AppConfig =>
    ({
      dataDir: root,
      artifactsBucket: null,
      artifactsBucketRegion: null,
      ...overrides,
    }) as AppConfig;

  it('returns a LocalArtifactStore when no bucket is configured', () => {
    const store = getArtifactStore(baseConfig({}));
    expect(store.kind).toBe('local');
  });

  it('returns an S3ArtifactStore when a bucket is configured', () => {
    const store = getArtifactStore(baseConfig({ artifactsBucket: 'my-bucket' }));
    expect(store.kind).toBe('s3');
  });

  it('memoizes by config signature', () => {
    const cfg = baseConfig({});
    expect(getArtifactStore(cfg)).toBe(getArtifactStore(cfg));
  });
});

describe('getArtifactStoreForLocation', () => {
  const baseConfig = (overrides: Partial<AppConfig>): AppConfig =>
    ({
      dataDir: root,
      artifactsBucket: null,
      artifactsBucketRegion: null,
      ...overrides,
    }) as AppConfig;

  it('resolves a local row to a LocalArtifactStore regardless of current config', () => {
    // Even though config now points at S3, a local-backed row stays local.
    const store = getArtifactStoreForLocation(
      { storage_kind: 'local', storage_bucket: null, storage_region: null },
      baseConfig({ artifactsBucket: 'new-bucket' }),
    );
    expect(store.kind).toBe('local');
  });

  it('resolves an S3 row to its RECORDED bucket, not the current config bucket', () => {
    const store = getArtifactStoreForLocation(
      { storage_kind: 's3', storage_bucket: 'original-bucket', storage_region: 'us-east-1' },
      baseConfig({ artifactsBucket: 'different-current-bucket' }),
    );
    expect(store.kind).toBe('s3');
    // Distinct from the store the current config would hand out.
    expect(store).not.toBe(
      getArtifactStore(baseConfig({ artifactsBucket: 'different-current-bucket' })),
    );
  });

  it('falls back to the configured bucket for legacy S3 rows without a recorded bucket', () => {
    const store = getArtifactStoreForLocation(
      { storage_kind: 's3', storage_bucket: null, storage_region: null },
      baseConfig({ artifactsBucket: 'fallback-bucket' }),
    );
    expect(store.kind).toBe('s3');
  });

  it('throws ArtifactStoreUnavailableError for an S3 row with no resolvable bucket', () => {
    expect(() =>
      getArtifactStoreForLocation(
        { storage_kind: 's3', storage_bucket: null, storage_region: null },
        baseConfig({}),
      ),
    ).toThrow(ArtifactStoreUnavailableError);
  });

  it('throws ArtifactStoreUnavailableError for an unknown backend', () => {
    expect(() =>
      getArtifactStoreForLocation(
        { storage_kind: 'gcs', storage_bucket: null, storage_region: null },
        baseConfig({}),
      ),
    ).toThrow(ArtifactStoreUnavailableError);
  });
});
