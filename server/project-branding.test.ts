import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import {
  ProjectEmailLogoError,
  PROJECT_EMAIL_LOGO_MAX_BYTES,
  deleteProjectEmailLogoFile,
  deleteProjectEmailLogoFiles,
  isAllowedEmailLogoType,
  parseImageDataUrl,
  projectEmailLogoPath,
  resolveProjectEmailLogoAttachment,
  writeProjectEmailLogo,
} from './project-branding.js';
import { BRAND_LOGO_CID } from './email-branding.js';

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'proj-branding-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('parseImageDataUrl', () => {
  it('parses a base64 data URL into a content type + buffer', () => {
    const parsed = parseImageDataUrl(`data:image/png;base64,${PNG_1X1.toString('base64')}`);
    expect(parsed).not.toBeNull();
    expect(parsed?.contentType).toBe('image/png');
    expect(parsed?.buffer.equals(PNG_1X1)).toBe(true);
  });

  it('returns null for a non-data-URL string', () => {
    expect(parseImageDataUrl('https://example.com/logo.png')).toBeNull();
    expect(parseImageDataUrl('')).toBeNull();
  });
});

describe('isAllowedEmailLogoType', () => {
  it('accepts raster image types and rejects svg / non-images', () => {
    expect(isAllowedEmailLogoType('image/png')).toBe(true);
    expect(isAllowedEmailLogoType('image/jpeg')).toBe(true);
    expect(isAllowedEmailLogoType('image/webp')).toBe(true);
    expect(isAllowedEmailLogoType('image/svg+xml')).toBe(false);
    expect(isAllowedEmailLogoType('text/plain')).toBe(false);
  });
});

describe('writeProjectEmailLogo', () => {
  it('writes the image to a unique file and returns metadata', () => {
    const logo = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    expect(logo.filename).toMatch(/^email-logo-.+\.png$/);
    expect(logo.contentType).toBe('image/png');
    expect(logo.size).toBe(PNG_1X1.length);
    expect(logo.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(projectEmailLogoPath(dataDir, logo))).toBe(true);
  });

  it('never overwrites a prior logo — each write is a distinct file', () => {
    const a = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    const b = writeProjectEmailLogo(dataDir, Buffer.from('GIF89a-fake'), 'image/gif');
    expect(a.filename).not.toBe(b.filename);
    // Both files coexist; the route (not the writer) is responsible for
    // deleting the superseded one after metadata is persisted.
    expect(existsSync(projectEmailLogoPath(dataDir, a))).toBe(true);
    expect(existsSync(projectEmailLogoPath(dataDir, b))).toBe(true);
    // No staging temp file is left behind.
    const temps = readdirSync(path.join(dataDir, 'branding')).filter((f) =>
      f.startsWith('email-logo.tmp-'),
    );
    expect(temps).toEqual([]);
  });

  it('rejects a disallowed image type', () => {
    expect(() => writeProjectEmailLogo(dataDir, PNG_1X1, 'image/svg+xml')).toThrow(
      ProjectEmailLogoError,
    );
  });

  it('rejects an empty body', () => {
    expect(() => writeProjectEmailLogo(dataDir, Buffer.alloc(0), 'image/png')).toThrow(
      ProjectEmailLogoError,
    );
  });

  it('rejects an oversized image', () => {
    const tooBig = Buffer.alloc(PROJECT_EMAIL_LOGO_MAX_BYTES + 1, 0x01);
    expect(() => writeProjectEmailLogo(dataDir, tooBig, 'image/png')).toThrow(
      ProjectEmailLogoError,
    );
  });
});

describe('deleteProjectEmailLogoFile', () => {
  it('removes only the given logo file and is a no-op for null', () => {
    const a = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    const b = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    deleteProjectEmailLogoFile(dataDir, a);
    expect(existsSync(projectEmailLogoPath(dataDir, a))).toBe(false);
    expect(existsSync(projectEmailLogoPath(dataDir, b))).toBe(true);
    expect(() => deleteProjectEmailLogoFile(dataDir, null)).not.toThrow();
  });
});

describe('deleteProjectEmailLogoFiles', () => {
  it('removes every stored logo file and is a no-op when none exist', () => {
    const a = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    const b = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    deleteProjectEmailLogoFiles(dataDir);
    expect(existsSync(projectEmailLogoPath(dataDir, a))).toBe(false);
    expect(existsSync(projectEmailLogoPath(dataDir, b))).toBe(false);
    expect(() => deleteProjectEmailLogoFiles(dataDir)).not.toThrow();
  });
});

describe('resolveProjectEmailLogoAttachment', () => {
  it('returns an inline attachment using the shared brand CID', () => {
    const logo = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    const att = resolveProjectEmailLogoAttachment(logo, dataDir);
    expect(att).not.toBeNull();
    expect(att?.cid).toBe(BRAND_LOGO_CID);
    expect(att?.contentType).toBe('image/png');
    expect((att?.content as Buffer).equals(PNG_1X1)).toBe(true);
  });

  it('returns null when the logo is unset', () => {
    expect(resolveProjectEmailLogoAttachment(null, dataDir)).toBeNull();
    expect(resolveProjectEmailLogoAttachment(undefined, dataDir)).toBeNull();
  });

  it('returns null when the stored file is missing', () => {
    const logo = writeProjectEmailLogo(dataDir, PNG_1X1, 'image/png');
    deleteProjectEmailLogoFiles(dataDir);
    expect(resolveProjectEmailLogoAttachment(logo, dataDir)).toBeNull();
  });
});
