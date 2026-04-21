import { describe, it, expect } from 'vitest';
import {
  bufferLooksLikeExecutableBinary,
  mimeLooksExecutable,
  validateUploadContent,
} from './upload-validation.js';

describe('upload-validation', () => {
  it('rejects ELF magic', () => {
    const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
    expect(bufferLooksLikeExecutableBinary(buf)).toBe(true);
    expect(validateUploadContent('application/octet-stream', buf)).toMatch(/executable/i);
  });

  it('rejects PE (MZ + PE signature)', () => {
    const buf = Buffer.alloc(0x80);
    buf[0] = 0x4d;
    buf[1] = 0x5a;
    buf.writeUInt32LE(0x40, 0x3c);
    buf.write('PE\0\0', 0x40);
    expect(bufferLooksLikeExecutableBinary(buf)).toBe(true);
  });

  it('allows PDF', () => {
    const buf = Buffer.from('%PDF-1.4\n');
    expect(bufferLooksLikeExecutableBinary(buf)).toBe(false);
    expect(validateUploadContent('application/pdf', buf)).toBeNull();
  });

  it('allows UTF-8 text', () => {
    const buf = Buffer.from('hello 世界\n', 'utf8');
    expect(bufferLooksLikeExecutableBinary(buf)).toBe(false);
    expect(validateUploadContent('text/plain', buf)).toBeNull();
  });

  it('rejects executable MIME hints', () => {
    const buf = Buffer.from('not really binary');
    expect(mimeLooksExecutable('application/x-executable')).toBe(true);
    expect(validateUploadContent('application/x-executable', buf)).toMatch(/MIME/i);
  });

  it('allows common video MIME types used by the chat attachment flow', () => {
    // ftyp atom at byte 4 is the hallmark of an ISO-BMFF container (mp4, mov,
    // m4v, etc). We fake a tiny prefix; the validator only sniffs magic bytes
    // for executables, so this should pass for all video MIME types we accept.
    const ftypPrefix = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]), // box size
      Buffer.from('ftypmp42', 'ascii'), // ftyp + brand
      Buffer.alloc(16, 0),
    ]);
    for (const mime of [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska',
    ]) {
      expect(mimeLooksExecutable(mime)).toBe(false);
      expect(validateUploadContent(mime, ftypPrefix)).toBeNull();
    }
  });
});
