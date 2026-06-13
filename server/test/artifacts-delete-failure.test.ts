import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// Mock the storage layer so we can force object-store delete failures without
// touching real S3 / disk. Everything else (the real ArtifactStoreUnavailableError
// class, buildArtifactKey) stays intact.
vi.mock('../artifacts/artifact-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../artifacts/artifact-store.js')>();
  return { ...actual, getArtifactStoreForLocation: vi.fn() };
});

import createArtifactRoutes from '../routes/artifacts.js';
import * as store from '../artifacts/artifact-store.js';
import type { RouteDeps } from '../types.js';

const getArtifactStoreForLocation = store.getArtifactStoreForLocation as Mock;

const ROW = {
  id: 'art-1',
  session_id: 'sess-1',
  filename: 'secret.pdf',
  content_type: 'application/pdf',
  size: 3,
  storage_kind: 'local',
  storage_key: 'sess-1/art-1',
  storage_bucket: null,
  storage_region: null,
  created_by: null,
  created_at: '2026-01-01 00:00:00',
};

let deleteArtifactRun: Mock;
let broadcast: Mock;

function buildApp() {
  deleteArtifactRun = vi.fn();
  broadcast = vi.fn();
  const deps = {
    stmts: {
      getSession: { get: vi.fn().mockReturnValue({ id: 'sess-1' }) },
      getArtifact: { get: vi.fn().mockReturnValue(ROW) },
      deleteArtifact: { run: deleteArtifactRun },
      countArtifactsBySession: { get: vi.fn().mockReturnValue({ n: 0 }) },
    },
    broadcast,
    config: { dataDir: '/tmp', artifactsBucket: null, artifactsBucketRegion: null },
  } as unknown as RouteDeps;
  const app = express();
  app.use(createArtifactRoutes(deps));
  return app;
}

beforeEach(() => {
  getArtifactStoreForLocation.mockReset();
});

describe('DELETE artifact — fail-closed on storage errors', () => {
  it('returns 502 and KEEPS the metadata row when object-store delete fails', async () => {
    getArtifactStoreForLocation.mockReturnValue({
      kind: 'local',
      delete: vi.fn().mockRejectedValue(new Error('S3 AccessDenied')),
    });
    const app = buildApp();
    const res = await supertest(app).delete('/api/sessions/sess-1/artifacts/art-1').expect(502);
    expect(res.body.error).toMatch(/retry/i);
    // Critical: the row must NOT be dropped (no orphaned bytes), and no
    // delete must be broadcast.
    expect(deleteArtifactRun).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('returns 503 and keeps the row when the backend cannot be resolved', async () => {
    getArtifactStoreForLocation.mockImplementation(() => {
      throw new store.ArtifactStoreUnavailableError('no bucket');
    });
    const app = buildApp();
    await supertest(app).delete('/api/sessions/sess-1/artifacts/art-1').expect(503);
    expect(deleteArtifactRun).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('drops the row and broadcasts the fresh count only after a successful delete', async () => {
    const storeDelete = vi.fn().mockResolvedValue(undefined);
    getArtifactStoreForLocation.mockReturnValue({ kind: 'local', delete: storeDelete });
    const app = buildApp();
    const res = await supertest(app).delete('/api/sessions/sess-1/artifacts/art-1').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(storeDelete).toHaveBeenCalledWith('sess-1/art-1');
    expect(deleteArtifactRun).toHaveBeenCalledWith('art-1');
    expect(broadcast).toHaveBeenCalledTimes(1);
    const event = broadcast.mock.calls[0][0];
    expect(event).toMatchObject({ type: 'artifact_deleted', artifactId: 'art-1', count: 0 });
  });
});
