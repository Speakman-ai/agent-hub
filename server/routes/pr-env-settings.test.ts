/**
 * Integration tests for the `/api/settings/pr-env` routes (GET, PUT,
 * POST /validate). Each test gets a fresh in-memory SQLite DB and a
 * throwaway encryption key file so state is isolated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import createPrEnvSettingsRoutes from './pr-env-settings.js';
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
    expect(res.body.githubPrivateKey).toBe('');
  });

  it('masks set secrets', async () => {
    writePrEnvConfig(
      {
        githubAppId: '123',
        githubPrivateKey: 'pk',
        route53AccessKeyId: 'AKIA',
        route53SecretAccessKey: 'aws-sekret',
      },
      db,
    );
    const res = await supertest(app).get('/api/settings/pr-env').expect(200);
    expect(res.body.githubAppId).toBe('123');
    expect(res.body.githubPrivateKey).toBe(MASK);
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
        githubPrivateKey: 'pk',
      })
      .expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.repoFullName).toBe('acme/repo');
    expect(res.body.githubPrivateKey).toBe(MASK);
  });

  it('preserves existing secrets when MASK is sent back', async () => {
    writePrEnvConfig({ githubPrivateKey: 'ORIGINAL' }, db);
    await supertest(app)
      .put('/api/settings/pr-env')
      .send({ githubPrivateKey: MASK, repoFullName: 'updated/repo' })
      .expect(200);
    const after = await supertest(app).get('/api/settings/pr-env').expect(200);
    expect(after.body.repoFullName).toBe('updated/repo');
    expect(after.body.githubPrivateKey).toBe(MASK);
    // Verify the underlying plaintext is still the original:
    const raw = db
      .prepare('SELECT github_private_key_enc FROM pr_env_config WHERE id = 1')
      .get() as { github_private_key_enc: string };
    expect(raw.github_private_key_enc).not.toBe('');
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
        githubAppId: '1',
        githubInstallationId: '2',
        githubPrivateKey: 'pk',
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

  it('passes saved secrets to adapters when payload has MASK', async () => {
    writePrEnvConfig(
      {
        githubAppId: '1',
        githubInstallationId: '2',
        githubPrivateKey: 'the-real-pk',
      },
      db,
    );
    const seen: { appId?: string; privateKey?: string; installationId?: string } = {};
    const spyApp = express();
    spyApp.use(express.json());
    spyApp.use(
      createPrEnvSettingsRoutes(stubRouteDeps(), {
        getDb: () => db,
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
    await supertest(spyApp)
      .post('/api/settings/pr-env/validate')
      .send({ githubPrivateKey: MASK }) // UI didn't re-enter — expect saved value
      .expect(200);
    expect(seen.privateKey).toBe('the-real-pk');
    expect(seen.appId).toBe('1');
    expect(seen.installationId).toBe('2');
  });
});
