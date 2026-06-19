import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api.js';
import { setToken, clearToken } from './auth.js';

/**
 * Regression coverage for the PDF/binary-attachment upload auth bug.
 *
 * Before: `api.uploadFile` built its own fetch (the body is a raw Blob, not
 * JSON, so it bypasses fetchJSON) but only set Content-Type + X-Filename. It
 * never attached auth headers, so on a JWT-enabled deployment the upload
 * arrived with no credentials and the server returned 401 "Authentication
 * required. Provide a bearer token via Authorization header." — surfaced to
 * the user as "Attachment upload failed: ...". PDFs attach as type 'file',
 * which routes through uploadFile, so they always failed.
 *
 * After: uploadFile spreads getAuthHeaders() into its request, matching the
 * fetchJSON pattern every other request uses.
 */
describe('api.uploadFile — auth headers', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    clearToken();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    clearToken();
  });

  function okResponse() {
    return new Response(JSON.stringify({ url: '/uploads/x.pdf', filename: 'x.pdf' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('attaches the JWT bearer token when a token is present', async () => {
    setToken({ token: 'jwt-abc', expiresAt: null, user: { role: 'Owner' } });
    fetchSpy.mockResolvedValue(okResponse());

    const file = new File([new Uint8Array([1, 2, 3])], 'doc.pdf', { type: 'application/pdf' });
    await api.uploadFile(file);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/upload\/file$/);
    expect(init.headers.Authorization).toBe('Bearer jwt-abc');
    expect(init.headers['Content-Type']).toBe('application/pdf');
    expect(init.headers['X-Filename']).toBe('doc.pdf');
  });

  it('throws the server error message when the upload is rejected (401)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Authentication required. Provide a bearer token via Authorization header.',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const file = new File([new Uint8Array([1])], 'doc.pdf', { type: 'application/pdf' });
    await expect(api.uploadFile(file)).rejects.toThrow(/Authentication required/);
  });
});
