import { describe, it, expect } from 'vitest';
import {
  isServerOriginChange,
  normalizeServerUrl,
  resolveActiveOrgLoginServer,
  resolveLoginServerOptions,
  serverOrigin,
  validateServerUrl,
} from './loginServerPicker';

const orgs = [
  { id: 'a', name: 'Acme', mode: 'remote', remote_url: 'https://acme.example.com/' },
  { id: 'b', name: 'Beta', mode: 'remote', remote_url: 'https://beta.example.com' },
  { id: 'l', name: 'Local', mode: 'local' },
];

describe('normalizeServerUrl', () => {
  it('trims, strips trailing slashes, and defaults to https', () => {
    expect(normalizeServerUrl('  hub.example.com/ ')).toBe('https://hub.example.com');
    expect(normalizeServerUrl('http://localhost:3051//')).toBe('http://localhost:3051');
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl(undefined)).toBe('');
  });

  it('does not turn a bare scheme into a bogus https://https: URL', () => {
    expect(normalizeServerUrl('https://')).toBe('');
    expect(normalizeServerUrl('http:/')).toBe('');
  });
});

describe('validateServerUrl', () => {
  it('rejects empty and malformed input, accepts hostnames', () => {
    expect(validateServerUrl('')).toMatch(/required/i);
    expect(validateServerUrl('https://')).toBeTruthy();
    expect(validateServerUrl('hub.example.com')).toBeNull();
  });
});

describe('resolveLoginServerOptions', () => {
  it('matches the current org by connection URL (ignoring trailing slash) and lists the rest', () => {
    const res = resolveLoginServerOptions({
      connection: { mode: 'remote', remoteUrl: 'https://acme.example.com' },
      orgs,
      activeOrgId: 'b', // stale active id must not win over the live URL
    });
    expect(res.current).toEqual({ id: 'a', name: 'Acme', url: 'https://acme.example.com' });
    expect(res.others.map((o) => o.id)).toEqual(['b']);
  });

  it('synthesizes a current entry when the connection URL is not bookmarked', () => {
    // ConnectFirstScreen writes connection.json without creating a bookmark.
    const res = resolveLoginServerOptions({
      connection: { mode: 'remote', remoteUrl: 'https://solo.example.com/' },
      orgs,
      activeOrgId: null,
    });
    expect(res.current).toEqual({
      id: null,
      name: 'solo.example.com',
      url: 'https://solo.example.com',
    });
    expect(res.others.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('falls back to the active org when the connection has no URL', () => {
    const res = resolveLoginServerOptions({
      connection: { mode: 'remote', remoteUrl: '' },
      orgs,
      activeOrgId: 'b',
    });
    expect(res.current.id).toBe('b');
    expect(res.others.map((o) => o.id)).toEqual(['a']);
  });

  it('reports local mode as this computer even when a stale active id names a remote org', () => {
    // "Use local server" clears the connection but leaves the active org id.
    const res = resolveLoginServerOptions({
      connection: { mode: 'local', remoteUrl: '' },
      orgs,
      activeOrgId: 'b',
    });
    expect(res.current).toEqual({ id: null, name: 'This computer', url: '' });
    // The stale bookmark stays reachable as a switch target.
    expect(res.others.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('reports local mode when there is neither a URL nor an active remote org', () => {
    const res = resolveLoginServerOptions({
      connection: { mode: 'local', remoteUrl: '' },
      orgs: [],
    });
    expect(res.current).toEqual({ id: null, name: 'This computer', url: '' });
    expect(res.others).toEqual([]);
  });
});

describe('isServerOriginChange', () => {
  it('flags a different host, scheme, or port as a new server', () => {
    expect(isServerOriginChange('https://acme.example.com', 'https://other.example.com')).toBe(
      true,
    );
    expect(isServerOriginChange('http://acme.example.com', 'https://acme.example.com')).toBe(true);
    expect(isServerOriginChange('https://acme.example.com', 'acme.example.com:8443')).toBe(true);
    expect(isServerOriginChange('', 'https://acme.example.com')).toBe(true);
  });

  it('treats a path, case, or trailing-slash edit on the same origin as the same server', () => {
    expect(isServerOriginChange('https://acme.example.com', 'ACME.example.com/')).toBe(false);
    expect(isServerOriginChange('https://acme.example.com', 'https://acme.example.com/hub')).toBe(
      false,
    );
    expect(serverOrigin('acme.example.com/hub/')).toBe('https://acme.example.com');
  });
});

describe('resolveActiveOrgLoginServer (mobile)', () => {
  const mobileOrgs = [
    { id: 'a', name: 'Acme', remoteUrl: 'https://acme.example.com/' },
    { id: 'b', name: 'Beta', remoteUrl: 'https://beta.example.com' },
    { id: 'empty', name: 'Unconfigured', remoteUrl: '' },
  ];

  it('returns the active org and the other connectable orgs', () => {
    const res = resolveActiveOrgLoginServer({ activeOrgId: 'a', orgs: mobileOrgs });
    expect(res?.current).toEqual({ id: 'a', name: 'Acme', url: 'https://acme.example.com' });
    // Orgs without a URL can't be signed in to, so they're not offered.
    expect(res?.others.map((o) => o.id)).toEqual(['b']);
  });

  it('falls back to the first org when the active id is missing', () => {
    const res = resolveActiveOrgLoginServer({ activeOrgId: 'nope', orgs: mobileOrgs });
    expect(res?.current.id).toBe('a');
    expect(res?.others.map((o) => o.id)).toEqual(['b']);
  });

  it('returns null for an empty or missing orgs state', () => {
    expect(resolveActiveOrgLoginServer(null)).toBeNull();
    expect(resolveActiveOrgLoginServer({ orgs: [] })).toBeNull();
  });
});
