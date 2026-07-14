import { describe, it, expect } from 'vitest';
import {
  migrateComposePreviewToDevServer,
  buildComposeServicesUpCommand,
  DEFAULT_COMPOSE_FILE,
} from './migrate-compose-preview.js';
import { DEV_SERVER_DEFAULT_START_COMMAND } from '../dev-server-config.js';
import type { PreviewComposeConfig } from '../types.js';

function baseCompose(overrides: Partial<PreviewComposeConfig> = {}): PreviewComposeConfig {
  return { entryService: 'web', entryPort: 3000, ...overrides };
}

describe('buildComposeServicesUpCommand', () => {
  it('defaults the compose file and appends --wait', () => {
    expect(buildComposeServicesUpCommand({})).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait`,
    );
  });

  it('honors a custom file and env-file', () => {
    expect(
      buildComposeServicesUpCommand({ file: 'compose.dev.yaml', envFile: '.env.preview' }),
    ).toBe('docker compose -f compose.dev.yaml --env-file .env.preview up -d --wait');
  });

  it('lists explicit backing services after the flags', () => {
    expect(buildComposeServicesUpCommand({}, ['db', 'redis'])).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait db redis`,
    );
  });

  it('drops blank service names and shell-quotes odd tokens', () => {
    expect(buildComposeServicesUpCommand({ file: 'my compose.yml' }, ['db', '  '])).toBe(
      `docker compose -f 'my compose.yml' up -d --wait db`,
    );
  });

  it('emits --scale <app>=0 when only an excludeService is given (no services)', () => {
    expect(buildComposeServicesUpCommand({}, { excludeService: 'web' })).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait --scale web=0`,
    );
  });

  it('keeps --scale <app>=0 even with explicit services (guards depends_on)', () => {
    // `up -d db` resolves db's depends_on, which may include the app service;
    // the always-present --scale web=0 holds it at 0 replicas regardless.
    expect(buildComposeServicesUpCommand({}, { services: ['db'], excludeService: 'web' })).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait --scale web=0 db`,
    );
  });

  it('applies filePathPrefix to the compose file and env-file', () => {
    expect(
      buildComposeServicesUpCommand(
        { file: 'docker-compose.yml', envFile: '.env.preview' },
        { excludeService: 'web', filePathPrefix: '../../' },
      ),
    ).toBe(
      'docker compose -f ../../docker-compose.yml --env-file ../../.env.preview up -d --wait --scale web=0',
    );
  });
});

describe('migrateComposePreviewToDevServer', () => {
  it('maps entryService/entryPort to a primary portMap entry', () => {
    const { devServer } = migrateComposePreviewToDevServer(
      baseCompose({ entryService: 'frontend', entryPort: 5173 }),
    );
    expect(devServer.portMap).toEqual([{ internalPort: 5173, label: 'frontend', primary: true }]);
  });

  it('builds a startCommand that brings up services then runs the app dev server', () => {
    const { startCommand, devServer } = migrateComposePreviewToDevServer(baseCompose(), {
      services: ['db', 'redis'],
      appDevCommand: 'pnpm dev',
    });
    // --scale web=0 (default entryService) guards against the app being pulled
    // in as a depends_on dependency of db/redis.
    expect(startCommand).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait --scale web=0 db redis && pnpm dev`,
    );
    expect(devServer.startCommand).toBe(startCommand);
  });

  it('defaults the app dev command to npm run dev and warns about it', () => {
    const { startCommand, warnings } = migrateComposePreviewToDevServer(baseCompose());
    expect(startCommand.endsWith(`&& ${DEV_SERVER_DEFAULT_START_COMMAND}`)).toBe(true);
    expect(warnings.some((w) => w.includes('Verify the app dev command'))).toBe(true);
  });

  it('guards the default plan with --scale <app>=0 when services are not enumerated', () => {
    const { startCommand, warnings } = migrateComposePreviewToDevServer(
      baseCompose({ entryService: 'web' }),
      { appDevCommand: 'npm run dev' },
    );
    // Safe-by-construction: every other service starts, the app stays off.
    expect(startCommand).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait --scale web=0 && npm run dev`,
    );
    expect(warnings.some((w) => w.includes('--scale web=0'))).toBe(true);
  });

  it('does not emit the double-start warning when services are enumerated', () => {
    const { warnings } = migrateComposePreviewToDevServer(baseCompose(), {
      services: ['db'],
      appDevCommand: 'npm run dev:web',
    });
    expect(warnings.some((w) => w.includes('double-start'))).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('filters the entry service out of the backing-services list and warns', () => {
    const { startCommand, warnings } = migrateComposePreviewToDevServer(
      baseCompose({ entryService: 'web', entryPort: 3000 }),
      { services: ['web', 'db'], appDevCommand: 'npm run dev' },
    );
    // "web" (the app) must NOT be a positional service — only "db" — and
    // --scale web=0 guards it against depends_on resolution.
    expect(startCommand).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait --scale web=0 db && npm run dev`,
    );
    expect(warnings.some((w) => w.includes('Excluded the app service "web"'))).toBe(true);
  });

  it('falls back to --scale <app>=0 when the only requested service was the entry service', () => {
    const { startCommand, warnings } = migrateComposePreviewToDevServer(
      baseCompose({ entryService: 'web' }),
      { services: ['web'], appDevCommand: 'npm run dev' },
    );
    // No backing services remain after filtering → guarded default, not a bare
    // `up -d` that would start the app.
    expect(startCommand).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait --scale web=0 && npm run dev`,
    );
    expect(warnings.some((w) => w.includes('Excluded the app service'))).toBe(true);
    expect(warnings.some((w) => w.includes('--scale web=0'))).toBe(true);
  });

  it('carries over healthPath and readyTimeoutMs', () => {
    const { devServer } = migrateComposePreviewToDevServer(
      baseCompose({ healthPath: '/healthz', readyTimeoutMs: 90_000 }),
      { services: ['db'], appDevCommand: 'npm run dev' },
    );
    expect(devServer.healthPath).toBe('/healthz');
    expect(devServer.readyTimeoutMs).toBe(90_000);
  });

  it('maps a monorepo entrySourceDir to cwd but ignores the root "."', () => {
    const sub = migrateComposePreviewToDevServer(baseCompose({ entrySourceDir: 'apps/web' }), {
      services: ['db'],
      appDevCommand: 'npm run dev',
    });
    expect(sub.devServer.cwd).toBe('apps/web');

    const root = migrateComposePreviewToDevServer(baseCompose({ entrySourceDir: '.' }), {
      services: ['db'],
      appDevCommand: 'npm run dev',
    });
    expect(root.devServer.cwd).toBeUndefined();
  });

  it('rewrites compose/env-file paths to reach the root from a monorepo cwd', () => {
    const { startCommand, devServer, warnings } = migrateComposePreviewToDevServer(
      baseCompose({
        entryService: 'web',
        entrySourceDir: 'apps/web',
        envFile: '.env.preview',
      }),
      { services: ['db'], appDevCommand: 'npm run dev' },
    );
    // cwd is apps/web (2 segments) → ../../ prefix so the root compose file
    // resolves when the process runs from the subdir.
    expect(devServer.cwd).toBe('apps/web');
    expect(startCommand).toBe(
      'docker compose -f ../../docker-compose.yml --env-file ../../.env.preview ' +
        'up -d --wait --scale web=0 db && npm run dev',
    );
    expect(warnings.some((w) => w.includes('devServer.cwd is "apps/web"'))).toBe(true);
  });

  it('does not rewrite compose paths when there is no monorepo cwd', () => {
    const { startCommand } = migrateComposePreviewToDevServer(
      baseCompose({ entryService: 'web' }),
      {
        services: ['db'],
        appDevCommand: 'npm run dev',
      },
    );
    expect(startCommand).toBe(
      `docker compose -f ${DEFAULT_COMPOSE_FILE} up -d --wait --scale web=0 db && npm run dev`,
    );
  });

  it('warns that the compose envFile is not consumed by the host process', () => {
    const { warnings } = migrateComposePreviewToDevServer(
      baseCompose({ envFile: '.env.preview' }),
      { services: ['db'], appDevCommand: 'npm run dev' },
    );
    expect(warnings.some((w) => w.includes('envFile ".env.preview"'))).toBe(true);
  });

  it('warns that compose live-mount fields are obsolete', () => {
    const { warnings } = migrateComposePreviewToDevServer(
      baseCompose({ entryWorkdir: '/app', shadowDirs: ['node_modules'] }),
      { services: ['db'], appDevCommand: 'npm run dev' },
    );
    expect(warnings.some((w) => w.includes('live-mount fields'))).toBe(true);
  });

  it('produces a config that round-trips through the dev-server validator', () => {
    // A non-throwing result already proves the generated config validated;
    // assert the key normalized fields to guard against silent drift.
    const { devServer } = migrateComposePreviewToDevServer(
      baseCompose({ entryService: 'api', entryPort: 8080, healthPath: '/api/health' }),
      { services: ['db', 'redis'], appDevCommand: 'npm start' },
    );
    expect(devServer.portMap[0].primary).toBe(true);
    expect(devServer.env).toEqual({});
    expect(devServer.secretKeys).toEqual([]);
  });
});
