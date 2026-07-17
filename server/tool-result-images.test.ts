import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { offloadToolResultImages } from './tool-result-images.js';
import type { ToolResultEvent } from './types.js';

function makeEvent(images?: ToolResultEvent['images']): ToolResultEvent {
  return {
    type: 'tool_result',
    toolUseId: 't1',
    output: '[image: image/png]',
    isError: false,
    images,
  };
}

describe('offloadToolResultImages', () => {
  let uploadsDir: string;

  beforeEach(() => {
    uploadsDir = mkdtempSync(path.join(tmpdir(), 'tool-images-'));
  });
  afterEach(() => {
    rmSync(uploadsDir, { recursive: true, force: true });
  });

  it('returns the same event untouched when there are no images', () => {
    const ev = makeEvent();
    expect(offloadToolResultImages(ev, uploadsDir)).toBe(ev);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it('writes base64 images to the uploads dir and rewrites to a served url', () => {
    const data = Buffer.from('fake-png-bytes').toString('base64');
    const out = offloadToolResultImages(
      makeEvent([{ mediaType: 'image/png', dataBase64: data }]),
      uploadsDir,
    );
    expect(out.images).toHaveLength(1);
    const img = out.images![0];
    expect(img.dataBase64).toBeUndefined();
    expect(img.url).toMatch(/^\/uploads\/tool-image-[a-f0-9-]+\.png$/);

    const files = readdirSync(uploadsDir);
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(uploadsDir, files[0])).toString()).toBe('fake-png-bytes');
  });

  it('picks the extension from the media type', () => {
    const data = Buffer.from('jpeg').toString('base64');
    const out = offloadToolResultImages(
      makeEvent([{ mediaType: 'image/jpeg', dataBase64: data }]),
      uploadsDir,
    );
    expect(out.images![0].url).toMatch(/\.jpg$/);
  });

  it('passes through images that already carry a url', () => {
    const out = offloadToolResultImages(
      makeEvent([{ mediaType: 'image', url: 'https://example.com/x.png' }]),
      uploadsDir,
    );
    expect(out.images![0].url).toBe('https://example.com/x.png');
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it('drops the data (no url) when the bytes fail content validation', () => {
    // An ELF header trips validateUploadContent's executable-binary check.
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01]).toString('base64');
    const out = offloadToolResultImages(
      makeEvent([{ mediaType: 'image/png', dataBase64: elf }]),
      uploadsDir,
    );
    expect(out.images![0].url).toBeUndefined();
    expect(out.images![0].dataBase64).toBeUndefined();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });
});
