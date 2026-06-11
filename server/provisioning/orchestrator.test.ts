import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetJobsForTests,
  startProvisioningJob,
  subscribeToJob,
  snapshotEvents,
  plannedPhases,
  hasGithubIntegration,
  resolveTemplateForPayload,
  PROVISIONING_PHASE_IDS,
  type ProvisioningEvent,
  type ProvisioningExecutor,
  type ProvisioningPhaseId,
} from './orchestrator.js';

describe('hasGithubIntegration', () => {
  it('treats idk as opt-in so the happy path includes GitHub', () => {
    // Hosting choice gates everything: explicit GitHub hosting + idk
    // integrations still gets the repo…
    expect(hasGithubIntegration({ integrations: 'idk', hostOnAgentHub: false })).toBe(true);
    expect(hasGithubIntegration({ integrations: null, hostOnAgentHub: false })).toBe(true);
    expect(hasGithubIntegration({ hostOnAgentHub: false })).toBe(true);
    // …but Agent Hub hosting (the default, incl. unset) never does.
    expect(hasGithubIntegration({ integrations: 'idk' })).toBe(false);
    expect(hasGithubIntegration({ integrations: ['github'] })).toBe(false);
    expect(hasGithubIntegration({})).toBe(false);
  });

  it('respects an explicit array that omits github', () => {
    expect(hasGithubIntegration({ integrations: ['db', 'slack'] })).toBe(false);
  });

  it('includes gh when the array lists it', () => {
    expect(hasGithubIntegration({ integrations: ['github'], hostOnAgentHub: false })).toBe(true);
  });
});

describe('resolveTemplateForPayload', () => {
  it('routes stack:"idk" via the appType default (CLI → go-cobra)', () => {
    expect(resolveTemplateForPayload({ appType: 'cli', stack: 'idk' })).toBe('go-cobra');
  });

  it('honours an explicit known template id regardless of appType', () => {
    expect(resolveTemplateForPayload({ appType: 'api', stack: 'rust-axum' })).toBe('rust-axum');
  });

  it('falls back to the universal default when both fields are missing', () => {
    expect(resolveTemplateForPayload({})).toBe('typescript-node-tsx');
  });
});

describe('plannedPhases', () => {
  it('marks gh-* phases as skip when the user opted out of GitHub', () => {
    const plan = plannedPhases({ integrations: ['db'] });
    const skipped = plan.filter((p) => p.skip).map((p) => p.phase);
    expect(skipped).toEqual(['mint-token', 'gh-create', 'gh-push']);
  });

  it('marks nothing as skipped when the user kept GitHub in', () => {
    const plan = plannedPhases({ integrations: ['github', 'db'], hostOnAgentHub: false });
    expect(plan.every((p) => !p.skip)).toBe(true);
  });
});

interface CollectedEvents {
  events: ProvisioningEvent[];
  unsubscribe: (() => void) | null;
}

async function waitForDone(collector: CollectedEvents, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (collector.events.some((e) => e.type === 'done')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Timed out waiting for done event');
}

function collect(jobId: string): CollectedEvents {
  const collector: CollectedEvents = { events: [], unsubscribe: null };
  collector.unsubscribe = subscribeToJob(jobId, (ev) => {
    collector.events.push(ev);
  });
  return collector;
}

describe('orchestrator', () => {
  beforeEach(() => {
    _resetJobsForTests();
  });

  it('runs every phase happy-path and emits a terminal done with repoUrl', async () => {
    const phases: ProvisioningPhaseId[] = [];
    const executor: ProvisioningExecutor = {
      async runPhase(phase) {
        phases.push(phase);
        if (phase === 'gh-push') {
          return { status: 'ok', repoUrl: 'https://github.com/example/test' };
        }
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-1',
      payload: { description: 'a new thing', integrations: ['github'], hostOnAgentHub: false },
      projectId: 'proj-1',
      executor,
    });

    const c = collect('job-1');
    await waitForDone(c);

    expect(phases).toEqual([...PROVISIONING_PHASE_IDS]);

    const done = c.events.find((e) => e.type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      repoUrl: 'https://github.com/example/test',
    });
    expect((done as { error?: unknown }).error).toBeUndefined();

    // Every non-skipped phase should have a matching 'started' and 'ok'.
    for (const phase of PROVISIONING_PHASE_IDS) {
      const started = c.events.find(
        (e) => e.type === 'phase' && e.phase === phase && e.status === 'started',
      );
      const ok = c.events.find((e) => e.type === 'phase' && e.phase === phase && e.status === 'ok');
      expect(started, `missing started for ${phase}`).toBeDefined();
      expect(ok, `missing ok for ${phase}`).toBeDefined();
    }
  });

  it('skips gh-* phases when the user opted out of GitHub', async () => {
    const runCalls: ProvisioningPhaseId[] = [];
    const executor: ProvisioningExecutor = {
      async runPhase(phase) {
        runCalls.push(phase);
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-no-gh',
      payload: { description: 'local only', integrations: ['db'] },
      projectId: 'proj-2',
      executor,
    });

    const c = collect('job-no-gh');
    await waitForDone(c);

    // gh phases should not have been executed.
    expect(runCalls).not.toContain('mint-token');
    expect(runCalls).not.toContain('gh-create');
    expect(runCalls).not.toContain('gh-push');

    // They should appear as 'skipped' phase events.
    const skipped = c.events.filter(
      (e) => e.type === 'phase' && (e as { status?: string }).status === 'skipped',
    );
    expect(skipped.map((s) => (s as { phase?: string }).phase).sort()).toEqual(
      ['gh-create', 'gh-push', 'mint-token'].sort(),
    );

    const done = c.events.find((e) => e.type === 'done')!;
    expect((done as { error?: unknown }).error).toBeUndefined();
  });

  it('emits a failed done when an early phase errors', async () => {
    const executor: ProvisioningExecutor = {
      async runPhase(phase) {
        if (phase === 'mint-token') {
          return {
            status: 'failed',
            error: { code: -2, message: 'no app installation' },
          };
        }
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-fail-early',
      payload: { description: 'x', integrations: ['github'], hostOnAgentHub: false },
      projectId: 'proj-3',
      executor,
    });

    const c = collect('job-fail-early');
    await waitForDone(c);

    const done = c.events.find((e) => e.type === 'done') as {
      error?: { code: number };
      partial?: boolean;
    };
    expect(done.error?.code).toBe(-2);
    expect(done.partial).toBeUndefined();

    // Phases after the failure should NOT appear.
    const phaseEvents = c.events.filter((e) => e.type === 'phase') as Array<{
      phase: string;
      status: string;
    }>;
    expect(phaseEvents.some((p) => p.phase === 'copy-template')).toBe(false);
  });

  it('emits a partial done when gh-create fails after git-init succeeds', async () => {
    const executor: ProvisioningExecutor = {
      async runPhase(phase) {
        if (phase === 'gh-create') {
          return {
            status: 'failed',
            error: { code: 5, message: 'no admin perm' },
          };
        }
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-partial',
      payload: { description: 'x', integrations: ['github'], hostOnAgentHub: false },
      projectId: 'proj-4',
      executor,
    });

    const c = collect('job-partial');
    await waitForDone(c);

    const done = c.events.find((e) => e.type === 'done') as {
      error?: { code: number };
      partial?: boolean;
    };
    expect(done.partial).toBe(true);
    expect(done.error?.code).toBe(5);
  });

  it('replays buffered events to late subscribers', async () => {
    const executor: ProvisioningExecutor = {
      async runPhase() {
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-replay',
      payload: { description: 'x', integrations: ['db'] },
      projectId: 'proj-5',
      executor,
    });

    // Let the job finish before we subscribe.
    await new Promise((r) => setTimeout(r, 50));

    const events: ProvisioningEvent[] = [];
    const unsubscribe = subscribeToJob('job-replay', (ev) => events.push(ev));
    expect(unsubscribe).not.toBeNull();

    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(snapshotEvents('job-replay').length).toBe(events.length);
  });

  it('stamps every event with a monotonically increasing seq', async () => {
    const executor: ProvisioningExecutor = {
      async runPhase() {
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-seq',
      payload: { description: 'x', integrations: ['db'] },
      projectId: 'proj-seq',
      executor,
    });

    const c = collect('job-seq');
    await waitForDone(c);

    const seqs = c.events.map((e) => (e as { seq?: number }).seq);
    expect(seqs.every((s) => typeof s === 'number')).toBe(true);
    // Strictly monotonic from 0.
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(i);
    }
  });

  it('replays only events after `since` for a reconnecting subscriber', async () => {
    const executor: ProvisioningExecutor = {
      async runPhase() {
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-since',
      payload: { description: 'x', integrations: ['db'] },
      projectId: 'proj-since',
      executor,
    });

    // Let the orchestrator finish so the ring buffer is populated.
    await new Promise((r) => setTimeout(r, 50));

    const snap = snapshotEvents('job-since');
    expect(snap.length).toBeGreaterThan(3);
    // Subscribe with `since` pointing at the middle of the stream.
    const midSeq = (snap[Math.floor(snap.length / 2)] as { seq?: number }).seq!;
    const received: ProvisioningEvent[] = [];
    const unsubscribe = subscribeToJob('job-since', (ev) => received.push(ev), { since: midSeq });
    expect(unsubscribe).not.toBeNull();

    // Only strictly-newer events should have replayed.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(snap.length);
    for (const ev of received) {
      expect((ev as { seq?: number }).seq! > midSeq).toBe(true);
    }
    // And the terminal done must be present in the tail replay.
    expect(received.some((e) => e.type === 'done')).toBe(true);
  });

  it('replays all events when `since` is negative or unset', async () => {
    const executor: ProvisioningExecutor = {
      async runPhase() {
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-since-none',
      payload: { description: 'x', integrations: ['db'] },
      projectId: 'proj-sn',
      executor,
    });
    await new Promise((r) => setTimeout(r, 50));
    const all = snapshotEvents('job-since-none');

    const full: ProvisioningEvent[] = [];
    subscribeToJob('job-since-none', (ev) => full.push(ev));
    expect(full.length).toBe(all.length);

    const negative: ProvisioningEvent[] = [];
    subscribeToJob('job-since-none', (ev) => negative.push(ev), { since: -5 });
    expect(negative.length).toBe(all.length);
  });

  it('pipes executor log() calls into log events', async () => {
    const executor: ProvisioningExecutor = {
      async runPhase(phase, ctx) {
        ctx.log(`starting ${phase}`);
        return { status: 'ok' };
      },
    };

    startProvisioningJob({
      jobId: 'job-logs',
      payload: { description: 'x', integrations: ['db'] },
      projectId: 'proj-6',
      executor,
    });

    const c = collect('job-logs');
    await waitForDone(c);

    const logs = c.events.filter((e) => e.type === 'log') as Array<{ line: string }>;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.line).toMatch(/^starting /);
  });
});
