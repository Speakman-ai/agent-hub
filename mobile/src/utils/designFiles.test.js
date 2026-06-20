import { describe, it, expect } from 'vitest';
import { buildDesignFileUrl, pickEntryFile, formatFileSize } from './designFiles.js';

const BASE = 'https://hub.example.test';

describe('buildDesignFileUrl', () => {
  it('returns null when no server base is configured', () => {
    expect(buildDesignFileUrl('', 'sess-1', 'index.html')).toBeNull();
    expect(buildDesignFileUrl(null, 'sess-1', 'index.html')).toBeNull();
  });

  it('builds a plain path with the static mount prefix', () => {
    expect(buildDesignFileUrl(BASE, 'sess-1', 'index.html')).toBe(
      `${BASE}/session-files/sess-1/design/index.html`,
    );
  });

  it('encodes URL-significant characters in each segment', () => {
    // Spaces, #, ?, % would otherwise break or truncate the link.
    expect(buildDesignFileUrl(BASE, 'sess-1', 'my page.html')).toBe(
      `${BASE}/session-files/sess-1/design/my%20page.html`,
    );
    expect(buildDesignFileUrl(BASE, 'sess-1', 'a#b?c%d.css')).toBe(
      `${BASE}/session-files/sess-1/design/a%23b%3Fc%25d.css`,
    );
  });

  it('preserves / separators while encoding nested segments', () => {
    expect(buildDesignFileUrl(BASE, 'sess-1', 'assets/my icons/logo (1).svg')).toBe(
      `${BASE}/session-files/sess-1/design/assets/my%20icons/logo%20(1).svg`,
    );
  });
});

describe('pickEntryFile', () => {
  it('returns null for an empty/missing list', () => {
    expect(pickEntryFile([])).toBeNull();
    expect(pickEntryFile(undefined)).toBeNull();
  });

  it('prefers a root index.html', () => {
    expect(pickEntryFile([{ path: 'style.css' }, { path: 'index.html' }])).toBe('index.html');
  });

  it('matches a nested index.html', () => {
    expect(pickEntryFile([{ path: 'sub/index.html' }])).toBe('sub/index.html');
  });

  it('falls back to the first html file when no index exists', () => {
    expect(pickEntryFile([{ path: 'style.css' }, { path: 'page.html' }])).toBe('page.html');
  });

  it('returns null when there is no html file at all', () => {
    expect(pickEntryFile([{ path: 'style.css' }, { path: 'app.js' }])).toBeNull();
  });
});

describe('formatFileSize', () => {
  it('formats bytes, KB and MB; blank for null/NaN', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatFileSize(null)).toBe('');
    expect(formatFileSize(NaN)).toBe('');
  });
});
