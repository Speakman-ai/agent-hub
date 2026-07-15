import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'crypto';
import {
  normalizePemPrivateKey,
  isValidGithubAppPrivateKey,
  generateJWT,
  getInstallationToken,
  getInstallationTokenForOwner,
  resolveInstallationId,
  clearTokenCache,
} from './github-app.js';

// A throwaway RSA keypair so JWT signing/verification is real (no network).
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// A PKCS#1 ("BEGIN RSA PRIVATE KEY") key to prove both PEM flavours validate.
const { privateKey: pkcs1PrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

// A valid EC private key — parses fine, but the App JWT is hard-coded RS256, so
// it must be rejected as an App key.
const { privateKey: ecPrivateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('isValidGithubAppPrivateKey', () => {
  it('accepts a real PKCS#8 private key', () => {
    expect(isValidGithubAppPrivateKey(privateKey)).toBe(true);
  });

  it('accepts a real PKCS#1 ("RSA PRIVATE KEY") private key', () => {
    expect(isValidGithubAppPrivateKey(pkcs1PrivateKey)).toBe(true);
  });

  it('accepts a key mangled with escaped \\n (same normalization as signing)', () => {
    expect(isValidGithubAppPrivateKey(privateKey.replace(/\n/g, '\\n'))).toBe(true);
  });

  it('rejects a pasted PUBLIC key', () => {
    expect(isValidGithubAppPrivateKey(publicKey)).toBe(false);
  });

  it('rejects a valid non-RSA (EC) private key — the App JWT is hard-coded RS256', () => {
    expect(isValidGithubAppPrivateKey(ecPrivateKey)).toBe(false);
  });

  it('rejects a truncated / typo PEM', () => {
    expect(
      isValidGithubAppPrivateKey(
        '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----',
      ),
    ).toBe(false);
  });

  it('rejects empty / arbitrary text', () => {
    expect(isValidGithubAppPrivateKey('')).toBe(false);
    expect(isValidGithubAppPrivateKey('not a key at all')).toBe(false);
  });
});

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('normalizePemPrivateKey', () => {
  it('converts escaped newlines from env/config transport into real newlines', () => {
    const escaped = privateKey.replace(/\n/g, '\\n');
    const out = normalizePemPrivateKey(escaped);
    expect(out).not.toContain('\\n'); // no literal backslash-n survives
    expect(out.trim()).toBe(privateKey.trim());
  });

  it('strips surrounding JSON quotes accidentally pasted into config fields', () => {
    const out = normalizePemPrivateKey(`"${privateKey}"`);
    expect(out.startsWith('"')).toBe(false);
    expect(out.trim()).toBe(privateKey.trim());
  });

  it('normalizes CRLF and a leading BOM', () => {
    const crlf = '\uFEFF' + privateKey.replace(/\n/g, '\r\n');
    const out = normalizePemPrivateKey(crlf);
    expect(out).not.toContain('\r');
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    expect(out.trim()).toBe(privateKey.trim());
  });
});

describe('generateJWT', () => {
  it('produces a 3-part RS256 JWT with iss=appId and a verifiable signature', () => {
    const jwt = generateJWT('123456', privateKey);
    const [h, p, sig] = jwt.split('.');
    expect(h && p && sig).toBeTruthy();

    const header = decodeJwtPart(h);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });

    const payload = decodeJwtPart(p) as { iss: string; iat: number; exp: number };
    expect(payload.iss).toBe('123456');
    // iat backdated 60s for clock skew; exp is 10 min out (GitHub max).
    expect(payload.exp - payload.iat).toBe(660);

    const verify = createVerify('RSA-SHA256');
    verify.update(`${h}.${p}`);
    expect(verify.verify(publicKey, sig, 'base64url')).toBe(true);
  });

  it('accepts a numeric app id', () => {
    const payload = decodeJwtPart(generateJWT(999, privateKey).split('.')[1]);
    expect(payload.iss).toBe('999');
  });
});

describe('getInstallationToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearTokenCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearTokenCache();
  });

  function okTokenResponse(token: string, expiresInMs = 60 * 60 * 1000): Response {
    return new Response(
      JSON.stringify({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('POSTs to the installation access-token endpoint with a Bearer JWT', async () => {
    fetchMock.mockResolvedValue(okTokenResponse('ghs_minted'));
    const token = await getInstallationToken('123', privateKey, '42');
    expect(token).toBe('ghs_minted');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(init.method).toBe('POST');
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer /);
  });

  it('caches the token and does not re-fetch while it is comfortably valid', async () => {
    fetchMock.mockResolvedValue(okTokenResponse('ghs_cached'));
    await getInstallationToken('123', privateKey, '42');
    const second = await getInstallationToken('123', privateKey, '42');
    expect(second).toBe('ghs_cached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the cached token is within 5 minutes of expiry', async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse('ghs_soon', 4 * 60 * 1000)); // expires in 4m
    fetchMock.mockResolvedValueOnce(okTokenResponse('ghs_fresh'));
    const first = await getInstallationToken('123', privateKey, '42');
    const second = await getInstallationToken('123', privateKey, '42');
    expect(first).toBe('ghs_soon');
    expect(second).toBe('ghs_fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws with the status and body on a non-2xx from GitHub', async () => {
    fetchMock.mockResolvedValue(new Response('bad app', { status: 401 }));
    await expect(getInstallationToken('123', privateKey, '42')).rejects.toThrow(/401/);
  });
});

describe('resolveInstallationId', () => {
  it('returns null for a null config', () => {
    expect(resolveInstallationId(null)).toBeNull();
  });

  it('prefers a per-owner installation match (case-insensitive)', () => {
    const id = resolveInstallationId(
      {
        appId: '1',
        privateKey: 'k',
        installationId: 'default-999',
        installations: [
          { account: 'other', id: 'inst-1' },
          { account: 'Acme', id: 'inst-2' },
        ],
      },
      'acme',
    );
    expect(id).toBe('inst-2');
  });

  it('falls back to the global installationId when no owner matches', () => {
    const id = resolveInstallationId(
      { appId: '1', privateKey: 'k', installationId: 'default-999', installations: [] },
      'nobody',
    );
    expect(id).toBe('default-999');
  });

  it('returns null when neither a match nor a global id exists', () => {
    expect(resolveInstallationId({ appId: '1', privateKey: 'k' }, 'acme')).toBeNull();
  });
});

describe('getInstallationTokenForOwner (graceful degradation)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearTokenCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearTokenCache();
  });

  it('returns null (never throws) when the app is not configured', async () => {
    expect(await getInstallationTokenForOwner(null, 'acme')).toBeNull();
    expect(await getInstallationTokenForOwner({ appId: '1' }, 'acme')).toBeNull(); // no privateKey
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when no installation resolves for the owner', async () => {
    const token = await getInstallationTokenForOwner(
      { appId: '1', privateKey, installations: [{ account: 'other', id: 'x' }] },
      'acme',
    );
    expect(token).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints a token when an installation resolves', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'ghs_owner',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    const token = await getInstallationTokenForOwner(
      { appId: '1', privateKey, installationId: '77' },
      'acme',
    );
    expect(token).toBe('ghs_owner');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null (swallows) when GitHub rejects the mint', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));
    const token = await getInstallationTokenForOwner(
      { appId: '1', privateKey, installationId: '77' },
      'acme',
    );
    expect(token).toBeNull();
  });
});
