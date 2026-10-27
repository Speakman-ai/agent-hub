import compression from 'compression';
import type { Request, RequestHandler, Response } from 'express';

// Only JSON bodies are compressed. Streaming responses (SSE, NDJSON, file and
// artifact downloads, proxied previews) keep their exact bytes and flush timing:
// compressing an event stream buffers it until the gzip window fills.
export function isCompressibleJsonResponse(res: Response): boolean {
  const type = res.getHeader('Content-Type');
  if (typeof type !== 'string') return false;
  const mime = type.split(';')[0].trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json');
}

export function createJsonCompression(): RequestHandler {
  return compression({
    // 1 is several times faster than the default 6 and still shrinks board
    // JSON about 4x; on a 12 MB payload the CPU cost of higher levels outweighs
    // the extra bytes saved.
    level: 1,
    threshold: 8 * 1024,
    filter: (req: Request, res: Response) =>
      isCompressibleJsonResponse(res) && compression.filter(req, res),
  });
}
