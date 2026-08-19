import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  agentIsDraining,
  httpTransport,
  resolveEcsTaskArn,
  runAgentClaimLoop,
  runAgentJob,
  runClaimedJobWithRecovery,
  runExecStepChild,
  RunnerBringupTimeoutError,
  STEP_DEADLINE_EXIT_CODE,
  withBringupDeadline,
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

/** Skip real `sudo chown` — unit tests never have passwordless sudo. */
const noChown = {
  clearJobWorktreeDest: async () => {},
  ensureJobWorktreeOwnership: async () => {},
};

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
      ...noChown,
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
      ...noChown,
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
      ...noChown,
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
      ...noChown,
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
      ...noChown,
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
    await runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      ...noChown,
    });
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
      ...noChown,
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
      runAgentJob({
        jobId: 'j',
        spec: wire(),
        workspaceDir: '/ws',
        transport,
        docker,
        protection,
        ...noChown,
      }),
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
      ...noChown,
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
      ...noChown,
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
      ...noChown,
      transport,
      docker,
      materialize: async (_spec, dest) => {
        materialized.push(dest);
      },
    });
    expect(materialized).toEqual(['/ws/repo']);
  });

  it('clears then materializes then chowns before starting the job container', async () => {
    const { transport, docker, events } = fakes([{ type: 'finish' }], () => 0);
    const order: string[] = [];
    await runAgentJob({
      jobId: 'j',
      spec: wire({ worktreeRef: { key: 'worktrees/o/r.bundle', sha256: 'x', sizeBytes: 1 } }),
      workspaceDir: '/ws',
      transport,
      docker,
      clearJobWorktreeDest: async (dest) => {
        order.push(`clear:${dest}`);
      },
      materialize: async () => {
        order.push('materialize');
      },
      ensureJobWorktreeOwnership: async (dest) => {
        order.push(`chown:${dest}`);
      },
    });
    expect(order).toEqual(['clear:/ws/repo', 'materialize', 'chown:/ws/repo']);
    expect(events[0]).toBe('start:/ws/repo');
  });

  it('skips chown (no agent_lost) when there is no worktreeRef to materialize', async () => {
    // `clear` already `sudo rm -rf`'d /ws/repo. If materialize is skipped the dest
    // no longer exists, so an unconditional `sudo chown -R` would fail with
    // "No such file or directory" and mark the shard agent_lost. It must be gated
    // on materialize actually having run.
    const { transport, docker, events } = fakes([{ type: 'finish' }], () => 0);
    const order: string[] = [];
    await runAgentJob({
      jobId: 'j',
      spec: wire({ worktreeRef: undefined }),
      workspaceDir: '/ws',
      transport,
      docker,
      clearJobWorktreeDest: async (dest) => {
        order.push(`clear:${dest}`);
      },
      materialize: async () => {
        order.push('materialize');
      },
      ensureJobWorktreeOwnership: async (dest) => {
        order.push(`chown:${dest}`);
      },
    });
    expect(order).toEqual(['clear:/ws/repo']);
    expect(events[0]).toBe('start:/ws/repo');
  });

  it('aborts hung bring-up before the first directive poll (bring-up deadline)', async () => {
    const { transport, docker } = fakes([{ type: 'finish' }], () => 0);
    await expect(
      runAgentJob({
        jobId: 'j',
        spec: wire({ worktreeRef: { key: 'worktrees/o/r.bundle', sha256: 'x', sizeBytes: 1 } }),
        workspaceDir: '/ws',
        ...noChown,
        transport,
        docker,
        bringupDeadlineMs: 30,
        materialize: async () => {
          await new Promise((r) => setTimeout(r, 500));
        },
      }),
    ).rejects.toThrow(/bring-up.*exceeded 30ms/);
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
        ...noChown,
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
        ...noChown,
        transport,
        docker,
        startSampler: () => ({ stop: () => null }),
      });
      expect(sawSignal()).toBe(false); // never aborted
      expect(results).toEqual([{ stepIndex: 0, exitCode: 0 }]);
    });
  });

  // Regression (card d8a76929, run 0e803638): the step-result post used to be
  // a single unretried fetch with no res.ok check. One dropped response / LB
  // 5xx / hung socket silently lost the result while the background heartbeat
  // kept the lease fresh — the Hub's step row sat `running` for 44 min with
  // the tests long green. Critical messages now retry with backoff and fail
  // LOUDLY when exhausted so the lease-reaper backstop can take over.
  describe('critical delivery (step-result / finish)', () => {
    it('retries a transiently failing step-result post until it delivers', async () => {
      const { transport, docker, results } = fakes(
        [{ type: 'run_step', stepIndex: 0, run: 'echo a', env: {} }, { type: 'finish' }],
        () => 0,
      );
      const original = transport.postStepResult;
      let attempts = 0;
      transport.postStepResult = async (j, s, e) => {
        attempts += 1;
        if (attempts < 3) throw new Error('step-result post failed: 502');
        return original(j, s, e);
      };

      const { stepExits } = await runAgentJob({
        jobId: 'j',
        spec: wire(),
        workspaceDir: '/ws',
        ...noChown,
        transport,
        docker,
        logFlushMs: 5,
        delivery: { attempts: 5, baseDelayMs: 1 },
      });

      expect(attempts).toBe(3);
      expect(stepExits).toEqual([{ stepIndex: 0, exitCode: 0 }]);
      expect(results).toEqual([{ stepIndex: 0, exitCode: 0 }]);
    });

    it('aborts the job loudly when step-result delivery exhausts its retries (teardown + finish still attempted)', async () => {
      const { transport, docker, events } = fakes(
        [{ type: 'run_step', stepIndex: 0, run: 'echo a', env: {} }, { type: 'finish' }],
        () => 0,
      );
      transport.postStepResult = async () => {
        throw new Error('step-result post failed: 500');
      };

      await expect(
        runAgentJob({
          jobId: 'j',
          spec: wire(),
          workspaceDir: '/ws',
          ...noChown,
          transport,
          docker,
          logFlushMs: 5,
          delivery: { attempts: 3, baseDelayMs: 1 },
        }),
      ).rejects.toThrow(/step-result .* delivery failed after 3 attempts/);

      // The failure aborts the poll loop but never skips teardown: the
      // container stops and finish is still posted — finish settles any
      // straggler steps Hub-side (channel.onFinish), so it is the immediate
      // second chance for the lost result before the lease reaper kicks in.
      expect(events).toContain('stop:c1');
      expect(events).toContain('finish');
    });

    it('does not fail a green job when only the finish post is undeliverable', async () => {
      const { transport, docker, results } = fakes(
        [{ type: 'run_step', stepIndex: 0, run: 'echo a', env: {} }, { type: 'finish' }],
        () => 0,
      );
      let finishAttempts = 0;
      transport.postFinish = async () => {
        finishAttempts += 1;
        throw new Error('finish post failed: 503');
      };

      // Finish delivery is retried but must NOT throw from the teardown
      // finally (it would mask a real step error); the stopped heartbeat +
      // Hub lease reaper surface the loss instead.
      const { stepExits } = await runAgentJob({
        jobId: 'j',
        spec: wire(),
        workspaceDir: '/ws',
        ...noChown,
        transport,
        docker,
        logFlushMs: 5,
        delivery: { attempts: 2, baseDelayMs: 1 },
      });

      expect(finishAttempts).toBe(2);
      expect(stepExits).toEqual([{ stepIndex: 0, exitCode: 0 }]);
      expect(results).toEqual([{ stepIndex: 0, exitCode: 0 }]);
    });
  });
});

describe('httpTransport.postStepResult / postFinish (critical posts fail loudly)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx step-result response instead of losing the result silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502 }) as Response),
    );
    const transport = httpTransport('http://hub.test', 'tok');
    await expect(transport.postStepResult('job-1', 0, 0)).rejects.toThrow(
      'step-result post failed: 502',
    );
  });

  it('bounds the step-result post with a per-attempt abort signal (a hung fetch is a loss too)', async () => {
    const seen: Array<RequestInit> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return { ok: true, status: 200 } as Response;
      }),
    );
    const transport = httpTransport('http://hub.test', 'tok');
    await transport.postStepResult('job-1', 0, 0);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-2xx finish response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );
    const transport = httpTransport('http://hub.test', 'tok');
    await expect(transport.postFinish('job-1', 0, null)).rejects.toThrow('finish post failed: 500');
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
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
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

  it('rethrows a bring-up timeout after reporting it so the runner process recycles', async () => {
    const t = recorder();
    const timeout = new RunnerBringupTimeoutError(30_000);
    await expect(
      runClaimedJobWithRecovery(t, 'job-timeout', async () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);
    expect(t.errors).toEqual([{ jobId: 'job-timeout', detail: timeout.message }]);
  });
});

describe('runAgentClaimLoop bring-up timeout isolation', () => {
  it('exits before claiming a second job while the timed-out work is still alive', async () => {
    let finishStaleBringup!: () => void;
    const staleBringup = new Promise<void>((resolve) => {
      finishStaleBringup = resolve;
    });
    const claims = [
      { jobId: 'job-1', spec: wire({ jobId: 'first' }) },
      { jobId: 'job-2', spec: wire({ jobId: 'second' }) },
    ];
    const { transport } = fakes([], () => 0);
    transport.claim = vi.fn(async () => claims.shift() ?? null);
    const started: string[] = [];

    await expect(
      runAgentClaimLoop({
        transport,
        isDraining: async () => false,
        runJob: async (job) => {
          started.push(job.jobId);
          await (job.jobId === 'job-1' ? withBringupDeadline(10, () => staleBringup) : undefined);
        },
      }),
    ).rejects.toBeInstanceOf(RunnerBringupTimeoutError);

    expect(transport.claim).toHaveBeenCalledTimes(1);
    expect(started).toEqual(['job-1']);
    finishStaleBringup();
    await staleBringup;
    expect(transport.claim).toHaveBeenCalledTimes(1);
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

// A draining instance (pending EC2 Spot reclaim) must never claim fresh work —
// any job it picks up inside the 2-minute window is guaranteed to be lost
// mid-run, burning a retry generation and minutes of the run's wall clock.
describe('agentIsDraining (claim-loop Spot guard)', () => {
  it('reports draining once the IMDS probe sees a pending interruption', async () => {
    await expect(agentIsDraining(async () => true)).resolves.toBe(true);
  });

  it('reports healthy when no interruption is pending', async () => {
    await expect(agentIsDraining(async () => false)).resolves.toBe(false);
  });

  it('fails open to healthy on a probe error (off-EC2 / IMDS blip must not idle the fleet)', async () => {
    await expect(
      agentIsDraining(async () => {
        throw new Error('IMDS unreachable');
      }),
    ).resolves.toBe(false);
  });
});
