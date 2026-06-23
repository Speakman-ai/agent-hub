import { describe, it, expect } from 'vitest';
import { resolveServerMediaUrl } from './resolveServerMediaUrl';

describe('resolveServerMediaUrl', () => {
  it('prefixes /uploads paths with remote serverBase', () => {
    expect(resolveServerMediaUrl('/uploads/a.png', { serverBase: 'https://hub.example.com' })).toBe(
      'https://hub.example.com/uploads/a.png',
    );
  });

  it('prefixes /design-files paths with remote serverBase', () => {
    expect(
      resolveServerMediaUrl('/design-files/abc/index.html', {
        serverBase: 'https://hub.example.com',
      }),
    ).toBe('https://hub.example.com/design-files/abc/index.html');
  });

  it('leaves relative server paths unchanged in local mode (empty base)', () => {
    expect(resolveServerMediaUrl('/uploads/x.pdf', { serverBase: '' })).toBe('/uploads/x.pdf');
  });

  it('does not rewrite arbitrary relative links', () => {
    expect(resolveServerMediaUrl('/docs/readme', { serverBase: '' })).toBe('/docs/readme');
  });

  it('leaves external https URLs unchanged', () => {
    expect(
      resolveServerMediaUrl('https://github.com/foo/bar', { serverBase: '', viteApiPort: '3051' }),
    ).toBe('https://github.com/foo/bar');
  });

  it('rewrites localhost + API port uploads URL to a path for Vite dev proxy', () => {
    expect(
      resolveServerMediaUrl('http://localhost:3051/uploads/uuid.pdf', {
        serverBase: '',
        viteApiPort: '3051',
      }),
    ).toBe('/uploads/uuid.pdf');
  });

  it('preserves query/hash when rewriting dev absolute uploads URL', () => {
    expect(
      resolveServerMediaUrl('http://127.0.0.1:3051/uploads/uuid.png?v=1#frag', {
        serverBase: '',
        viteApiPort: '3051',
      }),
    ).toBe('/uploads/uuid.png?v=1#frag');
  });

  it('does not strip localhost API URL when remote serverBase is set', () => {
    const url = 'http://localhost:3051/uploads/x.png';
    expect(
      resolveServerMediaUrl(url, {
        serverBase: 'https://remote.example.com',
        viteApiPort: '3051',
      }),
    ).toBe(url);
  });

  it('passes through mailto unchanged', () => {
    expect(resolveServerMediaUrl('mailto:a@b.com', { serverBase: 'https://x.com' })).toBe(
      'mailto:a@b.com',
    );
  });
});
