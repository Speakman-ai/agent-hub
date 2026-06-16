import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractGrokDeviceUrl,
  extractGrokDeviceUserCode,
  detectGrokAuthMode,
  computeGrokUiStatus,
} from './grok-device-auth-parse.js';

describe('extractGrokDeviceUrl', () => {
  it('pulls an auth.x.ai device URL out of a banner', () => {
    const banner = [
      'To authenticate, open the following URL in your browser:',
      '',
      '  https://auth.x.ai/device?user_code=ABCD-EFGH',
      '',
      'and enter the code shown below.',
    ].join('\n');
    expect(extractGrokDeviceUrl(banner)).toBe('https://auth.x.ai/device?user_code=ABCD-EFGH');
  });

  it('matches a grok.com verification URL', () => {
    expect(extractGrokDeviceUrl('Open https://grok.com/activate to continue')).toBe(
      'https://grok.com/activate',
    );
  });

  it('strips ANSI color codes before matching', () => {
    const colored = 'Visit [36mhttps://auth.x.ai/device[0m now';
    expect(extractGrokDeviceUrl(colored)).toBe('https://auth.x.ai/device');
  });

  it('returns null before any URL is printed', () => {
    expect(extractGrokDeviceUrl('Starting device authorization…')).toBeNull();
  });

  it('ignores unrelated (non-xAI) URLs', () => {
    expect(extractGrokDeviceUrl('see https://example.com/help')).toBeNull();
  });

  it('accepts deeper xAI subdomains', () => {
    expect(extractGrokDeviceUrl('go to https://accounts.x.ai/oauth/device')).toBe(
      'https://accounts.x.ai/oauth/device',
    );
  });

  it('rejects look-alike hosts that merely embed x.ai / grok.com as a substring', () => {
    // The apex appears as a label prefix, not the registrable domain — a
    // substring matcher would wrongly accept these and hand an attacker
    // origin to window.open. Hostname parsing must reject them.
    expect(extractGrokDeviceUrl('open https://x.ai.evil.example/device')).toBeNull();
    expect(extractGrokDeviceUrl('open https://grok.com.evil.example/device')).toBeNull();
    expect(extractGrokDeviceUrl('open https://notx.ai/device')).toBeNull();
    expect(extractGrokDeviceUrl('open https://evil.example/?u=https://auth.x.ai')).toBeNull();
  });

  it('strips trailing prose punctuation from a matched URL', () => {
    expect(extractGrokDeviceUrl('Visit https://auth.x.ai/device.')).toBe(
      'https://auth.x.ai/device',
    );
  });

  it('skips a spoofed URL and returns a later genuine xAI URL', () => {
    const banner = 'decoy https://x.ai.evil.example/a then https://auth.x.ai/device';
    expect(extractGrokDeviceUrl(banner)).toBe('https://auth.x.ai/device');
  });
});

describe('extractGrokDeviceUserCode', () => {
  it('extracts a labeled code', () => {
    expect(extractGrokDeviceUserCode('Enter this code: WXYZ-1234')).toBe('WXYZ-1234');
  });

  it('extracts a loose hyphenated code when unlabeled', () => {
    const banner = 'https://auth.x.ai/device\n\n   ABCD-EFGH\n';
    expect(extractGrokDeviceUserCode(banner)).toBe('ABCD-EFGH');
  });

  it('uppercases a lowercase code', () => {
    expect(extractGrokDeviceUserCode('code abcd-efgh')).toBe('ABCD-EFGH');
  });

  it('returns null when no code is present', () => {
    expect(extractGrokDeviceUserCode('waiting for code…')).toBeNull();
  });
});

describe('detectGrokAuthMode', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const writeAuth = (contents: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'grok-auth-'));
    const grokHome = join(dir, '.grok');
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, 'auth.json'), contents);
    return grokHome;
  };

  it('reports oauth when access/refresh tokens are present', () => {
    const home = writeAuth(JSON.stringify({ access_token: 'a', refresh_token: 'r' }));
    const info = detectGrokAuthMode(home);
    expect(info).toMatchObject({ mode: 'oauth', present: true });
  });

  it('reports oauth for a nested tokens object with a non-empty token', () => {
    const home = writeAuth(JSON.stringify({ tokens: { access_token: 'a' } }));
    expect(detectGrokAuthMode(home).mode).toBe('oauth');
  });

  it('does NOT report oauth for an empty/placeholder tokens object', () => {
    const home = writeAuth(JSON.stringify({ tokens: {} }));
    expect(detectGrokAuthMode(home)).toMatchObject({ mode: 'unknown', present: true });
  });

  it('does NOT report oauth when nested tokens are present but blank', () => {
    const home = writeAuth(JSON.stringify({ tokens: { access_token: '', refresh_token: '  ' } }));
    expect(detectGrokAuthMode(home).mode).toBe('unknown');
  });

  it('falls through to apikey when tokens is an empty object but a key exists', () => {
    const home = writeAuth(JSON.stringify({ tokens: {}, api_key: 'xai-123' }));
    expect(detectGrokAuthMode(home).mode).toBe('apikey');
  });

  it('reports apikey when only a persisted key is present', () => {
    const home = writeAuth(JSON.stringify({ api_key: 'xai-123' }));
    expect(detectGrokAuthMode(home).mode).toBe('apikey');
  });

  it('prefers oauth when both token and key shapes appear', () => {
    const home = writeAuth(JSON.stringify({ access_token: 'a', api_key: 'xai-123' }));
    expect(detectGrokAuthMode(home).mode).toBe('oauth');
  });

  it('returns present+unknown for an empty object', () => {
    const home = writeAuth('{}');
    expect(detectGrokAuthMode(home)).toMatchObject({ mode: 'unknown', present: true });
  });

  it('returns absent for a missing file (never throws)', () => {
    const info = detectGrokAuthMode(join(tmpdir(), 'definitely-missing-grok-home'));
    expect(info).toMatchObject({ mode: 'unknown', present: false });
  });

  it('returns absent for malformed JSON (never throws)', () => {
    const home = writeAuth('{ not json');
    expect(detectGrokAuthMode(home)).toMatchObject({ mode: 'unknown', present: false });
  });
});

describe('computeGrokUiStatus', () => {
  const base = {
    binaryPresent: true,
    loginInProgress: false,
    apiKeyConfigured: false,
    oauthFromFile: false,
  };

  it('is missing when the binary is absent', () => {
    expect(computeGrokUiStatus({ ...base, binaryPresent: false, oauthFromFile: true })).toBe(
      'missing',
    );
  });

  it('is pending while a login is in flight', () => {
    expect(computeGrokUiStatus({ ...base, loginInProgress: true })).toBe('pending');
  });

  it('is authenticated with an on-disk OAuth token', () => {
    expect(computeGrokUiStatus({ ...base, oauthFromFile: true })).toBe('authenticated');
  });

  it('is authenticated with a pasted API key', () => {
    expect(computeGrokUiStatus({ ...base, apiKeyConfigured: true })).toBe('authenticated');
  });

  it('is missing with a binary but no credentials', () => {
    expect(computeGrokUiStatus(base)).toBe('missing');
  });
});
