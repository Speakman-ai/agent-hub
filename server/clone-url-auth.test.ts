import { describe, it, expect } from 'vitest';
import {
  classifyCloneUrl,
  buildAuthenticatedUrl,
  redactToken,
  redactAuthHeader,
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

describe('redactAuthHeader', () => {
  // The production incident on 2026-05-14 17:16:40 leaked a live `gho_`
  // OAuth token via the spawned-process argv echo of the
  // `-c http.<host>.extraheader=Authorization: basic <BASE64>` arg —
  // because the secret in that echo is base64-encoded, the raw-token
  // pass `redactToken` ran in the catch handler missed it entirely.
  // This suite locks in the regex that catches that leak shape.

  it('redacts the basic-auth extraheader argv form (production-incident regression)', () => {
    // `Buffer.from('x-access-token:gho_secret_value_with_padding', 'utf8').toString('base64')`
    // produces a string ending in `==` padding — matches the real leak shape.
    const argv =
      'Command failed: git -c http.https://github.com/.extraheader=Authorization: basic eC1hY2Nlc3MtdG9rZW46Z2hvX3NlY3JldF92YWx1ZV93aXRoX3BhZGRpbmc= clone --depth 1 --quiet https://github.com/owner/repo.git /tmp/sessions/session-abc';
    const out = redactAuthHeader(argv);
    expect(out).not.toContain('eC1hY2Nlc3M');
    expect(out).toContain('Authorization: basic ***');
    // Surrounding context — both the upstream `-c http.…extraheader=`
    // anchor and the trailing git args — must survive so operators can
    // still diagnose the failure.
    expect(out).toContain('-c http.https://github.com/.extraheader=Authorization: basic ***');
    expect(out).toContain('clone --depth 1 --quiet https://github.com/owner/repo.git');
  });

  it('redacts a bearer-auth header echo', () => {
    const text = 'fatal: Authorization: Bearer ghs_installationtokenvalue not accepted';
    const out = redactAuthHeader(text);
    expect(out).not.toContain('ghs_installationtokenvalue');
    expect(out).toBe('fatal: Authorization: Bearer *** not accepted');
  });

  it('matches case-insensitively on the Authorization keyword', () => {
    const text = 'header authorization: basic eC1hY2Nlc3M= rejected';
    const out = redactAuthHeader(text);
    expect(out).not.toContain('eC1hY2Nlc3M');
    // Preserves the original casing of the keyword for debuggability.
    expect(out).toBe('header authorization: basic *** rejected');
  });

  it('handles a header at end-of-string with no trailing whitespace', () => {
    const text = 'Authorization: basic eC1hY2Nlc3M=';
    expect(redactAuthHeader(text)).toBe('Authorization: basic ***');
  });

  it('handles a header wrapped in single quotes', () => {
    const text = "args: 'Authorization: basic eC1hY2Nlc3M=' then more";
    const out = redactAuthHeader(text);
    expect(out).not.toContain('eC1hY2Nlc3M');
    expect(out).toBe("args: 'Authorization: basic ***' then more");
  });

  it('redacts multiple Authorization headers in the same string', () => {
    const text = 'try1 Authorization: basic AAAAAA= retry Authorization: bearer BBBBBB now';
    const out = redactAuthHeader(text);
    expect(out).not.toContain('AAAAAA');
    expect(out).not.toContain('BBBBBB');
    expect(out).toBe('try1 Authorization: basic *** retry Authorization: bearer *** now');
  });

  it('is a no-op when no Authorization header is present', () => {
    const text = 'fatal: Write access to repository not granted. remote: 403';
    expect(redactAuthHeader(text)).toBe(text);
  });

  it('is a no-op on empty input', () => {
    expect(redactAuthHeader('')).toBe('');
  });

  it('layers correctly with redactToken (raw + header form both stripped)', () => {
    // Realistic catch-handler shape: a `gho_` token leaks BOTH as the
    // raw value (e.g. embedded in a URL) and as the base64-encoded form
    // inside the extraheader argv. The defence-in-depth chain in
    // `server/worktree.ts` runs `redactToken` first, then this helper.
    const token = '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';
    const basicPayload = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    const raw =
      `Command failed: git -c http.https://github.com/.extraheader=Authorization: basic ${basicPayload} ` +
      `clone --depth 1 --quiet https://x-access-token:${token}@github.com/owner/repo.git /tmp/foo`;
    const layered = redactAuthHeader(redactToken(raw, token));
    expect(layered).not.toContain(token);
    expect(layered).not.toContain(basicPayload);
    expect(layered).toContain('Authorization: basic ***');
    // The userinfo `x-access-token:***@github.com/...` form falls to the
    // first pass (token-substring match), so it is also redacted.
    expect(layered).toContain('https://x-access-token:***@github.com/owner/repo.git');
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
