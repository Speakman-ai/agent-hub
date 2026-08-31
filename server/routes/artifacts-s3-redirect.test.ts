import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { ArtifactRow, RouteDeps } from '../types.js';

// Fake S3-backed store: presignGet returns a redirect URL and records the
// response-header overrides it was asked to sign in.
const presignGet = vi.fn();
const getBuffer = vi.fn(async () => Buffer.from('%PDF-1.4 fake pdf bytes'));

vi.mock('../artifacts/artifact-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../artifacts/artifact-store.js')>();
  return {
    ...actual,
    getArtifactStoreForLocation: () => ({ kind: 's3', presignGet, getBuffer }),
  };
});

import createArtifactRoutes from './artifacts.js';

// An older S3-backed PDF stored with generic metadata.
const PDF_ROW: ArtifactRow = {
  id: 'art-1',
  session_id: 'sess-1',
  filename: 'report.pdf',
  content_type: 'application/octet-stream',
  size: 23,
  storage_kind: 's3',
  storage_key: 'sess-1/art-1',
  storage_bucket: 'blobs',
  storage_region: 'us-east-2',
  created_by: null,
  created_at: '2026-08-31 00:00:00',
} as ArtifactRow;

function buildApp(): express.Express {
  const stmts = {
    getArtifact: { get: (id: string) => (id === PDF_ROW.id ? PDF_ROW : undefined) },
    countArtifactsBySession: { get: () => ({ n: 1 }) },
  } as unknown as RouteDeps['stmts'];
  const deps = {
    stmts,
    broadcast: vi.fn(),
    config: {} as RouteDeps['config'],
  } as unknown as RouteDeps;
  const app = express();
  app.use(createArtifactRoutes(deps));
  return app;
}

beforeEach(() => {
  presignGet.mockReset();
  presignGet.mockResolvedValue('https://blobs.s3.amazonaws.com/sess-1/art-1?sig=1');
});

describe('GET artifact content — S3 redirect corrects a stale generic type', () => {
  it('signs the redirect with the reconciled application/pdf type (inline)', async () => {
    const res = await supertest(buildApp())
      .get('/api/sessions/sess-1/artifacts/art-1/content?redirect=1')
      .expect(302);

    expect(res.headers.location).toBe('https://blobs.s3.amazonaws.com/sess-1/art-1?sig=1');
    expect(presignGet).toHaveBeenCalledTimes(1);
    const [key, opts] = presignGet.mock.calls[0]!;
    expect(key).toBe('sess-1/art-1');
    // The redirect must carry the reconciled type, not the stored octet-stream.
    expect(opts.responseContentType).toBe('application/pdf');
    expect(opts.responseContentDisposition).toContain('inline');
    expect(opts.responseContentDisposition).toContain('report.pdf');
  });

  it('signs an attachment disposition when download=1', async () => {
    const res = await supertest(buildApp())
      .get('/api/sessions/sess-1/artifacts/art-1/content?redirect=1&download=1')
      .expect(302);

    expect(res.headers.location).toContain('sig=1');
    const [, opts] = presignGet.mock.calls[0]!;
    expect(opts.responseContentType).toBe('application/pdf');
    expect(opts.responseContentDisposition).toContain('attachment');
  });
});
