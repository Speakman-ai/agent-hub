import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config', () => ({
  getApiBaseUrl: () => 'https://hub.test/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer tok' }),
}));

import {
  buildArtifactContentUrl,
  safeCacheName,
  shareArtifact,
  loadArtifactPreview,
} from './artifactContent';

describe('buildArtifactContentUrl', () => {
  it('builds the plain content URL', () => {
    expect(buildArtifactContentUrl('https://hub.test/api', 's1', 'a1')).toBe(
      'https://hub.test/api/sessions/s1/artifacts/a1/content',
    );
  });
  it('appends the download flag', () => {
    expect(buildArtifactContentUrl('https://hub.test/api', 's1', 'a1', { download: true })).toBe(
      'https://hub.test/api/sessions/s1/artifacts/a1/content?download=1',
    );
  });
});

describe('safeCacheName', () => {
  it('strips path separators to prevent cache-dir escape', () => {
    expect(safeCacheName('../../etc/passwd', 'a1')).toBe('passwd');
    expect(safeCacheName('sub/dir/report.pdf', 'a1')).toBe('report.pdf');
  });
  it('sanitizes unusual characters but keeps dots/dashes/spaces', () => {
    expect(safeCacheName('my report (final).pdf', 'a1')).toBe('my report _final_.pdf');
  });
  it('falls back to the artifact id when the name is empty/non-string', () => {
    expect(safeCacheName('', 'a9')).toBe('artifact-a9');
    expect(safeCacheName(null, 'a9')).toBe('artifact-a9');
    expect(safeCacheName(undefined, undefined)).toBe('artifact-file');
  });
  it('rejects reserved relative-path basenames to prevent cache-dir targeting', () => {
    // A filename of '.' / '..' survives separator-stripping as a bare dotted
    // basename; concatenated onto the cache dir it would target the dir (or its
    // parent) rather than a file. Must fall back to the artifact id.
    expect(safeCacheName('.', 'a9')).toBe('artifact-a9');
    expect(safeCacheName('..', 'a9')).toBe('artifact-a9');
    expect(safeCacheName('foo/..', 'a9')).toBe('artifact-a9');
    expect(safeCacheName('sub/dir/.', 'a9')).toBe('artifact-a9');
    // A real dotted filename is still preserved.
    expect(safeCacheName('..hidden.tar.gz', 'a9')).toBe('..hidden.tar.gz');
  });
});

function makeDeps(over: any = {}) {
  const downloadAsync = vi.fn().mockResolvedValue({ status: 200, uri: 'file:///cache/report.pdf' });
  const readAsStringAsync = vi.fn().mockResolvedValue('{"answer":42}');
  const shareAsync = vi.fn().mockResolvedValue(undefined);
  return {
    fileSystem: { cacheDirectory: 'file:///cache/', downloadAsync, readAsStringAsync },
    sharing: { isAvailableAsync: vi.fn().mockResolvedValue(true), shareAsync },
    ...over,
    _spies: { downloadAsync, readAsStringAsync, shareAsync },
  };
}

describe('shareArtifact', () => {
  let deps: any;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('downloads with auth headers to a sanitized cache path then shares', async () => {
    const artifact = { id: 'a1', filename: 'report.pdf', contentType: 'application/pdf' };
    const uri = await shareArtifact('s1', artifact, { download: false }, deps);
    expect(deps._spies.downloadAsync).toHaveBeenCalledWith(
      'https://hub.test/api/sessions/s1/artifacts/a1/content',
      'file:///cache/report.pdf',
      { headers: { Authorization: 'Bearer tok' } },
    );
    expect(deps._spies.shareAsync).toHaveBeenCalledWith('file:///cache/report.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: 'report.pdf',
    });
    expect(uri).toBe('file:///cache/report.pdf');
  });

  it('passes the download flag through to the URL', async () => {
    await shareArtifact('s1', { id: 'a1', filename: 'x.bin' }, { download: true }, deps);
    expect(deps._spies.downloadAsync.mock.calls[0][0]).toBe(
      'https://hub.test/api/sessions/s1/artifacts/a1/content?download=1',
    );
  });

  it('throws on a non-2xx download and does not share', async () => {
    deps.fileSystem.downloadAsync = vi.fn().mockResolvedValue({ status: 404 });
    await expect(
      shareArtifact('s1', { id: 'a1', filename: 'x' }, {}, deps),
    ).rejects.toThrow('Failed to fetch artifact (404)');
    expect(deps._spies.shareAsync).not.toHaveBeenCalled();
  });

  it('throws when sharing is unavailable', async () => {
    deps.sharing.isAvailableAsync = vi.fn().mockResolvedValue(false);
    await expect(
      shareArtifact('s1', { id: 'a1', filename: 'x' }, {}, deps),
    ).rejects.toThrow('Sharing is not available');
  });

  it('requires sessionId and artifact id', async () => {
    await expect(shareArtifact('', { id: 'a1' }, {}, deps)).rejects.toThrow('sessionId is required');
    await expect(shareArtifact('s1', {}, {}, deps)).rejects.toThrow('artifact.id is required');
  });
});

describe('loadArtifactPreview', () => {
  it('decodes and formats a JSON artifact for the in-app viewer', async () => {
    const deps = makeDeps();
    const preview = await loadArtifactPreview(
      's1',
      { id: 'a1', filename: 'data.json', contentType: 'application/json' },
      deps,
    );
    expect(preview).toEqual({
      uri: 'file:///cache/report.pdf',
      text: '{\n  "answer": 42\n}',
    });
    expect(deps._spies.readAsStringAsync).toHaveBeenCalledWith('file:///cache/report.pdf');
  });

  it('keeps binary preview resources as local URIs without decoding them as text', async () => {
    const deps = makeDeps();
    const preview = await loadArtifactPreview(
      's1',
      { id: 'a1', filename: 'report.pdf', contentType: 'application/pdf' },
      deps,
    );
    expect(preview).toEqual({ uri: 'file:///cache/report.pdf', text: '' });
    expect(deps._spies.readAsStringAsync).not.toHaveBeenCalled();
  });
});
