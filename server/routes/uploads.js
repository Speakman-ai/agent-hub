import { Router } from 'express';
import path from 'path';
import { writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';

const ALLOWED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100 MB

export default function createUploadRoutes(deps) {
  const { serverDir } = deps;
  const router = Router();
  const UPLOADS_DIR = path.join(serverDir, 'uploads');

  // Legacy data-URL upload (images)
  router.post('/api/upload', (req, res) => {
    try {
      const { dataUrl, filename } = req.body;
      if (!dataUrl || !filename) {
        return res.status(400).json({ error: 'dataUrl and filename are required' });
      }

      // Parse the data URL: data:image/png;base64,iVBOR...
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Invalid data URL format' });
      }

      const contentType = match[1];
      const base64Data = match[2];
      const ext =
        contentType.split('/')[1]?.replace('jpeg', 'jpg')?.replace('quicktime', 'mov') || 'bin';
      const id = uuidv4();
      const savedFilename = `${id}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, savedFilename);

      writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

      res.json({
        id,
        filename: savedFilename,
        originalName: filename,
        contentType,
        url: `/uploads/${savedFilename}`,
      });
    } catch (err) {
      console.error('Upload error:', err.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // Multipart file upload (images + videos) — avoids base64 overhead for large files
  router.post('/api/upload/file', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
    try {
      const originalName = req.headers['x-filename'] || 'upload';
      const contentType = req.headers['content-type'] || 'application/octet-stream';

      if (!ALLOWED_MEDIA_TYPES.has(contentType)) {
        return res
          .status(400)
          .json({ error: `Unsupported file type: ${contentType}. Allowed: images and videos.` });
      }

      const buf = req.body;
      if (!buf || buf.length === 0) {
        return res.status(400).json({ error: 'Empty file body' });
      }
      if (buf.length > MAX_UPLOAD_SIZE) {
        return res
          .status(413)
          .json({ error: `File too large. Max size: ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` });
      }

      const extMap = {
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
      };
      const ext = extMap[contentType] || originalName.split('.').pop() || 'bin';
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
    } catch (err) {
      console.error('File upload error:', err.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  return router;
}
