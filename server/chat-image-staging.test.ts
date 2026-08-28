import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ensureLocalUpload } from './chat-image-staging.js';
import { LocalUploadStore, ObjectUploadStore, type UploadStore } from './upload-store.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chat-image-staging-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ensureLocalUpload', () => {
  it('returns the existing local path without touching the store', async () => {
    const uploads = tempRoot();
    writeFileSync(path.join(uploads, 'capture.png'), 'local-bytes');
    const store: UploadStore = {
      kind: 'local',
      put: vi.fn(),
      getBytes: vi.fn(),
      delete: vi.fn(),
      presignGet: vi.fn(),
    };

    const resolved = await ensureLocalUpload(store, uploads, 'capture.png');

    expect(resolved).toBe(path.join(uploads, 'capture.png'));
    expect(store.getBytes).not.toHaveBeenCalled();
  });

  it('hydrates the local uploads dir from an S3-only upload (the remote-hub bug)', async () => {
    const uploads = path.join(tempRoot(), 'uploads'); // does not exist yet
    const store: UploadStore = {
      kind: 's3',
      put: vi.fn(),
      getBytes: vi.fn().mockResolvedValue(Buffer.from('s3-bytes')),
      delete: vi.fn(),
      presignGet: vi.fn(),
    };

    const resolved = await ensureLocalUpload(store, uploads, 'remote.png');

    expect(store.getBytes).toHaveBeenCalledWith('remote.png');
    expect(resolved).toBe(path.join(uploads, 'remote.png'));
    expect(readFileSync(resolved, 'utf8')).toBe('s3-bytes');
  });

  it('surfaces a store fetch failure instead of silently dropping the attachment', async () => {
    const uploads = tempRoot();
    const store: UploadStore = {
      kind: 's3',
      put: vi.fn(),
      getBytes: vi.fn().mockRejectedValue(new Error('S3 GetObject timed out')),
      delete: vi.fn(),
      presignGet: vi.fn(),
    };

    await expect(ensureLocalUpload(store, uploads, 'remote.png')).rejects.toThrow(
      /S3 GetObject timed out/,
    );
  });

  it('throws when the upload is missing from every backend', async () => {
    const uploads = tempRoot();
    const store: UploadStore = {
      kind: 's3',
      put: vi.fn(),
      getBytes: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      presignGet: vi.fn(),
    };

    await expect(ensureLocalUpload(store, uploads, 'gone.png')).rejects.toThrow(
      /not found in upload storage/,
    );
  });

  it('rejects unsafe filenames before any filesystem access', async () => {
    const uploads = tempRoot();
    const store: UploadStore = {
      kind: 's3',
      put: vi.fn(),
      getBytes: vi.fn(),
      delete: vi.fn(),
      presignGet: vi.fn(),
    };

    await expect(ensureLocalUpload(store, uploads, '../escape.png')).rejects.toThrow(
      /invalid upload filename/,
    );
    expect(store.getBytes).not.toHaveBeenCalled();
  });
});

describe('ObjectUploadStore.getBytes', () => {
  it('prefers a same-named legacy local file over the object store', async () => {
    const local = tempRoot();
    writeFileSync(path.join(local, 'legacy.png'), 'legacy-bytes');
    const objectStore = {
      kind: 's3' as const,
      put: vi.fn(),
      getBuffer: vi.fn(),
      delete: vi.fn(),
      presignGet: vi.fn(),
    };
    const store = new ObjectUploadStore(objectStore, new LocalUploadStore(local));

    const bytes = await store.getBytes('legacy.png');

    expect(bytes?.toString('utf8')).toBe('legacy-bytes');
    expect(objectStore.getBuffer).not.toHaveBeenCalled();
  });

  it('reads from the object store when no local copy exists', async () => {
    const objectStore = {
      kind: 's3' as const,
      put: vi.fn(),
      getBuffer: vi.fn().mockResolvedValue(Buffer.from('object-bytes')),
      delete: vi.fn(),
      presignGet: vi.fn(),
    };
    const store = new ObjectUploadStore(objectStore, new LocalUploadStore(tempRoot()));

    const bytes = await store.getBytes('capture.png');

    expect(bytes?.toString('utf8')).toBe('object-bytes');
    expect(objectStore.getBuffer).toHaveBeenCalledWith('uploads/capture.png');
  });
});
