/**
 * Store bytes as a session artifact: object storage write, `artifacts` row,
 * and the `artifact_created` broadcast the Artifacts panel listens for.
 * Shared by the upload route and server-produced artifacts (browser demo
 * recordings).
 */
import { v4 as uuidv4 } from 'uuid';
import type { ArtifactRow, RouteDeps } from '../types.js';
import { getSessionOwner } from '../session-ownership.js';
import { reconcileContentType } from '../mime-extensions.js';
import { getArtifactStore, buildArtifactKey } from './artifact-store.js';

export interface ArtifactView {
  id: string;
  sessionId: string;
  filename: string;
  contentType: string;
  size: number;
  storageKind: string;
  createdBy: string | null;
  createdAt: string;
  url: string;
}

export function toArtifactView(row: ArtifactRow): ArtifactView {
  return {
    id: row.id,
    sessionId: row.session_id,
    filename: row.filename,
    // Report the reconciled type so the Artifacts panel's inline-view decision
    // matches what the content route actually serves, even for older rows
    // stored as a generic `application/octet-stream`.
    contentType: reconcileContentType(row.content_type, row.filename),
    size: row.size,
    storageKind: row.storage_kind,
    createdBy: row.created_by,
    createdAt: row.created_at,
    url: `/api/sessions/${row.session_id}/artifacts/${row.id}/content`,
  };
}

export type SaveSessionArtifactDeps = Pick<RouteDeps, 'stmts' | 'broadcast' | 'config'>;

export interface SaveSessionArtifactInput {
  sessionId: string;
  filename: string;
  contentType: string;
  body: Buffer;
  createdBy: string | null;
  presentation?: 'inline';
}

/** Throws when the storage write fails; the caller decides how to report it. */
export async function saveSessionArtifact(
  deps: SaveSessionArtifactDeps,
  input: SaveSessionArtifactInput,
): Promise<ArtifactView> {
  const { stmts, broadcast, config } = deps;
  const id = uuidv4();
  const store = getArtifactStore(config);
  const key = buildArtifactKey(input.sessionId, id);
  // Stamp the S3 location on the row so reads resolve the ORIGINAL bucket
  // even if `artifactsBucket` later changes (local rows leave these NULL).
  const storageBucket = store.kind === 's3' ? config.artifactsBucket : null;
  const storageRegion = store.kind === 's3' ? config.artifactsBucketRegion : null;
  await store.put(key, input.body, input.contentType);

  stmts.insertArtifact.run(
    id,
    input.sessionId,
    input.filename,
    input.contentType,
    input.body.length,
    store.kind,
    key,
    storageBucket,
    storageRegion,
    input.createdBy,
  );
  const view = toArtifactView(stmts.getArtifact.get(id) as ArtifactRow);
  const count = (stmts.countArtifactsBySession.get(input.sessionId) as { n: number } | undefined)
    ?.n;
  broadcast({
    type: 'artifact_created',
    sessionId: input.sessionId,
    ownerUserId: getSessionOwner(input.sessionId),
    artifact: view,
    presentation: input.presentation,
    count: count ?? 0,
  });
  return view;
}
