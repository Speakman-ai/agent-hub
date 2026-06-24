import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROTECTION_EXPIRY_MINUTES,
  MAX_PROTECTION_EXPIRY_MINUTES,
  ecsTaskProtection,
  noopTaskProtection,
  resolveProtectionExpiryMinutes,
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

describe('resolveProtectionExpiryMinutes (FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES)', () => {
  const saved = process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES;
  afterEach(() => {
    if (saved === undefined) delete process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES;
    else process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES = saved;
  });

  it('defaults to 15 when unset', () => {
    delete process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES;
    expect(resolveProtectionExpiryMinutes()).toBe(DEFAULT_PROTECTION_EXPIRY_MINUTES);
  });

  it('reads the env (prod sets 40 to cover long shards through a dynamic shrink)', () => {
    process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES = '40';
    expect(resolveProtectionExpiryMinutes()).toBe(40);
  });

  it('coerces sub-1 / non-numeric to the default (never arm a zero/garbage lease)', () => {
    for (const bad of ['0', '-5', 'forty', '']) {
      process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES = bad;
      expect(resolveProtectionExpiryMinutes()).toBe(DEFAULT_PROTECTION_EXPIRY_MINUTES);
    }
  });

  it('clamps above the ECS limit (2880) so the protection call can never fail', () => {
    process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES = '5000';
    expect(resolveProtectionExpiryMinutes()).toBe(MAX_PROTECTION_EXPIRY_MINUTES);
    process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES = '2880';
    expect(resolveProtectionExpiryMinutes()).toBe(2880);
  });

  it('ecsTaskProtection PUTs the env-resolved expiry when no explicit opt is passed', async () => {
    process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES = '40';
    const fetchImpl = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: true, status: 200 } as unknown as Response),
    );
    const tp = ecsTaskProtection({ agentUri: 'http://agent', fetchImpl });
    await tp.set(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toMatchObject({
      ProtectionEnabled: true,
      ExpiresInMinutes: 40,
    });
  });
});

describe('noopTaskProtection', () => {
  it('resolves without doing anything', async () => {
    await expect(noopTaskProtection().set(true)).resolves.toBeUndefined();
    await expect(noopTaskProtection().set(false)).resolves.toBeUndefined();
  });
});
