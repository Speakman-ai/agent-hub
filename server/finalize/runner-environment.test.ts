import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_GATEWAY_PORT,
  ENVIRONMENT_READY_MARKER,
  buildEnvironmentOverrideYaml,
  buildEnvironmentPhases,
  environmentComposeEnv,
  environmentContainerName,
  parseDockerPortOutput,
  runEnvironmentBringup,
  type EnvironmentExec,
  type RunnerEnvironmentSpec,
} from './runner-environment.js';
import { buildStartJobContainerArgv } from './runner-exec-args.js';

const SPEC: RunnerEnvironmentSpec = {
  composeProject: 'pr-42',
  composeFile: 'docker-compose.preview.yml',
  service: 'app',
  port: 3000,
  health: '/healthz',
  steps: [{ name: 'migrate', run: 'docker compose exec -T app npm run db:migrate' }],
};

/** Fake exec: records commands; the health probe returns queued status codes. */
function fakeExec(opts: { fail?: string; health?: string[] } = {}) {
  const calls: Array<{ run: string; env: Record<string, string> }> = [];
  const health = [...(opts.health ?? ['200'])];
  const exec: EnvironmentExec = async (run, o) => {
    calls.push({ run, env: o.env });
    if (opts.fail && run.includes(opts.fail)) return { exitCode: 1, stdout: '' };
    if (run.startsWith('curl')) return { exitCode: 0, stdout: health.shift() ?? '000' };
    return { exitCode: 0, stdout: '' };
  };
  return { exec, calls };
}

describe('environment compose wiring', () => {
  it('publishes the exposed service on the gateway port via an override', () => {
    expect(buildEnvironmentOverrideYaml(SPEC)).toBe(
      `services:\n  "app":\n    ports:\n      - "${ENVIRONMENT_GATEWAY_PORT}:3000"\n`,
    );
    expect(environmentComposeEnv(SPEC)).toEqual({
      COMPOSE_PROJECT_NAME: 'pr-42',
      COMPOSE_FILE: 'docker-compose.preview.yml:/tmp/agent-hub-prenv.compose.yml',
    });
  });

  it('runs override, compose up, then seed steps in order', () => {
    expect(buildEnvironmentPhases(SPEC).map((p) => p.name)).toEqual([
      'compose override',
      'compose up',
      'migrate',
    ]);
  });

  it('parses docker port output', () => {
    expect(parseDockerPortOutput('0.0.0.0:49153\n[::]:49153\n')).toBe(49153);
    expect(parseDockerPortOutput('127.0.0.1:32768')).toBe(32768);
    expect(parseDockerPortOutput('')).toBeNull();
  });

  it('names environment containers apart from Finalize runners', () => {
    expect(environmentContainerName('Env/1-g2')).toBe('prenv-env-1-g2');
  });

  it('the DinD container publishes the gateway port only when asked', () => {
    const base = {
      containerName: 'prenv-x',
      image: 'img',
      worktreePath: '/w',
      workspaceMount: '/w',
      composeProjectName: 'pr-1',
      env: {},
      resourceEnv: {},
    };
    expect(buildStartJobContainerArgv(base)).not.toContain('-p');
    const argv = buildStartJobContainerArgv({
      ...base,
      publish: [{ containerPort: ENVIRONMENT_GATEWAY_PORT, hostIp: '127.0.0.1' }],
    });
    expect(argv[argv.indexOf('-p') + 1]).toBe(`127.0.0.1::${ENVIRONMENT_GATEWAY_PORT}`);
  });
});

describe('runEnvironmentBringup', () => {
  it('brings the stack up, waits for health, then marks it ready', async () => {
    const { exec, calls } = fakeExec({ health: ['000', '502', '200'] });
    const logs: string[] = [];
    const res = await runEnvironmentBringup({
      spec: SPEC,
      env: { DATABASE_PASSWORD: 's3cret' },
      exec,
      log: (l) => logs.push(l),
      sleep: async () => {},
    });
    expect(res).toEqual({ ok: true });
    expect(calls[1].run).toBe('docker compose up -d --build --remove-orphans');
    // Secrets and compose targeting reach every command.
    expect(calls[2].env).toMatchObject({
      DATABASE_PASSWORD: 's3cret',
      COMPOSE_PROJECT_NAME: 'pr-42',
    });
    expect(calls.filter((c) => c.run.startsWith('curl'))).toHaveLength(3);
    expect(calls[calls.length - 1].run).toBe(`touch ${ENVIRONMENT_READY_MARKER}`);
    expect(logs).toContain('health: HTTP 502');
  });

  it('does not report ready when the ready marker cannot be written', async () => {
    const calls: string[] = [];
    const exec: EnvironmentExec = async (run) => {
      calls.push(run);
      if (run.startsWith('curl')) return { exitCode: 0, stdout: '200' };
      if (run.startsWith('touch')) return { exitCode: 1, stdout: '' };
      return { exitCode: 0, stdout: '' };
    };
    const logs: string[] = [];
    const res = await runEnvironmentBringup({
      spec: SPEC,
      env: {},
      exec,
      log: (l) => logs.push(l),
      sleep: async () => {},
    });
    expect(res).toEqual({
      ok: false,
      error: 'Could not record the environment as ready (exit 1).',
    });
    expect(calls.filter((c) => c.startsWith('touch'))).toHaveLength(3);
    expect(logs).not.toContain('==> environment is healthy');
  });

  it('a transient marker failure is retried', async () => {
    let touches = 0;
    const exec: EnvironmentExec = async (run) => {
      if (run.startsWith('curl')) return { exitCode: 0, stdout: '200' };
      if (run.startsWith('touch')) return { exitCode: ++touches === 1 ? null : 0, stdout: '' };
      return { exitCode: 0, stdout: '' };
    };
    const res = await runEnvironmentBringup({
      spec: SPEC,
      env: {},
      exec,
      log: () => {},
      sleep: async () => {},
    });
    expect(res).toEqual({ ok: true });
    expect(touches).toBe(2);
  });

  it('fails on the first failing phase without probing health', async () => {
    const { exec, calls } = fakeExec({ fail: 'db:migrate' });
    const res = await runEnvironmentBringup({ spec: SPEC, env: {}, exec, log: () => {} });
    expect(res).toEqual({ ok: false, error: '"migrate" failed (exit 1).' });
    expect(calls.some((c) => c.run.startsWith('curl'))).toBe(false);
  });

  it('fails when the service never becomes healthy in time', async () => {
    let t = 0;
    const { exec } = fakeExec({ health: [] });
    const res = await runEnvironmentBringup({
      spec: { ...SPEC, healthTimeoutMs: 10_000 },
      env: {},
      exec,
      log: () => {},
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/did not become healthy within 10s/);
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { exec, calls } = fakeExec();
    const res = await runEnvironmentBringup({
      spec: SPEC,
      env: {},
      exec,
      log: () => {},
      signal: ac.signal,
    });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
