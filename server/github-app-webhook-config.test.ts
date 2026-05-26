import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { getAppWebhookConfig, patchAppWebhookSecret } from './github-app.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

describe('getAppWebhookConfig', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('hits /app/hook/config with a Bearer JWT and returns the parsed body', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: 'https://hub.example/api/webhooks/github',
          content_type: 'json',
          insecure_ssl: '0',
          secret: '********',
        }),
        { status: 200 },
      ),
    );

    const config = await getAppWebhookConfig('123', privateKey);

    expect(config).toEqual({
      url: 'https://hub.example/api/webhooks/github',
      content_type: 'json',
      insecure_ssl: '0',
      secret: '********',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/app/hook/config');
    const headers = (opts as RequestInit)?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers.Accept).toBe('application/vnd.github+json');
  });

  it('throws when GitHub returns non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not allowed', { status: 403 }));
    await expect(getAppWebhookConfig('123', privateKey)).rejects.toThrow(/403.*not allowed/);
  });
});

describe('patchAppWebhookSecret', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('PATCHes /app/hook/config with the new secret in the body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

    await patchAppWebhookSecret('123', privateKey, 'fresh-secret-xyz');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/app/hook/config');
    expect((opts as RequestInit)?.method).toBe('PATCH');
    const headers = (opts as RequestInit)?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse((opts as RequestInit)?.body as string);
    expect(body).toEqual({ secret: 'fresh-secret-xyz' });
  });

  it('accepts a JSON-escaped private key (literal \\n) when signing JWT', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));
    const escapedKey = privateKey.replace(/\n/g, '\\n');

    await patchAppWebhookSecret('123', escapedKey, 'fresh-secret-xyz');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0];
    const headers = (opts as RequestInit)?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
  });

  it('refuses to push an empty secret', async () => {
    await expect(patchAppWebhookSecret('123', privateKey, '')).rejects.toThrow(
      /refusing to set an empty/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when GitHub rejects the PATCH', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(patchAppWebhookSecret('123', privateKey, 'whatever-secret')).rejects.toThrow(
      /403.*forbidden/,
    );
  });
});
