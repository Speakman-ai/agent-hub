import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { GetParametersCommand } from '@aws-sdk/client-ssm';
import { resolveSsmRefs, __setSsmClientForTests, __clearSsmCacheForTests } from './ssm-resolver.js';

/**
 * Hand-rolled fake SSMClient — `aws-sdk-client-mock` is not in the
 * server's devDependencies (checked package.json), and the resolver
 * only uses `client.send(GetParametersCommand)`, so a one-method shim
 * is enough.
 *
 * `responder` lets each test program a custom batch response.
 */
function makeFakeClient(
  responder: (names: string[]) => {
    Parameters?: Array<{ Name?: string; Value?: string }>;
    InvalidParameters?: string[];
  },
) {
  const sendSpy = vi.fn(async (cmd: unknown) => {
    if (!(cmd instanceof GetParametersCommand)) {
      throw new Error('unexpected command');
    }
    const names = cmd.input.Names ?? [];
    return responder(names);
  });
  // Cast through unknown — we only implement `.send`, which is all the
  // resolver calls.
  const client = { send: sendSpy } as unknown as SSMClient;
  return { client, sendSpy };
}

describe('resolveSsmRefs', () => {
  beforeEach(() => {
    __clearSsmCacheForTests();
    __setSsmClientForTests(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    __setSsmClientForTests(null);
    __clearSsmCacheForTests();
  });

  it('passes plain string values through unchanged', async () => {
    const { client, sendSpy } = makeFakeClient(() => ({}));
    __setSsmClientForTests(client);

    const out = await resolveSsmRefs({
      UPSTREAM_API_URL: 'https://api.example.com',
      LOG_LEVEL: 'info',
    });

    expect(out).toEqual({
      UPSTREAM_API_URL: 'https://api.example.com',
      LOG_LEVEL: 'info',
    });
    // No SSM call when there are no refs.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('resolves a single ${ssm:/path} reference via SSM', async () => {
    const { client, sendSpy } = makeFakeClient((names) => ({
      Parameters: names.map((n) => ({ Name: n, Value: `value-of-${n}` })),
    }));
    __setSsmClientForTests(client);

    const out = await resolveSsmRefs({
      AWS_ACCESS_KEY_ID: '${ssm:/agent-hub/dev/aws-key}',
      LOG_LEVEL: 'info',
    });

    expect(out).toEqual({
      AWS_ACCESS_KEY_ID: 'value-of-/agent-hub/dev/aws-key',
      LOG_LEVEL: 'info',
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('batches multiple refs into a single SSM call', async () => {
    const { client, sendSpy } = makeFakeClient((names) => ({
      Parameters: names.map((n) => ({ Name: n, Value: `v:${n}` })),
    }));
    __setSsmClientForTests(client);

    const out = await resolveSsmRefs({
      A: '${ssm:/p/a}',
      B: '${ssm:/p/b}',
      C: '${ssm:/p/c}',
      LITERAL: 'literal',
    });

    expect(out).toEqual({
      A: 'v:/p/a',
      B: 'v:/p/b',
      C: 'v:/p/c',
      LITERAL: 'literal',
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const cmd = sendSpy.mock.calls[0][0] as GetParametersCommand;
    expect(cmd.input.Names).toEqual(['/p/a', '/p/b', '/p/c']);
    expect(cmd.input.WithDecryption).toBe(true);
  });

  it('splits >10 refs across multiple GetParameters calls (batch limit)', async () => {
    const { client, sendSpy } = makeFakeClient((names) => ({
      Parameters: names.map((n) => ({ Name: n, Value: `v:${n}` })),
    }));
    __setSsmClientForTests(client);

    const env: Record<string, string> = {};
    for (let i = 0; i < 12; i++) env[`K_${i}`] = `\${ssm:/p/${i}}`;

    const out = await resolveSsmRefs(env);

    expect(out['K_0']).toBe('v:/p/0');
    expect(out['K_11']).toBe('v:/p/11');
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('serves cached values within the 60s TTL (no second SSM call)', async () => {
    const { client, sendSpy } = makeFakeClient((names) => ({
      Parameters: names.map((n) => ({ Name: n, Value: `v:${n}` })),
    }));
    __setSsmClientForTests(client);

    const env = { AWS_KEY: '${ssm:/agent-hub/key}' };

    const first = await resolveSsmRefs(env);
    const second = await resolveSsmRefs(env);

    expect(first).toEqual({ AWS_KEY: 'v:/agent-hub/key' });
    expect(second).toEqual({ AWS_KEY: 'v:/agent-hub/key' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches after the cache TTL expires (>60s)', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(startedAt);

    let counter = 0;
    const { client, sendSpy } = makeFakeClient((names) => {
      counter += 1;
      return {
        Parameters: names.map((n) => ({ Name: n, Value: `v${counter}:${n}` })),
      };
    });
    __setSsmClientForTests(client);

    const env = { AWS_KEY: '${ssm:/agent-hub/key}' };

    const first = await resolveSsmRefs(env);
    expect(first.AWS_KEY).toBe('v1:/agent-hub/key');

    // Advance 61 seconds — past the 60 s cache TTL.
    vi.setSystemTime(startedAt + 61_000);

    const second = await resolveSsmRefs(env);
    expect(second.AWS_KEY).toBe('v2:/agent-hub/key');
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error when a parameter is missing (InvalidParameters)', async () => {
    const { client } = makeFakeClient((names) => ({
      Parameters: [],
      InvalidParameters: names,
    }));
    __setSsmClientForTests(client);

    await expect(resolveSsmRefs({ MISSING: '${ssm:/does/not/exist}' })).rejects.toThrow(
      /does\/not\/exist/,
    );
  });

  it('propagates underlying SDK errors (e.g. AccessDenied)', async () => {
    const sendSpy = vi.fn(async () => {
      throw new Error('AccessDeniedException: not authorized');
    });
    const client = { send: sendSpy } as unknown as SSMClient;
    __setSsmClientForTests(client);

    await expect(resolveSsmRefs({ AWS_KEY: '${ssm:/secure/key}' })).rejects.toThrow(/AccessDenied/);
  });

  it('treats malformed/mixed values as literals (validator catches them upstream)', async () => {
    // The validator rejects mixed strings before they reach the
    // resolver, but defensively the resolver must NOT attempt to
    // partially substitute. A value that is not a full-token ref is
    // returned verbatim.
    const { client, sendSpy } = makeFakeClient(() => ({}));
    __setSsmClientForTests(client);

    const out = await resolveSsmRefs({
      MIXED: 'prefix-${ssm:/x}',
      EMPTY_BRACES: '${ssm:}',
    });
    expect(out).toEqual({
      MIXED: 'prefix-${ssm:/x}',
      EMPTY_BRACES: '${ssm:}',
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
