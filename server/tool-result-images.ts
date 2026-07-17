/**
 * Offload inline base64 images on a `tool_result` event to the uploads store.
 *
 * When the CLI returns an image (e.g. Claude reading a PNG/JPEG file), the
 * stream parser lifts the base64 bytes onto `event.images[].dataBase64`. Those
 * blobs are 300KB–1MB each — far past the `session_events` payload cap — so if
 * we persisted them inline the row would be replaced by an unrenderable
 * truncation envelope and the image would be lost. Instead we write the bytes
 * to a file under `uploadsDir` (served at `/uploads/...`) and rewrite the ref
 * to a lightweight `url`, keeping the persisted + broadcast event small while
 * letting the client render the image inline.
 */
import path from 'path';
import { writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { ToolResultEvent, ToolResultImageRef } from './types.js';
import { validateUploadContent } from './upload-validation.js';

const MEDIA_TYPE_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function extForMediaType(mediaType: string): string {
  return MEDIA_TYPE_TO_EXT[mediaType.split(';')[0].trim().toLowerCase()] ?? 'png';
}

/**
 * Rewrite each inline base64 image on a tool_result event to a served
 * `/uploads/...` URL. Returns the original event unchanged when there are no
 * inline images (the common case — zero extra allocation / IO).
 *
 * Failure modes are non-fatal: an image whose bytes fail content validation or
 * whose write throws is emitted with neither `dataBase64` nor `url`, so a
 * broken image never re-inflates the payload past the truncation cap.
 */
export function offloadToolResultImages(
  event: ToolResultEvent,
  uploadsDir: string,
): ToolResultEvent {
  if (!event.images || event.images.length === 0) return event;

  const images: ToolResultImageRef[] = event.images.map((img) => {
    // Already a URL (URL-source image) or nothing to offload.
    if (!img.dataBase64) return { mediaType: img.mediaType, url: img.url };
    try {
      const buf = Buffer.from(img.dataBase64, 'base64');
      if (buf.length === 0 || validateUploadContent(img.mediaType, buf)) {
        return { mediaType: img.mediaType };
      }
      const filename = `tool-image-${uuidv4()}.${extForMediaType(img.mediaType)}`;
      writeFileSync(path.join(uploadsDir, filename), buf);
      return { mediaType: img.mediaType, url: `/uploads/${filename}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[tool-result-images] failed to offload image:', message);
      return { mediaType: img.mediaType };
    }
  });

  return { ...event, images };
}
