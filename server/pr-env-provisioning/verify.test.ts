import { describe, it, expect } from 'vitest';
import { verifyPhase, type VerifyAdapters, type VerifyCheck } from './verify.js';
import type { RemediationCard } from './orchestrator.js';

function passing(name: string): VerifyCheck {
  return { name, pass: true, message: `${name} ok` };
}
function failing(name: string, message = 'broken'): VerifyCheck {
  return { name, pass: false, message };
}

function makeAdapters(over: Partial<VerifyAdapters> = {}): VerifyAdapters {
  return {
    async checkDocker() {
      return passing('docker');
    },
    async checkNginx() {
      return passing('nginx');
    },
    async checkCert() {
      return passing('cert');
    },
    async checkGithubApp() {
      return passing('github-app');
    },
    async checkRoute53() {
      return passing('route53');
    },
    async checkWebhook() {
      return passing('webhook');
    },
    ...over,
  };
}

const PATHS = {
  sitesAvailableDir: '/etc/nginx/conf.d',
  sitesEnabledDir: '/etc/nginx/conf.d',
  baseVhostPath: '/etc/nginx/conf.d/agent-hub-pr-env.conf',
};
const APP = { appId: '123', installationId: '456', privateKey: '-----BEGIN-----' };
const R53 = { accessKeyId: '', secretAccessKey: '', hostedZoneId: 'Z1' };

describe('verifyPhase — all green', () => {
  it('returns status=ok with no remediations when every check passes', async () => {
    const result = await verifyPhase({
      adapters: makeAdapters(),
      nginxPaths: PATHS,
      certPath: '/etc/letsencrypt/live/h/fullchain.pem',
      githubApp: APP,
      route53: R53,
    });
    expect(result.status).toBe('ok');
    expect(result.remediations).toBeUndefined();
    expect(result.message).toMatch(/6\/6/);
  });
});

describe('verifyPhase — required-failure remediations', () => {
  it('emits a red remediation per failing required check, in order', async () => {
    const result = await verifyPhase({
      adapters: makeAdapters({
        async checkCert() {
          return failing('cert', 'cert expired');
        },
        async checkRoute53() {
          return failing('route53', 'AccessDenied');
        },
      }),
      nginxPaths: PATHS,
      certPath: '/x',
      githubApp: APP,
      route53: R53,
    });
    expect(result.status).toBe('ok'); // verify never `failed`s the run
    expect(result.remediations).toHaveLength(2);
    expect(result.remediations?.[0]?.check).toBe('cert');
    expect(result.remediations?.[0]?.severity).toBe('red');
    expect(result.remediations?.[1]?.check).toBe('route53');
  });

  it('does NOT emit remediations for failing docker (informational only)', async () => {
    const result = await verifyPhase({
      adapters: makeAdapters({
        async checkDocker() {
          return failing('docker', 'daemon down');
        },
      }),
      nginxPaths: PATHS,
      certPath: '/x',
      githubApp: APP,
      route53: R53,
    });
    expect(result.status).toBe('ok');
    expect(result.remediations).toBeUndefined();
  });

  it('forwards pendingRemediations from attach-iam at the top of the list', async () => {
    const card: RemediationCard = {
      check: 'route53',
      severity: 'amber',
      headline: 'attach IAM (carried over)',
      actions: [],
    };
    const result = await verifyPhase({
      adapters: makeAdapters({
        async checkCert() {
          return failing('cert');
        },
      }),
      nginxPaths: PATHS,
      certPath: '/x',
      githubApp: APP,
      route53: R53,
      pendingRemediations: [card],
    });
    expect(result.remediations?.[0]).toBe(card);
    expect(result.remediations?.[1]?.check).toBe('cert');
  });
});

describe('verifyPhase — adapter-throw safety', () => {
  it('translates a thrown adapter into a failing check, no orchestrator crash', async () => {
    const result = await verifyPhase({
      adapters: makeAdapters({
        async checkNginx() {
          throw new Error('nginx adapter blew up');
        },
      }),
      nginxPaths: PATHS,
      certPath: '/x',
      githubApp: APP,
      route53: R53,
    });
    expect(result.status).toBe('ok');
    expect(result.remediations?.some((c) => c.check === 'nginx')).toBe(true);
    expect(result.remediations?.find((c) => c.check === 'nginx')?.detail).toMatch(
      /nginx adapter blew up/,
    );
  });
});
