import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROTECTION_EXPIRY_MINUTES,
  ecsTaskProtection,
  noopTaskProtection,
} from './ecs-task-protection.js';

describe('ecsTaskProtection', () => {
  const okFetch = () =>
    vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: true, status: 200 } as unknown as Response),
    );
  const bodyOf = (init?: RequestInit) => JSON.parse(init!.body as string);

  it('no-ops (never fetches) when no agent URI is configured', async () => {
    const fetchImpl = okFetch();
    // Explicit empty agentUri (don't depend on the ambient env).
    const tp = ecsTaskProtection({ agentUri: '', fetchImpl });
    await tp.set(true);
    await tp.set(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('PUTs ProtectionEnabled:true with an expiry when protecting', async () => {
    const fetchImpl = okFetch();
    const tp = ecsTaskProtection({ agentUri: 'http://169.254.170.2/v2', fetchImpl });
    await tp.set(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://169.254.170.2/v2/task-protection/v1/state');
    expect(init).toMatchObject({ method: 'PUT' });
    expect(bodyOf(init)).toEqual({
      ProtectionEnabled: true,
      ExpiresInMinutes: DEFAULT_PROTECTION_EXPIRY_MINUTES,
    });
  });

  it('PUTs ProtectionEnabled:false (no expiry) when releasing', async () => {
    const fetchImpl = okFetch();
    const tp = ecsTaskProtection({ agentUri: 'http://agent', fetchImpl });
    await tp.set(false);
    expect(bodyOf(fetchImpl.mock.calls[0][1])).toEqual({ ProtectionEnabled: false });
  });

  it('honors a custom expiry and trims a trailing slash on the agent URI', async () => {
    const fetchImpl = okFetch();
    const tp = ecsTaskProtection({ agentUri: 'http://agent/', expiresInMinutes: 42, fetchImpl });
    await tp.set(true);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://agent/task-protection/v1/state');
    expect(bodyOf(fetchImpl.mock.calls[0][1])).toMatchObject({ ExpiresInMinutes: 42 });
  });

  it('throws on a non-2xx response so callers can swallow it as best-effort', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    const tp = ecsTaskProtection({ agentUri: 'http://agent', fetchImpl });
    await expect(tp.set(true)).rejects.toThrow(/task-protection set failed: HTTP 403/);
  });
});

describe('noopTaskProtection', () => {
  it('resolves without doing anything', async () => {
    await expect(noopTaskProtection().set(true)).resolves.toBeUndefined();
    await expect(noopTaskProtection().set(false)).resolves.toBeUndefined();
  });
});
