import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/projects/:projectId — prEnv slot
//
// The PR-env per-project config is persisted via the existing
// `PATCH /api/projects/:id` route, which calls `validatePrEnvProjectConfig`
// before writing the slot. The pure validator is covered in
// `routes/pr-env-project-validate.test.ts`; these supertest cases close
// the integration gap by hitting the real route and asserting the 400
// path bubbles up the validator's error message verbatim.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — prEnv', () => {
  it('persists a valid prEnv slot to the project', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          setupCommand: 'npm install',
          healthPath: '/healthz',
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      setupCommand: 'npm install',
      healthPath: '/healthz',
    });
  });

  it('rejects with 400 when startScript is missing on an enabled config', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prEnv: { enabled: true, internalPort: 3000 } })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/startScript/);
  });

  it('rejects with 400 when dockerfilePath is absolute', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          dockerfilePath: '/etc/passwd',
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/dockerfilePath/);
    expect(body.error).toMatch(/relative/i);
  });

  it('rejects with 400 when dockerfilePath escapes the repo root via ..', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          dockerfilePath: '../../etc/passwd',
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/dockerfilePath/);
    expect(body.error).toMatch(/escape/i);
  });

  it('round-trips enabled=false (toggle-off path)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    // First populate the slot.
    await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: { enabled: true, startScript: 'npm start', internalPort: 3000 },
      })
      .expect(200);
    // Then toggle it off.
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prEnv: { enabled: false } })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({ enabled: false });
  });

  it('persists per-project env vars round-trip through PATCH', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          env: {
            AWS_ACCESS_KEY_ID: 'AKIATEST',
            AWS_SECRET_ACCESS_KEY: 'shhh',
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      env: {
        AWS_ACCESS_KEY_ID: 'AKIATEST',
        AWS_SECRET_ACCESS_KEY: 'shhh',
      },
    });
  });

  it('rejects with 400 when env contains a reserved key (PORT)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          env: { PORT: '9999' },
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/PORT/);
    expect(body.error).toMatch(/reserved/i);
  });

  it('rejects with 400 when env contains an invalid key name', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          env: { 'has-dash': 'x' },
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/has-dash/);
  });

  it('persists preview.autoStart through PATCH', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          preview: {
            enabled: true,
            startScript: 'npm run dev',
            autoStart: false,
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: false,
      preview: {
        enabled: true,
        startScript: 'npm run dev',
        autoStart: false,
      },
    });
  });

  it('rejects preview.autoStart when not a boolean', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          preview: { enabled: true, autoStart: 'yes' },
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/autoStart must be a boolean/);
  });

  it('persists a fully-populated preview block round-trip through PATCH', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: {
            enabled: true,
            startScript: 'npm run preview',
            port: 4173,
            captureRoutes: ['/', '/about'],
            idleTTL: 600,
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      preview: {
        enabled: true,
        startScript: 'npm run preview',
        port: 4173,
        captureRoutes: ['/', '/about'],
        idleTTL: 600,
      },
    });
  });

  it('round-trips a preview block when parent enabled=false (worktree-preview-only mode)', async () => {
    // PR Environments were stripped in the "Strip PR Environments" epic;
    // `prEnv.enabled` is now a no-op for the PR-env subsystem. The
    // worktree-preview runtime still reads `prEnv.preview` and
    // `prEnv.healthPath`, so the parent toggle must NOT discard those
    // fields anymore. (Earlier this combination 400'd with
    // "preview.enabled requires prEnv.enabled".)
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: false,
          healthPath: '/health',
          preview: {
            enabled: true,
            startScript: 'npm run dev',
            captureRoutes: ['/'],
            idleTTL: 600,
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: false,
      healthPath: '/health',
      preview: {
        enabled: true,
        startScript: 'npm run dev',
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
  });

  it('rejects with 400 when parent enabled=false carries an invalid healthPath', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prEnv: { enabled: false, healthPath: 'no-leading-slash' } })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/healthPath/);
    expect(body.error).toMatch(/start with/);
  });

  it('rejects with 400 when preview.captureRoutes contains a non-/-prefixed entry', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: { enabled: true, captureRoutes: ['/', 'about'] },
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/captureRoutes/);
  });

  it('persists a preview.compose block round-trip through PATCH', async () => {
    // Smoke test for the compose-pivot PR 1 schema addition. Mirrors
    // the existing "fully-populated preview block" test above but uses
    // the new `compose` sub-block instead of the spawn-mode fields.
    // The validator must accept the shape and round-trip it cleanly.
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: {
            enabled: true,
            idleTTL: 600,
            compose: {
              file: 'compose.preview.yml',
              entryService: 'web',
              entryPort: 8000,
              envFile: '.env.preview',
              healthPath: '/healthz',
              hostPortRange: { min: 4500, max: 4600 },
              readyTimeoutMs: 120_000,
            },
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      preview: {
        enabled: true,
        idleTTL: 600,
        compose: {
          file: 'compose.preview.yml',
          entryService: 'web',
          entryPort: 8000,
          envFile: '.env.preview',
          healthPath: '/healthz',
          hostPortRange: { min: 4500, max: 4600 },
          readyTimeoutMs: 120_000,
        },
      },
    });
  });

  it('rejects with 400 when preview.compose.entryService is missing', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: { enabled: true, compose: { entryPort: 8000 } },
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/entryService/);
  });

  it('rejects with 400 when preview.compose.entryPort is out of range', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: { enabled: true, compose: { entryService: 'web', entryPort: 0 } },
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/entryPort/);
  });

  it('rejects with 400 when preview.compose.file traverses out of the worktree', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: {
            enabled: true,
            compose: {
              entryService: 'web',
              entryPort: 8000,
              file: '../../etc/compose.yml',
            },
          },
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/\.\./);
  });

  it('rejects with 400 when preview.compose.entryWorkdir is not an absolute path', async () => {
    // entryWorkdir is the in-container mount target for the host
    // worktree bind. Relative paths are ambiguous (compose would try
    // to resolve them against --project-directory and we'd silently
    // mount the wrong thing); reject up front.
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: {
            enabled: true,
            compose: {
              entryService: 'web',
              entryPort: 8000,
              entryWorkdir: 'workspace',
            },
          },
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/entryWorkdir.*absolute/);
  });

  it('rejects with 400 when preview.compose.shadowDirs is set without entryWorkdir', async () => {
    // shadowDirs is only meaningful as anonymous-volume "holes" in
    // the bind defined by entryWorkdir — without the bind there is
    // nothing to shadow. Surface the misconfig at save time.
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: {
            enabled: true,
            compose: {
              entryService: 'web',
              entryPort: 8000,
              shadowDirs: ['node_modules'],
            },
          },
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/shadowDirs.*entryWorkdir/);
  });

  it('persists preview.compose with entryWorkdir + shadowDirs for live-edit previews', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: false,
          preview: {
            enabled: true,
            compose: {
              entryService: 'frontend',
              entryPort: 4200,
              // Operator wrote shadow paths with leading slash and
              // trailing slash on the way in; the validator normalises
              // them to bare relative segments before persist.
              entryWorkdir: '/workspace',
              shadowDirs: ['/node_modules/', 'dist'],
            },
          },
        },
      })
      .expect(200);
    const body = res.body as {
      prEnv?: { preview?: { compose?: Record<string, unknown> } };
    };
    expect(body.prEnv?.preview?.compose).toMatchObject({
      entryService: 'frontend',
      entryPort: 4200,
      entryWorkdir: '/workspace',
      shadowDirs: ['node_modules', 'dist'],
    });
  });

  it('rejects with 400 when preview declares both compose and startScript (mutual exclusivity)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: {
            enabled: true,
            startScript: 'npm run preview',
            compose: { entryService: 'web', entryPort: 8000 },
          },
        },
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/mutually exclusive/);
  });

  it('persists the surveytracker preview-only compose shape (PR 3 conversion)', async () => {
    // Regression test for the surveytracker compose-pivot conversion
    // (PR 3 of the docker-compose-per-session epic). Surveytracker runs
    // in "preview-only" mode: the parent PR-env runner is disabled
    // (`prEnv.enabled: false`) but the worktree-preview runtime still
    // needs the preview slot (with the compose sub-block) for
    // in-session previews. Pin this shape so a future validator
    // refactor that re-couples preview to parent-enabled is flagged.
    //
    // The literal config below matches the live surveytracker prEnv as
    // persisted on the dev box after PR 3 landed — keep it in lockstep
    // with the actual project config so the test doubles as docs.
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: false,
          healthPath: '/',
          preview: {
            enabled: true,
            captureRoutes: ['/'],
            idleTTL: 600,
            compose: {
              file: 'compose.preview.yml',
              entryService: 'frontend',
              entryPort: 4200,
              healthPath: '/',
              envFile: '.env.preview',
            },
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: false,
      healthPath: '/',
      preview: {
        enabled: true,
        captureRoutes: ['/'],
        idleTTL: 600,
        compose: {
          file: 'compose.preview.yml',
          entryService: 'frontend',
          entryPort: 4200,
          healthPath: '/',
          envFile: '.env.preview',
        },
      },
    });
  });

  it('clears the prEnv slot when sent as null', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: { enabled: true, startScript: 'npm start', internalPort: 3000 },
      })
      .expect(200);
    const res = await request.patch(`/api/projects/${projectId}`).send({ prEnv: null }).expect(200);
    const body = res.body as { prEnv?: unknown };
    expect(body.prEnv).toBeUndefined();
  });
});
