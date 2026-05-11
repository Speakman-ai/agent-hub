/**
 * Kill-switch tests (epic 88367984 — strip PR Environments).
 *
 * After PR-Env Removal #3 the routes, store module, and dispatchers were
 * deleted outright. The remaining surface the kill switch still gates is:
 *
 *   - `readPrEnvConfig()` in `container-pool/pr-env-runtime.ts` — the last
 *     in-process reader; pinned here so a future caller can't slip past it.
 *   - `detectPreviewBlock()` — the `target: 'fullstack'` parse-time guard
 *     established in PR-Env Removal #2.
 *
 * The "settings / provisioning routes return 410 Gone" assertions are gone
 * because those routes are gone — there's nothing left to gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { __setPrEnvKillSwitchForTests, isPrEnvKillSwitchOn } from './pr-env-killswitch.js';
import { readPrEnvConfig } from './container-pool/pr-env-runtime.js';

beforeEach(() => {
  __setPrEnvKillSwitchForTests(true);
});

afterEach(() => {
  __setPrEnvKillSwitchForTests(false);
});

describe('PR-env kill switch — production contract', () => {
  it('isPrEnvKillSwitchOn() returns true once enabled', () => {
    expect(isPrEnvKillSwitchOn()).toBe(true);
  });

  it('readPrEnvConfig returns null regardless of DB / file / env state', () => {
    // Even with a fully-populated file block AND an enabled DB row, the
    // kill switch must win — that's the "enforced at boot regardless of
    // config value" half of the contract.
    const fileConfig = {
      prEnv: {
        enabled: true,
        repoFullName: 'acme/widgets',
        previewHost: 'preview.example.com',
        previewBaseUrl: 'https://preview.example.com',
      },
    };
    const dbRow = {
      enabled: true,
      repoFullName: 'acme/widgets',
      previewHost: 'preview.example.com',
      previewBaseUrl: 'https://preview.example.com',
      route53AccessKeyId: 'AKIA',
      route53SecretAccessKey: 'sekret',
      route53HostedZoneId: 'Z1',
      certRenewalLive: false,
      portRangeMin: null,
      portRangeMax: null,
    } as const;

    expect(readPrEnvConfig(fileConfig, {}, dbRow as never)).toBeNull();
  });

  it('fullstack preview block is rejected at parse time — handler is gone', async () => {
    // PR-Env Removal #2 deleted the fullstack preview handler module and
    // dropped `'fullstack'` from `PreviewTarget`. The parse-time gate in
    // `detectPreviewBlock` rejects `target: 'fullstack'` outright, so the
    // dispatcher never even sees a fullstack task and the kill switch has
    // nothing left to gate. Pin that contract here so a future
    // re-introduction has to update this test.
    const { detectPreviewBlock } = await import('./preview/preview-block.js');
    const result = detectPreviewBlock(
      `<agenthub:preview>{"target":"fullstack","route":"/"}</agenthub:preview>`,
    );
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('invalid-target');
  });

  it('PR-env webhook dispatch modules are gone — synchronize is a no-op', async () => {
    // PR-Env Removal #3 deleted `container-pool/pr-env-dispatch.ts` and the
    // `dispatchPrEnvBuild` / `dispatchPrEnvTeardown` invocations in
    // `routes/webhooks.ts`. Pin that here so a regression that
    // re-introduces the import is caught.
    await expect(import('./container-pool/pr-env-dispatch.js' as string)).rejects.toThrow();
  });
});
