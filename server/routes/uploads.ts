import { Router, Request, Response } from 'express';
import path from 'path';
import { writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import type { RouteDeps } from '../types.js';
import { validateUploadContent } from '../upload-validation.js';
import { resolveUploadsDir } from '../uploads-dir.js';

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100 MB

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
};

function pickSavedExtension(contentType: string, originalName: string): string {
  const t = contentType.split(';')[0].trim().toLowerCase();
  if (MIME_TO_EXT[t]) return MIME_TO_EXT[t];
  const ext = path.extname(path.basename(originalName)).replace(/^\./, '').toLowerCase();
  if (ext && /^[a-z0-9]{1,12}$/.test(ext)) return ext;
  if (t.startsWith('text/')) {
    const sub = t.slice(5);
    const safe = sub.replace(/\+xml$/i, '').replace(/[^a-z0-9]/g, '');
    if (safe.length >= 1 && safe.length <= 16) return safe;
    return 'txt';
  }
  return 'dat';
}

export default function createUploadRoutes(deps: RouteDeps): Router {
  const { serverDir, config } = deps;
  const router = Router();
  const UPLOADS_DIR = resolveUploadsDir(config, serverDir);

  router.post('/api/upload', (req: Request, res: Response) => {
    try {
      const { dataUrl, filename } = req.body as { dataUrl?: string; filename?: string };
      if (!dataUrl || !filename) {
        return res.status(400).json({ error: 'dataUrl and filename are required' });
      }

      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Invalid data URL format' });
      }

      const contentType = match[1];
      const base64Data = match[2];
      const buf = Buffer.from(base64Data, 'base64');

      const rejectReason = validateUploadContent(contentType, buf);
      if (rejectReason) {
        return res.status(400).json({ error: rejectReason });
      }

      const ext = pickSavedExtension(contentType, filename);
      const id = uuidv4();
      const savedFilename = `${id}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, savedFilename);

      writeFileSync(filePath, buf);

      res.json({
        id,
        filename: savedFilename,
        originalName: filename,
        contentType,
        url: `/uploads/${savedFilename}`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Upload error:', message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  router.post(
    '/api/upload/file',
    express.raw({ type: '*/*', limit: '100mb' }),
    (req: Request, res: Response) => {
      try {
        const originalName = (req.headers['x-filename'] as string | undefined) || 'upload';
        const contentType =
          (req.headers['content-type'] as string | undefined) || 'application/octet-stream';

        const buf = req.body as Buffer;
        if (!buf || buf.length === 0) {
          return res.status(400).json({ error: 'Empty file body' });
        }
        if (buf.length > MAX_UPLOAD_SIZE) {
          return res
            .status(413)
            .json({ error: `File too large. Max size: ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` });
        }

        const rejectReason = validateUploadContent(contentType, buf);
        if (rejectReason) {
          return res.status(400).json({ error: rejectReason });
        }

        const ext = pickSavedExtension(contentType, originalName);
        const id = uuidv4();
        const savedFilename = `${id}.${ext}`;
        const filePath = path.join(UPLOADS_DIR, savedFilename);

        writeFileSync(filePath, buf);

        res.json({
          id,
          filename: savedFilename,
          originalName,
          contentType,
          url: `/uploads/${savedFilename}`,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('File upload error:', message);
        res.status(500).json({ error: 'Upload failed' });
      }
    },
  );

  return router;
}
