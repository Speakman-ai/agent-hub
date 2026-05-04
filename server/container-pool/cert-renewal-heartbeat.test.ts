/**
 * cert-renewal-heartbeat tests (W2).
 *
 * Covers the glue logic between scheduler and cert-renewal:
 *   • No-op when feature is disabled (config === null)
 *   • Dry-run vs live dispatch driven by config.certRenewalLive
 *   • Never throws — returns a non-ok result instead
 */

import { describe, it, expect } from 'vitest';
import { runCertRenewalHeartbeat, certRenewalLock } from './cert-renewal-heartbeat.js';
import type { CertRunner } from './cert-renewal.js';
import type { PrEnvRuntimeConfig } from './pr-env-runtime.js';

function makeLogger() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
  };
}

function makeConfig(partial: Partial<PrEnvRuntimeConfig> = {}): PrEnvRuntimeConfig {
  return {
    enabled: true,
    checkoutBaseDir: '/srv/agent-hub/pr-envs',
    defaultBaseImage: 'node:20',
    previewBaseUrl: 'https://preview.agenthub.dev',
    github: { appId: '1', installationId: '2', privateKey: 'k' },
    route53: {
      accessKeyId: 'AKIA',
      secretAccessKey: 'sekret',
      hostedZoneId: 'Z1',
    },
    nginx: {
      sitesAvailableDir: '/etc/nginx/sites-available',
      sitesEnabledDir: '/etc/nginx/sites-enabled',
      certPath: '/cert.pem',
      keyPath: '/key.pem',
      previewHost: 'preview.agenthub.dev',
      certHome: '/var/lib/agent-hub/acme',
    },
    repoFullName: 'Speakman-ai/agent-hub',
    ...partial,
  };
}

describe('runCertRenewalHeartbeat', () => {
  it('is a no-op when the feature is disabled', async () => {
    const logger = makeLogger();
    const result = await runCertRenewalHeartbeat({ getConfig: () => null, logger });
    expect(result).toBeNull();
    expect(logger.logs.some((l) => l.includes('disabled'))).toBe(true);
  });

  it('dispatches dry-run by default (certRenewalLive unset)', async () => {
    const logger = makeLogger();
    const calls: Array<{ args: readonly string[] }> = [];
    const runner: CertRunner = {
      async run(_cmd, args) {
        calls.push({ args });
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const result = await runCertRenewalHeartbeat({
      getConfig: () => makeConfig({ certRenewalLive: false }),
      runner,
      logger,
    });
    expect(result?.ok).toBe(true);
    // --staging is the acme.sh dry-run stand-in.
    expect(calls[0].args).toContain('--staging');
  });

  it('dispatches live renewal when certRenewalLive is true', async () => {
    const logger = makeLogger();
    const calls: Array<{ args: readonly string[] }> = [];
    const runner: CertRunner = {
      async run(_cmd, args) {
        calls.push({ args });
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await runCertRenewalHeartbeat({
      getConfig: () => makeConfig({ certRenewalLive: true }),
      runner,
      logger,
    });
    expect(calls[0].args).not.toContain('--staging');
  });

  it('derives the wildcard domain from previewBaseUrl', async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const runner: CertRunner = {
      async run(_cmd, args) {
        calls.push({ args });
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await runCertRenewalHeartbeat({
      getConfig: () => makeConfig({ previewBaseUrl: 'https://preview.example.org/pr-123' }),
      runner,
      logger: makeLogger(),
    });
    // -d flag followed by the wildcard.
    const args = calls[0].args;
    const dIdx = args.indexOf('-d');
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(args[dIdx + 1]).toBe('*.preview.example.org');
  });

  it('never throws — returns a non-ok result when the config is malformed', async () => {
    const logger = makeLogger();
    const result = await runCertRenewalHeartbeat({
      getConfig: () => makeConfig({ previewBaseUrl: 'http://localhost' }),
      logger,
    });
    expect(result?.ok).toBe(false);
    expect(result?.stderr).toMatch(/not a real host/);
  });

  // ─── reentrancy guard (pairs with the 10m runner timeout) ──────────

  describe('reentrancy guard', () => {
    it('returns null + logs a skip when a previous tick is still running', async () => {
      const logger = makeLogger();
      // Prime the lock to simulate a previous tick that's still in flight.
      certRenewalLock.running = true;
      try {
        const result = await runCertRenewalHeartbeat({
          getConfig: () => makeConfig({ certRenewalLive: false }),
          logger,
        });
        expect(result).toBeNull();
        expect(logger.logs.some((l) => l.includes('previous tick still running'))).toBe(true);
      } finally {
        certRenewalLock.running = false;
      }
    });

    it('releases the lock even when the runner throws', async () => {
      const runner: CertRunner = {
        async run() {
          throw new Error('simulated spawn failure');
        },
      };
      await runCertRenewalHeartbeat({
        getConfig: () => makeConfig({ certRenewalLive: true }),
        runner,
        logger: makeLogger(),
      });
      expect(certRenewalLock.running).toBe(false);
    });

    it('allows a subsequent tick to run after the previous one completes', async () => {
      const runner: CertRunner = {
        async run() {
          return { code: 0, stdout: '', stderr: '' };
        },
      };
      const config = makeConfig({ certRenewalLive: false });
      const first = await runCertRenewalHeartbeat({
        getConfig: () => config,
        runner,
        logger: makeLogger(),
      });
      expect(first?.ok).toBe(true);
      expect(certRenewalLock.running).toBe(false);
      const second = await runCertRenewalHeartbeat({
        getConfig: () => config,
        runner,
        logger: makeLogger(),
      });
      expect(second?.ok).toBe(true);
    });
  });
});
