import { describe, it, expect, vi } from 'vitest';
import {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
} from '@aws-sdk/client-s3';
import { createS3LifecyclePort, provisionRumLifecycle } from './replay-lifecycle-s3.js';
import {
  RUM_LIFECYCLE_RULE_ID,
  rumProjectRuleId,
  type LifecycleRule,
  type LifecycleS3Port,
} from './replay-lifecycle.js';
import type { AppConfig } from '../types.js';

/** A mock S3Client whose `send` dispatches on the command class. */
function mockClient(handlers: {
  get?: () => unknown;
  put?: (input: unknown) => unknown;
  del?: (input: unknown) => unknown;
}): { client: S3Client; calls: string[] } {
  const calls: string[] = [];
  const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      calls.push('get');
      return handlers.get ? handlers.get() : { Rules: [] };
    }
    if (command instanceof PutBucketLifecycleConfigurationCommand) {
      calls.push('put');
      return handlers.put ? handlers.put(command.input) : {};
    }
    if (command instanceof DeleteBucketLifecycleCommand) {
      calls.push('delete');
      return handlers.del ? handlers.del(command.input) : {};
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  return { client: { send } as unknown as S3Client, calls };
}

describe('createS3LifecyclePort', () => {
  it('normalizes NoSuchLifecycleConfiguration to an empty rule set', async () => {
    const { client } = mockClient({
      get: () => {
        const err = new Error('no lifecycle');
        (err as { name: string }).name = 'NoSuchLifecycleConfiguration';
        throw err;
      },
    });
    const port = createS3LifecyclePort({ bucket: 'b', client });
    expect(await port.getBucketLifecycleRules()).toEqual([]);
  });

  it('rethrows non-NoSuchLifecycleConfiguration errors', async () => {
    const { client } = mockClient({
      get: () => {
        const err = new Error('access denied');
        (err as { name: string }).name = 'AccessDenied';
        throw err;
      },
    });
    const port = createS3LifecyclePort({ bucket: 'b', client });
    await expect(port.getBucketLifecycleRules()).rejects.toThrow('access denied');
  });

  it('reads back the bucket rules', async () => {
    const rules: LifecycleRule[] = [{ ID: 'x', Status: 'Enabled' }];
    const { client } = mockClient({ get: () => ({ Rules: rules }) });
    const port = createS3LifecyclePort({ bucket: 'b', client });
    expect(await port.getBucketLifecycleRules()).toEqual(rules);
  });

  it('PUTs a non-empty rule set with the bucket + configuration', async () => {
    let captured: unknown;
    const { client, calls } = mockClient({ put: (input) => (captured = input) });
    const port = createS3LifecyclePort({ bucket: 'my-bucket', client });
    await port.putBucketLifecycleRules([{ ID: 'r', Status: 'Enabled' }]);
    expect(calls).toEqual(['put']);
    expect(captured).toMatchObject({
      Bucket: 'my-bucket',
      LifecycleConfiguration: { Rules: [{ ID: 'r', Status: 'Enabled' }] },
    });
  });

  it('clears the config via DeleteBucketLifecycle when the rule set is empty', async () => {
    const { client, calls } = mockClient({});
    const port = createS3LifecyclePort({ bucket: 'my-bucket', client });
    await port.putBucketLifecycleRules([]);
    expect(calls).toEqual(['delete']);
  });
});

describe('provisionRumLifecycle', () => {
  const baseConfig = { replayRetentionDays: 30 } as unknown as AppConfig;

  it('no-ops (applied:false) on local storage (no bucket configured)', async () => {
    const out = await provisionRumLifecycle({
      config: { ...baseConfig, artifactsBucket: null } as AppConfig,
    });
    expect(out.applied).toBe(false);
    expect(out.provisioned).toBe(false);
    expect(out.result).toBeUndefined();
  });

  it('applies the managed rule against the configured bucket', async () => {
    const state: { rules: LifecycleRule[] } = { rules: [] };
    const port: LifecycleS3Port = {
      async getBucketLifecycleRules() {
        return state.rules;
      },
      async putBucketLifecycleRules(rules) {
        state.rules = rules;
      },
    };
    const out = await provisionRumLifecycle({
      config: { ...baseConfig, artifactsBucket: 'bkt' } as AppConfig,
      port,
    });
    expect(out.applied).toBe(true);
    expect(out.provisioned).toBe(true);
    expect(out.result?.changed).toBe(true);
    expect(state.rules.map((r) => r.ID)).toEqual([RUM_LIFECYCLE_RULE_ID]);
  });

  it('provisions a per-tenant prefix rule for each override alongside the global rule', async () => {
    const state: { rules: LifecycleRule[] } = { rules: [] };
    const port: LifecycleS3Port = {
      async getBucketLifecycleRules() {
        return state.rules;
      },
      async putBucketLifecycleRules(rules) {
        state.rules = rules;
      },
    };
    const out = await provisionRumLifecycle({
      config: { ...baseConfig, artifactsBucket: 'bkt' } as AppConfig,
      port,
      projectOverrides: [
        { prefix: 'rum/acme/', retentionDays: 7, ruleId: rumProjectRuleId('acme') },
      ],
    });
    expect(out.provisioned).toBe(true);
    expect(state.rules.map((r) => r.ID)).toEqual([RUM_LIFECYCLE_RULE_ID, rumProjectRuleId('acme')]);
    const acme = state.rules.find((r) => r.ID === rumProjectRuleId('acme'))!;
    expect(acme.Filter).toEqual({ Prefix: 'rum/acme/' });
    expect(acme.Expiration).toEqual({ Days: 7 });
  });

  it('swallows a provisioning failure and returns it as an error (boot stays up)', async () => {
    const logs: string[] = [];
    const port: LifecycleS3Port = {
      async getBucketLifecycleRules() {
        const err = new Error('missing s3:PutLifecycleConfiguration');
        (err as { name: string }).name = 'AccessDenied';
        throw err;
      },
      async putBucketLifecycleRules() {
        /* unreached */
      },
    };
    const out = await provisionRumLifecycle({
      config: { ...baseConfig, artifactsBucket: 'bkt' } as AppConfig,
      port,
      log: (m) => logs.push(m),
    });
    expect(out.applied).toBe(true);
    // Unconfirmed ⇒ the sweeper must keep deleting S3 bytes itself (no orphans).
    expect(out.provisioned).toBe(false);
    expect(out.error).toContain('missing s3:PutLifecycleConfiguration');
    expect(logs.some((l) => l.includes('failed to provision'))).toBe(true);
  });
});
