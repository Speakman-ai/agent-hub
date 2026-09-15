import { describe, it, expect } from 'vitest';
import {
  AUTOPILOT_JOURNAL_SLUG,
  AUTOPILOT_RUNBOOK_SLUG,
  buildDocumentationPages,
  buildStructuredCycleRecord,
  classifyCycleKind,
  createMemoryDocumentPort,
  kindLabel,
  parseCycleDocumentation,
  reconstructHandoff,
  redactAutopilotValue,
  redactCycleRecord,
  renderHandoffPrompt,
  renderJournalMarkdown,
  renderRunbookMarkdown,
  autopilotPublicationIdentity,
  stableAutopilotArtifactId,
  type AutopilotStructuredCycleRecord,
} from './document.js';
import type { AutopilotCycleRecord, AutopilotUsage } from './types.js';

const USAGE: AutopilotUsage = { wallTimeMs: 12000, costUsd: null, costAvailable: false };

function cycle(
  partial: Partial<AutopilotCycleRecord> & Pick<AutopilotCycleRecord, 'id'>,
): AutopilotCycleRecord {
  return {
    runId: 'run-1',
    cycleNumber: 1,
    briefRevision: 3,
    specRevision: 3,
    cardId: 'card-1',
    sessionId: 'sess-1',
    testedCommitSha: 'deadbeefcafe',
    finalizeRunId: 'fin-1',
    deploymentId: 'dep-1',
    verification: {
      judgement: { ok: true, sha: 'deadbeefcafe' },
      evidence: {
        expectedSha: 'deadbeefcafe',
        observedSha: 'deadbeefcafe',
        origin: 'http://127.0.0.1:4310',
        capturedAt: '2026-09-15T00:00:00.000Z',
        criteria: [
          {
            criterionId: 'baseline-1',
            passed: true,
            kind: 'browser_journey',
            screenshotPath: '/tmp/eval/list.png',
            tracePath: '/tmp/eval/list.trace',
          },
        ],
      },
    },
    documentation: null,
    selectedImprovement: null,
    outcome: null,
    status: 'active',
    createdAt: '2026-09-15T00:00:00.000Z',
    ...partial,
  };
}

const SPEC = {
  acceptanceJourneys: [{ action: 'create a todo', expectedResult: 'it appears in the list' }],
  nonGoals: ['auth'],
  specDecisions: [{ key: 'storage', decision: 'in-memory sqlite' }],
  storageRecovery: 'disposable',
};

describe('autopilot cycle documentation', () => {
  it('builds a structured cycle record with links, usage, evidence, and outcome', () => {
    const record = buildStructuredCycleRecord({
      runId: 'run-1',
      cycle: cycle({
        id: 'cyc-1',
        selectedImprovement: 'Users can add a todo from the list page.',
      }),
      spec: SPEC,
      usage: USAGE,
      origin: 'http://127.0.0.1:4310',
      failedAttempts: [
        { operationId: 'eval-fail', reason: 'health_only', detail: 'HTTP health is not proof' },
      ],
      documentedAt: '2026-09-15T01:00:00.000Z',
    });
    expect(record.kind).toBe('success');
    expect(record.briefRevision).toBe(3);
    expect(record.specRevision).toBe(3);
    expect(record.expectedBenefit).toContain('add a todo');
    expect(record.actualChange).toContain('Users can add a todo');
    expect(record.actualChange).toContain('deadbeefcafe');
    expect(record.actualChange).toContain('Verified at http://127.0.0.1:4310');
    expect(record.links).toMatchObject({
      cardId: 'card-1',
      sessionId: 'sess-1',
      testedCommitSha: 'deadbeefcafe',
      finalizeRunId: 'fin-1',
      deploymentId: 'dep-1',
      deploymentOrigin: 'http://127.0.0.1:4310',
    });
    expect(record.evidence.some((e) => e.kind === 'screenshot')).toBe(true);
    expect(record.usage).toEqual(USAGE);
    expect(record.outcome).toBe('verified');
    expect(record.failedAttempts).toHaveLength(1);
    expect(record.nextAction).toBe('selecting-next');
  });

  it('labels successful behavior, proposals, and failures as distinct kinds', () => {
    expect(classifyCycleKind(cycle({ id: 'ok' }))).toBe('success');
    expect(
      classifyCycleKind(
        cycle({
          id: 'prop',
          verification: {
            judgement: { ok: false, reason: 'no_benefit', detail: 'no delta', recover: false },
          },
          selectedImprovement: 'Add dark mode',
          status: 'active',
        }),
      ),
    ).toBe('proposal');
    expect(
      classifyCycleKind(
        cycle({
          id: 'fail',
          verification: {
            judgement: { ok: false, reason: 'health_only', detail: 'health', recover: true },
          },
          selectedImprovement: null,
          testedCommitSha: null,
        }),
      ),
    ).toBe('failure');
    const journal = renderJournalMarkdown([
      buildStructuredCycleRecord({
        runId: 'run-1',
        cycle: cycle({ id: 'ok' }),
        spec: SPEC,
        usage: USAGE,
        origin: 'http://127.0.0.1:4310',
        failedAttempts: [],
        documentedAt: 't',
      }),
    ]);
    expect(journal).toContain('successful behavior');
    expect(journal).not.toMatch(/proposal as current/i);
    const pages = buildDocumentationPages({
      lastVerifiedSha: 'deadbeefcafe',
      lastDeploymentId: 'dep-1',
      origin: 'http://127.0.0.1:4310',
      records: [
        buildStructuredCycleRecord({
          runId: 'run-1',
          cycle: cycle({ id: 'ok' }),
          spec: SPEC,
          usage: USAGE,
          origin: 'http://127.0.0.1:4310',
          failedAttempts: [],
          documentedAt: 't',
        }),
      ],
    });
    expect(pages.map((p) => p.slug)).toEqual([AUTOPILOT_JOURNAL_SLUG, AUTOPILOT_RUNBOOK_SLUG]);
    expect(pages[1]!.content).toContain('Current last-known-good');
    expect(kindLabel('proposal')).toBe('proposal');
    expect(kindLabel('failure')).toBe('failure');
  });

  it('does not treat a prior-run success as current when last-known-good is unset', () => {
    const prior = buildStructuredCycleRecord({
      runId: 'run-old',
      cycle: cycle({
        id: 'cyc-old',
        runId: 'run-old',
        testedCommitSha: 'oldshaoldsha01',
        deploymentId: 'dep-old',
        selectedImprovement: 'Users could list todos on the prior run.',
      }),
      spec: SPEC,
      usage: USAGE,
      origin: 'http://127.0.0.1:4310',
      failedAttempts: [],
      documentedAt: 't-old',
    });
    const current = buildStructuredCycleRecord({
      runId: 'run-new',
      cycle: cycle({
        id: 'cyc-new',
        runId: 'run-new',
        testedCommitSha: null,
        deploymentId: null,
        selectedImprovement: null,
        verification: {
          judgement: { ok: false, reason: 'health_only', detail: 'health', recover: true },
        },
      }),
      spec: SPEC,
      usage: USAGE,
      origin: 'http://127.0.0.1:4310',
      failedAttempts: [],
      documentedAt: 't-new',
    });
    const runbook = renderRunbookMarkdown({
      lastVerifiedSha: null,
      lastDeploymentId: null,
      origin: null,
      records: [prior, current],
    });
    expect(runbook).toMatch(/\*\*Last verified SHA:\*\* none/);
    expect(runbook).toMatch(/\*\*Last verified deployment:\*\* none/);
    expect(runbook).toContain('_No verified cycle yet._');
    expect(runbook).not.toContain('## Current verified behavior');
    expect(runbook).toContain('## Earlier successes');
    expect(runbook).toContain('Users could list todos on the prior run.');
  });

  it('describes delivered behavior and does not claim verification for a failed judgement', () => {
    const failed = buildStructuredCycleRecord({
      runId: 'run-1',
      cycle: cycle({
        id: 'fail-sha',
        selectedImprovement: 'Users can filter todos.',
        verification: {
          judgement: { ok: false, reason: 'health_only', detail: 'health', recover: true },
        },
      }),
      spec: SPEC,
      usage: USAGE,
      origin: 'http://127.0.0.1:4310',
      failedAttempts: [{ operationId: 'eval-1', reason: 'evaluate: health_only' }],
      documentedAt: 't',
    });
    expect(failed.kind).toBe('failure');
    expect(failed.actualChange).toContain('Users can filter todos');
    expect(failed.actualChange).toContain('Merged deadbeefcafe');
    expect(failed.actualChange).toContain('Not verified (health_only)');
    expect(failed.actualChange).not.toMatch(/Verified at/);
  });

  it('redacts secrets from records while keeping session ids and SHAs', () => {
    const dirty = {
      sessionId: 'sess-keep-me',
      testedCommitSha: 'deadbeefcafe',
      apiKey: 'sk_live_abcdefghijklmnopqrstuv',
      authorization: 'Bearer abc123DEFtoken456xyz',
      note: 'Authorization: Bearer abc123DEFtoken456xyz leaked',
      nested: { password: 'hunter2-secret' },
    };
    const { value, redactions } = redactAutopilotValue(dirty);
    const redacted = value as typeof dirty;
    expect(redactions).toBeGreaterThan(0);
    expect(redacted.sessionId).toBe('sess-keep-me');
    expect(redacted.testedCommitSha).toBe('deadbeefcafe');
    expect(JSON.stringify(redacted)).not.toContain('sk_live_abcdefghijklmnopqrstuv');
    expect(JSON.stringify(redacted)).not.toContain('abc123DEFtoken456xyz');
    expect(JSON.stringify(redacted)).not.toContain('hunter2-secret');
    expect(JSON.stringify(redacted)).toContain('[redacted]');

    const record = redactCycleRecord(
      buildStructuredCycleRecord({
        runId: 'run-1',
        cycle: cycle({
          id: 'cyc-1',
          selectedImprovement: `Ship with Authorization: Bearer abc123DEFtoken456xyz`,
        }),
        spec: SPEC,
        usage: USAGE,
        origin: 'http://127.0.0.1:4310',
        failedAttempts: [],
        documentedAt: 't',
      }),
    );
    expect(record.links.sessionId).toBe('sess-1');
    expect(record.expectedBenefit).not.toContain('abc123DEFtoken456xyz');
    expect(record.redactions).toBeGreaterThan(0);
  });

  it('reconstructs the next session handoff from saved cycle records after a restart', () => {
    const first = buildStructuredCycleRecord({
      runId: 'run-1',
      cycle: cycle({ id: 'cyc-1' }),
      spec: SPEC,
      usage: USAGE,
      origin: 'http://127.0.0.1:4310',
      failedAttempts: [{ operationId: 'eval-0', reason: 'health_only' }],
      documentedAt: 't1',
    });
    const saved: AutopilotCycleRecord = cycle({
      id: 'cyc-1',
      documentation: first as unknown as AutopilotStructuredCycleRecord,
    });
    const empty = cycle({
      id: 'cyc-2',
      cycleNumber: 2,
      documentation: null,
      testedCommitSha: null,
    });
    const handoff = reconstructHandoff({
      cycles: [saved, empty],
      spec: SPEC,
      lastVerifiedSha: 'deadbeefcafe',
      lastDeploymentId: 'dep-1',
    });
    expect(handoff.lastSuccessfulCycle?.cycleId).toBe('cyc-1');
    expect(handoff.records).toHaveLength(1);
    expect(handoff.lastVerifiedSha).toBe('deadbeefcafe');
    expect(handoff.specDecisions).toEqual(SPEC.specDecisions);
    expect(handoff.acceptanceJourneys).toEqual(SPEC.acceptanceJourneys);
    const prompt = renderHandoffPrompt(handoff);
    expect(prompt).toContain('deadbeefcafe');
    expect(prompt).toContain('successful behavior');
    expect(prompt).toContain('in-memory sqlite');
    expect(prompt).toContain('Do not treat proposals or failures as current verified behavior');
    expect(parseCycleDocumentation(saved.documentation)?.cycleId).toBe('cyc-1');
  });

  it('does not treat a prior success as last successful behavior without last-known-good', () => {
    const prior = buildStructuredCycleRecord({
      runId: 'run-old',
      cycle: cycle({
        id: 'cyc-old',
        runId: 'run-old',
        testedCommitSha: 'oldshaoldsha01',
        deploymentId: 'dep-old',
        selectedImprovement: 'Users could list todos on the prior run.',
      }),
      spec: SPEC,
      usage: USAGE,
      origin: 'http://127.0.0.1:4310',
      failedAttempts: [],
      documentedAt: 't-old',
    });
    const saved: AutopilotCycleRecord = cycle({
      id: 'cyc-old',
      runId: 'run-old',
      documentation: prior as unknown as AutopilotStructuredCycleRecord,
    });
    const handoff = reconstructHandoff({
      cycles: [saved],
      spec: SPEC,
      lastVerifiedSha: null,
      lastDeploymentId: null,
    });
    expect(handoff.lastSuccessfulCycle).toBeNull();
    expect(handoff.records).toHaveLength(1);
    expect(handoff.records[0]?.kind).toBe('success');
    expect(renderHandoffPrompt(handoff)).not.toContain('Last successful behavior:');
  });

  it('mints a stable artifact id from cycle id and key', () => {
    const a = stableAutopilotArtifactId('cyc-1', 'record.json');
    const b = stableAutopilotArtifactId('cyc-1', 'record.json');
    const c = stableAutopilotArtifactId('cyc-1', 'evaluation.json');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('scopes memory-port publication by cycle and key so retries reuse each cycle own artifact', async () => {
    const port = createMemoryDocumentPort();
    const publish = (cycleId: string, body: string) =>
      port.publishArtifact({
        sessionId: 'sess-1',
        cycleId,
        key: 'record.json',
        filename: `${cycleId}-record.json`,
        contentType: 'application/json',
        body,
      });
    const first = await publish('cyc-1', '{"cycle":1}');
    const second = await publish('cyc-2', '{"cycle":2}');
    expect(first.artifactId).toBe(stableAutopilotArtifactId('cyc-1', 'record.json'));
    expect(second.artifactId).toBe(stableAutopilotArtifactId('cyc-2', 'record.json'));
    expect(first.artifactId).not.toBe(second.artifactId);
    expect(port.artifacts.map((a) => a.body)).toEqual(['{"cycle":1}', '{"cycle":2}']);
    const retryFirst = await publish('cyc-1', '{"cycle":1-retry}');
    const retrySecond = await publish('cyc-2', '{"cycle":2-retry}');
    expect(retryFirst.artifactId).toBe(first.artifactId);
    expect(retrySecond.artifactId).toBe(second.artifactId);
    expect(port.artifactPublishes).toBe(2);
    expect(port.publishCounts[autopilotPublicationIdentity('cyc-1', 'record.json')]).toBe(2);
    expect(port.publishCounts[autopilotPublicationIdentity('cyc-2', 'record.json')]).toBe(2);
  });
});
