import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  httpTransport,
  resolveEcsTaskArn,
  runAgentJob,
  runClaimedJobWithRecovery,
  runExecStepChild,
  STEP_DEADLINE_EXIT_CODE,
  type AgentDocker,
  type AgentLogFrame,
  type AgentPollResult,
  type AgentTransport,
} from './runner-agent.js';
import type { TaskProtection } from './ecs-task-protection.js';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';
import type { JobResourceSummary, RunningSampler } from './job-resource-sampler.js';

/** Records the on/off protection calls so we can assert the job lifecycle. */
function fakeProtection(): TaskProtection & { calls: boolean[] } {
  const calls: boolean[] = [];
  return {
    calls,
    async set(enabled) {
      calls.push(enabled);
    },
  };
}

const wire = (over: Partial<RunnerJobWireSpec> = {}): RunnerJobWireSpec => ({
  orgId: 'o',
  projectId: 'p',
  runId: 'r',
  jobId: 'e2e',
  matrixKey: '',
  image: 'img',
  composeProjectName: 'cp',
  env: {},
  worktreeRef: null,
  ...over,
});

function fakes(polls: AgentPollResult[], exitFor: (run: string) => number) {
  let i = 0;
  const logs: AgentLogFrame[] = [];
  const results: Array<{ stepIndex: number; exitCode: number | null }> = [];
  const events: string[] = [];
  const finishArgs: Array<JobResourceSummary | null> = [];
  const transport: AgentTransport = {
    claim: async () => null,
    poll: async () => polls[i++] ?? { type: 'finish' },
    postLogs: async (_j, frames) => {
      logs.push(...frames);
    },
    postStepResult: async (_j, stepIndex, exitCode) => {
      results.push({ stepIndex, exitCode });
    },
    postFinish: async (_j, _exit, summary) => {
      events.push('finish');
      finishArgs.push(summary ?? null);
    },
    heartbeat: async () => {},
    reportError: async (jobId, detail) => {
      events.push(`error:${jobId}:${detail}`);
    },
  };
  const docker: AgentDocker = {
    startContainer: async (_spec, mount) => {
      events.push(`start:${mount}`);
      return 'c1';
    },
    execStep: async (_c, run, _env, onLog) => {
      onLog('stdout', `out:${run}\n`);
      return exitFor(run);
    },
    stopContainer: async (c) => {
      events.push(`stop:${c}`);
    },
  };
  return { transport, docker, logs, results, events, finishArgs };
}

describe('runAgentJob', () => {
  it('runs steps in order, streams logs, reports exits, tears down on finish', async () => {
    const { transport, docker, logs, results, events } = fakes(
      [
        { type: 'run_step', stepIndex: 0, run: 'echo a', env: {} },
        { type: 'idle' }, // long-poll miss between steps — skipped
        { type: 'run_step', stepIndex: 1, run: 'echo b', env: {} },
        { type: 'finish' },
      ],
      (run) => (run.includes('b') ? 2 : 0),
    );

    const { stepExits } = await runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      logFlushMs: 5,
    });

    expect(stepExits).toEqual([
      { stepIndex: 0, exitCode: 0 },
      { stepIndex: 1, exitCode: 2 },
    ]);
    expect(results).toEqual([
      { stepIndex: 0, exitCode: 0 },
      { stepIndex: 1, exitCode: 2 },
    ]);
    expect(logs.map((f) => f.data)).toEqual(['out:echo a\n', 'out:echo b\n']);
    expect(logs.map((f) => f.seq)).toEqual([0, 1]); // job-monotonic seq
    expect(events).toEqual(['start:/ws/repo', 'stop:c1', 'finish']);
  });

  it('reports a detected spot interruption on the heartbeat', async () => {
    const hbCalls: Array<boolean | undefined> = [];
    let releaseStep!: () => void;
    const stepGate = new Promise<void>((r) => {
      releaseStep = r;
    });
    const { transport, docker } = fakes(
      [{ type: 'run_step', stepIndex: 0, run: 'slow', env: {} }, { type: 'finish' }],
      () => 0,
    );
    transport.heartbeat = async (_j, spot) => {
      hbCalls.push(spot);
    };
    // Hold the step open so the background heartbeat timer fires at least once.
    docker.execStep = async () => {
      await stepGate;
      return 0;
    };

    const jobP = runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      heartbeatMs: 5,
      spotProbeMs: 5,
      checkSpot: async () => true,
    });

    await vi.waitFor(() => expect(hbCalls.some((s) => s === true)).toBe(true));
    releaseStep();
    await jobP;
  });

  it('reports a spot reclaim out-of-band even when the heartbeat cadence is slow', async () => {
    // Regression: the IMDS probe used to ride the heartbeat tick, so a reclaim
    // notice could not be reported any sooner than the next (potentially
    // stretched) heartbeat — frequently too late, misclassifying the lost lease
    // as generic `lease expired` instead of `spot_reclaimed`. The probe now runs
    // on its own faster interval and fires an immediate heartbeat on detection.
    const hbCalls: Array<boolean | undefined> = [];
    let releaseStep!: () => void;
    const stepGate = new Promise<void>((r) => {
      releaseStep = r;
    });
    const { transport, docker } = fakes(
      [{ type: 'run_step', stepIndex: 0, run: 'slow', env: {} }, { type: 'finish' }],
      () => 0,
    );
    transport.heartbeat = async (_j, spot) => {
      hbCalls.push(spot);
    };
    docker.execStep = async () => {
      await stepGate;
      return 0;
    };

    let probes = 0;
    const jobP = runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      // Heartbeat far slower than the probe: a reclaim must still be reported
      // promptly via the probe's own out-of-band heartbeat, not wait on the tick.
      heartbeatMs: 100_000,
      spotProbeMs: 5,
      checkSpot: async () => {
        probes += 1;
        return true;
      },
    });

    // The first reported heartbeat carries the spot flag — driven by the probe,
    // not the (100s-away) heartbeat tick.
    await vi.waitFor(() => expect(hbCalls.some((s) => s === true)).toBe(true));
    expect(hbCalls[0]).toBe(true);
    // Sticky: once detected the probe stops firing (it short-circuits), so the
    // probe count stays bounded rather than hammering IMDS for the whole job.
    const probesAfterDetect = probes;
    await new Promise((r) => setTimeout(r, 30));
    expect(probes).toBe(probesAfterDetect);
    releaseStep();
    await jobP;
  });

  it('does not stack overlapping IMDS probes when the metadata service stalls', async () => {
    // Regression: with the probe decoupled onto its own fast (5ms here) interval,
    // a checkSpot() that outlasts spotProbeMs must NOT let ticks pile up unbounded
    // pending probes. The in-flight guard skips a tick while one is outstanding.
    let releaseStep!: () => void;
    const stepGate = new Promise<void>((r) => {
      releaseStep = r;
    });
    const { transport, docker } = fakes(
      [{ type: 'run_step', stepIndex: 0, run: 'slow', env: {} }, { type: 'finish' }],
      () => 0,
    );
    transport.heartbeat = async () => {};
    docker.execStep = async () => {
      await stepGate;
      return 0;
    };

    // A probe that hangs until we let it go — far longer than the 5ms tick, so
    // many ticks fire while the first probe is still pending.
    let started = 0;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((r) => {
      releaseProbe = r;
    });
    const jobP = runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      heartbeatMs: 100_000,
      spotProbeMs: 5,
      checkSpot: async () => {
        started += 1;
        await probeGate;
        return false;
      },
    });

    // Let the interval fire many times while the single probe is in flight.
    await new Promise((r) => setTimeout(r, 60));
    // Exactly one probe should have started despite ~12 ticks elapsing.
    expect(started).toBe(1);

    releaseProbe();
    releaseStep();
    await jobP;
  });

  it('heartbeats with no interruption flag off-EC2 (checkSpot false)', async () => {
    const hbCalls: Array<boolean | undefined> = [];
    let releaseStep!: () => void;
    const stepGate = new Promise<void>((r) => {
      releaseStep = r;
    });
    const { transport, docker } = fakes(
      [{ type: 'run_step', stepIndex: 0, run: 'slow', env: {} }, { type: 'finish' }],
      () => 0,
    );
    transport.heartbeat = async (_j, spot) => {
      hbCalls.push(spot);
    };
    docker.execStep = async () => {
      await stepGate;
      return 0;
    };

    const jobP = runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      heartbeatMs: 5,
      spotProbeMs: 5,
      checkSpot: async () => false,
    });

    await vi.waitFor(() => expect(hbCalls.length).toBeGreaterThan(0));
    releaseStep();
    await jobP;
    expect(hbCalls.every((s) => s === false)).toBe(true);
  });

  it('treats a 410/gone poll as teardown', async () => {
    const { transport, docker, events } = fakes([{ type: 'gone' }], () => 0);
    await runAgentJob({ jobId: 'j', spec: wire(), workspaceDir: '/ws', transport, docker });
    expect(events).toEqual(['start:/ws/repo', 'stop:c1', 'finish']);
  });

  it('protects the task on start and releases it on finish', async () => {
    const { transport, docker } = fakes(
      [{ type: 'run_step', stepIndex: 0, run: 'echo a', env: {} }, { type: 'finish' }],
      () => 0,
    );
    const protection = fakeProtection();
    await runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      protection,
    });
    // First call protects (true); the final call (in finally) releases (false).
    expect(protection.calls[0]).toBe(true);
    expect(protection.calls.at(-1)).toBe(false);
  });

  it('still releases protection when the job throws', async () => {
    const { transport, docker } = fakes([{ type: 'finish' }], () => 0);
    docker.startContainer = async () => {
      throw new Error('dind boot failed');
    };
    const protection = fakeProtection();
    await expect(
      runAgentJob({ jobId: 'j', spec: wire(), workspaceDir: '/ws', transport, docker, protection }),
    ).rejects.toThrow('dind boot failed');
    expect(protection.calls[0]).toBe(true);
    expect(protection.calls.at(-1)).toBe(false);
  });

  it('threads the resource summary from the sampler into postFinish', async () => {
    const { transport, docker, finishArgs } = fakes(
      [{ type: 'run_step', stepIndex: 0, run: 'echo a', env: {} }, { type: 'finish' }],
      () => 0,
    );
    const summary: JobResourceSummary = {
      peakMemBytes: 1_700_000_000,
      memTotalBytes: 32_000_000_000,
      peakCpuPercent: 72.5,
      avgCpuPercent: 18.1,
      samples: 9,
      durationMs: 45_000,
    };
    let stopped = false;
    const sampler: RunningSampler = {
      stop: () => {
        stopped = true;
        return summary;
      },
    };
    await runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      startSampler: () => sampler,
    });
    expect(stopped).toBe(true);
    expect(finishArgs[0]).toEqual(summary);
  });

  it('finishes cleanly when the sampler has no summary (non-Linux host)', async () => {
    const { transport, docker, events, finishArgs } = fakes([{ type: 'finish' }], () => 0);
    await runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      startSampler: () => ({ stop: () => null }),
    });
    expect(events).toContain('finish');
    expect(finishArgs[0]).toBeNull();
  });

  it('materializes the worktree when a bundle ref is present', async () => {
    const { transport, docker } = fakes([{ type: 'finish' }], () => 0);
    const materialized: string[] = [];
    await runAgentJob({
      jobId: 'j',
      spec: wire({ worktreeRef: { key: 'worktrees/o/r.bundle', sha256: 'x', sizeBytes: 1 } }),
      workspaceDir: '/ws',
      transport,
      docker,
      materialize: async (_spec, dest) => {
        materialized.push(dest);
      },
    });
    expect(materialized).toEqual(['/ws/repo']);
  });

  // Regression: a hung/runaway remote step used to pin the agent in execStep
  // forever — the agent kept heartbeating, so the Hub lease reaper never fired
  // and the whole run hung. The agent now enforces the directive's per-step
  // deadline locally, aborting the exec and reporting a deterministic timeout.
  describe('per-step hard deadline (hang/runaway containment)', () => {
    /** A docker fake whose `execStep` hangs until its abort signal fires. */
    function hangingDocker(onAbortExit = 137): {
      docker: AgentDocker;
      sawSignal: () => boolean;
      events: string[];
    } {
      const events: string[] = [];
      let signalSeen = false;
      const docker: AgentDocker = {
        startContainer: async () => 'c1',
        execStep: (_c, run, _env, onLog, signal) => {
          if (run !== 'hang') {
            onLog('stdout', `out:${run}\n`);
            return Promise.resolve(0);
          }
          if (signal) signalSeen = true;
          // Never resolves on its own — only the abort (deadline) ends it,
          // exactly like a wedged or never-terminating CI step.
          return new Promise<number>((resolve) => {
            const finish = (): void => resolve(onAbortExit);
            if (signal?.aborted) finish();
            else signal?.addEventListener('abort', finish, { once: true });
          });
        },
        stopContainer: async (c) => {
          events.push(`stop:${c}`);
        },
      };
      return { docker, sawSignal: () => signalSeen, events };
    }

    it('kills a step that blows its deadline and reports STEP_DEADLINE_EXIT_CODE', async () => {
      const { docker, sawSignal, events } = hangingDocker();
      const results: Array<{ stepIndex: number; exitCode: number | null }> = [];
      const transport: AgentTransport = {
        claim: async () => null,
        poll: async () => ({ type: 'finish' }),
        postLogs: async () => {},
        postStepResult: async (_j, stepIndex, exitCode) => {
          results.push({ stepIndex, exitCode });
        },
        postFinish: async () => {},
        heartbeat: async () => {},
        reportError: async () => {},
      };
      // First poll returns the hung step with a tiny deadline; subsequent polls
      // (after the deadline kills it) return `finish` so the job loop ends.
      let n = 0;
      transport.poll = async () =>
        n++ === 0
          ? { type: 'run_step', stepIndex: 0, run: 'hang', env: {}, deadlineMs: 15 }
          : { type: 'finish' };

      const { stepExits } = await runAgentJob({
        jobId: 'j',
        spec: wire(),
        workspaceDir: '/ws',
        transport,
        docker,
        startSampler: () => ({ stop: () => null }),
      });

      // The job COMPLETED (did not hang) and the step was force-killed.
      expect(sawSignal()).toBe(true);
      expect(events).toContain('stop:c1'); // container torn down
      expect(results).toEqual([{ stepIndex: 0, exitCode: STEP_DEADLINE_EXIT_CODE }]);
      expect(stepExits).toEqual([{ stepIndex: 0, exitCode: STEP_DEADLINE_EXIT_CODE }]);
    });

    it('does NOT kill a step that finishes before its deadline (deadline cleared)', async () => {
      // `run:'ok'` resolves immediately; a generous deadline must never fire and
      // the real exit code must be preserved.
      const { docker, sawSignal } = hangingDocker();
      const results: Array<{ stepIndex: number; exitCode: number | null }> = [];
      let n = 0;
      const transport: AgentTransport = {
        claim: async () => null,
        poll: async () =>
          n++ === 0
            ? { type: 'run_step', stepIndex: 0, run: 'ok', env: {}, deadlineMs: 60_000 }
            : { type: 'finish' },
        postLogs: async () => {},
        postStepResult: async (_j, stepIndex, exitCode) => {
          results.push({ stepIndex, exitCode });
        },
        postFinish: async () => {},
        heartbeat: async () => {},
        reportError: async () => {},
      };
      await runAgentJob({
        jobId: 'j',
        spec: wire(),
        workspaceDir: '/ws',
        transport,
        docker,
        startSampler: () => ({ stop: () => null }),
      });
      expect(sawSignal()).toBe(false); // never aborted
      expect(results).toEqual([{ stepIndex: 0, exitCode: 0 }]);
    });
  });
});

describe('httpTransport.heartbeat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the spot flag as JSON with the application/json content type', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 204 } as Response;
      }),
    );
    const transport = httpTransport('http://hub.test', 'tok');

    await transport.heartbeat('job-1', true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://hub.test/api/runners/jobs/job-1/heartbeat');
    const headers = calls[0].init.headers as Record<string, string>;
    // Express's json() parser only populates req.body when the content type is
    // application/json — this is what makes req.body.spotInterruption land.
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ spotInterruption: true });
  });

  it('omits the flag when no interruption is reported', async () => {
    const calls: Array<{ init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ init });
        return { ok: true, status: 204 } as Response;
      }),
    );
    const transport = httpTransport('http://hub.test', 'tok');

    await transport.heartbeat('job-1');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({});
  });
});

describe('httpTransport.reportError (card #1184)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the detail as JSON with the application/json content type', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 204 } as Response;
      }),
    );
    const transport = httpTransport('http://hub.test', 'tok');

    await transport.reportError('job-1', 'inner dockerd not ready within 120s');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://hub.test/api/runners/jobs/job-1/error');
    const headers = calls[0].init.headers as Record<string, string>;
    // Without this content type Express's json() leaves req.body undefined, so the
    // route would drop the specific bring-up detail and fall back to a generic one.
    expect(headers['content-type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      detail: 'inner dockerd not ready within 120s',
    });
  });
});

describe('resolveEcsTaskArn', () => {
  const saved = process.env.ECS_CONTAINER_METADATA_URI_V4;
  afterEach(() => {
    if (saved === undefined) delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    else process.env.ECS_CONTAINER_METADATA_URI_V4 = saved;
  });

  it('returns null off-ECS (metadata URI unset) without fetching', async () => {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    const f = vi.fn();
    expect(await resolveEcsTaskArn(f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('fetches <metadata>/task and returns TaskARN', async () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/abc';
    const arn = 'arn:aws:ecs:us-east-2:1:task/agenthub-finalize-runner/deadbeef';
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://169.254.170.2/v4/abc/task');
      // Bounded: a timeout AbortSignal is passed so a hung endpoint fails closed.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => ({ TaskARN: arn }) } as unknown as Response;
    });
    expect(await resolveEcsTaskArn(f as unknown as typeof fetch)).toBe(arn);
  });

  it('returns null on non-ok, missing TaskARN, or a thrown fetch (best-effort)', async () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://md';
    const notOk = vi.fn(async () => ({ ok: false }) as unknown as Response);
    expect(await resolveEcsTaskArn(notOk as unknown as typeof fetch)).toBeNull();
    const noArn = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    expect(await resolveEcsTaskArn(noArn as unknown as typeof fetch)).toBeNull();
    const threw = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await resolveEcsTaskArn(threw as unknown as typeof fetch)).toBeNull();
  });
});

describe('runClaimedJobWithRecovery (card #1184)', () => {
  function recorder(): AgentTransport & { errors: Array<{ jobId: string; detail: string }> } {
    const errors: Array<{ jobId: string; detail: string }> = [];
    return {
      claim: async () => null,
      poll: async () => ({ type: 'finish' }),
      postLogs: async () => {},
      postStepResult: async () => {},
      postFinish: async () => {},
      heartbeat: async () => {},
      reportError: async (jobId, detail) => {
        errors.push({ jobId, detail });
      },
      errors,
    };
  }

  it('reports the job error to the Hub when the run throws (bring-up failure)', async () => {
    const t = recorder();
    await runClaimedJobWithRecovery(t, 'job-bringup', async () => {
      throw new Error('inner dockerd not ready within 120s');
    });
    // The thrown job is reported immediately so the Hub fails its channel
    // (→ infra_error → retry) instead of leaving it orphaned until the reaper.
    expect(t.errors).toEqual([
      { jobId: 'job-bringup', detail: 'inner dockerd not ready within 120s' },
    ]);
  });

  it('does NOT report when the job runs to completion', async () => {
    const t = recorder();
    await runClaimedJobWithRecovery(t, 'job-ok', async () => undefined);
    expect(t.errors).toEqual([]);
  });

  it('never lets a failed error-report throw out of the loop step (reaper is the backstop)', async () => {
    const t = recorder();
    t.reportError = async () => {
      throw new Error('hub unreachable');
    };
    // Must resolve (not reject) even though both the job and the report failed,
    // so the agent loop keeps claiming instead of crashing.
    await expect(
      runClaimedJobWithRecovery(t, 'job-x', async () => {
        throw new Error('materialize failed');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('runExecStepChild (exit-vs-close + process-group kill)', () => {
  /** Minimal ChildProcess stand-in: EventEmitter + stdout/stderr emitters. */
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed: string[] = [];
    constructor(public pid: number | undefined = undefined) {
      super();
    }
    kill(sig: NodeJS.Signals): boolean {
      this.killed.push(sig);
      return true;
    }
  }
  const spawnReturning = (fc: FakeChild) =>
    (() => fc) as unknown as Parameters<typeof runExecStepChild>[0]['spawnFn'];

  it('resolves on process exit, streaming output, when close follows promptly', async () => {
    const fc = new FakeChild();
    const out: string[] = [];
    const p = runExecStepChild({
      argv: ['docker', 'exec'],
      onLog: (_s, d) => out.push(d),
      spawnFn: spawnReturning(fc),
      exitDrainGraceMs: 1_000,
    });
    fc.stdout.emit('data', Buffer.from('hello\n'));
    fc.emit('exit', 0);
    fc.emit('close', 0);
    await expect(p).resolves.toBe(0);
    expect(out.join('')).toBe('hello\n');
  });

  // The core fix: a leftover child holds the pipe open so `close` NEVER fires —
  // we must still resolve (on exit + grace), not hang the step forever.
  it('resolves after the drain grace when close never fires (lingering pipe-holder)', async () => {
    const fc = new FakeChild();
    const out: string[] = [];
    const p = runExecStepChild({
      argv: ['x'],
      onLog: (_s, d) => out.push(d),
      spawnFn: spawnReturning(fc),
      exitDrainGraceMs: 15,
    });
    fc.stdout.emit('data', Buffer.from('partial output'));
    fc.emit('exit', 3); // process exited; close intentionally never emitted
    await expect(p).resolves.toBe(3);
    expect(out.join('')).toContain('partial output');
  });

  it('SIGTERMs then SIGKILLs the process on abort (group kill via child.kill when pid is unknown)', async () => {
    const fc = new FakeChild(undefined); // no pid → falls back to child.kill (no real process.kill)
    const ac = new AbortController();
    const p = runExecStepChild({
      argv: ['x'],
      onLog: () => {},
      signal: ac.signal,
      spawnFn: spawnReturning(fc),
      killGraceMs: 10,
      exitDrainGraceMs: 5,
    });
    ac.abort();
    expect(fc.killed).toEqual(['SIGTERM']); // immediate
    await new Promise((r) => setTimeout(r, 25));
    expect(fc.killed).toContain('SIGKILL'); // after the grace, since it didn't exit
    // The process finally dies; the promise settles with the kill exit code.
    fc.emit('exit', 137);
    fc.emit('close', 137);
    await expect(p).resolves.toBe(137);
  });

  it('does not SIGKILL if the process exits within the kill grace', async () => {
    const fc = new FakeChild(undefined);
    const ac = new AbortController();
    const p = runExecStepChild({
      argv: ['x'],
      onLog: () => {},
      signal: ac.signal,
      spawnFn: spawnReturning(fc),
      killGraceMs: 50,
      exitDrainGraceMs: 5,
    });
    ac.abort();
    expect(fc.killed).toEqual(['SIGTERM']);
    fc.emit('exit', 143); // exits on SIGTERM within the grace
    fc.emit('close', 143);
    await expect(p).resolves.toBe(143);
    await new Promise((r) => setTimeout(r, 70));
    expect(fc.killed).toEqual(['SIGTERM']); // no stray SIGKILL after it settled
  });
});
