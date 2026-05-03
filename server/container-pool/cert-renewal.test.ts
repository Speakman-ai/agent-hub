/**
 * cert-renewal tests (W2).
 *
 * Covers:
 *   • dry-run exit 0 path
 *   • Route53 API error path (client exits non-zero)
 *   • Redaction of AWS creds from stderr
 *   • wildcardDomainFromConfig derivation
 */

import { describe, it, expect } from 'vitest';
import {
  renewCerts,
  renewCertsDryRun,
  wildcardDomainFromConfig,
  type CertRunner,
  type CertRenewalDeps,
} from './cert-renewal.js';

function makeFakeRunner(
  responses: Array<{ code: number; stdout: string; stderr: string }>,
): CertRunner & {
  calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  let i = 0;
  return {
    calls,
    async run(command, args, env) {
      calls.push({ command, args, env });
      const resp = responses[i++] ?? { code: 0, stdout: '', stderr: '' };
      return resp;
    },
  };
}

const BASE_DEPS: Omit<CertRenewalDeps, 'runner'> = {
  route53: {
    accessKeyId: 'AKIATESTKEY',
    secretAccessKey: 'supersecret/value+with/slashes',
    hostedZoneId: 'Z1ABCD1234',
  },
  wildcardDomain: '*.preview.agenthub.dev',
  certHome: '/var/lib/agent-hub/acme',
};

// ─── dry-run ──────────────────────────────────────────────────────────────

describe('renewCertsDryRun (acme.sh)', () => {
  it('returns ok on exit 0 with no renewed flag', async () => {
    const runner = makeFakeRunner([{ code: 0, stdout: 'Reload success', stderr: '' }]);
    const result = await renewCertsDryRun({ ...BASE_DEPS, runner });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // Dry-run never flips `renewed`, regardless of what the client prints.
    expect(result.renewed).toBe(false);
  });

  it('invokes acme.sh with --staging and isolated staging cert-home', async () => {
    const runner = makeFakeRunner([{ code: 0, stdout: '', stderr: '' }]);
    await renewCertsDryRun({ ...BASE_DEPS, runner });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('acme.sh');
    expect(runner.calls[0].args).toContain('--staging');
    expect(runner.calls[0].args).toContain('--dns');
    expect(runner.calls[0].args).toContain('dns_aws');
    // Staging uses a separate cert-home so it never pollutes prod certs.
    const certHomeIdx = runner.calls[0].args.indexOf('--cert-home');
    expect(runner.calls[0].args[certHomeIdx + 1]).toBe('/var/lib/agent-hub/acme/staging');
  });

  it('passes Route53 creds via env, never argv', async () => {
    const runner = makeFakeRunner([{ code: 0, stdout: '', stderr: '' }]);
    await renewCertsDryRun({ ...BASE_DEPS, runner });
    const call = runner.calls[0];
    expect(call.args.every((a) => !a.includes('AKIATESTKEY'))).toBe(true);
    expect(call.args.every((a) => !a.includes('supersecret'))).toBe(true);
    expect(call.env.AWS_ACCESS_KEY_ID).toBe('AKIATESTKEY');
    expect(call.env.AWS_SECRET_ACCESS_KEY).toBe('supersecret/value+with/slashes');
    expect(call.env.AWS_HOSTED_ZONE_ID).toBe('Z1ABCD1234');
  });

  it('clears ambient AWS session/profile vars to prevent cred conflicts', async () => {
    // Simulate a host with an IAM role that sets session vars.
    const origToken = process.env.AWS_SESSION_TOKEN;
    const origProfile = process.env.AWS_PROFILE;
    process.env.AWS_SESSION_TOKEN = 'ambient-session-token';
    process.env.AWS_PROFILE = 'ambient-profile';
    try {
      const runner = makeFakeRunner([{ code: 0, stdout: '', stderr: '' }]);
      await renewCertsDryRun({ ...BASE_DEPS, runner });
      const env = runner.calls[0].env;
      expect(env.AWS_SESSION_TOKEN).toBeUndefined();
      expect(env.AWS_PROFILE).toBeUndefined();
    } finally {
      if (origToken !== undefined) process.env.AWS_SESSION_TOKEN = origToken;
      else delete process.env.AWS_SESSION_TOKEN;
      if (origProfile !== undefined) process.env.AWS_PROFILE = origProfile;
      else delete process.env.AWS_PROFILE;
    }
  });
});

// ─── empty creds → AWS SDK default chain (IMDSv2) ────────────────────────

describe('renewCertsDryRun — empty Route 53 keys delegate to default chain', () => {
  /**
   * When `accessKeyId` and `secretAccessKey` are both blank, we let the
   * subprocess inherit AWS_* from `process.env` so the AWS SDK / botocore
   * default credential chain (env → shared config → IAM Role via IMDSv2)
   * takes over. On EC2 instances launched by `ops/terraform/`, the role
   * already has the correct Route 53 policy, so this is the supported
   * "let infra do it" path.
   */
  const EMPTY_CREDS_DEPS: Omit<CertRenewalDeps, 'runner'> = {
    route53: {
      accessKeyId: '',
      secretAccessKey: '',
      hostedZoneId: 'Z1ABCD1234',
    },
    wildcardDomain: '*.preview.agenthub.dev',
    certHome: '/var/lib/agent-hub/acme',
  };

  it('does not inject AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY when keys are empty', async () => {
    // Make sure nothing in the host env is shadowing our assertion.
    const origAccess = process.env.AWS_ACCESS_KEY_ID;
    const origSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const runner = makeFakeRunner([{ code: 0, stdout: '', stderr: '' }]);
      await renewCertsDryRun({ ...EMPTY_CREDS_DEPS, runner });
      const env = runner.calls[0].env;
      // The cert-renewal module spreads process.env into the spawn env;
      // when keys are empty it must NOT explicitly set AWS_ACCESS_KEY_ID.
      // (If it did, the SDK would prefer empty static creds over the
      // instance-role profile and the call would fail with InvalidClientTokenId.)
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      if (origAccess !== undefined) process.env.AWS_ACCESS_KEY_ID = origAccess;
      if (origSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = origSecret;
    }
  });

  it('preserves ambient AWS_SESSION_TOKEN when keys are empty (default chain needs it)', async () => {
    // Critical for IMDSv2: the EC2 metadata service issues a session token,
    // and the SDK propagates AWS_SESSION_TOKEN through to subprocesses. If
    // we cleared it (as the explicit-creds path does), the chain breaks.
    const origToken = process.env.AWS_SESSION_TOKEN;
    process.env.AWS_SESSION_TOKEN = 'imds-session-token';
    try {
      const runner = makeFakeRunner([{ code: 0, stdout: '', stderr: '' }]);
      await renewCertsDryRun({ ...EMPTY_CREDS_DEPS, runner });
      expect(runner.calls[0].env.AWS_SESSION_TOKEN).toBe('imds-session-token');
    } finally {
      if (origToken !== undefined) process.env.AWS_SESSION_TOKEN = origToken;
      else delete process.env.AWS_SESSION_TOKEN;
    }
  });

  it('still sets AWS_HOSTED_ZONE_ID for acme.sh when keys are empty', async () => {
    // Hosted-zone id is a routing parameter, not a credential — acme.sh
    // uses it to short-circuit zone discovery whether we're on static
    // creds or the default chain.
    const runner = makeFakeRunner([{ code: 0, stdout: '', stderr: '' }]);
    await renewCertsDryRun({ ...EMPTY_CREDS_DEPS, runner });
    expect(runner.calls[0].env.AWS_HOSTED_ZONE_ID).toBe('Z1ABCD1234');
  });
});

// ─── failure paths ───────────────────────────────────────────────────────

describe('renewCerts — error path', () => {
  it('surfaces exit code on Route53 API failure', async () => {
    const runner = makeFakeRunner([
      {
        code: 1,
        stdout: '',
        stderr: 'Route53 API error: AccessDenied for Z1ABCD1234',
      },
    ]);
    const result = await renewCerts({ ...BASE_DEPS, runner });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    // Hosted zone id is redacted from stderr.
    expect(result.stderr).not.toContain('Z1ABCD1234');
    expect(result.stderr).toContain('***REDACTED***');
  });

  it('redacts AWS secret from stderr even if the client logs it', async () => {
    const runner = makeFakeRunner([
      {
        code: 1,
        stdout: '',
        stderr: 'Failed with AKIATESTKEY / supersecret/value+with/slashes — retrying',
      },
    ]);
    const result = await renewCerts({ ...BASE_DEPS, runner });
    expect(result.stderr).not.toContain('AKIATESTKEY');
    expect(result.stderr).not.toContain('supersecret');
  });

  it('treats spawn failure as a non-ok result (no throw)', async () => {
    const runner: CertRunner = {
      async run() {
        throw new Error('ENOENT: acme.sh not on PATH');
      },
    };
    const result = await renewCertsDryRun({ ...BASE_DEPS, runner });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/spawn failed/);
  });
});

// ─── live-renewal success ────────────────────────────────────────────────

describe('renewCerts — success flags renewed=true on real cert material', () => {
  it('flips renewed=true when acme.sh stdout says "Cert success!"', async () => {
    const runner = makeFakeRunner([
      { code: 0, stdout: 'Cert success! — certificate written', stderr: '' },
    ]);
    const result = await renewCerts({ ...BASE_DEPS, runner });
    expect(result.ok).toBe(true);
    expect(result.renewed).toBe(true);
  });

  it('flips renewed=true when certbot stdout says "Successfully received certificate"', async () => {
    const runner = makeFakeRunner([
      { code: 0, stdout: 'Successfully received certificate', stderr: '' },
    ]);
    const result = await renewCerts({ ...BASE_DEPS, runner, client: 'certbot' });
    expect(result.ok).toBe(true);
    expect(result.renewed).toBe(true);
  });

  it('does NOT false-positive on "cert not renewed because it is not due"', async () => {
    const runner = makeFakeRunner([
      { code: 0, stdout: 'Skip renew, cert not renewed because it is not due', stderr: '' },
    ]);
    const result = await renewCerts({ ...BASE_DEPS, runner });
    expect(result.ok).toBe(true);
    expect(result.renewed).toBe(false);
  });
});

// ─── certbot variant ─────────────────────────────────────────────────────

describe('renewCertsDryRun — certbot variant', () => {
  it('invokes certbot with --dns-route53 and --dry-run', async () => {
    const runner = makeFakeRunner([{ code: 0, stdout: '', stderr: '' }]);
    await renewCertsDryRun({ ...BASE_DEPS, runner, client: 'certbot' });
    const args = runner.calls[0].args;
    expect(runner.calls[0].command).toBe('certbot');
    expect(args).toContain('certonly');
    expect(args).toContain('--dns-route53');
    expect(args).toContain('--dry-run');
    // certbot reads AWS creds from env too.
    expect(runner.calls[0].env.AWS_ACCESS_KEY_ID).toBe('AKIATESTKEY');
  });
});

// ─── wildcardDomainFromConfig ────────────────────────────────────────────

describe('wildcardDomainFromConfig', () => {
  it('derives the wildcard from a normal preview URL', () => {
    expect(wildcardDomainFromConfig({ previewBaseUrl: 'https://preview.agenthub.dev' })).toBe(
      '*.preview.agenthub.dev',
    );
  });

  it('handles a trailing path component', () => {
    expect(wildcardDomainFromConfig({ previewBaseUrl: 'https://preview.agenthub.dev/foo' })).toBe(
      '*.preview.agenthub.dev',
    );
  });

  it('refuses localhost (operator forgot to set previewBaseUrl)', () => {
    expect(() => wildcardDomainFromConfig({ previewBaseUrl: 'http://localhost' })).toThrow(
      /not a real host/,
    );
  });

  it('refuses a garbage URL', () => {
    expect(() => wildcardDomainFromConfig({ previewBaseUrl: 'not-a-url' })).toThrow(
      /could not parse/,
    );
  });
});
