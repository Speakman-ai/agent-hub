import { describe, it, expect, beforeEach } from 'vitest';
import { writeTier3Config } from './write-tier3-config.js';
import type { DetectedHost } from './detect-host.js';
import type { ProvisionIO } from './io.js';

function memFs(initial: Record<string, string> = {}): ProvisionIO & {
  _files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  const io: ProvisionIO = {
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
    async spawn() {
      return { code: 0, stdout: '', stderr: '' };
    },
    fetch: async () => new Response(null, { status: 200 }),
  };
  return Object.assign(io, { _files: files });
}

function detected(over: Partial<DetectedHost> = {}): DetectedHost {
  return {
    class: 'pm2-on-ec2',
    sitesAvailableDir: '/etc/nginx/sites-available',
    sitesEnabledDir: '/etc/nginx/sites-enabled',
    baseVhostPath: '/etc/nginx/sites-available/agent-hub-pr-env',
    certPathFor: (h) => `/etc/letsencrypt/live/${h}/fullchain.pem`,
    keyPathFor: (h) => `/etc/letsencrypt/live/${h}/privkey.pem`,
    instanceRoleArn: null,
    instanceRoleName: null,
    instanceId: null,
    notes: [],
    ...over,
  };
}

describe('writeTier3Config — file write', () => {
  it('creates config.json when missing and writes the full nginx block', async () => {
    const io = memFs();
    const result = await writeTier3Config({
      io,
      detected: detected(),
      payload: { previewHost: 'preview.example.com' },
      configPath: '/data/config.json',
    });

    const written = JSON.parse(
      (io as unknown as { _files: Map<string, string> })._files.get('/data/config.json') ?? '{}',
    );
    expect(written.prEnv.nginx).toEqual({
      previewHost: 'preview.example.com',
      previewBaseUrl: 'https://pr-{{number}}.preview.example.com',
      baseVhostPath: '/etc/nginx/sites-available/agent-hub-pr-env',
      sitesAvailableDir: '/etc/nginx/sites-available',
      sitesEnabledDir: '/etc/nginx/sites-enabled',
      certPath: '/etc/letsencrypt/live/preview.example.com/fullchain.pem',
      keyPath: '/etc/letsencrypt/live/preview.example.com/privkey.pem',
      certHome: '/etc/letsencrypt',
    });
    expect(result.changedKeys).toBe(8);
    expect(result.certPath).toBe('/etc/letsencrypt/live/preview.example.com/fullchain.pem');
  });

  it('preserves unrelated top-level keys via deep merge', async () => {
    const io = memFs({
      '/data/config.json': JSON.stringify({
        port: 3051,
        someOther: { nested: 'value' },
        prEnv: { enabled: true, nginx: { customField: 'keep' } },
      }),
    });

    await writeTier3Config({
      io,
      detected: detected(),
      payload: { previewHost: 'preview.example.com' },
      configPath: '/data/config.json',
    });

    const written = JSON.parse(
      (io as unknown as { _files: Map<string, string> })._files.get('/data/config.json') ?? '{}',
    );
    expect(written.port).toBe(3051);
    expect(written.someOther.nested).toBe('value');
    expect(written.prEnv.enabled).toBe(true);
    expect(written.prEnv.nginx.customField).toBe('keep');
    expect(written.prEnv.nginx.previewHost).toBe('preview.example.com');
  });

  it('refuses to overwrite a corrupt config.json', async () => {
    const io = memFs({ '/data/config.json': '{ this is not json' });
    await expect(
      writeTier3Config({
        io,
        detected: detected(),
        payload: { previewHost: 'preview.example.com' },
        configPath: '/data/config.json',
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('rejects an empty previewHost', async () => {
    const io = memFs();
    await expect(
      writeTier3Config({
        io,
        detected: detected(),
        payload: { previewHost: '   ' },
        configPath: '/data/config.json',
      }),
    ).rejects.toThrow(/previewHost is required/);
  });
});

describe('writeTier3Config — nginx-paths bug fix', () => {
  it('writes containerized layout (`/etc/nginx/conf.d`) when host is containerized', async () => {
    const io = memFs();
    await writeTier3Config({
      io,
      detected: detected({
        class: 'containerized',
        sitesAvailableDir: '/etc/nginx/conf.d',
        sitesEnabledDir: '/etc/nginx/conf.d',
        baseVhostPath: '/etc/nginx/conf.d/agent-hub-pr-env.conf',
      }),
      payload: { previewHost: 'preview.example.com' },
      configPath: '/data/config.json',
    });

    const written = JSON.parse(
      (io as unknown as { _files: Map<string, string> })._files.get('/data/config.json') ?? '{}',
    );
    // The bug: validate previously hardcoded `/etc/nginx/sites-available`,
    // even on containerized AL2023 hosts that only have `/etc/nginx/conf.d`.
    // After this adapter runs, sitesAvailable === sitesEnabled === conf.d.
    expect(written.prEnv.nginx.sitesAvailableDir).toBe('/etc/nginx/conf.d');
    expect(written.prEnv.nginx.sitesEnabledDir).toBe('/etc/nginx/conf.d');
    expect(written.prEnv.nginx.baseVhostPath).toBe('/etc/nginx/conf.d/agent-hub-pr-env.conf');
  });

  it('reports zero changed keys on a re-run with identical inputs', async () => {
    const io = memFs();
    const args = {
      io,
      detected: detected(),
      payload: { previewHost: 'preview.example.com' },
      configPath: '/data/config.json',
    };
    await writeTier3Config(args);
    const second = await writeTier3Config(args);
    expect(second.changedKeys).toBe(0);
  });
});

describe('writeTier3Config — atomicity', () => {
  it('writes via FsIO.writeFileAtomic so partial writes are not visible', async () => {
    let atomicCalls = 0;
    const io = memFs();
    const original = io.fs.writeFileAtomic.bind(io.fs);
    io.fs.writeFileAtomic = async (...args) => {
      atomicCalls += 1;
      return original(...args);
    };
    await writeTier3Config({
      io,
      detected: detected(),
      payload: { previewHost: 'preview.example.com' },
      configPath: '/data/config.json',
    });
    expect(atomicCalls).toBe(1);
  });
});

describe('writeTier3Config — DB backfill', () => {
  it('marks dbBackfilled=false when no db is provided (file-only mode)', async () => {
    const io = memFs();
    const result = await writeTier3Config({
      io,
      detected: detected(),
      payload: { previewHost: 'preview.example.com' },
      configPath: '/data/config.json',
    });
    expect(result.dbBackfilled).toBe(false);
  });
});
