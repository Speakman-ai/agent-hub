import { describe, it, expect } from 'vitest';
import { buildPrEnvPatchFromWizardApply } from './preview-setup-apply.js';
import type { Project } from './types.js';

function stubProject(prEnv?: Project['prEnv']): Project {
  return {
    id: 'p1',
    name: 'Demo',
    cwd: '/tmp/demo',
    color: '#000',
    ahw: '/tmp/demo/.ahw',
    agents: [],
    prEnv,
  } as Project;
}

describe('buildPrEnvPatchFromWizardApply', () => {
  it('accepts compose preview with healthPath on compose sub-block', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      enabled: true,
      preview: {
        compose: {
          file: 'docker-compose.yml',
          entryService: 'web',
          entryPort: 3000,
          healthPath: '/healthz',
        },
        idleTTL: 600,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prEnv.preview?.compose?.healthPath).toBe('/healthz');
      expect(result.prEnv.preview?.startScript).toBeUndefined();
    }
  });

  it('accepts multi-process preview without startScript', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      enabled: true,
      preview: {
        processes: [
          { name: 'api', startScript: 'npm run dev', healthPath: '/' },
          {
            name: 'web',
            startScript: 'npm run dev',
            healthPath: '/',
            dependsOn: ['api'],
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prEnv.preview?.processes?.length).toBe(2);
    }
  });

  it('hoists captureRoutes and idleTTL from compose to preview', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      preview: {
        compose: {
          file: 'docker-compose.yml',
          entryService: 'web',
          entryPort: 5173,
          captureRoutes: ['/'],
          idleTTL: 600,
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prEnv.preview?.captureRoutes).toEqual(['/']);
      expect(result.prEnv.preview?.idleTTL).toBe(600);
      expect(result.prEnv.preview?.compose).not.toHaveProperty('captureRoutes');
      expect(result.prEnv.preview?.compose).not.toHaveProperty('idleTTL');
    }
  });

  it('rejects compose + startScript together', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      enabled: true,
      preview: {
        startScript: 'npm run dev',
        compose: {
          entryService: 'web',
          entryPort: 3000,
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('persists a devServer block without a compose preview', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      enabled: true,
      devServer: {
        startCommand: 'docker compose up -d --wait db && npm run dev',
        portMap: [{ internalPort: 3000, label: 'web' }],
        healthPath: '/healthz',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prEnv.devServer?.startCommand).toBe(
        'docker compose up -d --wait db && npm run dev',
      );
      // parseDevServerConfig promotes the sole portMap entry to primary.
      expect(result.prEnv.devServer?.portMap[0].primary).toBe(true);
      expect(result.prEnv.preview).toBeUndefined();
    }
  });

  it('rejects devServer combined with an app-wrapping compose preview', () => {
    // `preview.compose.entryService` IS the app-wrapping runtime — there is no
    // "services-only" compose in that field. Combining it with devServer would
    // let startSessionPreview pick the compose runtime and ignore / double-start
    // the app. Backing services belong in devServer.startCommand.
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      enabled: true,
      preview: {
        compose: { entryService: 'db', entryPort: 5432 },
      },
      devServer: {
        startCommand: 'docker compose up -d --wait && npm run dev',
        portMap: [{ internalPort: 5173, label: 'web' }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cannot be combined with devServer');
    }
  });

  it('rejects devServer combined with a startScript preview', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      enabled: true,
      preview: { startScript: 'npm run dev' },
      devServer: {
        startCommand: 'npm run dev',
        portMap: [{ internalPort: 5173, label: 'web' }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cannot be combined with devServer');
    }
  });

  it('clears a legacy app-wrapping compose preview when adopting devServer-only', () => {
    // Existing project runs the app wrapped in compose; the migration flow
    // POSTs only the devServer block. The carried-over app-wrapping compose
    // must NOT survive, or startSessionPreview would still select the compose
    // runtime and double-start the app.
    const project = stubProject({
      enabled: false,
      preview: {
        enabled: true,
        compose: { entryService: 'web', entryPort: 3000, healthPath: '/healthz' },
      },
    } as Project['prEnv']);
    const result = buildPrEnvPatchFromWizardApply(project, {
      enabled: true,
      devServer: {
        startCommand: 'docker compose up -d --wait db && npm run dev',
        portMap: [{ internalPort: 3000, label: 'web' }],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prEnv.devServer?.startCommand).toContain('npm run dev');
      // No app-wrapping compose left → compose runtime won't be selected.
      expect(result.prEnv.preview?.compose).toBeUndefined();
      expect(result.prEnv.preview?.enabled).toBe(false);
    }
  });

  it('rejects re-sending an app-wrapping compose preview alongside devServer', () => {
    // Even an explicit re-send of a compose app-wrapping preview conflicts with
    // devServer — the two runtimes cannot both own the app.
    const project = stubProject({
      enabled: false,
      preview: {
        enabled: true,
        compose: { entryService: 'web', entryPort: 3000 },
      },
    } as Project['prEnv']);
    const result = buildPrEnvPatchFromWizardApply(project, {
      enabled: true,
      preview: { compose: { entryService: 'db', entryPort: 5432 } },
      devServer: {
        startCommand: 'docker compose up -d --wait && npm run dev',
        portMap: [{ internalPort: 5173, label: 'web' }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cannot be combined with devServer');
    }
  });

  it('rejects an enabled apply with neither preview nor devServer', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('preview or devServer');
    }
  });

  it('surfaces a devServer validation error from the parser', () => {
    const result = buildPrEnvPatchFromWizardApply(stubProject(), {
      enabled: true,
      devServer: {
        startCommand: 'npm run dev',
        env: { PORT: '3000' }, // PORT is reserved → rejected
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('devServer');
    }
  });
});
