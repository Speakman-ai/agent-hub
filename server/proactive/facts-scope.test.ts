/**
 * Event (scoped) collection: the event's subject must be found even when more
 * unrelated facts exist than a snapshot's per-kind cap allows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import type { AppConfig, Project, Stmts } from '../types.js';
import type { InfraAlarmEvaluation } from '../infra/alert-evaluator.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb, getStmts, getDb } = await import('../db.js');
const { initInfraDb, closeInfraDb } = await import('../infra/infra-db.js');
const { createInfraAlertRule, recordInfraAlertEvaluation } =
  await import('../infra/alert-store.js');
const { setSessionOwner } = await import('../session-ownership.js');
const extra = await import('./facts-extra.js');
const { collectDevFacts } = await import('./facts.js');
const check = await import('./check.js');
const { normalizeProactivePrefs } = await import('../../shared/utils/serverAgentProactive.js');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
let dir = '';
let userId = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'proactive-scope-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  initInfraDb(dir);
  userId = createUser({
    username: `s-${Math.random().toString(36).slice(2)}`,
    passwordHash: 'x',
  }).id;
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function alarm(projectId: string, severity: 'critical' | 'warning'): string {
  const rule = createInfraAlertRule(
    projectId,
    {
      name: `CPU ${projectId}`,
      service: 'ec2',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      stat: 'Average',
      periodS: 300,
      threshold: 90,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 3,
      severity,
    },
    NOW,
  );
  const evaluation: InfraAlarmEvaluation = {
    state: 'ALARM',
    previousState: 'OK',
    transitioned: true,
    reason: 'datapoints_breached',
    evaluatedAtMs: NOW,
    realDatapoints: 3,
    filledDatapoints: 0,
    breachingDatapoints: 3,
  } as InfraAlarmEvaluation;
  const res = recordInfraAlertEvaluation({
    projectId,
    ruleId: rule.id,
    resourceKey: `${projectId}|123456789012|us-east-2|ec2|i-0abc`,
    evaluation,
    observedAtMs: NOW,
    value: 95,
    nowMs: NOW,
  });
  return res.alert!.id;
}

describe('scoped infra alert collection', () => {
  const projects: Project[] = Array.from({ length: 12 }, (_, i) => ({
    id: `p${String(i).padStart(2, '0')}`,
    name: `Project ${i}`,
  })) as Project[];
  const caller = { userId: null, localBypass: true };

  it('finds the triggering alert behind more unrelated alarms than the snapshot cap', async () => {
    for (const p of projects.slice(0, 11)) alarm(p.id, 'warning');
    const target = alarm(projects[11].id, 'critical');

    const snapshot = extra.collectInfraAlertFacts({ caller, getProjects: () => projects });
    expect(snapshot.length).toBeLessThan(12);
    expect(snapshot.some((f) => f.target.alertId === target)).toBe(false);

    const match = (f: { kind: string; target: { alertId?: string } }) =>
      f.kind === 'infra_alert' && f.target.alertId === target;
    const scoped = extra.collectInfraAlertFacts({ caller, getProjects: () => projects, match });
    expect(scoped.map((f) => f.target.alertId)).toEqual([target]);

    // End to end through an event-scoped check: the model sees exactly that alert.
    const classify = vi.fn(async () => []);
    await check.runProactiveCheck(
      userId,
      normalizeProactivePrefs({ enabled: true, quietHours: { enabled: false } }),
      {
        config: {} as AppConfig,
        stmts: getStmts() as Stmts,
        broadcast: vi.fn(),
        getProjects: () => projects,
        collectors: {
          infra: ({ match: m }) =>
            extra.collectInfraAlertFacts({ caller, getProjects: () => projects, match: m }),
        },
        classify,
        now: () => new Date(NOW),
      },
      { source: 'event', scope: { area: 'infra', matches: match as never } },
    );
    expect(classify).toHaveBeenCalledTimes(1);
    const sent = (classify.mock.calls[0] as unknown[])[1] as Array<{
      target: { alertId?: string };
    }>;
    expect(sent.map((f) => f.target.alertId)).toEqual([target]);
  });
});

describe('scoped dev collection', () => {
  it('finds a failed Finalize session behind more recent failures than the snapshot cap', () => {
    const insert = getDb().prepare(
      `INSERT INTO finalize_runs (id, card_id, session_id, project_id, branch, head_sha,
         idempotency_key, status, trigger_source, triggered_by_user_id, author_name, author_email,
         started_at)
       VALUES (?, '', ?, 'proj', 'b', 'sha', ?, 'failed', 'manual', ?, 'a', 'a@x', ?)`,
    );
    for (let i = 0; i < 15; i++) {
      const sid = `s${i}`;
      getStmts().createSession.run(sid, 'agent-x', `Session ${i}`, 'claude-code', 'm', 0, 0, 1);
      setSessionOwner(sid, userId);
      // s0 is the oldest failure, so a capped snapshot drops it.
      insert.run(`r${i}`, sid, `idem-${i}`, userId, NOW - (15 - i) * 60_000);
    }
    const deps = {
      userId,
      caller: { userId, localBypass: true },
      getProjects: () => [],
      stmts: getStmts() as Stmts,
      now: new Date(NOW),
    };
    const snapshot = collectDevFacts(deps).filter((f) => f.kind === 'finalize_failed');
    expect(snapshot.some((f) => f.target.sessionId === 's0')).toBe(false);
    const scoped = collectDevFacts({
      ...deps,
      match: (f) => f.kind === 'finalize_failed' && f.target.sessionId === 's0',
    });
    expect(scoped.map((f) => f.target.sessionId)).toEqual(['s0']);
  });
});
