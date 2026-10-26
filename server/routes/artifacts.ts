/**
 * Session artifacts — agent-generated documents (PDFs, scripts, reports, …).
 *
 * Agents upload via the agent-hub `artifacts.sh` script (POST), and both the
 * web/mobile Artifacts panel and the agent itself read them back (GET list /
 * GET content). Bytes live in object storage (S3 or a local dir; see
 * server/artifacts/artifact-store.ts); the `artifacts` table is the metadata
 * index. All routes are session-scoped and gated by `userOwnsSession` — the
 * `x-api-key` break-glass an agent uses counts as owner (see
 * session-ownership.ts).
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import type { RouteDeps, ArtifactRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession, getSessionOwner } from '../session-ownership.js';
import { validateUploadContent } from '../upload-validation.js';
import {
  ensureFilenameExtension,
  isGenericContentType,
  reconcileContentType,
  sniffContentType,
} from '../mime-extensions.js';
import {
  getArtifactStoreForLocation,
  ArtifactStoreUnavailableError,
} from '../artifacts/artifact-store.js';
import {
  saveSessionArtifact,
  toArtifactView,
  type ArtifactView,
} from '../artifacts/save-session-artifact.js';

const MAX_ARTIFACT_SIZE = 100 * 1024 * 1024; // 100 MB — matches /api/upload.

/**
 * "Active" content can execute script in the app origin when rendered inline
 * (HTML, SVG, XML, JS). Artifacts are agent-controlled, so the content route
 * never serves these inline — it forces an attachment + a neutral content type
 * + `nosniff`, and never hands out a presigned (inline-rendering) S3 URL for
 * them. Keep this in sync with the client allowlist in
 * `client/src/utils/artifactView.js` (`isInlineViewable`).
 */
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/vnd.ms-htmlhelp',
]);

function isActiveContentType(contentType: string | null | undefined): boolean {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!t) return false;
  if (ACTIVE_CONTENT_TYPES.has(t)) return true;
  // Any `*+xml` (e.g. application/rss+xml) can carry script when rendered.
  if (t.endsWith('+xml')) return true;
  return false;
}

/**
 * ASCII-only fallback token for the legacy `filename=` parameter. Strips quotes,
 * backslashes, control chars, AND any non-ASCII byte — passing a raw non-ASCII
 * filename (em-dash, emoji, accent) to res.setHeader throws ERR_INVALID_CHAR in
 * Node's HTTP layer / resets the HTTP/2 stream, so the download fails with
 * "Failed to fetch". Non-ASCII names are preserved via `filename*` (see below).
 */
function safeDispositionName(name: string): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim();
  return cleaned.length > 0 ? cleaned : 'artifact';
}

/**
 * Clients percent-encode the `X-Filename` upload header (via encodeURIComponent)
 * so Unicode filenames survive the header's Latin-1 charset limit — a raw
 * non-ASCII byte throws "Invalid character in header content" in the client's
 * HTTP stack. Decode tolerantly; fall back to the raw value for legacy callers
 * that sent an unencoded ASCII name (encodeURIComponent is a no-op on those).
 */
function decodeFilenameHeader(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** RFC 5987 (ext-value) percent-encoding for the `filename*` parameter. */
function encodeRFC5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build an RFC 6266 Content-Disposition value. Always emits an ASCII-safe
 * `filename="…"`; when the original name carries non-ASCII characters it also
 * emits `filename*=UTF-8''…` so modern clients recover the real name. This is
 * what keeps downloads of Unicode-named artifacts from resetting the stream.
 */
function contentDisposition(disposition: string, name: string): string {
  const cleaned = name.replace(/[\r\n"\\]/g, '_').trim();
  let value = `${disposition}; filename="${safeDispositionName(name)}"`;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(cleaned)) {
    value += `; filename*=UTF-8''${encodeRFC5987(cleaned.length > 0 ? cleaned : 'artifact')}`;
  }
  return value;
}

export default function createArtifactRoutes(deps: RouteDeps): Router {
  const { stmts, broadcast, config } = deps;
  const router = Router();

  /** Authoritative artifact count for a session — carried on broadcasts so
   *  clients reconcile their toolbar badge from server truth (never +/-1). */
  const artifactCount = (sessionId: string): number => {
    const row = stmts.countArtifactsBySession.get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  };

  // List
  router.get('/api/sessions/:sessionId/artifacts', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!stmts.getSession.get(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const rows = stmts.getArtifactsBySession.all(sessionId) as ArtifactRow[];
    res.json({ artifacts: rows.map(toArtifactView) });
  });

  // Upload
  router.post(
    '/api/sessions/:sessionId/artifacts',
    express.raw({ type: '*/*', limit: '100mb' }),
    async (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string;
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = stmts.getSession.get(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const buf = req.body as Buffer;
      if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: 'Empty file body' });
      }
      if (buf.length > MAX_ARTIFACT_SIZE) {
        return res
          .status(413)
          .json({ error: `File too large. Max size: ${MAX_ARTIFACT_SIZE / 1024 / 1024}MB` });
      }

      const headerType =
        (req.headers['content-type'] as string | undefined) || 'application/octet-stream';
      // A generic type tells us nothing, so read the bytes: a PNG uploaded from a
      // host without `file` must still be stored as an image with a `.png` name.
      const declaredType = isGenericContentType(headerType)
        ? (sniffContentType(buf) ?? headerType)
        : headerType;
      // Guarantee every stored artifact carries an extension (derived from the
      // content type when the caller's name lacks one) so downloads open in the
      // right app and the Artifacts panel shows a real file type. The 255-char
      // cap is applied inside the helper so it trims the basename, never the
      // extension it just guaranteed.
      const filename = ensureFilenameExtension(
        decodeFilenameHeader((req.headers['x-filename'] as string | undefined) || 'artifact'),
        declaredType,
        255,
      );
      // A generic `application/octet-stream` (uploaders without `file`, or a
      // browser upload that omits the type) would make a PDF download as an
      // opaque blob instead of rendering inline. Recover the real type from the
      // filename extension so PDFs (and other known types) are always stored
      // and served with the correct content type. An explicit non-generic type
      // is trusted as-is.
      const contentType = reconcileContentType(declaredType, filename);
      const createdBy = (req.headers['x-agent-id'] as string | undefined) || null;
      const presentation =
        req.headers['x-artifact-presentation'] === 'inline' ? ('inline' as const) : undefined;

      const rejectReason = validateUploadContent(contentType, buf);
      if (rejectReason) {
        return res.status(400).json({ error: rejectReason });
      }

      let view: ArtifactView;
      try {
        view = await saveSessionArtifact(deps, {
          sessionId,
          filename,
          contentType,
          body: buf,
          createdBy,
          presentation,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Artifact storage write failed:', message);
        return res.status(500).json({ error: 'Failed to store artifact' });
      }
      res.json(view);
    },
  );

  // Download / view content
  router.get(
    '/api/sessions/:sessionId/artifacts/:artifactId/content',
    async (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string;
      const artifactId = req.params.artifactId as string;
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const row = stmts.getArtifact.get(artifactId) as ArtifactRow | undefined;
      if (!row || row.session_id !== sessionId) {
        return res.status(404).json({ error: 'Artifact not found' });
      }

      let store;
      try {
        store = getArtifactStoreForLocation(row, config);
      } catch (err: unknown) {
        if (err instanceof ArtifactStoreUnavailableError) {
          return res.status(503).json({ error: err.message });
        }
        throw err;
      }

      // Reconcile a generic/missing stored type against the filename so an
      // artifact stored as `application/octet-stream` (e.g. a PDF uploaded
      // before the type was recovered at upload time) still serves with its
      // real content type and renders inline. An explicit type is kept as-is.
      // The active-content guard below runs on this reconciled type, so
      // deriving e.g. `text/html` from a `.html` name still forces a download.
      const effectiveType = reconcileContentType(row.content_type, row.filename);
      // Still generic (e.g. a screenshot stored as `shot.dat` before uploads
      // sniffed their bytes): the type can only come from the bytes, so skip
      // the presigned redirect and stream instead.
      const needsSniff = isGenericContentType(effectiveType);

      // Agent-controlled artifacts must never execute script in the app origin:
      // active content (HTML/SVG/XML/JS) is forced to download with a neutral
      // type, and `nosniff` stops the browser from re-interpreting bytes.
      const active = isActiveContentType(effectiveType);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const forceAttachment = active || req.query.download === '1';
      const disposition = forceAttachment ? 'attachment' : 'inline';
      const contentType = active ? 'application/octet-stream' : effectiveType;

      // S3 backend: hand the browser a presigned URL when asked, so large
      // downloads don't proxy through the Hub process. Skip for active content —
      // a direct-to-S3 URL renders inline with the stored type and can't carry
      // our nosniff / attachment guards. Override the object's stored metadata
      // with the reconciled type + disposition so a redirect corrects an older
      // object stored as a generic `application/octet-stream` (e.g. a PDF)
      // instead of serving it with that stale type.
      if (req.query.redirect === '1' && !active && !needsSniff) {
        try {
          const url = await store.presignGet(row.storage_key, {
            responseContentType: contentType,
            responseContentDisposition: contentDisposition(disposition, row.filename),
          });
          if (url) return res.redirect(302, url);
        } catch {
          // fall through to streaming below
        }
      }
      try {
        const buf = await store.getBuffer(row.storage_key);
        const sniffed = needsSniff ? sniffContentType(buf) : null;
        if (sniffed) {
          // Repair the row so listings (Artifacts panel, QA screenshots) see
          // the real type from now on.
          try {
            stmts.updateArtifactContentType?.run(sniffed, row.id);
          } catch (err: unknown) {
            console.warn('Artifact content-type repair failed:', err);
          }
        }
        res.setHeader('Content-Type', sniffed ?? contentType);
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('Content-Disposition', contentDisposition(disposition, row.filename));
        res.send(buf);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Artifact storage read failed:', message);
        res.status(500).json({ error: 'Failed to read artifact' });
      }
    },
  );

  // Delete
  router.delete(
    '/api/sessions/:sessionId/artifacts/:artifactId',
    async (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string;
      const artifactId = req.params.artifactId as string;
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const row = stmts.getArtifact.get(artifactId) as ArtifactRow | undefined;
      if (!row || row.session_id !== sessionId) {
        return res.status(404).json({ error: 'Artifact not found' });
      }

      // Resolve the row's ORIGINAL backend (not the current config) so we
      // delete the right object after a storage reconfiguration.
      let store;
      try {
        store = getArtifactStoreForLocation(row, config);
      } catch (err: unknown) {
        if (err instanceof ArtifactStoreUnavailableError) {
          return res.status(503).json({ error: err.message });
        }
        throw err;
      }

      // Delete the bytes FIRST and only drop the metadata row on success.
      // Dropping the row when object deletion fails would orphan the bytes in
      // storage with no record left to retry cleanup — for potentially
      // sensitive generated documents we fail the request instead so the user
      // (or a retry) can complete the delete. The row stays intact for retry.
      try {
        await store.delete(row.storage_key);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Artifact storage delete failed (keeping metadata for retry):', message);
        return res.status(502).json({
          error:
            'Failed to delete the artifact from storage; nothing was removed. Please retry — ' +
            'the artifact and its metadata are preserved.',
        });
      }
      stmts.deleteArtifact.run(artifactId);
      broadcast({
        type: 'artifact_deleted',
        sessionId,
        ownerUserId: getSessionOwner(sessionId),
        artifactId,
        count: artifactCount(sessionId),
      });
      res.json({ ok: true });
    },
  );

  return router;
}
