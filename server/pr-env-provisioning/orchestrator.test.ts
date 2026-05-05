import { describe, it, expect, beforeEach } from 'vitest';
import {
  PR_ENV_PHASE_IDS,
  _resetJobsForTests,
  startProvisionJob,
  snapshotEvents,
  isJobFinished,
  lastFinishedSummary,
  plannedPhases,
  stubExecutor,
  subscribeToJob,
  type PrEnvExecutor,
  type ExecutorPhaseResult,
  type PrEnvProvisionEvent,
  type PrEnvPhaseId,
  type RemediationCard,
} from './orchestrator.js';

const PAYLOAD = {
  previewHost: 'preview.example.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
  repoFullName: 'acme/widgets',
};

/** Wait until the orchestrator has appended a `done` event for `jobId`. */
async function waitForDone(jobId: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isJobFinished(jobId)) {
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  _resetJobsForTests();
});

describe('plannedPhases', () => {
  it('returns the frozen V1 phase list in order, no skips by default', () => {
    const planned = plannedPhases(PAYLOAD);
    expect(planned.map((p) => p.phase)).toEqual([...PR_ENV_PHASE_IDS]);
    expect(planned.every((p) => !p.skip)).toBe(true);
  });

  it('skips write-tier3-config when dryRun is set', () => {
    const planned = plannedPhases({ ...PAYLOAD, dryRun: true });
    const tier3 = planned.find((p) => p.phase === 'write-tier3-config');
    expect(tier3?.skip).toBe(true);
    // No other phase is skipped by dryRun.
    const otherSkips = planned.filter((p) => p.phase !== 'write-tier3-config' && p.skip);
    expect(otherSkips).toEqual([]);
  });
});

describe('startProvisionJob — input validation', () => {
  it('throws on duplicate jobId', () => {
    startProvisionJob({ jobId: 'dup', payload: PAYLOAD, executor: stubExecutor });
    expect(() =>
      startProvisionJob({ jobId: 'dup', payload: PAYLOAD, executor: stubExecutor }),
    ).toThrow(/already exists/);
  });

  it.each([
    ['previewHost', { ...PAYLOAD, previewHost: '' }],
    ['hostedZoneId', { ...PAYLOAD, hostedZoneId: '   ' }],
    ['repoFullName', { ...PAYLOAD, repoFullName: '' }],
  ])('throws when %s is empty/whitespace', (field, payload) => {
    expect(() =>
      startProvisionJob({ jobId: `bad-${field}`, payload, executor: stubExecutor }),
    ).toThrow(new RegExp(`${field} is required`));
  });
});

describe('happy path — stub executor', () => {
  it('runs every phase to ok and finishes with outcome=ok', async () => {
    startProvisionJob({ jobId: 'happy', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('happy');

    const events = snapshotEvents('happy');
    const phaseEvents = events.filter((e) => e.type === 'phase');

    // Two phase events per phase (started + ok), in order.
    expect(phaseEvents).toHaveLength(PR_ENV_PHASE_IDS.length * 2);
    for (let i = 0; i < PR_ENV_PHASE_IDS.length; i++) {
      const started = phaseEvents[i * 2];
      const finished = phaseEvents[i * 2 + 1];
      expect(started).toMatchObject({ phase: PR_ENV_PHASE_IDS[i], status: 'started' });
      expect(finished).toMatchObject({ phase: PR_ENV_PHASE_IDS[i], status: 'ok' });
    }

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect(done && 'outcome' in done && done.outcome).toBe('ok');
  });

  it('assigns monotonically increasing seq ids across the whole job', async () => {
    startProvisionJob({ jobId: 'seq', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('seq');

    const seqs = snapshotEvents('seq').map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it('emits phase=skipped for write-tier3-config when dryRun is set', async () => {
    startProvisionJob({
      jobId: 'dry',
      payload: { ...PAYLOAD, dryRun: true },
      executor: stubExecutor,
    });
    await waitForDone('dry');

    const skipped = snapshotEvents('dry').find(
      (e) => e.type === 'phase' && e.phase === 'write-tier3-config',
    );
    expect(skipped).toMatchObject({ status: 'skipped' });

    // Skipped is a terminal-OK status — overall outcome stays ok.
    const done = snapshotEvents('dry').at(-1);
    expect(done && 'outcome' in done && done.outcome).toBe('ok');
  });
});

describe('failure modes', () => {
  it('halts the sequence on the first failed phase and emits done.outcome=error', async () => {
    const calls: PrEnvPhaseId[] = [];
    const exec: PrEnvExecutor = {
      async runPhase(phase) {
        calls.push(phase);
        if (phase === 'issue-cert') {
          return {
            status: 'failed',
            message: 'certbot exited 1',
            error: { code: 1, message: 'certbot exited 1', hint: 'check Route 53 perms' },
          };
        }
        return { status: 'ok' };
      },
    };

    startProvisionJob({ jobId: 'cert-fail', payload: PAYLOAD, executor: exec });
    await waitForDone('cert-fail');

    // executor only saw phases up to & including the failing one.
    expect(calls).toEqual(['detect-host', 'write-tier3-config', 'issue-cert']);

    const done = snapshotEvents('cert-fail').at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.outcome).toBe('error');
    expect(done.error).toMatchObject({ code: 1, message: 'certbot exited 1' });
  });

  it('converts an executor throw into done.outcome=error', async () => {
    const exec: PrEnvExecutor = {
      async runPhase(phase) {
        if (phase === 'detect-host') throw new Error('probe blew up');
        return { status: 'ok' };
      },
    };

    startProvisionJob({ jobId: 'throw', payload: PAYLOAD, executor: exec });
    await waitForDone('throw');

    const events = snapshotEvents('throw');
    const failed = events.find((e) => e.type === 'phase' && e.status === 'failed');
    expect(failed).toMatchObject({ phase: 'detect-host', message: 'probe blew up' });

    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.outcome).toBe('error');
    expect(done.error?.message).toBe('probe blew up');
  });
});

describe('verify remediations downgrade ok → partial', () => {
  it('attaches verify remediations to done.remediations when verify reports them', async () => {
    const remediations: RemediationCard[] = [
      {
        check: 'route53',
        severity: 'amber',
        headline: 'Attach IAM policy to ryan-ec2-ssm',
        actions: [{ label: 'Copy CLI', kind: 'copy', payload: 'aws iam put-role-policy …' }],
      },
    ];
    const exec: PrEnvExecutor = {
      async runPhase(phase): Promise<ExecutorPhaseResult> {
        if (phase === 'verify') return { status: 'ok', remediations };
        return { status: 'ok' };
      },
    };

    startProvisionJob({ jobId: 'partial', payload: PAYLOAD, executor: exec });
    await waitForDone('partial');

    const done = snapshotEvents('partial').at(-1);
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.outcome).toBe('partial');
    expect(done.remediations).toEqual(remediations);
  });

  it('ignores remediations attached to non-verify phases', async () => {
    // Defends the contract: only verify can downgrade the run. A
    // mis-attached remediation on detect-host should NOT change outcome.
    const exec: PrEnvExecutor = {
      async runPhase(phase): Promise<ExecutorPhaseResult> {
        if (phase === 'detect-host') {
          return {
            status: 'ok',
            remediations: [
              {
                check: 'docker',
                severity: 'red',
                headline: 'should be ignored',
                actions: [],
              },
            ],
          };
        }
        return { status: 'ok' };
      },
    };

    startProvisionJob({ jobId: 'misattached', payload: PAYLOAD, executor: exec });
    await waitForDone('misattached');

    const done = snapshotEvents('misattached').at(-1);
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.outcome).toBe('ok');
    expect(done.remediations).toBeUndefined();
  });
});

describe('subscribers — replay + live tail + since=', () => {
  it('replays every event to a late subscriber after job finishes', async () => {
    startProvisionJob({ jobId: 'replay', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('replay');

    const seen: PrEnvProvisionEvent[] = [];
    const unsub = subscribeToJob('replay', (ev) => seen.push(ev));
    expect(unsub).not.toBeNull();
    expect(seen.length).toBe(snapshotEvents('replay').length);
    unsub?.();
  });

  it('honours the since= seq filter on replay', async () => {
    startProvisionJob({ jobId: 'since', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('since');

    const all = snapshotEvents('since');
    const cutoff = all[2]!.seq!;

    const seen: PrEnvProvisionEvent[] = [];
    subscribeToJob('since', (ev) => seen.push(ev), { since: cutoff });

    expect(seen.every((ev) => (ev.seq ?? -1) > cutoff)).toBe(true);
    expect(seen.length).toBe(all.length - (cutoff + 1));
  });

  it('live-tails events appended after subscribe', async () => {
    // Block one phase so we can attach a subscriber mid-run.
    let releaseDetect: () => void = () => {};
    const detectGate = new Promise<void>((res) => (releaseDetect = res));
    const exec: PrEnvExecutor = {
      async runPhase(phase) {
        if (phase === 'detect-host') await detectGate;
        return { status: 'ok' };
      },
    };

    startProvisionJob({ jobId: 'live', payload: PAYLOAD, executor: exec });

    const seen: PrEnvProvisionEvent[] = [];
    const unsub = subscribeToJob('live', (ev) => seen.push(ev));
    expect(unsub).not.toBeNull();

    releaseDetect();
    await waitForDone('live');

    // Subscriber received the terminal done event via live tail.
    expect(seen.at(-1)?.type).toBe('done');
    unsub?.();
  });

  it('returns null for an unknown jobId', () => {
    expect(subscribeToJob('missing', () => undefined)).toBeNull();
  });
});

describe('lastFinishedSummary', () => {
  it('reflects the most-recently finished job', async () => {
    startProvisionJob({ jobId: 'first', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('first');
    startProvisionJob({ jobId: 'second', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('second');

    const summary = lastFinishedSummary();
    expect(summary?.jobId).toBe('second');
    expect(summary?.outcome).toBe('ok');
    expect(typeof summary?.finishedAt).toBe('string');
  });

  it('returns null before any job has finished', () => {
    expect(lastFinishedSummary()).toBeNull();
  });
});
