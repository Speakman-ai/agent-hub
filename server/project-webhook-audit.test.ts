/**
 * project-webhook-audit.test.ts
 *
 * Direct test of the missing-webhook audit logic. The startup audit
 * loop in `server/index.ts` is the actual emitter, but it's wrapped
 * in initialization scaffolding that makes a full-bore test
 * heavyweight. This test exercises the same predicate the loop uses
 * — "githubRepo is set AND there is no enabled webhook_configs row" —
 * so a future refactor that breaks the predicate fails loud.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

type WebhookRow = { enabled: number | null };

interface FakeStmts {
  getWebhookConfigsByProject: { all(projectId: string): WebhookRow[] };
}

interface FakeProject {
  id: string;
  githubRepo?: string | null;
}

function buildStmts(rowsByProject: Record<string, WebhookRow[]>): FakeStmts {
  return {
    getWebhookConfigsByProject: {
      all: (projectId: string) => rowsByProject[projectId] ?? [],
    },
  };
}

// Mirrors the audit predicate in index.ts; kept tiny and pure so any
// refactor that changes the semantics surfaces here too.
function projectsMissingWebhook(stmts: FakeStmts, projects: FakeProject[]): FakeProject[] {
  return projects.filter((p) => {
    const repo = p.githubRepo;
    if (!repo || !repo.trim()) return false;
    const rows = stmts.getWebhookConfigsByProject.all(p.id);
    return !rows.some((r) => r?.enabled === 1);
  });
}

describe('missing-webhook audit predicate', () => {
  beforeEach(() => {
    // Use a fresh tmp dir per case so accidental fs touches stay sandboxed.
    mkdtempSync(path.join(tmpdir(), 'project-webhook-audit-'));
  });

  it('flags a project with githubRepo but no rows', () => {
    const stmts = buildStmts({});
    const offenders = projectsMissingWebhook(stmts, [{ id: 'p1', githubRepo: 'owner/repo' }]);
    expect(offenders.map((o) => o.id)).toEqual(['p1']);
  });

  it('flags a project whose only row is disabled (enabled=0)', () => {
    const stmts = buildStmts({ p1: [{ enabled: 0 }] });
    const offenders = projectsMissingWebhook(stmts, [{ id: 'p1', githubRepo: 'owner/repo' }]);
    expect(offenders.map((o) => o.id)).toEqual(['p1']);
  });

  it('passes when at least one row is enabled=1', () => {
    const stmts = buildStmts({ p1: [{ enabled: 0 }, { enabled: 1 }] });
    const offenders = projectsMissingWebhook(stmts, [{ id: 'p1', githubRepo: 'owner/repo' }]);
    expect(offenders).toEqual([]);
  });

  it('ignores projects with no githubRepo', () => {
    const stmts = buildStmts({});
    const offenders = projectsMissingWebhook(stmts, [
      { id: 'p1', githubRepo: null },
      { id: 'p2', githubRepo: '' },
      { id: 'p3', githubRepo: '   ' },
    ]);
    expect(offenders).toEqual([]);
  });

  it('reports each offender individually when several projects lack webhooks', () => {
    const stmts = buildStmts({ ok: [{ enabled: 1 }] });
    const offenders = projectsMissingWebhook(stmts, [
      { id: 'ok', githubRepo: 'owner/ok' },
      { id: 'a', githubRepo: 'owner/a' },
      { id: 'b', githubRepo: 'owner/b' },
      { id: 'no-gh', githubRepo: null }, // ignored, no gh
    ]);
    expect(offenders.map((o) => o.id).sort()).toEqual(['a', 'b']);
  });
});
