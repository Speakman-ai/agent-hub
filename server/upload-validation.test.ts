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
});
