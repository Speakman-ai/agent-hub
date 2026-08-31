import { describe, it, expect } from 'vitest';
import {
  extensionForContentType,
  hasFileExtension,
  ensureFilenameExtension,
  truncateFilename,
  contentTypeForFilename,
  isGenericContentType,
  reconcileContentType,
} from './mime-extensions.js';

describe('extensionForContentType', () => {
  it('maps known content types', () => {
    expect(extensionForContentType('application/pdf')).toBe('pdf');
    expect(extensionForContentType('image/png')).toBe('png');
    expect(extensionForContentType('text/markdown')).toBe('md');
    expect(extensionForContentType('application/json')).toBe('json');
  });

  it('ignores content-type parameters and case', () => {
    expect(extensionForContentType('IMAGE/JPEG; charset=binary')).toBe('jpg');
  });

  it('falls back to an extension already on the original name', () => {
    expect(extensionForContentType('application/octet-stream', 'archive.rar')).toBe('rar');
  });

  it('guesses from a text/* subtype', () => {
    expect(extensionForContentType('text/x-python')).toBe('xpython');
    expect(extensionForContentType('text/rtf')).toBe('rtf');
  });

  it('falls back to dat for an unknown binary type', () => {
    expect(extensionForContentType('application/octet-stream')).toBe('dat');
  });
});

describe('hasFileExtension', () => {
  it('detects a plausible extension', () => {
    expect(hasFileExtension('report.pdf')).toBe(true);
    expect(hasFileExtension('build.log')).toBe(true);
    expect(hasFileExtension('archive.tar.gz')).toBe(true);
  });

  it('returns false for extensionless names', () => {
    expect(hasFileExtension('Quarterly Report')).toBe(false);
    expect(hasFileExtension('artifact')).toBe(false);
  });

  it('treats dotfiles and trailing-dot names as having no extension', () => {
    expect(hasFileExtension('.gitignore')).toBe(false);
    expect(hasFileExtension('report.')).toBe(false);
  });

  it('rejects a non-alphanumeric or over-long "extension"', () => {
    expect(hasFileExtension('weird.name with spaces')).toBe(false);
    expect(hasFileExtension('file.superlongextension')).toBe(false);
  });
});

describe('ensureFilenameExtension', () => {
  it('appends an extension derived from the content type', () => {
    expect(ensureFilenameExtension('Quarterly Report', 'application/pdf')).toBe(
      'Quarterly Report.pdf',
    );
  });

  it('leaves an already-extensioned name untouched', () => {
    expect(ensureFilenameExtension('data.json', 'application/json')).toBe('data.json');
    expect(ensureFilenameExtension('screenshot.png', 'image/png')).toBe('screenshot.png');
  });

  it('names a blank input artifact.<ext>', () => {
    expect(ensureFilenameExtension('', 'text/markdown')).toBe('artifact.md');
    expect(ensureFilenameExtension('   ', 'image/png')).toBe('artifact.png');
  });

  it('strips a trailing dot before appending', () => {
    expect(ensureFilenameExtension('report.', 'application/pdf')).toBe('report.pdf');
  });

  it('falls back to dat for an unknown binary type', () => {
    expect(ensureFilenameExtension('blob', 'application/octet-stream')).toBe('blob.dat');
  });

  it('keeps the extension when capping an extensionless name at the length limit', () => {
    const longName = 'a'.repeat(255);
    const out = ensureFilenameExtension(longName, 'application/pdf', 255);
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(hasFileExtension(out)).toBe(true);
  });

  it('keeps the extension when capping an already-long extensioned name', () => {
    const longName = 'b'.repeat(300) + '.tar.gz';
    const out = ensureFilenameExtension(longName, 'application/gzip', 255);
    expect(out.length).toBe(255);
    expect(out.endsWith('.gz')).toBe(true);
    expect(hasFileExtension(out)).toBe(true);
  });
});

describe('contentTypeForFilename', () => {
  it('maps a known extension to its canonical MIME type', () => {
    expect(contentTypeForFilename('report.pdf')).toBe('application/pdf');
    expect(contentTypeForFilename('photo.JPG')).toBe('image/jpeg');
    expect(contentTypeForFilename('notes.md')).toBe('text/markdown');
    expect(contentTypeForFilename('data.json')).toBe('application/json');
  });

  it('uses only the basename and is case-insensitive', () => {
    expect(contentTypeForFilename('/tmp/some.dir/Quarterly Report.PDF')).toBe('application/pdf');
  });

  it('returns null for unknown or missing extensions', () => {
    expect(contentTypeForFilename('archive.rar')).toBeNull();
    expect(contentTypeForFilename('Quarterly Report')).toBeNull();
    expect(contentTypeForFilename('.gitignore')).toBeNull();
    expect(contentTypeForFilename('')).toBeNull();
  });
});

describe('isGenericContentType', () => {
  it('treats missing and octet-stream types as generic', () => {
    expect(isGenericContentType('')).toBe(true);
    expect(isGenericContentType(null)).toBe(true);
    expect(isGenericContentType(undefined)).toBe(true);
    expect(isGenericContentType('application/octet-stream')).toBe(true);
    expect(isGenericContentType('binary/octet-stream')).toBe(true);
    expect(isGenericContentType('APPLICATION/OCTET-STREAM; charset=binary')).toBe(true);
  });

  it('treats a specific type as non-generic', () => {
    expect(isGenericContentType('application/pdf')).toBe(false);
    expect(isGenericContentType('image/png')).toBe(false);
  });
});

describe('reconcileContentType', () => {
  it('recovers a real type from the filename when the declared type is generic', () => {
    expect(reconcileContentType('application/octet-stream', 'report.pdf')).toBe('application/pdf');
    expect(reconcileContentType('', 'slides.pdf')).toBe('application/pdf');
    expect(reconcileContentType(null, 'image.png')).toBe('image/png');
  });

  it('lets a known extension override a mismatched declared type', () => {
    // The ticket requires PDFs to ALWAYS carry the correct type, even when the
    // uploader declared something else. The extension is authoritative.
    expect(reconcileContentType('text/plain', 'report.pdf')).toBe('application/pdf');
    expect(reconcileContentType('application/msword', 'contract.pdf')).toBe('application/pdf');
    expect(reconcileContentType('image/png; charset=binary', 'x.pdf')).toBe('application/pdf');
  });

  it('keeps a matching declared type (drops redundant parameters)', () => {
    expect(reconcileContentType('application/pdf', 'report.pdf')).toBe('application/pdf');
    expect(reconcileContentType('image/png', 'logo.png')).toBe('image/png');
  });

  it('trusts an explicit non-generic declared type when the extension is unknown', () => {
    expect(reconcileContentType('application/pdf', 'weird.name')).toBe('application/pdf');
    expect(reconcileContentType('application/x-rar-compressed', 'blob.rar')).toBe(
      'application/x-rar-compressed',
    );
  });

  it('falls back to octet-stream when both the type and extension are unknown', () => {
    expect(reconcileContentType('application/octet-stream', 'blob.rar')).toBe(
      'application/octet-stream',
    );
    expect(reconcileContentType('', 'noext')).toBe('application/octet-stream');
  });
});

describe('truncateFilename', () => {
  it('returns the name unchanged when within the limit', () => {
    expect(truncateFilename('report.pdf', 255)).toBe('report.pdf');
  });

  it('trims the basename, not the extension', () => {
    const out = truncateFilename('x'.repeat(300) + '.pdf', 255);
    expect(out.length).toBe(255);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('falls back to a plain slice when the extension leaves no room', () => {
    // A 12-char "extension" with a tiny cap can't keep a basename char.
    const out = truncateFilename('a.abcdefghijkl', 5);
    expect(out.length).toBe(5);
  });

  it('is a no-op for a non-positive limit', () => {
    expect(truncateFilename('report.pdf', 0)).toBe('report.pdf');
  });
});
