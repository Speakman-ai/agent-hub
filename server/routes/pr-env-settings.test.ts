/**
 * Integration tests for the `/api/settings/pr-env` routes (GET, PUT,
 * POST /validate). Each test gets a fresh in-memory SQLite DB and a
 * throwaway encryption key file so state is isolated.
 *
 * After the script-mode refactor, GitHub App credentials are NOT stored
 * in `pr_env_config` and are NOT accepted by PUT — the dispatcher reuses
 * the registered Reviewer App (`config.githubApp`). Tests that previously
 * exercised stored github creds were either pivoted to the route53 secret
 * (for partial-preserving / MASK semantics) or removed (precedence).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import createPrEnvSettingsRoutes from './pr-env-settings.js';
import type { GitHubAppConfig } from '../types.js';
import {
  PR_ENV_CONFIG_SCHEMA,
  MASK,
  writePrEnvConfig,
  __resetPrEnvStoreForTests,
  __setPrEnvKeyFilePathForTests,
} from '../pr-env-store.js';
import type { RouteDeps } from '../types.js';

let db: Database.Database;
let keyDir: string;
let app: Express;

function stubRouteDeps(): RouteDeps {
  return {} as unknown as RouteDeps;
}

beforeEach(() => {
  keyDir = mkdtempSync(path.join(tmpdir(), 'pr-env-route-'));
  __setPrEnvKeyFilePathForTests(path.join(keyDir, 'key'));
  db = new Database(':memory:');
  db.exec(PR_ENV_CONFIG_SCHEMA);

  app = express();
  app.use(express.json());
  app.use(
    createPrEnvSettingsRoutes(stubRouteDeps(), {
      getDb: () => db,
      adapters: {
        checkDocker: async () => ({ name: 'docker', pass: true, message: 'ok' }),
        checkNginx: async () => ({ name: 'nginx', pass: true, message: 'ok' }),
        checkGithubApp: async () => ({ name: 'github-app', pass: true, message: 'ok' }),
        checkRoute53: async () => ({ name: 'route53', pass: true, message: 'ok' }),
      },
    }),
  );
});

afterEach(() => {
  db.close();
  rmSync(keyDir, { recursive: true, force: true });
  __resetPrEnvStoreForTests();
});

describe('GET /api/settings/pr-env', () => {
  it('returns empty defaults when no row exists', async () => {
    const res = await supertest(app).get('/api/settings/pr-env').expect(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.repoFullName).toBe('');
    expect(res.body.route53SecretAccessKey).toBe('');
  });

  it('masks set secrets', async () => {
    writePrEnvConfig(
      {
        repoFullName: 'acme/repo',
        route53AccessKeyId: 'AKIA',
        route53SecretAccessKey: 'aws-sekret',
      },
      db,
    );
    const res = await supertest(app).get('/api/settings/pr-env').expect(200);
    expect(res.body.repoFullName).toBe('acme/repo');
    expect(res.body.route53AccessKeyId).toBe('AKIA');
    expect(res.body.route53SecretAccessKey).toBe(MASK);
    // Plaintext must never appear in the response.
    expect(JSON.stringify(res.body)).not.toContain('aws-sekret');
  });
});

describe('PUT /api/settings/pr-env', () => {
  it('writes a new row and returns masked view', async () => {
    const res = await supertest(app)
      .put('/api/settings/pr-env')
      .send({
        enabled: true,
        repoFullName: 'acme/repo',
        route53SecretAccessKey: 'sekret',
      })
      .expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.repoFullName).toBe('acme/repo');
    expect(res.body.route53SecretAccessKey).toBe(MASK);
  });

  it('preserves existing secrets when MASK is sent back', async () => {
    writePrEnvConfig({ route53SecretAccessKey: 'ORIGINAL' }, db);
    await supertest(app)
      .put('/api/settings/pr-env')
      .send({ route53SecretAccessKey: MASK, repoFullName: 'updated/repo' })
      .expect(200);
    const after = await supertest(app).get('/api/settings/pr-env').expect(200);
    expect(after.body.repoFullName).toBe('updated/repo');
    expect(after.body.route53SecretAccessKey).toBe(MASK);
    // Verify the underlying ciphertext is still populated:
    const raw = db
      .prepare('SELECT route53_secret_access_key_enc FROM pr_env_config WHERE id = 1')
      .get() as { route53_secret_access_key_enc: string };
    expect(raw.route53_secret_access_key_enc).not.toBe('');
  });

  it('silently ignores legacy github.* fields (Reviewer App is sole source)', async () => {
    // Old clients may still post `githubAppId` / `githubPrivateKey` etc.
    // The route drops them — those columns no longer exist.
    const res = await supertest(app)
      .put('/api/settings/pr-env')
      .send({
        repoFullName: 'acme/repo',
        githubAppId: '123',
        githubPrivateKey: 'pk',
        githubInstallationId: '99',
      })
      .expect(200);
    expect(res.body.repoFullName).toBe('acme/repo');
    // Legacy keys must not appear in the response.
    expect(res.body.githubAppId).toBeUndefined();
    expect(res.body.githubPrivateKey).toBeUndefined();
    expect(res.body.githubInstallationId).toBeUndefined();
  });

  it('rejects non-string values for string fields', async () => {
    const res = await supertest(app)
      .put('/api/settings/pr-env')
      .send({ repoFullName: 42 })
      .expect(400);
    expect(res.body.error).toMatch(/repoFullName must be a string/);
  });

  it('rejects half-specified port range', async () => {
    const res = await supertest(app)
      .put('/api/settings/pr-env')
      .send({ portRangeMin: 3100 })
      .expect(400);
    expect(res.body.error).toMatch(/must be set together/);
  });

  it('rejects inverted port range', async () => {
    const res = await supertest(app)
      .put('/api/settings/pr-env')
      .send({ portRangeMin: 5000, portRangeMax: 4000 })
      .expect(400);
    expect(res.body.error).toMatch(/max >= min/);
  });

  it('accepts valid port range', async () => {
    await supertest(app)
      .put('/api/settings/pr-env')
      .send({ portRangeMin: 3100, portRangeMax: 3999 })
      .expect(200);
    const after = await supertest(app).get('/api/settings/pr-env').expect(200);
    expect(after.body.portRangeMin).toBe(3100);
    expect(after.body.portRangeMax).toBe(3999);
  });

  it('allows clearing port range via null', async () => {
    writePrEnvConfig({ portRangeMin: 3100, portRangeMax: 3999 }, db);
    await supertest(app)
      .put('/api/settings/pr-env')
      .send({ portRangeMin: null, portRangeMax: null })
      .expect(200);
    const after = await supertest(app).get('/api/settings/pr-env').expect(200);
    expect(after.body.portRangeMin).toBeNull();
    expect(after.body.portRangeMax).toBeNull();
  });
});

describe('POST /api/settings/pr-env/validate', () => {
  it('runs all four checks and returns ok when they all pass', async () => {
    writePrEnvConfig(
      {
        route53AccessKeyId: 'AKIA',
        route53SecretAccessKey: 'sekret',
        route53HostedZoneId: 'Z1',
      },
      db,
    );
    const res = await supertest(app).post('/api/settings/pr-env/validate').send({}).expect(200);
    expect(res.body.ok).toBe(true);
    const names = res.body.checks.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['docker', 'github-app', 'nginx', 'route53']);
    expect(res.body.checks.every((c: { pass: boolean }) => c.pass)).toBe(true);
  });

  it('returns ok: false when any check fails', async () => {
    const failApp = express();
    failApp.use(express.json());
    failApp.use(
      createPrEnvSettingsRoutes(stubRouteDeps(), {
        getDb: () => db,
        adapters: {
          checkDocker: async () => ({ name: 'docker', pass: false, message: 'not running' }),
          checkNginx: async () => ({ name: 'nginx', pass: true, message: 'ok' }),
          checkGithubApp: async () => ({ name: 'github-app', pass: true, message: 'ok' }),
          checkRoute53: async () => ({ name: 'route53', pass: true, message: 'ok' }),
        },
      }),
    );
    const res = await supertest(failApp).post('/api/settings/pr-env/validate').send({}).expect(200);
    expect(res.body.ok).toBe(false);
    const docker = res.body.checks.find((c: { name: string }) => c.name === 'docker');
    expect(docker.pass).toBe(false);
    expect(docker.message).toBe('not running');
  });

  it('catches adapter rejections as failed checks', async () => {
    const throwApp = express();
    throwApp.use(express.json());
    throwApp.use(
      createPrEnvSettingsRoutes(stubRouteDeps(), {
        getDb: () => db,
        adapters: {
          checkDocker: async () => {
            throw new Error('boom');
          },
          checkNginx: async () => ({ name: 'nginx', pass: true, message: 'ok' }),
          checkGithubApp: async () => ({ name: 'github-app', pass: true, message: 'ok' }),
          checkRoute53: async () => ({ name: 'route53', pass: true, message: 'ok' }),
        },
      }),
    );
    const res = await supertest(throwApp)
      .post('/api/settings/pr-env/validate')
      .send({})
      .expect(200);
    expect(res.body.ok).toBe(false);
    const docker = res.body.checks.find((c: { name: string }) => c.name === 'docker');
    expect(docker.pass).toBe(false);
    expect(docker.message).toBe('boom');
  });

  it('uses the registered Reviewer App as the github-check identity', async () => {
    // GitHub App creds are sourced exclusively from `config.githubApp`.
    // The PR-env Settings form no longer carries appId/installationId/
    // privateKey inputs, and `pr_env_config` no longer stores them.
    const reviewerApp: GitHubAppConfig = {
      appId: 'reviewer-app',
      installationId: 5544332211,
      privateKey: 'reviewer-pk',
    };
    const seen: { appId?: string; privateKey?: string; installationId?: string } = {};
    const reviewerInjectedApp = express();
    reviewerInjectedApp.use(express.json());
    reviewerInjectedApp.use(
      createPrEnvSettingsRoutes(stubRouteDeps(), {
        getDb: () => db,
        getReviewerApp: () => reviewerApp,
        adapters: {
          checkDocker: async () => ({ name: 'docker', pass: true, message: 'ok' }),
          checkNginx: async () => ({ name: 'nginx', pass: true, message: 'ok' }),
          checkGithubApp: async (appId, privateKey, installationId) => {
            seen.appId = appId;
            seen.privateKey = privateKey;
            seen.installationId = installationId;
            return { name: 'github-app', pass: true, message: 'ok' };
          },
          checkRoute53: async () => ({ name: 'route53', pass: true, message: 'ok' }),
        },
      }),
    );
    await supertest(reviewerInjectedApp).post('/api/settings/pr-env/validate').send({}).expect(200);
    expect(seen.appId).toBe('reviewer-app');
    // installationId is a number on GitHubAppConfig but stringified for the validate adapter.
    expect(seen.installationId).toBe('5544332211');
    expect(seen.privateKey).toBe('reviewer-pk');
  });

  it('passes empty github creds to the adapter when no Reviewer App is registered', async () => {
    // Surfaces a misconfiguration: with no Reviewer App and no DB github
    // creds (which can no longer be set anyway), the github-app check
    // sees empty strings and the default adapter would fail. We assert
    // the route doesn't silently substitute anything from elsewhere.
    const seen: { appId?: string; privateKey?: string; installationId?: string } = {};
    const noReviewerApp = express();
    noReviewerApp.use(express.json());
    noReviewerApp.use(
      createPrEnvSettingsRoutes(stubRouteDeps(), {
        getDb: () => db,
        getReviewerApp: () => null,
        adapters: {
          checkDocker: async () => ({ name: 'docker', pass: true, message: 'ok' }),
          checkNginx: async () => ({ name: 'nginx', pass: true, message: 'ok' }),
          checkGithubApp: async (appId, privateKey, installationId) => {
            seen.appId = appId;
            seen.privateKey = privateKey;
            seen.installationId = installationId;
            return { name: 'github-app', pass: false, message: 'no reviewer app' };
          },
          checkRoute53: async () => ({ name: 'route53', pass: true, message: 'ok' }),
        },
      }),
    );
    await supertest(noReviewerApp).post('/api/settings/pr-env/validate').send({}).expect(200);
    expect(seen.appId).toBe('');
    expect(seen.installationId).toBe('');
    expect(seen.privateKey).toBe('');
  });

  it('Route 53 check passes empty access keys through to the adapter', async () => {
    // The default-chain / IMDS path: empty keys mean "use the AWS SDK
    // default credential chain". The route layer must not silently fill
    // them in from somewhere — the cert-renewal client is the one that
    // decides whether to inject env vars or fall through.
    writePrEnvConfig({ route53HostedZoneId: 'Z-only-zone' }, db);
    const seen: { accessKeyId?: string; secretAccessKey?: string; hostedZoneId?: string } = {};
    const r53App = express();
    r53App.use(express.json());
    r53App.use(
      createPrEnvSettingsRoutes(stubRouteDeps(), {
        getDb: () => db,
        adapters: {
          checkDocker: async () => ({ name: 'docker', pass: true, message: 'ok' }),
          checkNginx: async () => ({ name: 'nginx', pass: true, message: 'ok' }),
          checkGithubApp: async () => ({ name: 'github-app', pass: true, message: 'ok' }),
          checkRoute53: async (accessKeyId, secretAccessKey, hostedZoneId) => {
            seen.accessKeyId = accessKeyId;
            seen.secretAccessKey = secretAccessKey;
            seen.hostedZoneId = hostedZoneId;
            return {
              name: 'route53',
              pass: true,
              message: 'Hosted zone reachable (instance role / default chain).',
            };
          },
        },
      }),
    );
    await supertest(r53App).post('/api/settings/pr-env/validate').send({}).expect(200);
    expect(seen.accessKeyId).toBe('');
    expect(seen.secretAccessKey).toBe('');
    expect(seen.hostedZoneId).toBe('Z-only-zone');
  });

  it('passes saved route53 secret to the adapter when payload has MASK', async () => {
    writePrEnvConfig(
      {
        route53AccessKeyId: 'AKIA',
        route53SecretAccessKey: 'the-real-secret',
        route53HostedZoneId: 'Z1',
      },
      db,
    );
    const seen: { accessKeyId?: string; secretAccessKey?: string; hostedZoneId?: string } = {};
    const spyApp = express();
    spyApp.use(express.json());
    spyApp.use(
      createPrEnvSettingsRoutes(stubRouteDeps(), {
        getDb: () => db,
        adapters: {
          checkDocker: async () => ({ name: 'docker', pass: true, message: 'ok' }),
          checkNginx: async () => ({ name: 'nginx', pass: true, message: 'ok' }),
          checkGithubApp: async () => ({ name: 'github-app', pass: true, message: 'ok' }),
          checkRoute53: async (accessKeyId, secretAccessKey, hostedZoneId) => {
            seen.accessKeyId = accessKeyId;
            seen.secretAccessKey = secretAccessKey;
            seen.hostedZoneId = hostedZoneId;
            return { name: 'route53', pass: true, message: 'ok' };
          },
        },
      }),
    );
    await supertest(spyApp)
      .post('/api/settings/pr-env/validate')
      .send({ route53SecretAccessKey: MASK }) // UI didn't re-enter — expect saved value
      .expect(200);
    expect(seen.accessKeyId).toBe('AKIA');
    expect(seen.secretAccessKey).toBe('the-real-secret');
    expect(seen.hostedZoneId).toBe('Z1');
  });
});
