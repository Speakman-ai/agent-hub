import { describe, it, expect, beforeEach } from 'vitest';
import { createRealExecutor } from './executor.js';
import {
  PR_ENV_PHASE_IDS,
  _resetJobsForTests,
  startProvisionJob,
  snapshotEvents,
  isJobFinished,
} from './orchestrator.js';
import type { ProvisionIO, SpawnResult } from './io.js';
import type { VerifyAdapters, VerifyCheck } from './verify.js';
import type { IamClient } from './attach-iam.js';

const PAYLOAD = {
  previewHost: 'preview.example.com',
  hostedZoneId: 'Z123',
  repoFullName: 'acme/widgets',
};

async function waitForDone(jobId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!isJobFinished(jobId)) {
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeIO(opts: {
  files?: Record<string, string>;
  spawn?: (cmd: string, args: string[]) => SpawnResult;
  fetch?: ProvisionIO['fetch'];
}): ProvisionIO & { _files: Map<string, string> } {
  const files = new Map(Object.entries(opts.files ?? {}));
  return {
    fs: {
      async exists(p) {
        return files.has(p);
      },
      async readFile(p) {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      async readdir() {
        return [];
      },
      async writeFileAtomic(p, body) {
        files.set(p, body);
      },
      async mkdirp() {},
      async isWritableDir() {
        return true;
      },
    },
    async spawn(cmd, args) {
      return opts.spawn ? opts.spawn(cmd, args) : { code: 0, stdout: '', stderr: '' };
    },
    fetch: opts.fetch ?? (async () => new Response(null, { status: 599 })),
    _files: files,
  };
}

function passingAdapters(): VerifyAdapters {
  const ok = (name: string): VerifyCheck => ({ name, pass: true, message: 'ok' });
  return {
    async checkDocker() {
      return ok('docker');
    },
    async checkNginx() {
      return ok('nginx');
    },
    async checkCert() {
      return ok('cert');
    },
    async checkGithubApp() {
      return ok('github-app');
    },
    async checkRoute53() {
      return ok('route53');
    },
    async checkWebhook() {
      return ok('webhook');
    },
  };
}

beforeEach(() => {
  _resetJobsForTests();
});

describe('createRealExecutor — happy path (containerized)', () => {
  it('drives every phase to ok and writes config.json with detected paths', async () => {
    const io = makeIO({
      files: { '/.dockerenv': '' },
      spawn: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const iamCalls: Array<{ RoleName: string }> = [];
    const iam: IamClient = {
      async putRolePolicy(input) {
        iamCalls.push(input);
      },
    };
    const exec = createRealExecutor({
      io,
      configPath: '/data/config.json',
      devNginxStubDir: '/tmp/dev-nginx',
      iam,
      hasExplicitAwsCreds: true,
      verifyAdapters: passingAdapters(),
      githubApp: { appId: '1', installationId: '2', privateKey: 'pk' },
      route53: { accessKeyId: 'AKIA', secretAccessKey: 'sk', hostedZoneId: 'Z1' },
    });

    startProvisionJob({ jobId: 'real-happy', payload: PAYLOAD, executor: exec });
    await waitForDone('real-happy');

    const events = snapshotEvents('real-happy');
    const phaseEvents = events.filter((e) => e.type === 'phase');
    expect(phaseEvents.length).toBe(PR_ENV_PHASE_IDS.length * 2);
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.outcome).toBe('ok');
      expect(done.remediations).toBeUndefined();
    }

    const written = JSON.parse(io._files.get('/data/config.json') ?? '{}');
    expect(written.prEnv.nginx.sitesAvailableDir).toBe('/etc/nginx/conf.d');
    expect(written.prEnv.nginx.previewHost).toBe('preview.example.com');
  });
});

describe('createRealExecutor — copy-paste fallback', () => {
  it('downgrades to partial when verify is amber + carries IAM card forward', async () => {
    const io = makeIO({
      files: { '/.dockerenv': '' },
      spawn: () => ({ code: 0, stdout: '', stderr: '' }),
      fetch: async () => {
        throw new Error('IMDS unreachable');
      },
    });
    // no creds, no instance role → attach-iam should emit a generic card
    const exec = createRealExecutor({
      io,
      configPath: '/data/config.json',
      devNginxStubDir: '/tmp/dev-nginx',
      iam: null,
      hasExplicitAwsCreds: false,
      verifyAdapters: {
        ...passingAdapters(),
        async checkRoute53() {
          return { name: 'route53', pass: false, message: 'AccessDenied' };
        },
      },
      githubApp: { appId: '1', installationId: '2', privateKey: 'pk' },
      route53: { accessKeyId: '', secretAccessKey: '', hostedZoneId: 'Z1' },
    });

    startProvisionJob({ jobId: 'real-partial', payload: PAYLOAD, executor: exec });
    await waitForDone('real-partial');
    const done = snapshotEvents('real-partial').at(-1);
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.outcome).toBe('partial');
    expect(done.remediations?.length).toBeGreaterThanOrEqual(1);
    // First remediation is the carried-forward IAM copy-paste card.
    expect(done.remediations?.[0]?.headline).toMatch(/Attach IAM policy/);
  });
});

describe('createRealExecutor — issue-cert subprocess wiring', () => {
  it('halts the job when certbot fails and emits done.outcome=error', async () => {
    const io = makeIO({
      files: { '/.dockerenv': '' },
      spawn: (cmd) => {
        if (cmd === 'certbot') return { code: 1, stdout: '', stderr: 'AccessDenied on Route 53' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const exec = createRealExecutor({
      io,
      configPath: '/data/config.json',
      devNginxStubDir: '/tmp/dev-nginx',
      iam: null,
      hasExplicitAwsCreds: false,
      verifyAdapters: passingAdapters(),
      githubApp: { appId: '1', installationId: '2', privateKey: 'pk' },
      route53: { accessKeyId: '', secretAccessKey: '', hostedZoneId: 'Z1' },
    });

    startProvisionJob({ jobId: 'real-cert-fail', payload: PAYLOAD, executor: exec });
    await waitForDone('real-cert-fail');
    const done = snapshotEvents('real-cert-fail').at(-1);
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.outcome).toBe('error');
    expect(done.error?.message).toMatch(/AccessDenied/);
  });
});

describe('createRealExecutor — dryRun', () => {
  it('skips write-tier3-config and still issues the cert / verifies', async () => {
    const io = makeIO({
      files: { '/.dockerenv': '' },
      spawn: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const exec = createRealExecutor({
      io,
      configPath: '/data/config.json',
      devNginxStubDir: '/tmp/dev-nginx',
      iam: { async putRolePolicy() {} },
      hasExplicitAwsCreds: true,
      verifyAdapters: passingAdapters(),
      githubApp: { appId: '1', installationId: '2', privateKey: 'pk' },
      route53: { accessKeyId: '', secretAccessKey: '', hostedZoneId: 'Z1' },
    });
    startProvisionJob({
      jobId: 'real-dry',
      payload: { ...PAYLOAD, dryRun: true },
      executor: exec,
    });
    await waitForDone('real-dry');
    const events = snapshotEvents('real-dry');
    const tier3 = events.find((e) => e.type === 'phase' && e.phase === 'write-tier3-config');
    expect(tier3?.type === 'phase' && tier3.status).toBe('skipped');
    // config.json was NOT written
    expect(io._files.has('/data/config.json')).toBe(false);
  });
});
