import { describe, it, expect } from 'vitest';
import { detectHost, type DetectedHost } from './detect-host.js';
import type { ProvisionIO, SpawnResult } from './io.js';

interface FakeFs {
  files: Map<string, string>;
  dirs: Set<string>;
}

function fakeIO(opts: {
  files?: Record<string, string>;
  dirs?: string[];
  spawn?: (cmd: string, args: string[]) => SpawnResult;
  fetch?: ProvisionIO['fetch'];
}): ProvisionIO {
  const fs: FakeFs = {
    files: new Map(Object.entries(opts.files ?? {})),
    dirs: new Set(opts.dirs ?? []),
  };
  return {
    fs: {
      async exists(p) {
        return fs.files.has(p) || fs.dirs.has(p);
      },
      async readFile(p) {
        const body = fs.files.get(p);
        if (body === undefined) throw new Error(`ENOENT: ${p}`);
        return body;
      },
      async readdir(p) {
        if (!fs.dirs.has(p)) throw new Error(`ENOENT: ${p}`);
        const prefix = p.endsWith('/') ? p : `${p}/`;
        return Array.from(fs.files.keys())
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length).split('/')[0]!);
      },
      async writeFileAtomic(p, body) {
        fs.files.set(p, body);
      },
      async mkdirp(p) {
        fs.dirs.add(p);
      },
      async isWritableDir(p) {
        return fs.dirs.has(p);
      },
    },
    async spawn(cmd, args) {
      return opts.spawn ? opts.spawn(cmd, args) : { code: 127, stdout: '', stderr: 'no spawn' };
    },
    fetch: opts.fetch ?? (async () => new Response(null, { status: 599 })),
  };
}

const noFetch: ProvisionIO['fetch'] = async () => new Response(null, { status: 599 });

describe('detectHost — containerized', () => {
  it('classifies a Docker container via /.dockerenv', async () => {
    const io = fakeIO({ files: { '/.dockerenv': '' } });
    const result = await detectHost(io, { devNginxStubDir: '/tmp/dev-nginx' });
    expect(result.class).toBe('containerized');
    expect(result.sitesAvailableDir).toBe('/etc/nginx/conf.d');
    expect(result.sitesEnabledDir).toBe('/etc/nginx/conf.d');
    expect(result.baseVhostPath).toBe('/etc/nginx/conf.d/agent-hub-pr-env.conf');
    expect(result.certPathFor('preview.example.com')).toBe(
      '/etc/letsencrypt/live/preview.example.com/fullchain.pem',
    );
  });

  it('classifies via /proc/1/cgroup container marker', async () => {
    const io = fakeIO({
      files: {
        '/proc/1/cgroup': '12:cpu:/docker/abc\n11:memory:/kubepods/poda/cca\n',
      },
    });
    const result = await detectHost(io, { devNginxStubDir: '/tmp/dev-nginx' });
    expect(result.class).toBe('containerized');
  });

  it('does not match when /proc/1/cgroup lacks container markers', async () => {
    const io = fakeIO({
      files: {
        '/proc/1/cgroup': '11:memory:/system.slice/foo.service\n',
      },
      // dev fallback path requires NODE_ENV != production
    });
    const result = await detectHost(io, {
      devNginxStubDir: '/tmp/dev-nginx',
      readNodeEnv: () => 'development',
    });
    expect(result.class).toBe('dev');
  });
});

describe('detectHost — pm2-on-ec2', () => {
  it('classifies as pm2-on-ec2 with successful pm2 + IMDS instance id', async () => {
    const io = fakeIO({
      spawn: (cmd) =>
        cmd === 'pm2' ? { code: 0, stdout: '', stderr: '' } : { code: 127, stdout: '', stderr: '' },
      fetch: async (url, init) => {
        if (init?.method === 'PUT') return new Response('imds-token', { status: 200 });
        if (String(url).endsWith('/iam/info'))
          return new Response(
            JSON.stringify({
              InstanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/ryan-ec2-ssm',
            }),
            { status: 200 },
          );
        if (String(url).endsWith('/instance-id')) return new Response('i-0abc', { status: 200 });
        return new Response(null, { status: 404 });
      },
    });
    const result = await detectHost(io, { devNginxStubDir: '/tmp/dev-nginx' });
    expect(result.class).toBe('pm2-on-ec2');
    expect(result.sitesAvailableDir).toBe('/etc/nginx/sites-available');
    expect(result.sitesEnabledDir).toBe('/etc/nginx/sites-enabled');
    expect(result.instanceId).toBe('i-0abc');
    expect(result.instanceRoleArn).toBe('arn:aws:iam::123456789012:instance-profile/ryan-ec2-ssm');
    expect(result.instanceRoleName).toBe('ryan-ec2-ssm');
  });

  it('classifies as pm2-on-ec2 via product_uuid when IMDS is absent', async () => {
    const io = fakeIO({
      files: {
        '/sys/devices/virtual/dmi/id/product_uuid': 'EC2A1B2C-1234-5678-90AB-CDEF01234567',
      },
      spawn: (cmd) =>
        cmd === 'pm2' ? { code: 0, stdout: '', stderr: '' } : { code: 127, stdout: '', stderr: '' },
      fetch: noFetch,
    });
    const result = await detectHost(io, { devNginxStubDir: '/tmp/dev-nginx' });
    expect(result.class).toBe('pm2-on-ec2');
  });

  it('falls through to dev when pm2 succeeds but neither EC2 marker is present', async () => {
    const io = fakeIO({
      spawn: (cmd) =>
        cmd === 'pm2' ? { code: 0, stdout: '', stderr: '' } : { code: 127, stdout: '', stderr: '' },
      fetch: noFetch,
    });
    const result = await detectHost(io, {
      devNginxStubDir: '/tmp/dev-nginx',
      readNodeEnv: () => 'development',
    });
    expect(result.class).toBe('dev');
  });
});

describe('detectHost — dev fallback', () => {
  it('refuses dev fallback when NODE_ENV=production', async () => {
    const io = fakeIO({ fetch: noFetch });
    await expect(
      detectHost(io, {
        devNginxStubDir: '/tmp/dev-nginx',
        readNodeEnv: () => 'production',
      }),
    ).rejects.toThrow(/NODE_ENV=production/);
  });

  it('returns dev with stub paths when NODE_ENV=development', async () => {
    const io = fakeIO({ fetch: noFetch });
    const result = await detectHost(io, {
      devNginxStubDir: '/tmp/dev-nginx',
      readNodeEnv: () => 'development',
    });
    expect(result.class).toBe('dev');
    expect(result.sitesAvailableDir).toBe('/tmp/dev-nginx');
    expect(result.baseVhostPath).toBe('/tmp/dev-nginx/agent-hub-pr-env.conf');
    expect(result.certPathFor('preview.example.com')).toBe(
      '/tmp/dev-nginx/preview.example.com/fullchain.pem',
    );
  });
});

describe('detectHost — log/notes integration', () => {
  it('forwards probe notes to the log sink', async () => {
    const lines: string[] = [];
    const io = fakeIO({ files: { '/.dockerenv': '' } });
    const result: DetectedHost = await detectHost(io, {
      devNginxStubDir: '/tmp/dev-nginx',
      log: (l) => lines.push(l),
    });
    expect(result.class).toBe('containerized');
    expect(lines.some((l) => l.includes('/.dockerenv present'))).toBe(true);
    expect(result.notes).toEqual(lines);
  });
});

describe('detectHost — IMDSv2 token exchange', () => {
  it('treats IMDS token PUT failure as non-EC2 (not a hard error)', async () => {
    const io = fakeIO({
      files: { '/.dockerenv': '' },
      fetch: async () => {
        throw new Error('connect ETIMEDOUT 169.254.169.254');
      },
    });
    const result = await detectHost(io, { devNginxStubDir: '/tmp/dev-nginx' });
    expect(result.class).toBe('containerized');
    expect(result.instanceId).toBeNull();
    expect(result.instanceRoleArn).toBeNull();
  });
});
