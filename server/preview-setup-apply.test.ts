import { describe, expect, it } from 'vitest';
import { buildPrEnvPatchFromWizardApply } from './preview-setup-apply.js';
import type { Project } from './types.js';

function project(prEnv?: Project['prEnv']): Project {
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
  it('persists a validated dev-server block without legacy preview state', () => {
    const result = buildPrEnvPatchFromWizardApply(project(), {
      devServer: {
        startCommand: 'npm run dev',
        portMap: [{ internalPort: 3000, label: 'web' }],
        healthPath: '/healthz',
        idleTTL: 600,
      },
    });

    expect(result).toEqual({
      ok: true,
      prEnv: {
        enabled: false,
        devServer: {
          startCommand: 'npm run dev',
          env: {},
          secretKeys: [],
          portMap: [{ internalPort: 3000, label: 'web', primary: true }],
          healthPath: '/healthz',
          idleTTL: 600,
          aptPackages: [],
        },
      },
    });
  });

  it('drops carried legacy preview keys when migrating an existing project', () => {
    const result = buildPrEnvPatchFromWizardApply(
      project({ enabled: false, preview: { enabled: true } } as unknown as Project['prEnv']),
      {
        devServer: {
          startCommand: 'pnpm dev',
          portMap: [{ internalPort: 5173, label: 'web', primary: true }],
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prEnv).not.toHaveProperty('preview');
  });

  it('returns a validation error for an invalid dev-server config', () => {
    const result = buildPrEnvPatchFromWizardApply(project(), {
      devServer: { startCommand: 'npm run dev', env: { PORT: '3000' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('devServer');
  });
});
