import { describe, it, expect } from 'vitest';
import {
  classifyCloneUrl,
  buildAuthenticatedUrl,
  redactToken,
  SSH_NOT_SUPPORTED_MESSAGE,
} from './clone-url-auth.js';

describe('classifyCloneUrl', () => {
  it('recognizes plain https github URLs', () => {
    const p = classifyCloneUrl('https://github.com/mcsteen/surveytracker');
    expect(p.kind).toBe('github-https');
    expect(p.owner).toBe('mcsteen');
    expect(p.repo).toBe('surveytracker');
  });

  it('strips the .git suffix from https URLs', () => {
    const p = classifyCloneUrl('https://github.com/foo/bar.git');
    expect(p.kind).toBe('github-https');
    expect(p.owner).toBe('foo');
    expect(p.repo).toBe('bar');
  });

  it('accepts the www.github.com alias', () => {
    const p = classifyCloneUrl('https://www.github.com/foo/bar.git');
    expect(p.kind).toBe('github-https');
    expect(p.owner).toBe('foo');
  });

  it('tolerates trailing slash and trailing whitespace', () => {
    expect(classifyCloneUrl('  https://github.com/foo/bar/  ').kind).toBe('github-https');
  });

  it('recognizes scp-style ssh URLs as github-ssh', () => {
    const p = classifyCloneUrl('git@github.com:foo/bar.git');
    expect(p.kind).toBe('github-ssh');
    expect(p.owner).toBe('foo');
    expect(p.repo).toBe('bar');
  });

  it('recognizes ssh:// scheme URLs as github-ssh', () => {
    const p = classifyCloneUrl('ssh://git@github.com/foo/bar.git');
    expect(p.kind).toBe('github-ssh');
  });

  it('classifies non-github HTTPS URLs as other', () => {
    expect(classifyCloneUrl('https://gitlab.com/foo/bar.git').kind).toBe('other');
    expect(classifyCloneUrl('https://bitbucket.org/x/y.git').kind).toBe('other');
    expect(classifyCloneUrl('file:///tmp/foo.git').kind).toBe('other');
  });

  it('does NOT misclassify lookalike hosts as github', () => {
    expect(classifyCloneUrl('https://notgithub.com/foo/bar').kind).toBe('other');
    expect(classifyCloneUrl('https://github.com.evil.com/foo/bar').kind).toBe('other');
  });

  it('rejects shell metachars in the owner/repo segments', () => {
    // Defence in depth: the post-clone `git remote set-url` no longer
    // goes through a shell, but keeping the classifier strict means a
    // tokenized URL never gets built for a malicious repo segment in
    // the first place.
    const owner = classifyCloneUrl('https://github.com/owner$(touch x)/repo');
    expect(owner.kind).toBe('other');
    const repo = classifyCloneUrl('https://github.com/owner/repo$(touch x).git');
    expect(repo.kind).toBe('other');
    const backtick = classifyCloneUrl('https://github.com/owner/`evil`.git');
    expect(backtick.kind).toBe('github-https');
    // Backticks aren't blocked by the regex (they're rare in repo
    // names but legal-ish chars). The shell-bypass guarantee lives in
    // the route, not the classifier — we just want to be sure the
    // route never invokes /bin/sh with these strings.
    expect(backtick.repo).toBe('`evil`');
  });

  it('returns other for empty / undefined input', () => {
    expect(classifyCloneUrl('').kind).toBe('other');
    expect(classifyCloneUrl('   ').kind).toBe('other');
  });
});

describe('buildAuthenticatedUrl', () => {
  it('produces the documented x-access-token form', () => {
    const parsed = classifyCloneUrl('https://github.com/foo/bar.git');
    const url = buildAuthenticatedUrl(parsed, 'ghu_secret123');
    expect(url).toBe('https://x-access-token:ghu_secret123@github.com/foo/bar.git');
  });

  it('canonicalizes URLs without .git to include .git', () => {
    const parsed = classifyCloneUrl('https://github.com/foo/bar');
    const url = buildAuthenticatedUrl(parsed, 'tok');
    expect(url).toBe('https://x-access-token:tok@github.com/foo/bar.git');
  });

  it('refuses to build a URL for SSH input', () => {
    const parsed = classifyCloneUrl('git@github.com:foo/bar.git');
    expect(() => buildAuthenticatedUrl(parsed, 'tok')).toThrow();
  });

  it('refuses an empty token', () => {
    const parsed = classifyCloneUrl('https://github.com/foo/bar.git');
    expect(() => buildAuthenticatedUrl(parsed, '')).toThrow();
  });
});

describe('redactToken', () => {
  it('replaces every occurrence of the token with ***', () => {
    const text = 'fatal: bad credentials https://x-access-token:ghu_abcdef@github.com/foo/bar';
    const out = redactToken(text, 'ghu_abcdef');
    expect(out).not.toContain('ghu_abcdef');
    expect(out).toContain('***');
  });

  it('handles tokens with regex specials safely', () => {
    const tok = 'tok+special.value$';
    const out = redactToken(`error involving ${tok} twice: ${tok}`, tok);
    expect(out).toBe('error involving *** twice: ***');
  });

  it('passes text through when token is null/empty/very short', () => {
    expect(redactToken('hello main world', null)).toBe('hello main world');
    expect(redactToken('hello main world', '')).toBe('hello main world');
    expect(redactToken('hello main world', 'main')).toBe('hello main world');
  });
});

describe('SSH_NOT_SUPPORTED_MESSAGE', () => {
  it('mentions HTTPS as the alternative', () => {
    expect(SSH_NOT_SUPPORTED_MESSAGE.toLowerCase()).toContain('https');
  });

  it('points the user at the Settings → GitHub connect flow', () => {
    // The route's stderr-mapping branch reuses this message verbatim,
    // so dropping the actionable hint here would silently regress the
    // user-facing error without breaking any other test.
    expect(SSH_NOT_SUPPORTED_MESSAGE).toContain('Settings');
    expect(SSH_NOT_SUPPORTED_MESSAGE).toContain('GitHub');
  });
});
