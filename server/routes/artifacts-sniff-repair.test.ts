import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { ArtifactRow, RouteDeps } from '../types.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const presignGet = vi.fn(async () => 'https://blobs.s3.amazonaws.com/x?sig=1');
const getBuffer = vi.fn(async (): Promise<Buffer> => PNG);

vi.mock('../artifacts/artifact-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../artifacts/artifact-store.js')>();
  return {
    ...actual,
    getArtifactStoreForLocation: () => ({ kind: 's3', presignGet, getBuffer }),
  };
});

import createArtifactRoutes from './artifacts.js';

// A QA screenshot stored before uploads sniffed their bytes.
const ROW = {
  id: 'art-1',
  session_id: 'sess-1',
  filename: 'case 1: page loaded.dat',
  content_type: 'application/octet-stream',
  size: PNG.length,
  storage_kind: 's3',
  storage_key: 'sess-1/art-1',
  storage_bucket: 'blobs',
  storage_region: 'us-east-2',
  created_by: null,
  created_at: '2026-10-26 00:00:00',
} as ArtifactRow;

function buildApp(update: ReturnType<typeof vi.fn>): express.Express {
  const stmts = {
    getArtifact: { get: (id: string) => (id === ROW.id ? ROW : undefined) },
    updateArtifactContentType: { run: update },
  } as unknown as RouteDeps['stmts'];
  const app = express();
  app.use(
    createArtifactRoutes({
      stmts,
      broadcast: vi.fn(),
      config: {},
    } as unknown as RouteDeps),
  );
  return app;
}

describe('GET artifact content: generic type recovered from the bytes', () => {
  it('serves a .dat PNG as image/png and repairs the stored type', async () => {
    const update = vi.fn();
    const res = await supertest(buildApp(update))
      .get('/api/sessions/sess-1/artifacts/art-1/content')
      .expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(update).toHaveBeenCalledWith('image/png', 'art-1');
  });

  it('streams instead of redirecting when the type must be sniffed', async () => {
    const update = vi.fn();
    const res = await supertest(buildApp(update))
      .get('/api/sessions/sess-1/artifacts/art-1/content?redirect=1')
      .expect(200);
    expect(presignGet).not.toHaveBeenCalled();
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('leaves unrecognised bytes as octet-stream without a repair', async () => {
    getBuffer.mockResolvedValueOnce(Buffer.from('\x00\x01\x02 opaque'));
    const update = vi.fn();
    const res = await supertest(buildApp(update))
      .get('/api/sessions/sess-1/artifacts/art-1/content')
      .expect(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(update).not.toHaveBeenCalled();
  });
});
