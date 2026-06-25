/**
 * Focused unit coverage for `runPreviewEnvironmentBuild`. The existing
 * supertest in `server/test/preview-environment-route.test.ts` covers
 * authn/authz and shape errors; this file pins the body→prEnv mapping for
 * fields that round-trip into the persisted project config — specifically
 * the per-project `compose.readyTimeoutMs` override that the wizard now
 * exposes (card 6fa63d9e).
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./preview-compose-build-test.js', () => ({
  // Skip the real docker compose ready-poll loop — we only care about the
  // pre-test mutation of project.prEnv, not the build phase outcome.
  runPreviewComposeBuildTest: vi.fn().mockResolvedValue({
    ok: false,
    ports: { allocated: null },
    durationMs: 0,
    error: 'stubbed — skipping real compose run in unit test',
    logTail: [],
  }),
}));

vi.mock('./preview/preview-secrets-store.js', () => ({
  listRawPreviewSecretRows: vi.fn().mockReturnValue([]),
  replacePreviewSecretsMixed: vi.fn(),
  parseDotEnv: vi.fn().mockReturnValue([]),
  PreviewSecretValidationError: class extends Error {
    statusCode = 400;
  },
}));

import { runPreviewEnvironmentBuild } from './preview-environment-build.js';
import type { Project } from './types.js';

function makeProjectWithCompose(): { project: Project; cwd: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'preview-build-test-'));
  // Minimal valid compose so writeFileSync isn't triggered and the runner
  // moves on to the prEnv mutation step.
  writeFileSync(
    path.join(cwd, 'docker-compose.yml'),
    'services:\n  web:\n    image: nginx\n    ports: ["3000:3000"]\n',
    'utf8',
  );
  // Parent prEnv left disabled — the compose preview config lives under
  // `prEnv.preview.compose` and the validator routes through the "PR-env
  // stripped" branch when the parent flag is off. That branch is what
  // production projects use today; the alternate path requires
  // `startScript` + `internalPort` from the long-retired PR-env runner.
  const project = {
    id: `proj-${Date.now()}`,
    name: 'preview-build-unit',
    cwd,
    ahw: cwd,
    agents: [],
    prEnv: { enabled: false },
  } as unknown as Project;
  return { project, cwd };
}

describe('runPreviewEnvironmentBuild — readyTimeoutMs round-trip', () => {
  const getRuntimeStub = vi.fn();
  const saveProjectsSpy = vi.fn();

  beforeEach(() => {
    saveProjectsSpy.mockClear();
    getRuntimeStub.mockReset();
    // Cast through unknown — the runtime is stubbed out by the
    // preview-compose-build-test mock above, so the actual shape is
    // irrelevant to this assertion path.
    getRuntimeStub.mockReturnValue({} as unknown);
  });

  it('persists compose.readyTimeoutMs onto project.prEnv when supplied', async () => {
    const { project } = makeProjectWithCompose();
    await runPreviewEnvironmentBuild({
      project,
      cwd: project.cwd,
      body: {
        compose: {
          file: 'docker-compose.yml',
          entryService: 'web',
          entryPort: 3000,
          readyTimeoutMs: 1_500_000,
        },
      },
      saveProjects: saveProjectsSpy,
      getPreviewComposeRuntime: getRuntimeStub as never,
      actorUserId: null,
    });
    expect(saveProjectsSpy).toHaveBeenCalled();
    const compose = (project.prEnv as { preview?: { compose?: { readyTimeoutMs?: number } } })
      ?.preview?.compose;
    expect(compose?.readyTimeoutMs).toBe(1_500_000);
  });

  it('leaves readyTimeoutMs unset when the wizard omits it (server default applies)', async () => {
    const { project } = makeProjectWithCompose();
    await runPreviewEnvironmentBuild({
      project,
      cwd: project.cwd,
      body: {
        compose: {
          file: 'docker-compose.yml',
          entryService: 'web',
          entryPort: 3000,
        },
      },
      saveProjects: saveProjectsSpy,
      getPreviewComposeRuntime: getRuntimeStub as never,
      actorUserId: null,
    });
    const compose = (project.prEnv as { preview?: { compose?: { readyTimeoutMs?: number } } })
      ?.preview?.compose;
    expect(compose).toBeDefined();
    expect(compose?.readyTimeoutMs).toBeUndefined();
  });

  it('rejects readyTimeoutMs values outside the documented 5,000–3,600,000 ms band', async () => {
    const { project } = makeProjectWithCompose();
    const result = await runPreviewEnvironmentBuild({
      project,
      cwd: project.cwd,
      body: {
        compose: {
          file: 'docker-compose.yml',
          entryService: 'web',
          entryPort: 3000,
          // 90 min — over the 60-minute ceiling — must surface as a 400 from
          // validatePrEnvPreviewCompose, not silently clamp.
          readyTimeoutMs: 5_400_000,
        },
      },
      saveProjects: saveProjectsSpy,
      getPreviewComposeRuntime: getRuntimeStub as never,
      actorUserId: null,
    });
    expect('statusCode' in result && result.statusCode).toBe(400);
    expect(result.ok).toBe(false);
    if ('error' in result && typeof result.error === 'string') {
      expect(result.error).toContain('readyTimeoutMs');
    }
  });

  it('accepts and persists a 45-minute readyTimeoutMs that the old 30-minute ceiling rejected', async () => {
    const { project } = makeProjectWithCompose();
    await runPreviewEnvironmentBuild({
      project,
      cwd: project.cwd,
      body: {
        compose: {
          file: 'docker-compose.yml',
          entryService: 'web',
          entryPort: 3000,
          // 45 min — above the old 30-min cap, within the new 60-min ceiling.
          // The config-save step is what we assert here; the post-save preview
          // smoke test is out of scope (same as the "persists" case above).
          readyTimeoutMs: 2_700_000,
        },
      },
      saveProjects: saveProjectsSpy,
      getPreviewComposeRuntime: getRuntimeStub as never,
      actorUserId: null,
    });
    expect(saveProjectsSpy).toHaveBeenCalled();
    const compose = (project.prEnv as { preview?: { compose?: { readyTimeoutMs?: number } } })
      ?.preview?.compose;
    expect(compose?.readyTimeoutMs).toBe(2_700_000);
  });
});
