/**
 * PR-env Settings API.
 *
 * Backs the `/settings/pr-environments` Settings page.
 *
 *   GET  /api/settings/pr-env             — masked read
 *   PUT  /api/settings/pr-env             — write (partial-preserving)
 *   POST /api/settings/pr-env/validate    — dry-run: Docker / nginx /
 *                                           GitHub App / Route53 checks
 *
 * Validate is deliberately decoupled from the save flow so the operator
 * can sanity-check credentials before committing them (or re-check an
 * existing install after rotating a key) without side effects beyond
 * issuing a single GitHub-App token and one Route53 `GetHostedZone`.
 */

import { Router, Request, Response } from 'express';
import { access, constants } from 'fs/promises';
import { spawn } from 'child_process';
import { createSign } from 'crypto';
import type Database from 'better-sqlite3';
import {
  readPrEnvConfigMasked,
  readPrEnvConfigRow,
  writePrEnvConfig,
  MASK,
  type PrEnvConfigWrite,
} from '../pr-env-store.js';
import type { GitHubAppConfig, RouteDeps } from '../types.js';

interface ValidateCheck {
  name: string;
  pass: boolean;
  message: string;
}

interface ValidateAdapters {
  /** Check Docker daemon reachable via `docker version`. */
  checkDocker?: () => Promise<ValidateCheck>;
  /** Check nginx sites-{available,enabled} dirs are writable. */
  checkNginx?: (sitesAvailable: string, sitesEnabled: string) => Promise<ValidateCheck>;
  /** Check GitHub App installation token obtainable. */
  checkGithubApp?: (
    appId: string,
    privateKey: string,
    installationId: string,
  ) => Promise<ValidateCheck>;
  /** Check Route53 hosted zone is describe-able. */
  checkRoute53?: (
    accessKeyId: string,
    secretAccessKey: string,
    hostedZoneId: string,
  ) => Promise<ValidateCheck>;
}

// ─── Default adapters (production) ─────────────────────────────────────────

function spawnOnce(command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr?.on('data', (b) => (stderr += String(b)));
    proc.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function defaultCheckDocker(): Promise<ValidateCheck> {
  const { code, stderr } = await spawnOnce('docker', [
    'version',
    '--format',
    '{{.Server.Version}}',
  ]);
  return code === 0
    ? { name: 'docker', pass: true, message: 'Docker daemon reachable.' }
    : {
        name: 'docker',
        pass: false,
        message: `docker version failed (exit ${code}): ${stderr.trim().split('\n')[0] || 'no output'}`,
      };
}

async function defaultCheckNginx(
  sitesAvailable: string,
  sitesEnabled: string,
): Promise<ValidateCheck> {
  const problems: string[] = [];
  for (const dir of [sitesAvailable, sitesEnabled]) {
    if (!dir) {
      problems.push(`(dir path empty)`);
      continue;
    }
    try {
      await access(dir, constants.W_OK);
    } catch (err) {
      problems.push(`${dir}: ${(err as Error).message}`);
    }
  }
  return problems.length === 0
    ? { name: 'nginx', pass: true, message: `Writable: ${sitesAvailable}, ${sitesEnabled}` }
    : { name: 'nginx', pass: false, message: problems.join('; ') };
}

/**
 * Generate a short-lived GitHub App JWT and exchange it for an installation
 * token. We don't cache — the token is discarded after the check.
 */
async function defaultCheckGithubApp(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<ValidateCheck> {
  if (!appId || !privateKey || !installationId) {
    return {
      name: 'github-app',
      pass: false,
      message: 'appId, installationId, and privateKey are all required.',
    };
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: String(appId), iat: now - 60, exp: now + 300 }),
    ).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const sign = createSign('RSA-SHA256');
    sign.update(unsigned);
    const sig = sign.sign(privateKey, 'base64url');
    const jwt = `${unsigned}.${sig}`;

    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        name: 'github-app',
        pass: false,
        message: `Access-tokens request failed (${res.status}): ${body.slice(0, 200)}`,
      };
    }
    return {
      name: 'github-app',
      pass: true,
      message: 'Installation token obtained.',
    };
  } catch (err) {
    return {
      name: 'github-app',
      pass: false,
      message: (err as Error).message,
    };
  }
}

/**
 * Call Route53's `GetHostedZone` via the AWS CLI — shells out rather than
 * pulling in the AWS SDK so we keep the dependency surface small and can
 * capture stderr verbatim.
 *
 * When `accessKeyId` and `secretAccessKey` are both empty, the spawned
 * `aws` CLI inherits `process.env` and uses the default credential chain
 * (env → shared config → IAM Role via IMDSv2). This is the supported
 * "let infra do it" path — operators running the Terraform module get
 * the correct Route 53 policy attached to the EC2 instance role
 * automatically. `hostedZoneId` is still required because it tells the
 * CLI which zone to describe; it's a routing parameter, not a credential.
 */
async function defaultCheckRoute53(
  accessKeyId: string,
  secretAccessKey: string,
  hostedZoneId: string,
): Promise<ValidateCheck> {
  if (!hostedZoneId) {
    return {
      name: 'route53',
      pass: false,
      message: 'hostedZoneId is required.',
    };
  }
  // Reject partial credentials — "AKIA without secret" silently breaks at
  // runtime. Either both keys, or both empty (default chain / IMDS).
  if (!!accessKeyId !== !!secretAccessKey) {
    return {
      name: 'route53',
      pass: false,
      message:
        'Set both accessKeyId and secretAccessKey, or leave both empty to use the AWS SDK default chain (IMDS).',
    };
  }
  const useExplicitCreds = !!accessKeyId && !!secretAccessKey;
  return new Promise((resolve) => {
    let stderr = '';
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Route53 is a global (non-regional) service but the SDK insists.
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || 'us-east-1',
    };
    if (useExplicitCreds) {
      baseEnv.AWS_ACCESS_KEY_ID = accessKeyId;
      baseEnv.AWS_SECRET_ACCESS_KEY = secretAccessKey;
      // Clear ambient session/profile so static creds aren't shadowed.
      delete baseEnv.AWS_SESSION_TOKEN;
      delete baseEnv.AWS_PROFILE;
      delete baseEnv.AWS_DEFAULT_PROFILE;
    }
    const proc = spawn(
      'aws',
      ['route53', 'get-hosted-zone', '--id', hostedZoneId, '--output', 'json'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: baseEnv,
      },
    );
    proc.stderr?.on('data', (b) => (stderr += String(b)));
    proc.on('error', (err) =>
      resolve({
        name: 'route53',
        pass: false,
        message: `aws CLI not available: ${err.message}`,
      }),
    );
    proc.on('close', (code) => {
      if (code === 0) {
        const credsLabel = useExplicitCreds ? 'explicit creds' : 'instance role / default chain';
        resolve({
          name: 'route53',
          pass: true,
          message: `Hosted zone ${hostedZoneId} reachable (${credsLabel}).`,
        });
      } else {
        resolve({
          name: 'route53',
          pass: false,
          message: `aws route53 get-hosted-zone failed (exit ${code}): ${stderr.trim().split('\n')[0] || 'no output'}`,
        });
      }
    });
  });
}

// ─── Router factory ────────────────────────────────────────────────────────

export interface PrEnvSettingsDeps {
  /** Override adapters for tests; any unset key falls back to prod default. */
  adapters?: ValidateAdapters;
  /**
   * Override the DB handle for tests. Production leaves this unset so the
   * store module falls back to the module-level `getDb()` singleton.
   */
  getDb?: () => Database.Database;
  /**
   * Override the registered Reviewer App config for tests. Production
   * sources this from `routeDeps.config.githubApp`; tests inject a fixture
   * directly so they don't have to construct a full `AppConfig`.
   */
  getReviewerApp?: () => GitHubAppConfig | null;
}

export default function createPrEnvSettingsRoutes(
  routeDeps: RouteDeps,
  extra: PrEnvSettingsDeps = {},
): Router {
  const resolveReviewerApp = (): GitHubAppConfig | null => {
    if (extra.getReviewerApp) return extra.getReviewerApp();
    return routeDeps?.config?.githubApp ?? null;
  };
  const router = Router();
  const adapters: Required<ValidateAdapters> = {
    checkDocker: extra.adapters?.checkDocker ?? defaultCheckDocker,
    checkNginx: extra.adapters?.checkNginx ?? defaultCheckNginx,
    checkGithubApp: extra.adapters?.checkGithubApp ?? defaultCheckGithubApp,
    checkRoute53: extra.adapters?.checkRoute53 ?? defaultCheckRoute53,
  };
  const resolveDb = (): Database.Database | undefined => (extra.getDb ? extra.getDb() : undefined);

  router.get('/api/settings/pr-env', (_req: Request, res: Response) => {
    try {
      const db = resolveDb();
      res.json(db ? readPrEnvConfigMasked(db) : readPrEnvConfigMasked());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/api/settings/pr-env', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Validate the payload shape. Unknown keys are ignored.
    const payload: PrEnvConfigWrite = {};
    const strKeys = [
      'repoFullName',
      'previewHost',
      'previewBaseUrl',
      'githubAppId',
      'githubInstallationId',
      'githubPrivateKey',
      'route53AccessKeyId',
      'route53SecretAccessKey',
      'route53HostedZoneId',
    ] as const;
    for (const k of strKeys) {
      const v = body[k];
      if (v === undefined) continue;
      if (v === null) {
        payload[k] = '';
      } else if (typeof v !== 'string') {
        return res.status(400).json({ error: `${k} must be a string` });
      } else {
        payload[k] = v;
      }
    }
    if (body.enabled !== undefined) payload.enabled = body.enabled === true;
    if (body.certRenewalLive !== undefined) payload.certRenewalLive = body.certRenewalLive === true;

    // Port range: accept either both or neither. A half-set range is a
    // configuration footgun — reject. `null` explicitly clears; `undefined`
    // means "not in payload" (don't touch).
    const minProvided = Object.prototype.hasOwnProperty.call(body, 'portRangeMin');
    const maxProvided = Object.prototype.hasOwnProperty.call(body, 'portRangeMax');
    if (minProvided !== maxProvided) {
      return res.status(400).json({ error: 'portRangeMin and portRangeMax must be set together' });
    }
    if (minProvided && maxProvided) {
      const min = body.portRangeMin;
      const max = body.portRangeMax;
      const minN = min === null ? null : Number(min);
      const maxN = max === null ? null : Number(max);
      if ((minN === null) !== (maxN === null)) {
        return res.status(400).json({
          error: 'portRangeMin and portRangeMax must be set together (null/null or both integers)',
        });
      }
      if (minN !== null && maxN !== null) {
        if (!Number.isInteger(minN) || !Number.isInteger(maxN) || minN <= 0 || maxN < minN) {
          return res
            .status(400)
            .json({ error: 'portRange must be positive integers with max >= min' });
        }
      }
      payload.portRangeMin = minN;
      payload.portRangeMax = maxN;
    }

    try {
      const db = resolveDb();
      const after = db ? writePrEnvConfig(payload, db) : writePrEnvConfig(payload);
      res.json(after);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/settings/pr-env/validate', async (req: Request, res: Response) => {
    // Use the saved row as the source of truth, but let the caller pass a
    // transient payload to validate unsaved edits. Mask sentinel preserves
    // existing secrets the user didn't re-enter in the form.
    const db = resolveDb();
    const saved = db ? readPrEnvConfigRow(db) : readPrEnvConfigRow();
    const incoming = (req.body ?? {}) as Partial<Record<keyof typeof saved, unknown>> & {
      sitesAvailableDir?: string;
      sitesEnabledDir?: string;
    };

    const pickStr = (key: keyof typeof saved): string => {
      const v = incoming[key];
      if (v === undefined || v === null) return (saved[key] as string) || '';
      if (typeof v !== 'string') return (saved[key] as string) || '';
      if (v === MASK) return (saved[key] as string) || '';
      return v;
    };

    // GitHub App fields fall back to the registered Reviewer App
    // (`config.githubApp`) when both the incoming payload and the saved
    // row are empty. Same App, same permission set — the operator no
    // longer needs to register a second App just for PR Environments.
    const reviewerApp = resolveReviewerApp();
    const reviewerInstallationId =
      reviewerApp?.installationId != null ? String(reviewerApp.installationId) : '';
    const repoInputs = {
      appId: pickStr('githubAppId') || (reviewerApp?.appId ?? ''),
      installationId: pickStr('githubInstallationId') || reviewerInstallationId,
      privateKey: pickStr('githubPrivateKey') || (reviewerApp?.privateKey ?? ''),
      route53AccessKeyId: pickStr('route53AccessKeyId'),
      route53SecretAccessKey: pickStr('route53SecretAccessKey'),
      route53HostedZoneId: pickStr('route53HostedZoneId'),
    };

    // Tier-3 host paths aren't UI-editable but we still need somewhere to
    // point the nginx check at. Prefer the caller-supplied override, then
    // the conventional linux defaults.
    const sitesAvailable =
      typeof incoming.sitesAvailableDir === 'string'
        ? incoming.sitesAvailableDir
        : '/etc/nginx/sites-available';
    const sitesEnabled =
      typeof incoming.sitesEnabledDir === 'string'
        ? incoming.sitesEnabledDir
        : '/etc/nginx/sites-enabled';

    const checks = await Promise.all([
      adapters.checkDocker().catch((err: Error) => ({
        name: 'docker',
        pass: false,
        message: err.message,
      })),
      adapters.checkNginx(sitesAvailable, sitesEnabled).catch((err: Error) => ({
        name: 'nginx',
        pass: false,
        message: err.message,
      })),
      adapters
        .checkGithubApp(repoInputs.appId, repoInputs.privateKey, repoInputs.installationId)
        .catch((err: Error) => ({
          name: 'github-app',
          pass: false,
          message: err.message,
        })),
      adapters
        .checkRoute53(
          repoInputs.route53AccessKeyId,
          repoInputs.route53SecretAccessKey,
          repoInputs.route53HostedZoneId,
        )
        .catch((err: Error) => ({
          name: 'route53',
          pass: false,
          message: err.message,
        })),
    ]);

    const allPass = checks.every((c) => c.pass);
    res.json({ ok: allPass, checks });
  });

  return router;
}
