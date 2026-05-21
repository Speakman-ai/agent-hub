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
});
