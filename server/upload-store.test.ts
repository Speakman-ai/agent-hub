import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { existsSync, mkdtempSync } from 'fs';
import { readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppConfig } from './types.js';
import { resetArtifactStoreCache } from './artifacts/artifact-store.js';
import { S3ArtifactStore } from './artifacts/artifact-store-s3.js';
import {
  buildUploadKey,
  createObjectUploadFallback,
  createUploadStore,
  LocalUploadStore,
  ObjectUploadStore,
} from './upload-store.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'upload-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetArtifactStoreCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalUploadStore', () => {
  it('preserves the existing local upload behavior when no bucket is configured', async () => {
    const root = tempRoot();
    const store = new LocalUploadStore(root);
    await store.put('capture.png', Buffer.from('png-bytes'), 'image/png');

    expect(await readFile(path.join(root, 'capture.png'), 'utf8')).toBe('png-bytes');
    expect(await store.presignGet('capture.png')).toBeNull();

    await store.delete('capture.png');
    expect(existsSync(path.join(root, 'capture.png'))).toBe(false);
  });

  it('rejects traversal and nested object keys', async () => {
    const store = new LocalUploadStore(tempRoot());
    await expect(store.put('../escape.png', Buffer.from('x'), 'image/png')).rejects.toThrow(
      /invalid upload filename/,
    );
    expect(() => buildUploadKey('nested/escape.png')).toThrow(/invalid upload filename/);
  });
});

describe('S3-backed uploads', () => {
  it('selects S3 when the deployment artifact bucket is configured', async () => {
    const put = vi.spyOn(S3ArtifactStore.prototype, 'put').mockResolvedValue(undefined);
    const root = tempRoot();
    const config = {
      dataDir: root,
      artifactsBucket: 'durable-blobs',
      artifactsBucketRegion: 'us-east-2',
    } as AppConfig;

    const store = createUploadStore(config, path.join(root, 'uploads'));
    await store.put('support-screenshot-id.png', Buffer.from('image'), 'image/png');

    expect(store.kind).toBe('s3');
    expect(put).toHaveBeenCalledWith(
      'uploads/support-screenshot-id.png',
      Buffer.from('image'),
      'image/png',
    );
    expect(existsSync(path.join(root, 'uploads', 'support-screenshot-id.png'))).toBe(false);
  });

  it('serves an object-backed /uploads ref through a signed redirect after local miss', async () => {
    const objectStore = {
      kind: 's3' as const,
      put: vi.fn().mockResolvedValue(undefined),
      getBuffer: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      presignGet: vi.fn().mockResolvedValue('https://storage.test/signed-object'),
    };
    const store = new ObjectUploadStore(objectStore, new LocalUploadStore(tempRoot()));
    const app = express();
    app.use('/uploads', createObjectUploadFallback(store));

    const response = await supertest(app).get('/uploads/support-screenshot-id.png').expect(307);

    expect(response.headers.location).toBe('https://storage.test/signed-object');
    expect(objectStore.presignGet).toHaveBeenCalledWith('uploads/support-screenshot-id.png');
  });

  it('deletes both the object and a same-named legacy local upload', async () => {
    const root = tempRoot();
    const local = new LocalUploadStore(root);
    await writeFile(path.join(root, 'support-screenshot-old.png'), 'legacy');
    const objectStore = {
      kind: 's3' as const,
      put: vi.fn().mockResolvedValue(undefined),
      getBuffer: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      presignGet: vi.fn().mockResolvedValue(null),
    };
    const store = new ObjectUploadStore(objectStore, local);

    await store.delete('support-screenshot-old.png');

    expect(objectStore.delete).toHaveBeenCalledWith('uploads/support-screenshot-old.png');
    expect(existsSync(path.join(root, 'support-screenshot-old.png'))).toBe(false);
  });
});
