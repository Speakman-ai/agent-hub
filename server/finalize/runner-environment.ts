/**
 * PR environment bring-up, shared by the fleet runner-agent and the Hub-local
 * backend so both boot a stack the same way.
 *
 * An environment runs in one DinD container (the same runner image Finalize
 * uses). Inside it, the project's compose file is brought up as project
 * `pr-<n>` with a generated override that also publishes the exposed service
 * on a fixed gateway port. The outer container publishes that gateway port on
 * a free host port, which is the upstream the Hub routes to.
 *
 * Pure apart from the injected `exec`: no DB, no Hub imports, so it is safe in
 * the runner-agent bundle.
 */

/** Port inside the DinD container that forwards to the exposed service. */
export const ENVIRONMENT_GATEWAY_PORT = 18080;

/** Compose override written inside the container (outside the checkout). */
export const ENVIRONMENT_OVERRIDE_PATH = '/tmp/agent-hub-prenv.compose.yml';

/**
 * Written once the stack passed its health check. A Hub-local environment
 * whose bring-up was cut short by a Hub restart has no marker, so reattach can
 * tell a healthy stack from a half-built one.
 */
export const ENVIRONMENT_READY_MARKER = '/tmp/agent-hub-prenv.ready';

/** Label on every environment container (value: the environment key). */
export const ENVIRONMENT_LABEL = 'agent-hub.prenv.key';

/** Per-phase ceiling for `compose up` and each seed step. */
export const DEFAULT_ENVIRONMENT_PHASE_DEADLINE_MS = 30 * 60_000;

/** How long the exposed service may take to answer its health path. */
export const DEFAULT_ENVIRONMENT_HEALTH_TIMEOUT_MS = 5 * 60_000;

const HEALTH_POLL_MS = 2_000;

/** Attempts at writing the ready marker before bring-up fails. */
const MARKER_ATTEMPTS = 3;

/** What an environment job boots. Carried in the runner wire spec. */
export interface RunnerEnvironmentSpec {
  /** Compose project name, `pr-<n>`. */
  composeProject: string;
  /** Repo-relative compose file. */
  composeFile: string;
  /** Service whose container port is exposed. */
  service: string;
  /** Container port on `service`. */
  port: number;
  /** Health path probed on the exposed port. */
  health: string;
  /** Seed steps run after `compose up`. */
  steps: Array<{ name: string; run: string }>;
  healthTimeoutMs?: number;
}

/** Container name for an environment key (`<envId>-g<generation>`). */
export function environmentContainerName(key: string): string {
  const slug = key.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return `prenv-${slug}`.toLowerCase();
}

/** Env every compose command in the container runs with. */
export function environmentComposeEnv(spec: RunnerEnvironmentSpec): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: spec.composeProject,
    COMPOSE_FILE: `${spec.composeFile}:${ENVIRONMENT_OVERRIDE_PATH}`,
  };
}

/**
 * Compose override that adds the gateway mapping to the exposed service.
 * Compose appends `ports` across files, so mappings in the project's own file
 * are kept. Names are JSON-quoted, which is valid YAML.
 */
export function buildEnvironmentOverrideYaml(spec: RunnerEnvironmentSpec): string {
  return [
    'services:',
    `  ${JSON.stringify(spec.service)}:`,
    '    ports:',
    `      - ${JSON.stringify(`${ENVIRONMENT_GATEWAY_PORT}:${spec.port}`)}`,
    '',
  ].join('\n');
}

const HEREDOC_TAG = 'AGENT_HUB_PRENV_EOF';

export interface EnvironmentPhase {
  name: string;
  run: string;
  deadlineMs: number;
}

/** Ordered bring-up commands: write the override, `compose up`, seed steps. */
export function buildEnvironmentPhases(spec: RunnerEnvironmentSpec): EnvironmentPhase[] {
  const deadlineMs = DEFAULT_ENVIRONMENT_PHASE_DEADLINE_MS;
  return [
    {
      name: 'compose override',
      run: `cat > ${ENVIRONMENT_OVERRIDE_PATH} <<'${HEREDOC_TAG}'\n${buildEnvironmentOverrideYaml(spec)}${HEREDOC_TAG}`,
      deadlineMs: 60_000,
    },
    {
      name: 'compose up',
      run: 'docker compose up -d --build --remove-orphans',
      deadlineMs,
    },
    ...spec.steps.map((s) => ({ name: s.name, run: s.run, deadlineMs })),
  ];
}

/** Prints the HTTP status of the gateway's health path (`000` when unreachable). */
export function buildHealthProbeCommand(spec: RunnerEnvironmentSpec): string {
  const url = `http://127.0.0.1:${ENVIRONMENT_GATEWAY_PORT}${spec.health}`;
  return `curl -sS -o /dev/null -w '%{http_code}' --max-time 5 ${shellQuote(url)} || true`;
}

/** Stops the stack and removes its volumes. Safe to run when nothing is up. */
export function buildEnvironmentTeardownCommand(): string {
  return 'docker compose down -v --remove-orphans --timeout 10 || true';
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Host port from `docker port <container> <port>` output, e.g. `0.0.0.0:49153`. */
export function parseDockerPortOutput(out: string): number | null {
  for (const line of out.split('\n')) {
    const m = /:(\d+)\s*$/.exec(line.trim());
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

export interface EnvironmentExecResult {
  exitCode: number | null;
  /** Captured stdout (the health probe reads the status code from it). */
  stdout: string;
}

/**
 * Run one command in the environment container. `phase` is the log stream
 * index; `quiet` commands are not echoed to the environment log.
 */
export type EnvironmentExec = (
  run: string,
  opts: {
    env: Record<string, string>;
    phase: number;
    deadlineMs: number;
    quiet?: boolean;
    signal?: AbortSignal;
  },
) => Promise<EnvironmentExecResult>;

export type EnvironmentBringupResult = { ok: true } | { ok: false; error: string };

/**
 * Bring the stack up and wait until the exposed service answers its health
 * path with a 2xx/3xx. `env` is the job env (project preview secrets); the
 * compose env is layered on top.
 */
export async function runEnvironmentBringup(args: {
  spec: RunnerEnvironmentSpec;
  env: Record<string, string>;
  exec: EnvironmentExec;
  log: (line: string) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  healthPollMs?: number;
}): Promise<EnvironmentBringupResult> {
  const { spec, exec, log } = args;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const env = { ...args.env, ...environmentComposeEnv(spec) };
  const stopped = (): EnvironmentBringupResult => ({
    ok: false,
    error: 'Environment was stopped during bring-up.',
  });

  const phases = buildEnvironmentPhases(spec);
  for (let i = 0; i < phases.length; i++) {
    if (args.signal?.aborted) return stopped();
    const phase = phases[i];
    log(`==> ${phase.name}`);
    const res = await exec(phase.run, {
      env,
      phase: i,
      deadlineMs: phase.deadlineMs,
      signal: args.signal,
    });
    if (args.signal?.aborted) return stopped();
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: `"${phase.name}" failed (exit ${res.exitCode ?? 'killed'}).`,
      };
    }
  }

  const timeoutMs = spec.healthTimeoutMs ?? DEFAULT_ENVIRONMENT_HEALTH_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const probe = buildHealthProbeCommand(spec);
  log(`==> health check ${spec.service}:${spec.port}${spec.health}`);
  let last = '';
  for (;;) {
    if (args.signal?.aborted) return stopped();
    const res = await exec(probe, {
      env,
      phase: phases.length,
      deadlineMs: 15_000,
      quiet: true,
      signal: args.signal,
    });
    const code = Number.parseInt(res.stdout.trim().slice(-3), 10);
    if (code >= 200 && code < 400) break;
    const seen = Number.isFinite(code) && code > 0 ? `HTTP ${code}` : 'no response';
    if (seen !== last) log(`health: ${seen}`);
    last = seen;
    if (now() >= deadline) {
      return {
        ok: false,
        error: `${spec.service}:${spec.port}${spec.health} did not become healthy within ${Math.round(
          timeoutMs / 1000,
        )}s (last: ${seen}).`,
      };
    }
    await sleep(args.healthPollMs ?? HEALTH_POLL_MS);
  }

  // The marker is how a Hub-local restart tells this healthy stack from an
  // interrupted bring-up, so ready is only reported once it exists.
  let marked: EnvironmentExecResult | null = null;
  for (let attempt = 0; attempt < MARKER_ATTEMPTS; attempt++) {
    if (args.signal?.aborted) return stopped();
    marked = await exec(`touch ${ENVIRONMENT_READY_MARKER}`, {
      env,
      phase: phases.length,
      deadlineMs: 15_000,
      quiet: true,
      signal: args.signal,
    });
    if (marked.exitCode === 0) break;
    if (attempt < MARKER_ATTEMPTS - 1) await sleep(args.healthPollMs ?? HEALTH_POLL_MS);
  }
  if (args.signal?.aborted) return stopped();
  if (marked?.exitCode !== 0) {
    return {
      ok: false,
      error: `Could not record the environment as ready (exit ${marked?.exitCode ?? 'killed'}).`,
    };
  }
  log('==> environment is healthy');
  return { ok: true };
}
