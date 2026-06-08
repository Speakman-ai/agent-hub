/**
 * Integration tests for the spawning halves of the project-aws router:
 *
 *   GET  /api/projects/:projectId/aws-sso/status   — spawns `aws sts`
 *   POST /api/projects/:projectId/aws-sso/login    — spawns `aws sso login`
 *
 * Both routes shell out to the host `aws` binary. Tests MUST NEVER spawn
 * the real CLI (see CLAUDE.md "Testing — never spawn real CLI binaries"),
 * so this file mocks `child_process.spawn` and feeds the route stdout /
 * stderr / close events through a tiny `EventEmitter`-based fake proc.
 *
 * The router is mounted on a bare express app that pre-sets
 * `req.authRole = 'Owner'`, so `requireRole('Admin')` passes without
 * standing up the full auth middleware stack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync } from 'fs';
import type { Request, Response, NextFunction } from 'express';
import type { ChildProcess } from 'child_process';
import type { RouteDeps, Project } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { ProjectAwsSsoProfilesMap } from '../project-aws-profiles.js';

// Hoisted spawn mock — vi.mock is hoisted above the import statements
// below, so the spawnMock reference is the one the route file picks up.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: (...args: Parameters<typeof import('child_process').spawn>) =>
    spawnMock(...args) as ReturnType<typeof import('child_process').spawn>,
}));

// Avoid touching real PIDs on kill. trackChild short-circuits on falsy pid
// (so its EventEmitter cleanup hooks are skipped, which is fine for tests),
// but killProcessGroup would call `process.kill(-pid)` on a real pgid if
// the fake proc happened to land on a live one. Mocking the module
// removes that risk entirely.
const killProcessGroupMock = vi.hoisted(() => vi.fn());
const trackChildMock = vi.hoisted(() => vi.fn());
vi.mock('../process-groups.js', () => ({
  trackChild: trackChildMock,
  killProcessGroup: killProcessGroupMock,
}));

// `config.dataDir` must live under os.tmpdir() for writeProjectAwsConfigFile
// to land somewhere safe. The route writes a real ini file there on every
// status / login call.
const tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'project-aws-spawn-test-'));
process.env.AGENT_HUB_DATA_DIR = tmpDataDir;

// Imported AFTER the env override + vi.mock calls above so the modules
// pick up the mocked spawn and the test data dir.
const { default: createProjectAwsRoutes } = await import('./project-aws.js');
const { spawnAwsSsoLogin } = await import('../aws-sso-identity.js');

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
}

function makeFakeProc(): FakeProc {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(),
    // No pid — keeps trackChild + killProcessGroup off real system calls
    // even if a future regression accidentally un-mocks them.
  }) as FakeProc;
  return proc;
}

const PROFILE: ProjectAwsSsoProfilesMap = {
  dev: {
    sso_account_id: '120569607241',
    sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
    sso_region: 'us-east-2',
    sso_role_name: 'AdministratorAccess',
    region: 'us-east-2',
  },
};

function buildApp(project: Project): express.Express {
  const app = express();
  app.use(express.json());
  // Pre-seed the role so requireRole('Admin') / requireRole('Owner') pass.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).authRole = 'Owner';
    (req as AuthenticatedRequest).authUserId = 'test-user';
    next();
  });
  const deps = {
    findProject: (id: string) => (id === project.id ? project : null),
    saveProjects: vi.fn(),
  } as unknown as RouteDeps;
  app.use(createProjectAwsRoutes(deps));
  return app;
}

function projectWith(profiles: ProjectAwsSsoProfilesMap): Project {
  return {
    id: 'proj-spawn-test',
    name: 'spawn test',
    cwd: '/tmp',
    color: '#3B82F6',
    awsSsoProfiles: profiles,
  } as Project;
}

beforeEach(() => {
  spawnMock.mockReset();
  killProcessGroupMock.mockReset();
  trackChildMock.mockReset();
});

afterEach(() => {
  // Drop fake timers if the test installed them.
  vi.useRealTimers();
});

// Best-effort cleanup of the shared tmp data dir at the end of the file.
afterAll(() => {
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('GET /api/projects/:projectId/aws-sso/status', () => {
  it('returns { loggedIn: true, ... } when aws sts exits 0 with valid JSON', async () => {
    const project = projectWith(PROFILE);
    const app = buildApp(project);

    spawnMock.mockImplementation(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => {
        proc.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              Account: '120569607241',
              Arn: 'arn:aws:sts::120569607241:assumed-role/AWSReservedSSO_AdministratorAccess_abcd/test',
              UserId: 'AROAEXAMPLE:test',
            }),
          ),
        );
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcess;
    });

    const res = await request(app)
      .get(`/api/projects/${project.id}/aws-sso/status?profile=dev`)
      .expect(200);

    expect(res.body).toEqual({
      profile: 'dev',
      loggedIn: true,
      account: '120569607241',
      arn: expect.stringContaining('AdministratorAccess'),
      userId: 'AROAEXAMPLE:test',
      // The test app authenticates as a user → per-user HOME probed first and
      // it authenticated, so the identity is attributed to the caller HOME.
      homeSource: 'caller',
    });

    // Sanity: the spawn was the expected `aws sts` invocation.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('aws');
    expect(args).toEqual(['sts', 'get-caller-identity', '--profile', 'dev', '--output', 'json']);
    // The route MUST point the child at the project-scoped config file —
    // pre-fix would let it inherit the user's ~/.aws/config and pick the
    // wrong account.
    const opts = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.AWS_CONFIG_FILE).toContain(`project-aws-config/${project.id}/config`);
  });

  it('returns { loggedIn: false, needsLogin: true } when aws sts exits non-zero with an expired-token hint', async () => {
    const project = projectWith(PROFILE);
    const app = buildApp(project);

    spawnMock.mockImplementation(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('Error loading SSO Token: Token has expired'));
        proc.emit('close', 255);
      });
      return proc as unknown as ChildProcess;
    });

    const res = await request(app)
      .get(`/api/projects/${project.id}/aws-sso/status?profile=dev`)
      .expect(200);

    expect(res.body.profile).toBe('dev');
    expect(res.body.loggedIn).toBe(false);
    expect(res.body.needsLogin).toBe(true);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('rejects unknown profile names with 400 before spawning anything', async () => {
    const project = projectWith(PROFILE);
    const app = buildApp(project);

    const res = await request(app)
      .get(`/api/projects/${project.id}/aws-sso/status?profile=nope`)
      .expect(400);

    expect(res.body.error).toMatch(/unknown profile/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the project has no AWS SSO profiles configured', async () => {
    const project = projectWith({});
    const app = buildApp(project);

    const res = await request(app)
      .get(`/api/projects/${project.id}/aws-sso/status?profile=dev`)
      .expect(400);

    expect(res.body.error).toMatch(/no AWS SSO profiles/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects/:projectId/aws-sso/login', () => {
  it('returns { ok: true, loginUrl } when the spawned aws emits the device URL on stderr', async () => {
    const project = projectWith(PROFILE);
    const app = buildApp(project);

    spawnMock.mockImplementation(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => {
        // `aws sso login --no-browser` writes the device URL to stderr in
        // current CLI versions; the route's onData handler listens on
        // both pipes so either is fine, but we exercise the realistic
        // path here.
        proc.stderr.emit(
          'data',
          Buffer.from(
            'Attempting to automatically open the SSO authorization page in your default browser.\n' +
              'If the browser does not open or you wish to use a different device to authorize this request, ' +
              'open the following URL:\n\n' +
              'https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-1234\n',
          ),
        );
      });
      return proc as unknown as ChildProcess;
    });

    const res = await request(app)
      .post(`/api/projects/${project.id}/aws-sso/login`)
      .send({ profile: 'dev' })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.profile).toBe('dev');
    expect(res.body.loginUrl).toBe(
      'https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-1234',
    );
    expect(res.body.loginId).toBeTruthy();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('aws');
    expect(args).toEqual(['sso', 'login', '--profile', 'dev', '--no-browser']);
    const opts = spawnMock.mock.calls[0][2] as {
      env: NodeJS.ProcessEnv;
      detached: boolean;
      cwd: string;
    };
    expect(opts.env.AWS_CONFIG_FILE).toContain(`project-aws-config/${project.id}/config`);
    expect(opts.detached).toBe(true);
    // Regression: cwd must be the always-existing server-process HOME, not the
    // per-user env.HOME — which may not exist on disk yet and would ENOENT-fail
    // the spawn before the device-code URL is ever printed.
    expect(opts.cwd).toBe(process.env.HOME || '/');
    if (opts.env.HOME && opts.env.HOME !== (process.env.HOME || '/')) {
      expect(opts.cwd).not.toBe(opts.env.HOME);
    }
  });

  it('returns loginUrl with user_code when CLI prints URL and code on separate lines', async () => {
    const project = projectWith(PROFILE);
    const app = buildApp(project);

    spawnMock.mockImplementation(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => {
        proc.stderr.emit(
          'data',
          Buffer.from(
            'Browser will not be automatically opened.\n' +
              'Please visit the following URL:\n\n' +
              'https://device.sso.us-east-2.amazonaws.com/\n\n' +
              'Then enter the code: WXYZ-9876\n',
          ),
        );
      });
      return proc as unknown as ChildProcess;
    });

    const res = await request(app)
      .post(`/api/projects/${project.id}/aws-sso/login`)
      .send({ profile: 'dev' })
      .expect(200);

    expect(res.body.loginUrl).toBe(
      'https://device.sso.us-east-2.amazonaws.com/?user_code=WXYZ-9876',
    );
  });

  it('times out after 30 s when no device URL is emitted, kills the proc, and returns an error', async () => {
    const project = projectWith(PROFILE);
    const app = buildApp(project);

    // Capture the fake proc so we can assert it was killed, plus a
    // signal we can await once the route handler has called spawn.
    let capturedProc: FakeProc | null = null;
    let resolveSpawnCalled: (() => void) | null = null;
    const spawnCalled = new Promise<void>((r) => {
      resolveSpawnCalled = r;
    });
    spawnMock.mockImplementation(() => {
      const proc = makeFakeProc();
      capturedProc = proc;
      resolveSpawnCalled?.();
      // Important: emit NOTHING. The route should sit waiting until the
      // 30 s setTimeout fires and gives up.
      return proc as unknown as ChildProcess;
    });

    // Wrap `global.setTimeout` so the route's 30 s URL-extraction timer
    // is diverted into a side channel — its callback is recorded for
    // the test to invoke directly. Every OTHER setTimeout call (TCP
    // socket timeouts, agent keep-alives, supertest internals) forwards
    // to the real impl so the HTTP round-trip can still complete.
    const realSetTimeout = global.setTimeout;
    let captured: { fn: (...args: unknown[]) => void } | null = null;
    const wrappedSetTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 30_000 && captured === null) {
        captured = { fn };
        return { unref: () => undefined, refresh: () => undefined } as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(fn, ms as number, ...rest);
    }) as unknown as typeof setTimeout;
    // Carry over static properties (promisify.custom symbol, __promisify__ etc.)
    // so reflective callers keep working.
    for (const k of Reflect.ownKeys(realSetTimeout)) {
      try {
        (wrappedSetTimeout as unknown as Record<string | symbol, unknown>)[k] = (
          realSetTimeout as unknown as Record<string | symbol, unknown>
        )[k];
      } catch {
        /* read-only — skip */
      }
    }
    global.setTimeout = wrappedSetTimeout;

    try {
      // supertest's chained builder is a thenable that starts running
      // when `.then` is invoked. Wrapping in a real Promise via .then
      // kicks off the request without blocking on its resolution.
      const responsePromise = new Promise<request.Response>((resolve, reject) => {
        request(app)
          .post(`/api/projects/${project.id}/aws-sso/login`)
          .send({ profile: 'dev' })
          .then(resolve, reject);
      });

      await spawnCalled;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(capturedProc).not.toBeNull();
      expect(captured).not.toBeNull();

      // Restore the real setTimeout before firing the captured callback
      // so any reentrant setTimeout inside it (none today, but defensive)
      // lands on the real impl.
      global.setTimeout = realSetTimeout;
      captured!.fn();

      const res = await responsePromise;
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.profile).toBe('dev');
      expect(res.body.error).toMatch(/Timed out waiting for AWS SSO device URL/);
      expect(res.body.loginId).toBeTruthy();

      // The spawned proc must have been signalled so a stuck device-URL
      // extraction can't leak the `aws` child until trackChild cleanup.
      expect(killProcessGroupMock).toHaveBeenCalledWith(capturedProc, 'SIGTERM');
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  it('rejects when the body omits a profile name', async () => {
    const project = projectWith(PROFILE);
    const app = buildApp(project);

    const res = await request(app)
      .post(`/api/projects/${project.id}/aws-sso/login`)
      .send({})
      .expect(400);

    expect(res.body.error).toMatch(/profile is required/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the project has no AWS SSO profiles configured', async () => {
    const project = projectWith({});
    const app = buildApp(project);

    const res = await request(app)
      .post(`/api/projects/${project.id}/aws-sso/login`)
      .send({ profile: 'dev' })
      .expect(400);

    expect(res.body.error).toMatch(/no AWS SSO profiles/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('spawnAwsSsoLogin', () => {
  it('uses the server-process HOME as cwd, never the (possibly missing) per-user env.HOME', () => {
    spawnMock.mockReturnValue(makeFakeProc() as unknown as ChildProcess);

    // A per-user HOME path that does not exist on disk. If the helper used
    // this as cwd, spawn would throw ENOENT before the device-code URL prints.
    const env = {
      HOME: path.join(os.tmpdir(), 'nonexistent-per-user-home', 'never-created'),
      AWS_CONFIG_FILE: '/tmp/whatever/config',
    } as NodeJS.ProcessEnv;

    const proc = spawnAwsSsoLogin(env, 'dev');
    expect(proc).toBeTruthy();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: unknown },
    ];
    expect(bin).toBe('aws');
    expect(args).toEqual(['sso', 'login', '--profile', 'dev', '--no-browser']);
    // The regression: cwd is the stable server-process HOME, NOT env.HOME.
    expect(opts.cwd).toBe(process.env.HOME || '/');
    expect(opts.cwd).not.toBe(env.HOME);
    // env (and therefore the SSO token-cache HOME) is still threaded through.
    expect(opts.env).toBe(env);
    expect(opts.detached).toBe(true);
  });
});
