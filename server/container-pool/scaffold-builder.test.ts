/**
 * Scaffolding builder tests (W3).
 *
 * The card's hard contract is **fail-fast with no partial host state**.
 * Because the dispatcher deliberately writes nothing to the host
 * filesystem (the container does all the work and force-removes itself),
 * "cleanup" becomes an observation: on any failure path, the token is
 * still minted at most once, no retry fires, and no host-side side
 * effect is observable.
 *
 * What these tests pin:
 *
 *   Happy path:
 *     • mintInstallationToken called once with expected creds.
 *     • runner.run called once with expected image, slotId, spec, token.
 *     • result.repoUrl resolves to github.com/<owner>/<name>.
 *     • Duration is recorded.
 *
 *   Request validation (no container ever runs):
 *     • Unknown template → ScaffoldError(exitCode=-2)
 *     • Invalid repo name (e.g. "../evil") → -2
 *     • PostScaffoldFiles with ".." or absolute path → -2
 *     • Missing github creds → -2
 *
 *   Token mint failure:
 *     • Runner is never called; error bubbles with exitCode=-2.
 *
 *   Container-level failures (runner returned):
 *     • exitCode=5 (gh push fail) → ScaffoldError preserves code + stderr.
 *     • timedOut=true → ScaffoldError with timedOut + exitCode=-1.
 *
 *   Spec wire format:
 *     • buildScaffoldSpec round-trips through JSON with expected shape.
 *     • postScaffoldFiles renamed .relativePath → .path.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildScaffoldSpec,
  scaffoldRepo,
  validateRepoName,
  validatePostFile,
  ScaffoldError,
  type ScaffoldBuilderDeps,
  type ScaffoldRequest,
  type ContainerRunResult,
} from './scaffold-builder.js';

// ─── fakes ────────────────────────────────────────────────────────────────

interface FakeRunnerState {
  calls: Array<{
    image: string;
    slotId: string;
    scaffoldSpec: string;
    githubToken: string;
    timeoutMs: number;
  }>;
  /** Override the default "exit 0, no stderr" result. */
  nextResult: ContainerRunResult | null;
  /** Throw this from run() instead of returning — simulates daemon unreachable. */
  throwWith: Error | null;
}

function makeFakeRunner(): { runner: ScaffoldBuilderDeps['runner']; state: FakeRunnerState } {
  const state: FakeRunnerState = {
    calls: [],
    nextResult: null,
    throwWith: null,
  };
  return {
    state,
    runner: {
      async run(args) {
        state.calls.push({ ...args });
        if (state.throwWith) throw state.throwWith;
        return (
          state.nextResult ?? { exitCode: 0, timedOut: false, stderr: '', containerId: 'cid-1' }
        );
      },
    },
  };
}

interface FakeMinterState {
  calls: number;
  lastArgs: { appId: string | number; privateKey: string; installationId: string | number } | null;
  token: string;
  throwWith: Error | null;
}

function makeFakeMinter(): {
  mint: ScaffoldBuilderDeps['mintInstallationToken'];
  state: FakeMinterState;
} {
  const state: FakeMinterState = {
    calls: 0,
    lastArgs: null,
    token: 'ghs_fake_installation_token',
    throwWith: null,
  };
  return {
    state,
    async mint(args) {
      state.calls++;
      state.lastArgs = args;
      if (state.throwWith) throw state.throwWith;
      return state.token;
    },
  };
}

function goodRequest(overrides: Partial<ScaffoldRequest> = {}): ScaffoldRequest {
  return {
    template: 'next',
    owner: 'acme-user',
    name: 'cool-app',
    description: 'A scaffolded app',
    private: true,
    postScaffoldFiles: [
      { relativePath: 'CLAUDE.md', contents: '# Project instructions\n' },
      { relativePath: 'AGENTS.md', contents: '# Agent roster\n' },
      { relativePath: '.github/workflows/ci.yml', contents: 'name: ci\n' },
    ],
    github: {
      appId: '12345',
      privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
      installationId: '67890',
    },
    slotId: 'scaffold-1',
    ...overrides,
  };
}

function freshDeps(): ScaffoldBuilderDeps & {
  runner: ReturnType<typeof makeFakeRunner>['runner'];
  runnerState: FakeRunnerState;
  minterState: FakeMinterState;
} {
  const runner = makeFakeRunner();
  const minter = makeFakeMinter();
  return {
    runner: runner.runner,
    mintInstallationToken: minter.mint,
    scaffoldImage: 'ghcr.io/acme/agent-hub/scaffold-base:2026-04-19',
    containerTimeoutMs: 90_000,
    runnerState: runner.state,
    minterState: minter.state,
  };
}

// ─── suite ────────────────────────────────────────────────────────────────

describe('scaffoldRepo — happy path', () => {
  it('mints a token, runs the container once, and returns the repo URL', async () => {
    const deps = freshDeps();
    const res = await scaffoldRepo(deps, goodRequest());

    expect(res.repoUrl).toBe('https://github.com/acme-user/cool-app');
    expect(res.containerId).toBe('cid-1');
    expect(typeof res.durationMs).toBe('number');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    // Token minted exactly once with the passed credentials.
    expect(deps.minterState.calls).toBe(1);
    expect(deps.minterState.lastArgs).toEqual({
      appId: '12345',
      privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
      installationId: '67890',
    });

    // Runner called exactly once with the scaffold spec + token + image.
    expect(deps.runnerState.calls).toHaveLength(1);
    const call = deps.runnerState.calls[0];
    expect(call.image).toBe('ghcr.io/acme/agent-hub/scaffold-base:2026-04-19');
    expect(call.slotId).toBe('scaffold-1');
    expect(call.githubToken).toBe('ghs_fake_installation_token');
    expect(call.timeoutMs).toBe(90_000);

    // Spec round-trips through JSON with expected keys.
    const parsed = JSON.parse(call.scaffoldSpec);
    expect(parsed.template).toBe('next');
    expect(parsed.owner).toBe('acme-user');
    expect(parsed.name).toBe('cool-app');
    expect(parsed.private).toBe(true);
    expect(parsed.postScaffoldFiles).toHaveLength(3);
    expect(parsed.postScaffoldFiles[0]).toEqual({
      path: 'CLAUDE.md',
      contents: '# Project instructions\n',
    });
  });

  it('defaults private=true when the field is omitted', async () => {
    const deps = freshDeps();
    const req = goodRequest();
    delete req.private;
    await scaffoldRepo(deps, req);
    const parsed = JSON.parse(deps.runnerState.calls[0].scaffoldSpec);
    expect(parsed.private).toBe(true);
  });

  it('defaults containerTimeoutMs to 90s when deps omits it', async () => {
    const { containerTimeoutMs: _, ...rest } = freshDeps();
    const deps = rest as ScaffoldBuilderDeps & { runnerState: FakeRunnerState };
    await scaffoldRepo(deps, goodRequest());
    expect(deps.runnerState.calls[0].timeoutMs).toBe(90_000);
  });
});

describe('scaffoldRepo — request validation (no container ever runs)', () => {
  it('rejects an unknown template with exitCode -2 and no runner call', async () => {
    const deps = freshDeps();
    await expect(scaffoldRepo(deps, goodRequest({ template: 'ruby-on-rails' }))).rejects.toSatisfy(
      (e) => e instanceof ScaffoldError && e.exitCode === -2,
    );
    expect(deps.runnerState.calls).toHaveLength(0);
    expect(deps.minterState.calls).toBe(0);
  });

  it('rejects an invalid repo name (..)', async () => {
    const deps = freshDeps();
    await expect(scaffoldRepo(deps, goodRequest({ name: '..' }))).rejects.toBeInstanceOf(
      ScaffoldError,
    );
    expect(deps.runnerState.calls).toHaveLength(0);
  });

  it('rejects postScaffoldFiles with absolute path', async () => {
    const deps = freshDeps();
    await expect(
      scaffoldRepo(
        deps,
        goodRequest({
          postScaffoldFiles: [{ relativePath: '/etc/passwd', contents: 'x' }],
        }),
      ),
    ).rejects.toThrow(/absolute path/);
    expect(deps.runnerState.calls).toHaveLength(0);
  });

  it('rejects postScaffoldFiles with ".." traversal', async () => {
    const deps = freshDeps();
    await expect(
      scaffoldRepo(
        deps,
        goodRequest({
          postScaffoldFiles: [{ relativePath: '../../escape.md', contents: 'x' }],
        }),
      ),
    ).rejects.toThrow(/traversal/);
    expect(deps.runnerState.calls).toHaveLength(0);
  });

  it('rejects missing github credentials', async () => {
    const deps = freshDeps();
    const req = goodRequest();
    req.github.privateKey = '';
    await expect(scaffoldRepo(deps, req)).rejects.toThrow(/github credentials missing/);
    expect(deps.runnerState.calls).toHaveLength(0);
  });

  it('rejects missing slotId', async () => {
    const deps = freshDeps();
    await expect(scaffoldRepo(deps, goodRequest({ slotId: '' }))).rejects.toThrow(/slotId/);
    expect(deps.runnerState.calls).toHaveLength(0);
  });
});

describe('scaffoldRepo — cleanup & fail-fast paths', () => {
  it('mint failure: runner is never called, no partial state', async () => {
    const deps = freshDeps();
    deps.minterState.throwWith = new Error('401 bad signature');
    await expect(scaffoldRepo(deps, goodRequest())).rejects.toSatisfy(
      (e) =>
        e instanceof ScaffoldError &&
        e.exitCode === -2 &&
        /mint installation token/.test(e.message),
    );
    expect(deps.runnerState.calls).toHaveLength(0);
  });

  it('container returns non-zero exit: preserves exit code + stderr tail', async () => {
    const deps = freshDeps();
    deps.runnerState.nextResult = {
      exitCode: 5,
      timedOut: false,
      stderr: 'ERROR: HTTP 422: repo already exists',
      containerId: 'cid-failed',
    };

    const err = await scaffoldRepo(deps, goodRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScaffoldError);
    const se = err as ScaffoldError;
    expect(se.exitCode).toBe(5);
    expect(se.timedOut).toBe(false);
    expect(se.stderr).toContain('repo already exists');
    expect(se.message).toMatch(/gh auth|repo create|push/i);
    // Runner was called exactly once — no retry loop.
    expect(deps.runnerState.calls).toHaveLength(1);
  });

  it('container timeout: surfaces timedOut=true with exitCode=-1', async () => {
    const deps = freshDeps();
    deps.runnerState.nextResult = {
      exitCode: -1,
      timedOut: true,
      stderr: 'killed after 90s',
      containerId: 'cid-timed-out',
    };
    const err = await scaffoldRepo(deps, goodRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScaffoldError);
    const se = err as ScaffoldError;
    expect(se.timedOut).toBe(true);
    expect(se.exitCode).toBe(-1);
    expect(se.message).toMatch(/timed out/);
  });

  it('runner throws before returning: classified as pre-flight failure (-2)', async () => {
    const deps = freshDeps();
    deps.runnerState.throwWith = new Error('Cannot connect to the Docker daemon');
    const err = await scaffoldRepo(deps, goodRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScaffoldError);
    const se = err as ScaffoldError;
    expect(se.exitCode).toBe(-2);
    expect(se.message).toMatch(/container runner failed to start/);
  });

  it('preserves the original failure across gh-push failure — no partial GitHub repo state on our side', async () => {
    // Scenario: scaffold got all the way to `gh repo create --push`, the
    // push failed (e.g. network blip after repo was created). scaffold.sh
    // exits 5. The dispatcher records the failure and does NOT attempt to
    // re-run the container (which would try to create the repo a second
    // time and 422). No host-side state was ever created by the dispatcher,
    // so there is nothing to clean up locally.
    const deps = freshDeps();
    deps.runnerState.nextResult = {
      exitCode: 5,
      timedOut: false,
      stderr: 'fatal: unable to access ... Could not resolve host',
      containerId: 'cid-push-failed',
    };
    await expect(scaffoldRepo(deps, goodRequest())).rejects.toBeInstanceOf(ScaffoldError);

    // Critical: runner was called EXACTLY once. No retry. No second `gh repo
    // create` attempt which would 422 because the first call already created
    // the remote.
    expect(deps.runnerState.calls).toHaveLength(1);
    // Token was minted exactly once.
    expect(deps.minterState.calls).toBe(1);
  });
});

describe('buildScaffoldSpec — wire format', () => {
  it('produces the JSON shape scaffold.sh expects', () => {
    const spec = buildScaffoldSpec(goodRequest());
    const parsed = JSON.parse(spec);
    expect(Object.keys(parsed).sort()).toEqual(
      ['description', 'name', 'owner', 'postScaffoldFiles', 'private', 'template'].sort(),
    );
    expect(parsed.template).toBe('next');
    expect(parsed.postScaffoldFiles[0]).toEqual({
      path: 'CLAUDE.md',
      contents: '# Project instructions\n',
    });
  });

  it('collapses undefined description to empty string (so jq .description // "" works)', () => {
    const parsed = JSON.parse(buildScaffoldSpec(goodRequest({ description: undefined })));
    expect(parsed.description).toBe('');
  });

  it('collapses absent postScaffoldFiles to an empty array', () => {
    const parsed = JSON.parse(buildScaffoldSpec(goodRequest({ postScaffoldFiles: undefined })));
    expect(parsed.postScaffoldFiles).toEqual([]);
  });
});

describe('validateRepoName', () => {
  it.each([
    ['cool-app', true],
    ['cool_app-1.0', true],
    ['a', true],
    ['', false],
    ['.leading-dot', false],
    ['has/slash', false],
    ['..', false],
    ['a..b', false],
    ['a'.repeat(101), false],
    ['space in name', false],
  ])('validateRepoName(%p) ok=%p', (name, ok) => {
    if (ok) expect(() => validateRepoName(name as string)).not.toThrow();
    else expect(() => validateRepoName(name as string)).toThrow(ScaffoldError);
  });
});

describe('validatePostFile', () => {
  it('accepts a plain relative path', () => {
    expect(() => validatePostFile({ relativePath: 'src/index.ts', contents: '' })).not.toThrow();
  });
  it('rejects a Windows-style ".." traversal', () => {
    expect(() => validatePostFile({ relativePath: '..\\escape.md', contents: '' })).toThrow(
      /traversal/,
    );
  });
  it('rejects ".." substring in path segment (matches scaffold.sh glob)', () => {
    expect(() => validatePostFile({ relativePath: 'v1..2/notes.md', contents: '' })).toThrow(
      /traversal/,
    );
  });
  it('rejects non-string contents', () => {
    expect(() =>
      validatePostFile({ relativePath: 'x.md', contents: 42 as unknown as string }),
    ).toThrow(/contents must be a string/);
  });
});

describe('ScaffoldError', () => {
  it('carries exit code, timedOut flag, and stderr', () => {
    const e = new ScaffoldError('x', { exitCode: 5, timedOut: false, stderr: 'boom' });
    expect(e.exitCode).toBe(5);
    expect(e.timedOut).toBe(false);
    expect(e.stderr).toBe('boom');
    expect(e.name).toBe('ScaffoldError');
    expect(e).toBeInstanceOf(Error);
  });
});

// A minimal integration-style test that wires the same builder up with a
// throwing minter spy, just to confirm the error surfaces are what a caller
// would see in production.
describe('scaffoldRepo — integration surface', () => {
  it('vi.fn minter sees the exact credential object', async () => {
    const mint = vi.fn().mockResolvedValue('t');
    const runner = makeFakeRunner();
    const deps: ScaffoldBuilderDeps = {
      runner: runner.runner,
      mintInstallationToken: mint,
      scaffoldImage: 'img',
    };
    await scaffoldRepo(deps, goodRequest());
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      appId: '12345',
      privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
      installationId: '67890',
    });
  });
});
