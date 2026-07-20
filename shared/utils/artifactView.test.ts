import { describe, it, expect } from 'vitest';
import { formatBytes, extOf, isInlineViewable, artifactGlyph } from './artifactView';

describe('formatBytes', () => {
  it('formats bytes, KB, MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 * 3.4)).toBe('3.4 MB');
  });
  it('handles invalid input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes('nope')).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });
});

describe('extOf', () => {
  it('extracts the lowercased extension', () => {
    expect(extOf('report.PDF')).toBe('pdf');
    expect(extOf('a/b/c.tar.gz')).toBe('gz');
  });
  it('returns empty for no extension / dotfiles', () => {
    expect(extOf('Makefile')).toBe('');
    expect(extOf('.gitignore')).toBe('');
    expect(extOf('trailing.')).toBe('');
    expect(extOf(null)).toBe('');
  });
});

describe('isInlineViewable', () => {
  it('allows safe renderable MIME types', () => {
    expect(isInlineViewable('application/pdf', 'x.pdf')).toBe(true);
    expect(isInlineViewable('image/png', 'x.png')).toBe(true);
    expect(isInlineViewable('text/markdown', 'x.md')).toBe(true);
    expect(isInlineViewable('application/json', 'x.json')).toBe(true);
  });
  it('falls back to extension for octet-stream', () => {
    expect(isInlineViewable('application/octet-stream', 'data.csv')).toBe(true);
    expect(isInlineViewable('application/octet-stream', 'archive.zip')).toBe(false);
  });
  it('rejects unknown binary types', () => {
    expect(isInlineViewable('application/zip', 'a.zip')).toBe(false);
  });
  it('never offers inline View for active / scriptable content', () => {
    // These can execute script in the app origin from a same-origin blob URL.
    expect(isInlineViewable('text/html', 'page.html')).toBe(false);
    expect(isInlineViewable('application/xhtml+xml', 'page.xhtml')).toBe(false);
    expect(isInlineViewable('image/svg+xml', 'logo.svg')).toBe(false);
    expect(isInlineViewable('application/xml', 'data.xml')).toBe(false);
    expect(isInlineViewable('text/xml', 'data.xml')).toBe(false);
    expect(isInlineViewable('application/javascript', 'app.js')).toBe(false);
    // Even when stored as octet-stream, scriptable extensions stay non-viewable.
    expect(isInlineViewable('application/octet-stream', 'page.html')).toBe(false);
    expect(isInlineViewable('application/octet-stream', 'logo.svg')).toBe(false);
    expect(isInlineViewable('application/octet-stream', 'app.js')).toBe(false);
  });
});

describe('artifactGlyph', () => {
  it('picks a glyph by MIME family then extension', () => {
    expect(artifactGlyph('application/pdf', 'x.pdf')).toBe('📄');
    expect(artifactGlyph('image/png', 'x.png')).toBe('🖼️');
    expect(artifactGlyph('application/octet-stream', 'deploy.sh')).toBe('📜');
    expect(artifactGlyph('application/octet-stream', 'data.csv')).toBe('📊');
    expect(artifactGlyph('application/octet-stream', 'unknown.bin')).toBe('📎');
  });
});
