import '../test/setup.js';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { buildSecurityCardContent, generateSecurityCard } from './card-generation.js';
import type { SecurityFindingRow } from './findings-store.js';
import { getRequest, createProject } from '../test/helpers.js';
import type supertest from 'supertest';

function row(overrides: Partial<SecurityFindingRow>): SecurityFindingRow {
  return {
    id: overrides.id ?? 'f1',
    project_id: overrides.project_id ?? 'p1',
    ecosystem: 'npm',
    package_name: overrides.package_name ?? 'lodash',
    package_version: overrides.package_version ?? '4.17.11',
    advisory_id: overrides.advisory_id ?? 'GHSA-a',
    severity: overrides.severity ?? 'high',
    summary: overrides.summary ?? 'Prototype pollution',
    fixed_version: overrides.fixed_version ?? '4.17.21',
    advisory_url: overrides.advisory_url ?? 'https://example.com/a',
    manifest_path: overrides.manifest_path ?? 'package-lock.json',
    status: 'open',
    first_seen_at: 1,
    last_seen_at: 1,
    scan_ref: 'main',
    last_scan_id: 'scan-1',
    ...overrides,
  };
}

describe('buildSecurityCardContent', () => {
  it('summarises the severity breakdown in the title and tags priority high for critical', () => {
    const { title, description, priority } = buildSecurityCardContent([
      row({ id: '1', severity: 'critical' }),
      row({ id: '2', severity: 'high', package_name: 'express' }),
      row({ id: '3', severity: 'high', package_name: 'minimist' }),
    ]);
    expect(title).toBe('[security] 3 vulnerable dependencies (1 critical, 2 high)');
    expect(priority).toBe('high');
    // Critical sorted first; bump suggestion + advisory link present.
    expect(description).toContain('**CRITICAL** `lodash@4.17.11` → bump to `4.17.21`');
    expect(description).toContain('([GHSA-a](https://example.com/a))');
  });

  it('uses the singular noun and notes when no fix is published', () => {
    const { title, description } = buildSecurityCardContent([
      row({ severity: 'medium', fixed_version: null }),
    ]);
    expect(title).toBe('[security] 1 vulnerable dependency (1 medium)');
    expect(description).toContain('(no fix published)');
  });
});

describe('generateSecurityCard', () => {
  let request: supertest.Agent;
  let getStmts: typeof import('../db.js').getStmts;

  beforeAll(async () => {
    request = await getRequest();
    ({ getStmts } = await import('../db.js'));
  });

  it('is a no-op when there are no new findings', () => {
    const result = generateSecurityCard(
      { stmts: getStmts(), broadcast: vi.fn() },
      { projectId: 'whatever', newFindings: [] },
    );
    expect(result).toEqual({ card: null, created: false });
  });

  it('creates a To Do card labelled security on the project board', async () => {
    const project = (await createProject()) as { id: string };
    const broadcast = vi.fn();
    const result = generateSecurityCard(
      { stmts: getStmts(), broadcast },
      {
        projectId: project.id,
        newFindings: [row({ project_id: project.id, severity: 'critical' })],
      },
    );
    expect(result.created).toBe(true);
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: project.id });

    const board = await request.get(`/api/projects/${project.id}/board`).expect(200);
    const body = board.body as {
      columns: Array<{ id: string; name: string }>;
      cards: Array<{
        id: string;
        title: string;
        labels: string;
        column_id: string;
        priority: string;
      }>;
    };
    const card = body.cards.find((c) => c.id === result.card?.id);
    expect(card).toBeTruthy();
    expect(card?.title).toContain('[security]');
    expect(card?.labels).toBe('security,dependencies');
    expect(card?.priority).toBe('high');
    const todo = body.columns.find((c) => c.name.toLowerCase() === 'to do');
    expect(card?.column_id).toBe(todo?.id);
  });
});
