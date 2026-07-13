import { describe, it, expect } from 'vitest';
import { resolveRepoImageUrl } from './resolveRepoMediaUrl';

const base = { projectId: 'agent-hub', branch: 'main', mediaToken: 'media-token', serverBase: '' };

describe('resolveRepoImageUrl', () => {
  it('maps a repo-root-relative image path to the media mount', () => {
    expect(resolveRepoImageUrl('docs/media/dashboard.png', base)).toBe(
      '/git-host-media/agent-hub?path=docs%2Fmedia%2Fdashboard.png&branch=main&token=media-token',
    );
  });

  it('leaves leading-slash site-root paths untouched', () => {
    expect(resolveRepoImageUrl('/docs/media/x.png', base)).toBe('/docs/media/x.png');
  });

  it('resolves relative to the README directory via baseDir', () => {
    expect(resolveRepoImageUrl('./img/logo.png', { ...base, baseDir: 'docs' })).toBe(
      '/git-host-media/agent-hub?path=docs%2Fimg%2Flogo.png&branch=main&token=media-token',
    );
  });

  it('collapses .. within the repo', () => {
    expect(resolveRepoImageUrl('../assets/logo.png', { ...base, baseDir: 'docs/sub' })).toBe(
      '/git-host-media/agent-hub?path=docs%2Fassets%2Flogo.png&branch=main&token=media-token',
    );
  });

  it('strips a trailing query/hash (e.g. ?raw=true)', () => {
    expect(resolveRepoImageUrl('docs/x.png?raw=true', base)).toBe(
      '/git-host-media/agent-hub?path=docs%2Fx.png&branch=main&token=media-token',
    );
  });

  it('prefixes a remote server base', () => {
    expect(
      resolveRepoImageUrl('docs/x.png', { ...base, serverBase: 'https://hub.example.com/' }),
    ).toBe(
      'https://hub.example.com/git-host-media/agent-hub?path=docs%2Fx.png&branch=main&token=media-token',
    );
  });

  it('omits the branch param when no branch given', () => {
    expect(
      resolveRepoImageUrl('x.png', { projectId: 'p', mediaToken: 'tok', serverBase: '' }),
    ).toBe('/git-host-media/p?path=x.png&token=tok');
  });

  it('omits the token param when no token given', () => {
    expect(resolveRepoImageUrl('x.png', { projectId: 'p', branch: 'main', serverBase: '' })).toBe(
      '/git-host-media/p?path=x.png&branch=main',
    );
  });

  it('leaves absolute http(s) URLs untouched (shields.io badges)', () => {
    const badge = 'https://img.shields.io/badge/node-x.svg';
    expect(resolveRepoImageUrl(badge, base)).toBe(badge);
  });

  it('leaves protocol-relative and data URIs untouched', () => {
    expect(resolveRepoImageUrl('//cdn.example.com/a.png', base)).toBe('//cdn.example.com/a.png');
    expect(resolveRepoImageUrl('data:image/png;base64,AAAA', base)).toBe(
      'data:image/png;base64,AAAA',
    );
  });

  it('leaves a src that escapes the repo root untouched', () => {
    expect(resolveRepoImageUrl('../../../etc/passwd', base)).toBe('../../../etc/passwd');
  });

  it('passes through nullish / non-string / empty values', () => {
    expect(resolveRepoImageUrl(null, base)).toBeNull();
    expect(resolveRepoImageUrl(undefined, base)).toBeUndefined();
    expect(resolveRepoImageUrl('   ', base)).toBe('   ');
  });
});
