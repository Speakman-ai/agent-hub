import { describe, it, expect } from 'vitest';
import { buildPreviewSubdomainHost, parsePreviewSubdomainHost } from './preview-subdomain-host.js';

const SID = 'b371b1ba-37d3-4a10-8b44-40bd1cddcc6d';
const BASE = 'preview.agenthub.dev.surveytracker.io';

describe('parsePreviewSubdomainHost', () => {
  it('returns null when subdomain mode is off (base unset)', () => {
    // The whole feature is opt-in via env. With no base, the parser
    // MUST short-circuit so we never accidentally dispatch by host.
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, undefined)).toBeNull();
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, null)).toBeNull();
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, '')).toBeNull();
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, '   ')).toBeNull();
  });

  it('returns null when host is missing or non-string', () => {
    expect(parsePreviewSubdomainHost(undefined, BASE)).toBeNull();
    expect(parsePreviewSubdomainHost(null, BASE)).toBeNull();
    expect(parsePreviewSubdomainHost('', BASE)).toBeNull();
    // Express sometimes types req.headers.host as string|string[]; the
    // array form (multiple Host headers) is malformed by spec — refuse.
    expect(parsePreviewSubdomainHost([BASE], BASE)).toBeNull();
  });

  it('returns the session id on a clean match', () => {
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, BASE)).toBe(SID);
  });

  it('lower-cases both the host and base for the comparison', () => {
    // Host headers are case-insensitive per RFC 7230 §5.4; mismatched
    // casing must not gate dispatch.
    expect(parsePreviewSubdomainHost(`${SID.toUpperCase()}.${BASE.toUpperCase()}`, BASE)).toBe(SID);
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, BASE.toUpperCase())).toBe(SID);
  });

  it('strips a trailing :port from both arguments', () => {
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}:8443`, BASE)).toBe(SID);
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, `${BASE}:443`)).toBe(SID);
  });

  it('returns null when the host does not end in the configured base', () => {
    expect(parsePreviewSubdomainHost(`${SID}.preview.other.example`, BASE)).toBeNull();
    // Suffix-substring match without the leading dot would otherwise
    // misfire — e.g. host `xxxhost` matches base `host`. The leading-
    // dot check prevents that.
    const baseShort = 'example.com';
    expect(parsePreviewSubdomainHost(`evilexample.com`, baseShort)).toBeNull();
  });

  it('returns null for a nested subdomain (foo.bar.<base>)', () => {
    // Strict single-label rule: nested labels could conflict with
    // operator vhosts at e.g. `mail.preview.host` and we'd misdispatch
    // them as session previews.
    expect(parsePreviewSubdomainHost(`foo.${SID}.${BASE}`, BASE)).toBeNull();
  });

  it('returns null when the label is not a UUID', () => {
    expect(parsePreviewSubdomainHost(`hello.${BASE}`, BASE)).toBeNull();
    expect(parsePreviewSubdomainHost(`not-a-uuid.${BASE}`, BASE)).toBeNull();
    // 8-4-4-4-11 (one hex short of full UUID) — must NOT match. A
    // hostile actor crafting near-UUIDs to brute-force session ids
    // shouldn't even reach the proxy.
    expect(
      parsePreviewSubdomainHost(`b371b1ba-37d3-4a10-8b44-40bd1cddcc6.${BASE}`, BASE),
    ).toBeNull();
    // 8-4-4-4-13 (one hex too many) — same.
    expect(
      parsePreviewSubdomainHost(`b371b1ba-37d3-4a10-8b44-40bd1cddcc6dd.${BASE}`, BASE),
    ).toBeNull();
  });

  it('returns null when host is exactly the base (no session label at all)', () => {
    expect(parsePreviewSubdomainHost(BASE, BASE)).toBeNull();
  });

  it('handles base with leading or trailing dots gracefully', () => {
    // Operators have been known to write `base.com.` (FQDN with root
    // dot) or `.base.com` in config; normalise both ends defensively.
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, `.${BASE}`)).toBe(SID);
    expect(parsePreviewSubdomainHost(`${SID}.${BASE}`, `${BASE}.`)).toBe(SID);
  });

  it('handles IPv6-in-Host (port-stripping safety)', () => {
    // Synthetic — IPv6 Host headers don't appear in subdomain-preview
    // flows in practice, but the port-strip helper should not blow up
    // on them or accidentally interpret the colons as a port delimiter.
    expect(parsePreviewSubdomainHost(`[::1]:443`, BASE)).toBeNull();
  });
});

describe('buildPreviewSubdomainHost', () => {
  it('returns null when subdomain mode is off (base unset)', () => {
    expect(buildPreviewSubdomainHost(SID, undefined)).toBeNull();
    expect(buildPreviewSubdomainHost(SID, '')).toBeNull();
  });

  it('builds <sid>.<base> on the happy path', () => {
    expect(buildPreviewSubdomainHost(SID, BASE)).toBe(`${SID}.${BASE}`);
  });

  it('lower-cases and trims/de-dot the base', () => {
    expect(buildPreviewSubdomainHost(SID, `  ${BASE.toUpperCase()}.  `)).toBe(`${SID}.${BASE}`);
  });

  it('returns null when sessionId is not a UUID (defensive)', () => {
    // Caller shouldn't pass a non-UUID, but if they do (e.g. cron
    // session id like "cron"), we'd rather return null than build
    // a hostname that won't parse on the receiving side.
    expect(buildPreviewSubdomainHost('cron', BASE)).toBeNull();
    expect(buildPreviewSubdomainHost('not-a-uuid', BASE)).toBeNull();
  });

  it('round-trips with the parser', () => {
    const host = buildPreviewSubdomainHost(SID, BASE);
    expect(host).not.toBeNull();
    expect(parsePreviewSubdomainHost(host!, BASE)).toBe(SID);
  });
});
