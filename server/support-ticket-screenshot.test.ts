import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { mkdtempSync } from 'fs';
import {
  parseScreenshotDataUrl,
  persistSupportTicketScreenshot,
  persistSupportTicketScreenshotBuffer,
  deleteSupportTicketScreenshot,
  sniffImageMime,
  validateScreenshotBuffer,
  MAX_SCREENSHOT_BYTES,
} from './support-ticket-screenshot.js';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

// Minimal byte sequences carrying each allowed format's magic signature.
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_SIG = Buffer.from('GIF89a', 'latin1');
const WEBP_SIG = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
]);
const dataUrl = (mime: string, buf: Buffer): string =>
  `data:${mime};base64,${buf.toString('base64')}`;

describe('parseScreenshotDataUrl', () => {
  it('parses a valid PNG data URL into mime/ext/buffer', () => {
    const out = parseScreenshotDataUrl(PNG_DATA_URL);
    expect(out.mime).toBe('image/png');
    expect(out.ext).toBe('png');
    expect(out.buffer.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect(out.buffer.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('maps jpeg/webp/gif to the right extensions (with matching magic bytes)', () => {
    expect(parseScreenshotDataUrl(dataUrl('image/jpeg', JPEG_SIG)).ext).toBe('jpg');
    expect(parseScreenshotDataUrl(dataUrl('image/webp', WEBP_SIG)).ext).toBe('webp');
    expect(parseScreenshotDataUrl(dataUrl('image/gif', GIF_SIG)).ext).toBe('gif');
  });

  it('rejects a non-data-URL string', () => {
    expect(() => parseScreenshotDataUrl('not a data url')).toThrow(/base64 data URL/);
  });

  it('rejects an empty value', () => {
    expect(() => parseScreenshotDataUrl('')).toThrow(/non-empty/);
  });

  it('rejects a disallowed mime type (e.g. svg / pdf)', () => {
    expect(() => parseScreenshotDataUrl(`data:image/svg+xml;base64,${PNG_B64}`)).toThrow(
      /mime must be one of/,
    );
    expect(() => parseScreenshotDataUrl(`data:application/pdf;base64,${PNG_B64}`)).toThrow(
      /mime must be one of/,
    );
  });

  it('rejects an oversize payload', () => {
    // Build a data URL whose decoded size exceeds the cap.
    const bigBuf = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1024, 0x41);
    const url = `data:image/png;base64,${bigBuf.toString('base64')}`;
    expect(() => parseScreenshotDataUrl(url)).toThrow(/exceeds/);
  });

  it('rejects malformed base64 with out-of-alphabet characters', () => {
    // `Buffer.from` would silently drop the `!`s and decode this to bytes; the
    // strict decoder must reject it instead of persisting a bogus image.
    expect(() => parseScreenshotDataUrl('data:image/png;base64,abcd!!!!')).toThrow(/invalid/);
  });

  it('rejects base64 with a length that is not a multiple of 4', () => {
    expect(() => parseScreenshotDataUrl('data:image/png;base64,abcde')).toThrow(/invalid/);
  });

  it('rejects misplaced padding', () => {
    expect(() => parseScreenshotDataUrl('data:image/png;base64,ab=c')).toThrow(/invalid/);
  });

  it('rejects non-canonical base64 (nonzero unused bits in a padded final quantum)', () => {
    // 'YR==' decodes to the single byte 'a' (0x61) but its final quantum carries
    // 4 nonzero low-order bits a canonical encoder never emits — re-encoding 'a'
    // yields 'YQ=='. The regex accepts it; the round-trip check rejects it.
    const nonCanonical = 'YR==';
    const reencoded = Buffer.from(nonCanonical, 'base64').toString('base64');
    expect(reencoded).not.toBe(nonCanonical); // guard: confirm it is non-canonical
    expect(() => parseScreenshotDataUrl(`data:image/png;base64,${nonCanonical}`)).toThrow(
      /not canonical/,
    );
  });

  it('rejects valid base64 whose bytes are not a recognized image', () => {
    // 'YQ==' is canonical base64 for the single byte 'a' — valid base64, but not
    // an image. The magic-byte check must reject it so the endpoint can't be
    // used to persist arbitrary blobs under /uploads.
    expect(() => parseScreenshotDataUrl('data:image/png;base64,YQ==')).toThrow(
      /not a recognized image/,
    );
  });

  it('rejects a payload whose bytes do not match the declared mime', () => {
    // Real PNG bytes, but the data URL claims JPEG.
    expect(() =>
      parseScreenshotDataUrl(dataUrl('image/jpeg', Buffer.from(PNG_B64, 'base64'))),
    ).toThrow(/bytes are image\/png but the data URL declared image\/jpeg/);
  });
});

describe('sniffImageMime', () => {
  it('detects each allowed format from its magic bytes', () => {
    expect(sniffImageMime(Buffer.from(PNG_B64, 'base64'))).toBe('image/png');
    expect(sniffImageMime(JPEG_SIG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF_SIG)).toBe('image/gif');
    expect(sniffImageMime(WEBP_SIG)).toBe('image/webp');
  });

  it('returns null for non-image bytes and truncated signatures', () => {
    expect(sniffImageMime(Buffer.from('a'))).toBeNull();
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated JPEG
    expect(sniffImageMime(Buffer.from('RIFF', 'latin1'))).toBeNull(); // RIFF without WEBP
  });
});

describe('validateScreenshotBuffer', () => {
  it('accepts recognized image bytes and returns mime/ext (ignoring declared type)', () => {
    expect(validateScreenshotBuffer(Buffer.from(PNG_B64, 'base64'))).toEqual({
      mime: 'image/png',
      ext: 'png',
    });
    expect(validateScreenshotBuffer(JPEG_SIG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(validateScreenshotBuffer(GIF_SIG)).toEqual({ mime: 'image/gif', ext: 'gif' });
    expect(validateScreenshotBuffer(WEBP_SIG)).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('rejects empty bytes', () => {
    expect(() => validateScreenshotBuffer(Buffer.alloc(0))).toThrow(/empty/);
  });

  it('rejects non-image bytes', () => {
    expect(() => validateScreenshotBuffer(Buffer.from('not an image', 'utf8'))).toThrow(
      /not a recognized image/,
    );
  });

  it('rejects an oversize buffer', () => {
    // PNG magic + filler past the cap so it sniffs as an image but trips the size guard.
    const big = Buffer.concat([
      Buffer.from(PNG_B64, 'base64'),
      Buffer.alloc(MAX_SCREENSHOT_BYTES, 0x41),
    ]);
    expect(() => validateScreenshotBuffer(big)).toThrow(/exceeds/);
  });
});

describe('persistSupportTicketScreenshotBuffer', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('writes raw image bytes under /uploads and returns a server-relative ref', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-buf-'));
    tmpDirs.push(serverDir);

    const png = Buffer.from(PNG_B64, 'base64');
    const ref = await persistSupportTicketScreenshotBuffer(serverDir, png);
    expect(ref).toMatch(/^\/uploads\/support-screenshot-[\w-]+\.png$/);

    const onDisk = await readFile(path.join(serverDir, ref.replace(/^\//, '')));
    expect(onDisk.equals(png)).toBe(true);
  });

  it('rejects a non-image buffer without writing a file', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-buf-'));
    tmpDirs.push(serverDir);
    await expect(
      persistSupportTicketScreenshotBuffer(serverDir, Buffer.from('nope', 'utf8')),
    ).rejects.toThrow(/not a recognized image/);
  });
});

describe('persistSupportTicketScreenshot', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('writes the decoded bytes under /uploads and returns a server-relative ref', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-'));
    tmpDirs.push(serverDir);

    const ref = await persistSupportTicketScreenshot(serverDir, PNG_DATA_URL);
    expect(ref).toMatch(/^\/uploads\/support-screenshot-[\w-]+\.png$/);

    const onDisk = await readFile(path.join(serverDir, ref.replace(/^\//, '')));
    expect(onDisk.equals(parseScreenshotDataUrl(PNG_DATA_URL).buffer)).toBe(true);
  });

  it('propagates a validation error without writing a file', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-'));
    tmpDirs.push(serverDir);
    await expect(persistSupportTicketScreenshot(serverDir, 'garbage')).rejects.toThrow();
  });
});

describe('deleteSupportTicketScreenshot', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function seedFile(serverDir: string, filename: string): Promise<string> {
    const uploads = path.join(serverDir, 'uploads');
    await mkdir(uploads, { recursive: true });
    await writeFile(path.join(uploads, filename), Buffer.from([1, 2, 3]));
    return path.join(uploads, filename);
  }

  it('removes a previously-persisted screenshot file by its ref', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-'));
    tmpDirs.push(serverDir);
    const filePath = await seedFile(serverDir, 'support-screenshot-xyz.png');
    expect(existsSync(filePath)).toBe(true);

    await deleteSupportTicketScreenshot(serverDir, '/uploads/support-screenshot-xyz.png');
    expect(existsSync(filePath)).toBe(false);
  });

  it('no-ops on a null/empty ref', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-'));
    tmpDirs.push(serverDir);
    await expect(deleteSupportTicketScreenshot(serverDir, null)).resolves.toBeUndefined();
    await expect(deleteSupportTicketScreenshot(serverDir, '')).resolves.toBeUndefined();
  });

  it('refuses to touch refs outside the support-screenshot naming (no traversal)', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-'));
    tmpDirs.push(serverDir);
    // A replay upload and a traversal attempt must both be ignored.
    const replay = await seedFile(serverDir, 'replay-abc.json');
    await deleteSupportTicketScreenshot(serverDir, '/uploads/replay-abc.json');
    await deleteSupportTicketScreenshot(serverDir, '/uploads/../secret.txt');
    await deleteSupportTicketScreenshot(serverDir, '/uploads/support-screenshot-../escape.png');
    expect(existsSync(replay)).toBe(true);
  });

  it('never throws on a missing file', async () => {
    const serverDir = mkdtempSync(path.join(os.tmpdir(), 'support-shot-'));
    tmpDirs.push(serverDir);
    await expect(
      deleteSupportTicketScreenshot(serverDir, '/uploads/support-screenshot-gone.png'),
    ).resolves.toBeUndefined();
  });
});
