import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppConfig, RouteDeps } from '../types.js';
import { resetArtifactStoreCache } from '../artifacts/artifact-store.js';
import { S3ArtifactStore } from '../artifacts/artifact-store-s3.js';
import createUploadRoutes from './uploads.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  resetArtifactStoreCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('upload routes', () => {
  it('writes uploaded screenshots to S3 when the deployment bucket is configured', async () => {
    const put = vi.spyOn(S3ArtifactStore.prototype, 'put').mockResolvedValue(undefined);
    const root = mkdtempSync(path.join(os.tmpdir(), 'uploads-route-'));
    roots.push(root);
    const config = {
      dataDir: root,
      artifactsBucket: 'durable-blobs',
      artifactsBucketRegion: 'us-east-2',
    } as AppConfig;
    const app = express();
    app.use(express.json());
    app.use(createUploadRoutes({ config, serverDir: root } as RouteDeps));

    const response = await supertest(app)
      .post('/api/upload')
      .send({ dataUrl: `data:image/png;base64,${PNG_B64}`, filename: 'screenshot.png' })
      .expect(200);

    expect(response.body.url).toMatch(/^\/uploads\/[a-f0-9-]+\.png$/);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]![0]).toBe(`uploads/${response.body.filename as string}`);
    expect(put.mock.calls[0]![2]).toBe('image/png');
  });
});
