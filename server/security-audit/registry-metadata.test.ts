import '../test/setup.js';
import { describe, it, expect, vi } from 'vitest';
import { fetchNpmDistMetadata, registryBaseFromResolvedUrl } from './registry-metadata.js';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('fetchNpmDistMetadata', () => {
  it('returns the tarball + integrity for a published version', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) =>
      jsonResponse({
        name: 'shell-quote',
        version: '1.8.4',
        dist: {
          tarball: 'https://registry.npmjs.org/shell-quote/-/shell-quote-1.8.4.tgz',
          integrity: 'sha512-NEW==',
          shasum: 'abc',
        },
      }),
    );
    const out = await fetchNpmDistMetadata('shell-quote', '1.8.4', { fetchImpl });
    expect(out).toEqual({
      resolved: 'https://registry.npmjs.org/shell-quote/-/shell-quote-1.8.4.tgz',
      integrity: 'sha512-NEW==',
    });
    // hits the version-specific registry endpoint
    expect(fetchImpl.mock.calls[0][0]).toBe('https://registry.npmjs.org/shell-quote/1.8.4');
  });

  it('percent-encodes the scoped-package slash in the request path', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) =>
      jsonResponse({ dist: { tarball: 'https://x/t.tgz', integrity: 'sha512-A' } }),
    );
    await fetchNpmDistMetadata('@babel/core', '7.24.0', { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://registry.npmjs.org/@babel%2fcore/7.24.0');
  });

  it('honours a custom registry URL and trims a trailing slash', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) =>
      jsonResponse({ dist: { tarball: 'https://x/t.tgz', integrity: 'sha512-A' } }),
    );
    await fetchNpmDistMetadata('lodash', '4.17.21', {
      fetchImpl,
      registryUrl: 'https://npm.internal.example/',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://npm.internal.example/lodash/4.17.21');
  });

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { ok: false, status: 404 }));
    expect(await fetchNpmDistMetadata('nope', '1.0.0', { fetchImpl })).toBeNull();
  });

  it('returns null when dist fields are missing or empty', async () => {
    const missingDist = vi.fn(async () => jsonResponse({ name: 'x', version: '1.0.0' }));
    expect(await fetchNpmDistMetadata('x', '1.0.0', { fetchImpl: missingDist })).toBeNull();

    const emptyFields = vi.fn(async () => jsonResponse({ dist: { tarball: '', integrity: '' } }));
    expect(await fetchNpmDistMetadata('x', '1.0.0', { fetchImpl: emptyFields })).toBeNull();

    const noIntegrity = vi.fn(async () => jsonResponse({ dist: { tarball: 'https://x/t.tgz' } }));
    expect(await fetchNpmDistMetadata('x', '1.0.0', { fetchImpl: noIntegrity })).toBeNull();
  });

  it('never throws — a rejected fetch resolves to null', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await fetchNpmDistMetadata('x', '1.0.0', { fetchImpl })).toBeNull();
  });

  it('returns null for empty package name or version without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    expect(await fetchNpmDistMetadata('', '1.0.0', { fetchImpl })).toBeNull();
    expect(await fetchNpmDistMetadata('x', '', { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('registryBaseFromResolvedUrl', () => {
  it('derives the public-npm base from an unscoped tarball URL', () => {
    expect(
      registryBaseFromResolvedUrl(
        'https://registry.npmjs.org/lodash/-/lodash-4.17.11.tgz',
        'lodash',
      ),
    ).toBe('https://registry.npmjs.org');
  });

  it('derives a private-registry base, preserving the host', () => {
    expect(
      registryBaseFromResolvedUrl(
        'https://npm.internal.example/repo/lodash/-/lodash-4.17.11.tgz',
        'lodash',
      ),
    ).toBe('https://npm.internal.example/repo');
  });

  it('handles scoped packages (the slash is part of the name marker)', () => {
    expect(
      registryBaseFromResolvedUrl(
        'https://registry.npmjs.org/@babel/core/-/core-7.24.0.tgz',
        '@babel/core',
      ),
    ).toBe('https://registry.npmjs.org');
  });

  it('returns null for a non-http specifier (git/file/url)', () => {
    expect(
      registryBaseFromResolvedUrl('git+https://github.com/x/lodash.git#abc', 'lodash'),
    ).toBeNull();
    expect(registryBaseFromResolvedUrl('file:../local/lodash', 'lodash')).toBeNull();
  });

  it('returns null when the package name does not match the URL marker', () => {
    expect(
      registryBaseFromResolvedUrl(
        'https://registry.npmjs.org/lodash/-/lodash-4.17.11.tgz',
        'express',
      ),
    ).toBeNull();
  });

  it('returns null for empty inputs', () => {
    expect(registryBaseFromResolvedUrl('', 'lodash')).toBeNull();
    expect(registryBaseFromResolvedUrl('https://x/lodash/-/lodash-1.0.0.tgz', '')).toBeNull();
  });
});
