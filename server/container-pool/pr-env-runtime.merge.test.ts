/**
 * Tests for the merge path in readPrEnvConfig(). The DB row is now the canonical
 * source for host-level fields (repo, port range, route 53, nginx host, cert
 * renewal). GitHub App credentials are sourced exclusively from the registered
 * Reviewer App (appConfig.githubApp) — env / DB / file overrides for those
 * fields were removed in the script-mode refactor.
 */

import { describe, it, expect } from 'vitest';
import { readPrEnvConfig, type PrEnvAppConfigRef } from './pr-env-runtime.js';
import type { PrEnvConfigRow } from '../pr-env-store.js';
import type { GitHubAppConfig } from '../types.js';

// Required env after the script-mode rewrite: prodDbPath / prEnvDataDir /
// envFilesDir / composeTemplatePath are all gone — per-PR working trees live
// under a single base dir (default `~/.agent-hub/pr-envs`) and per-project
// config supplies the start script. Nginx cert/key paths still need to be
// supplied somewhere (UI tier-1 in production); we set them via env here so
// the merge tests don't have to repeat the file-block plumbing.
const REQUIRED_NON_UI_ENV = {
  PR_ENV_NGINX_CERT_PATH: '/etc/letsencrypt/live/preview/fullchain.pem',
  PR_ENV_NGINX_KEY_PATH: '/etc/letsencrypt/live/preview/privkey.pem',
};

const REVIEWER_APP: GitHubAppConfig = {
  appId: 'reviewer-app-id',
  installationId: 99887766,
  privateKey: 'reviewer-pk',
  webhookSecret: 'whsec',
};

const APP_CONFIG_REF: PrEnvAppConfigRef = { githubApp: REVIEWER_APP };

const FULL_DB_ROW: PrEnvConfigRow = {
  enabled: true,
  repoFullName: 'acme/from-db',
  previewHost: 'preview.db.example.com',
  previewBaseUrl: 'https://db.example.com',
  certRenewalLive: true,
  portRangeMin: 4000,
  portRangeMax: 4100,
  route53AccessKeyId: 'db-akia',
  route53SecretAccessKey: 'db-secret',
  route53HostedZoneId: 'db-zone',
};

describe('readPrEnvConfig — merge DB row', () => {
  it('uses DB row as source when feature enabled via DB', () => {
    const result = readPrEnvConfig({}, REQUIRED_NON_UI_ENV, FULL_DB_ROW, APP_CONFIG_REF);
    expect(result).not.toBeNull();
    expect(result!.repoFullName).toBe('acme/from-db');
    expect(result!.previewBaseUrl).toBe('https://db.example.com');
    // GitHub creds always come from the Reviewer App now — never from DB.
    expect(result!.github.appId).toBe('reviewer-app-id');
    expect(result!.github.privateKey).toBe('reviewer-pk');
    expect(result!.route53.secretAccessKey).toBe('db-secret');
    expect(result!.nginx.previewHost).toBe('preview.db.example.com');
    expect(result!.portRange).toEqual({ min: 4000, max: 4100 });
    expect(result!.certRenewalLive).toBe(true);
  });

  it('env vars override DB row for host-level fields', () => {
    const result = readPrEnvConfig(
      {},
      {
        ...REQUIRED_NON_UI_ENV,
        PR_ENV_REPO_FULL_NAME: 'env/wins',
        PR_ENV_ROUTE53_SECRET_ACCESS_KEY: 'env-secret',
      },
      FULL_DB_ROW,
      APP_CONFIG_REF,
    );
    expect(result!.repoFullName).toBe('env/wins');
    expect(result!.route53.secretAccessKey).toBe('env-secret');
    // Non-overridden DB values still come through:
    expect(result!.nginx.previewHost).toBe('preview.db.example.com');
  });

  it('DB row overrides file block', () => {
    const result = readPrEnvConfig(
      {
        prEnv: {
          enabled: true,
          repoFullName: 'file/loses',
          nginx: { previewHost: 'file.example.com' },
        },
      },
      REQUIRED_NON_UI_ENV,
      FULL_DB_ROW,
      APP_CONFIG_REF,
    );
    expect(result!.repoFullName).toBe('acme/from-db');
    expect(result!.nginx.previewHost).toBe('preview.db.example.com');
  });

  it('returns null when feature is disabled everywhere', () => {
    const disabledRow: PrEnvConfigRow = { ...FULL_DB_ROW, enabled: false };
    expect(readPrEnvConfig({}, {}, disabledRow, APP_CONFIG_REF)).toBeNull();
  });

  it('enabled via DB row is sufficient to enable feature', () => {
    expect(readPrEnvConfig({}, REQUIRED_NON_UI_ENV, FULL_DB_ROW, APP_CONFIG_REF)).not.toBeNull();
  });

  it('ignores half-specified port range from DB', () => {
    const partial: PrEnvConfigRow = {
      ...FULL_DB_ROW,
      portRangeMin: 4000,
      portRangeMax: null,
    };
    const result = readPrEnvConfig({}, REQUIRED_NON_UI_ENV, partial, APP_CONFIG_REF);
    expect(result!.portRange).toBeUndefined();
  });

  it('ignores inverted port range from DB', () => {
    const bad: PrEnvConfigRow = {
      ...FULL_DB_ROW,
      portRangeMin: 5000,
      portRangeMax: 4000,
    };
    const result = readPrEnvConfig({}, REQUIRED_NON_UI_ENV, bad, APP_CONFIG_REF);
    expect(result!.portRange).toBeUndefined();
  });

  it('DB certRenewalLive=false authoritatively overrides file-block true', () => {
    // Regression for PR #493: previously OR-composed across DB + file, so
    // toggling the UI off couldn't disable a feature that a legacy file
    // block had turned on. DB is now authoritative once the row exists.
    const row: PrEnvConfigRow = { ...FULL_DB_ROW, certRenewalLive: false };
    const result = readPrEnvConfig(
      { prEnv: { certRenewalLive: true } },
      REQUIRED_NON_UI_ENV,
      row,
      APP_CONFIG_REF,
    );
    expect(result!.certRenewalLive).toBe(false);
  });

  it('env var forces certRenewalLive on even when DB has false', () => {
    const row: PrEnvConfigRow = { ...FULL_DB_ROW, certRenewalLive: false };
    const result = readPrEnvConfig(
      {},
      { ...REQUIRED_NON_UI_ENV, PR_ENV_CERT_RENEWAL_LIVE: 'true' },
      row,
      APP_CONFIG_REF,
    );
    expect(result!.certRenewalLive).toBe(true);
  });

  it('falls back to file-block certRenewalLive when no DB row is present', () => {
    // dbRow === null means the UI has never written — file block wins.
    const result = readPrEnvConfig(
      {
        prEnv: {
          enabled: true,
          repoFullName: 'acme/file',
          previewBaseUrl: 'https://file.example.com',
          certRenewalLive: true,
          route53: { accessKeyId: 'f-akia', secretAccessKey: 'f-sk', hostedZoneId: 'f-zone' },
          nginx: { previewHost: 'preview.file.example.com' },
        },
      },
      REQUIRED_NON_UI_ENV,
      null,
      APP_CONFIG_REF,
    );
    expect(result!.certRenewalLive).toBe(true);
  });

  it('DB enabled=false authoritatively disables even when file-block enabled=true', () => {
    // Regression for PR #493 blocking review: the OR-composed version let a
    // stale `prEnv.enabled: true` in config.json override a user who had
    // toggled the feature off in Settings.
    const row: PrEnvConfigRow = { ...FULL_DB_ROW, enabled: false };
    const result = readPrEnvConfig(
      { prEnv: { enabled: true, repoFullName: 'file/leftover' } },
      REQUIRED_NON_UI_ENV,
      row,
      APP_CONFIG_REF,
    );
    expect(result).toBeNull();
  });

  it('file-block enabled=true still enables when no DB row exists', () => {
    const result = readPrEnvConfig(
      {
        prEnv: {
          enabled: true,
          repoFullName: 'acme/file',
          previewBaseUrl: 'https://file.example.com',
          route53: { accessKeyId: 'f-akia', secretAccessKey: 'f-sk', hostedZoneId: 'f-zone' },
          nginx: { previewHost: 'preview.file.example.com' },
        },
      },
      REQUIRED_NON_UI_ENV,
      null,
      APP_CONFIG_REF,
    );
    expect(result).not.toBeNull();
    expect(result!.repoFullName).toBe('acme/file');
  });

  it('env flag forces enabled even when DB row says false', () => {
    const row: PrEnvConfigRow = { ...FULL_DB_ROW, enabled: false };
    const result = readPrEnvConfig(
      {},
      { ...REQUIRED_NON_UI_ENV, AGENT_HUB_PR_ENV_ENABLED: 'true' },
      row,
      APP_CONFIG_REF,
    );
    expect(result).not.toBeNull();
  });
});

// ─── Reviewer-App is the sole source for GitHub creds ────────────────────

/**
 * After the script-mode refactor, GitHub App credentials are sourced
 * exclusively from the registered Reviewer App. Env / DB / file overrides
 * for `github.*` were removed; one App per install handles both formal PR
 * reviews and PR-env webhook/sticky-comment posting.
 *
 * `installationId` on `GitHubAppConfig` is `number`; the runtime coerces to
 * string to match the rest of the pipeline.
 */

/** A minimal DB row that enables the feature with route 53 host + zone set. */
const ENABLED_BLANK_ROW: PrEnvConfigRow = {
  enabled: true,
  repoFullName: 'acme/from-db',
  previewHost: 'preview.db.example.com',
  previewBaseUrl: 'https://db.example.com',
  certRenewalLive: false,
  portRangeMin: null,
  portRangeMax: null,
  route53AccessKeyId: '',
  route53SecretAccessKey: '',
  route53HostedZoneId: 'Z-from-db',
};

describe('readPrEnvConfig — Reviewer-App is sole source for GitHub creds', () => {
  it('uses appConfig.githubApp for github.appId / installationId / privateKey', () => {
    const result = readPrEnvConfig({}, REQUIRED_NON_UI_ENV, ENABLED_BLANK_ROW, APP_CONFIG_REF);
    expect(result).not.toBeNull();
    expect(result!.github.appId).toBe('reviewer-app-id');
    // installationId is `number` on GitHubAppConfig but `string` on the runtime config.
    expect(result!.github.installationId).toBe('99887766');
    expect(result!.github.privateKey).toBe('reviewer-pk');
  });

  it('throws misconfig error when appConfig is null (no Reviewer App registered)', () => {
    // Defends against a regression where a missing `appConfig` arg silently
    // injects empty github creds into the runtime — surface failure early.
    expect(() => readPrEnvConfig({}, REQUIRED_NON_UI_ENV, ENABLED_BLANK_ROW, null)).toThrow(
      /PR_ENV_GITHUB_APP_ID/,
    );
  });

  it('ignores legacy file-block github.* fields (Reviewer App still wins)', () => {
    const result = readPrEnvConfig(
      {
        prEnv: {
          github: { appId: 'file-app', installationId: 'file-inst', privateKey: 'file-pk' },
        },
      },
      REQUIRED_NON_UI_ENV,
      ENABLED_BLANK_ROW,
      APP_CONFIG_REF,
    );
    expect(result!.github.appId).toBe('reviewer-app-id');
    expect(result!.github.installationId).toBe('99887766');
    expect(result!.github.privateKey).toBe('reviewer-pk');
  });

  it('ignores legacy env var overrides for github.* (Reviewer App still wins)', () => {
    const result = readPrEnvConfig(
      {},
      {
        ...REQUIRED_NON_UI_ENV,
        PR_ENV_GITHUB_APP_ID: 'env-app',
        PR_ENV_GITHUB_INSTALLATION_ID: 'env-inst',
        PR_ENV_GITHUB_PRIVATE_KEY: 'env-pk',
      },
      ENABLED_BLANK_ROW,
      APP_CONFIG_REF,
    );
    expect(result!.github.appId).toBe('reviewer-app-id');
    expect(result!.github.installationId).toBe('99887766');
    expect(result!.github.privateKey).toBe('reviewer-pk');
  });
});

// ─── Route 53: empty access keys → AWS SDK default chain ─────────────────

describe('readPrEnvConfig — Route 53 access keys are optional (default-chain / IMDS)', () => {
  it('does not throw when both Route 53 access keys are empty and hostedZoneId is set', () => {
    // The cert-renewal client falls back to the AWS SDK default chain
    // (IMDSv2) at run-time. Config-load must not block this path.
    const result = readPrEnvConfig({}, REQUIRED_NON_UI_ENV, ENABLED_BLANK_ROW, APP_CONFIG_REF);
    expect(result).not.toBeNull();
    expect(result!.route53.accessKeyId).toBe('');
    expect(result!.route53.secretAccessKey).toBe('');
    expect(result!.route53.hostedZoneId).toBe('Z-from-db');
  });

  it('still throws when hostedZoneId is missing (it is a routing param, not a credential)', () => {
    const noZoneRow: PrEnvConfigRow = { ...ENABLED_BLANK_ROW, route53HostedZoneId: '' };
    expect(() => readPrEnvConfig({}, REQUIRED_NON_UI_ENV, noZoneRow, APP_CONFIG_REF)).toThrow(
      /PR_ENV_ROUTE53_HOSTED_ZONE_ID/,
    );
  });

  it('rejects partial credentials (AKIA without secret)', () => {
    const partialRow: PrEnvConfigRow = {
      ...ENABLED_BLANK_ROW,
      route53AccessKeyId: 'AKIA-LONELY',
      route53SecretAccessKey: '',
    };
    expect(() => readPrEnvConfig({}, REQUIRED_NON_UI_ENV, partialRow, APP_CONFIG_REF)).toThrow(
      /ACCESS_KEY_ID \+ PR_ENV_ROUTE53_SECRET_ACCESS_KEY/,
    );
  });

  it('rejects partial credentials (secret without AKIA)', () => {
    const partialRow: PrEnvConfigRow = {
      ...ENABLED_BLANK_ROW,
      route53AccessKeyId: '',
      route53SecretAccessKey: 'lonely-secret',
    };
    expect(() => readPrEnvConfig({}, REQUIRED_NON_UI_ENV, partialRow, APP_CONFIG_REF)).toThrow(
      /ACCESS_KEY_ID \+ PR_ENV_ROUTE53_SECRET_ACCESS_KEY/,
    );
  });

  it('accepts both keys set explicitly (legacy path)', () => {
    const result = readPrEnvConfig({}, REQUIRED_NON_UI_ENV, FULL_DB_ROW, APP_CONFIG_REF);
    expect(result!.route53.accessKeyId).toBe('db-akia');
    expect(result!.route53.secretAccessKey).toBe('db-secret');
  });
});
