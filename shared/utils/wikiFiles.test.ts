import { describe, it, expect } from 'vitest';
import {
  buildWikiFolderTree,
  listWikiFolderPaths,
  normalizeWikiFolderInput,
  wikiFileUploadUrl,
  wikiUploadRetryDelayMs,
  wikiFileActionError,
  type WikiFileWire,
} from './wikiFiles';

function file(folder: string, filename: string): WikiFileWire {
  return {
    id: `${folder}/${filename}`,
    project_id: 'p',
    folder,
    filename,
    path: folder ? `${folder}/${filename}` : filename,
    content_type: 'text/plain',
    size_bytes: 1,
    page_id: null,
    page_slug: null,
    extracted_chars: 0,
    truncated: 0,
    uploaded_by: null,
    created_at: '',
    updated_at: '',
  };
}

describe('buildWikiFolderTree', () => {
  it('nests folders, creates intermediate folders, and counts descendants', () => {
    const root = buildWikiFolderTree([
      file('SOPs/Safety', 'lockout.pdf'),
      file('SOPs', 'index.md'),
      file('', 'readme.txt'),
      file('SOPs/Safety', 'fire.pdf'),
      file('Archive/2025/Q1', 'old.docx'),
    ]);

    expect(root.files.map((f) => f.filename)).toEqual(['readme.txt']);
    expect(root.totalFiles).toBe(5);
    expect(root.folders.map((f) => f.name)).toEqual(['Archive', 'SOPs']);

    const sops = root.folders[1]!;
    expect(sops.totalFiles).toBe(3);
    expect(sops.folders[0]!.path).toBe('SOPs/Safety');
    expect(sops.folders[0]!.files.map((f) => f.filename)).toEqual(['fire.pdf', 'lockout.pdf']);

    const q1 = root.folders[0]!.folders[0]!.folders[0]!;
    expect(q1.path).toBe('Archive/2025/Q1');
    expect(q1.depth).toBe(3);
  });

  it('lists folder paths depth-first', () => {
    const root = buildWikiFolderTree([file('B/C', 'x'), file('A', 'y')]);
    expect(listWikiFolderPaths(root)).toEqual(['A', 'B', 'B/C']);
  });
});

describe('normalizeWikiFolderInput / wikiFileUploadUrl', () => {
  it('trims segments and drops empties', () => {
    expect(normalizeWikiFolderInput(' /SOPs\\ Safety //')).toBe('SOPs/Safety');
  });

  it('omits folder for the root and encodes names', () => {
    expect(wikiFileUploadUrl('/api', 'proj', '', 'a b.pdf')).toBe(
      '/api/projects/proj/wiki-files?filename=a+b.pdf',
    );
    expect(wikiFileUploadUrl('/api', 'proj', 'SOPs/Safety', 'x.pdf')).toBe(
      '/api/projects/proj/wiki-files?filename=x.pdf&folder=SOPs%2FSafety',
    );
  });
});

describe('wikiUploadRetryDelayMs', () => {
  it('honors Retry-After, falls back to backoff, and caps the wait', () => {
    expect(wikiUploadRetryDelayMs('5', 0)).toBe(5000);
    expect(wikiUploadRetryDelayMs(null, 0)).toBe(1000);
    expect(wikiUploadRetryDelayMs(undefined, 2)).toBe(4000);
    expect(wikiUploadRetryDelayMs('600', 0)).toBe(30_000);
  });
});

describe('wikiFileActionError', () => {
  it('prefers the server message, then the status, then the transport error', () => {
    expect(wikiFileActionError('Move', { status: 409, body: { error: 'Name taken' } })).toBe(
      'Move failed: Name taken',
    );
    expect(wikiFileActionError('Delete', { status: 500, body: null })).toBe(
      'Delete failed (HTTP 500)',
    );
    expect(wikiFileActionError('Delete', { network: new TypeError('Failed to fetch') })).toBe(
      'Delete failed: could not reach the server (Failed to fetch)',
    );
  });
});
