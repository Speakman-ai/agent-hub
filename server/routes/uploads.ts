import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import type { RouteDeps } from '../types.js';
import { validateUploadContent } from '../upload-validation.js';
import { resolveUploadsDir } from '../uploads-dir.js';
import { extensionForContentType as pickSavedExtension } from '../mime-extensions.js';
import { createUploadStore } from '../upload-store.js';
import { UploadFileHeadersSchema, UploadRequestSchema } from './uploads.openapi.js';

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100 MB

export default function createUploadRoutes(deps: RouteDeps): Router {
  const { serverDir, config } = deps;
  const router = Router();
  const UPLOADS_DIR = resolveUploadsDir(config, serverDir);
  const uploadStore = createUploadStore(config, UPLOADS_DIR);

  router.post('/api/upload', async (req: Request, res: Response) => {
    try {
      const parsedBody = UploadRequestSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return res.status(400).json({ error: 'dataUrl and filename are required' });
      }
      const { dataUrl, filename } = parsedBody.data;

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

      await uploadStore.put(savedFilename, buf, contentType);

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
    async (req: Request, res: Response) => {
      try {
        const parsedHeaders = UploadFileHeadersSchema.safeParse(req.headers);
        if (!parsedHeaders.success) {
          return res.status(400).json({ error: 'Invalid upload headers' });
        }
        const originalName = parsedHeaders.data['x-filename'] || 'upload';
        const contentType = parsedHeaders.data['content-type'] || 'application/octet-stream';

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

        await uploadStore.put(savedFilename, buf, contentType);

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
