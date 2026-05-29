/**
 * Regression coverage for the §14 `merged_pr_provenance` metric emitted
 * from `handleWebhookPrClosed`.
 *
 * The handler became `async` to call `classifyPr` (§11 registry hit OR
 * PR-body marker fallback) and `recordMergedPrProvenance` (counter row
 * labelled `source: 'finalize' | 'external'`). These tests pin the
 * classification → label mapping and the URL-fallback chain so
 * accidental regressions don't silently flip the population definition.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebhookPrClosed } from './webhooks.js';
import { PR_BODY_MARKER } from '../finalize/provenance.js';
import type {
  KanbanCardRow,
  KanbanColumnRow,
  Project,
  RouteDeps,
  FinalizeRunRow,
} from '../types.js';

const CARD: KanbanCardRow = {
  id: 'card-1',
  column_id: 'col-review',
  title: 'feature: shipping',
  description: '',
  priority: 'medium',
  assignee: null,
  labels: null,
  session_id: null,
  github_issue_url: null,
  pr_url: 'https://github.com/o/r/pull/42',
  epic_id: null,
  dispatched_by_autonomous: 0,
  position: 0,
  created_at: '',
  updated_at: '',
} as unknown as KanbanCardRow;

const COLS: KanbanColumnRow[] = [
  { id: 'col-review', name: 'Review' } as unknown as KanbanColumnRow,
  { id: 'col-done', name: 'Done' } as unknown as KanbanColumnRow,
];

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Test',
  cwd: '/tmp',
  ahw: '',
} as unknown as Project;

function makeDeps(opts: { registryHit?: FinalizeRunRow | undefined }): {
  deps: RouteDeps;
  metricCalls: Array<{
    projectId: string;
    name: string;
    labels: Record<string, unknown>;
    runId: string | null;
  }>;
  broadcastCalls: unknown[];
} {
  const metricCalls: Array<{
    projectId: string;
    name: string;
    labels: Record<string, unknown>;
    runId: string | null;
  }> = [];
  const broadcastCalls: unknown[] = [];
  const stmts = {
    moveKanbanCard: { run: vi.fn() },
    getSession: { get: vi.fn(() => undefined) },
    deletePrStateByRepoPr: { run: vi.fn() },
    getFinalizeRunByPrUrl: { get: vi.fn(() => opts.registryHit) },
    insertFinalizeMetric: {
      run: vi.fn(
        (projectId: string, name: string, labels: string, _value: number, runId: string | null) => {
          metricCalls.push({ projectId, name, labels: JSON.parse(labels), runId });
        },
      ),
    },
  } as unknown as RouteDeps['stmts'];

  const deps: RouteDeps = {
    stmts,
    broadcast: (msg: unknown) => {
      broadcastCalls.push(msg);
    },
    tryAutonomousDispatch: vi.fn(),
  } as unknown as RouteDeps;
  return { deps, metricCalls, broadcastCalls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('handleWebhookPrClosed — merged_pr_provenance metric', () => {
  it('labels source=finalize when the §11 registry lookup hits', async () => {
    // Registry hit: orchestrator pushed this PR (finalize_runs.pr_url matches).
    const hitRow = { id: 'run-1', pr_url: 'https://github.com/o/r/pull/42' } as FinalizeRunRow;
    const { deps, metricCalls } = makeDeps({ registryHit: hitRow });
    const ok = await handleWebhookPrClosed(
      deps,
      CARD,
      PROJECT,
      COLS,
      {
        action: 'closed',
        repository: { full_name: 'o/r', html_url: '' },
        sender: { login: 'human' },
        pull_request: {
          number: 42,
          title: 'feature',
          html_url: 'https://github.com/o/r/pull/42',
          merged: true,
          body: 'body — no marker',
        },
      } as never,
      'human',
    );
    expect(ok).toBe(true);
    const provRows = metricCalls.filter((c) => c.name === 'merged_pr_provenance');
    expect(provRows).toHaveLength(1);
    expect(provRows[0].labels).toEqual({ source: 'finalize' });
    expect(provRows[0].projectId).toBe(PROJECT.id);
    expect(provRows[0].runId).toBe('run-1');
  });

  it('labels source=finalize via the PR-body marker fallback when registry misses', async () => {
    const { deps, metricCalls } = makeDeps({ registryHit: undefined });
    await handleWebhookPrClosed(
      deps,
      CARD,
      PROJECT,
      COLS,
      {
        action: 'closed',
        repository: { full_name: 'o/r', html_url: '' },
        sender: { login: 'human' },
        pull_request: {
          number: 42,
          title: 'feature',
          html_url: 'https://github.com/o/r/pull/42',
          merged: true,
          body: `Some description.\n\n${PR_BODY_MARKER}`,
        },
      } as never,
      'human',
    );
    const provRows = metricCalls.filter((c) => c.name === 'merged_pr_provenance');
    expect(provRows).toHaveLength(1);
    expect(provRows[0].labels).toEqual({ source: 'finalize' });
    // Registry missed, so no run id is attached.
    expect(provRows[0].runId).toBeNull();
  });

  it('labels source=external when neither signal fires', async () => {
    const { deps, metricCalls } = makeDeps({ registryHit: undefined });
    await handleWebhookPrClosed(
      deps,
      CARD,
      PROJECT,
      COLS,
      {
        action: 'closed',
        repository: { full_name: 'o/r', html_url: '' },
        sender: { login: 'human' },
        pull_request: {
          number: 42,
          title: 'feature',
          html_url: 'https://github.com/o/r/pull/42',
          merged: true,
          body: 'Plain description, no marker.',
        },
      } as never,
      'human',
    );
    const provRows = metricCalls.filter((c) => c.name === 'merged_pr_provenance');
    expect(provRows).toHaveLength(1);
    expect(provRows[0].labels).toEqual({ source: 'external' });
    expect(provRows[0].runId).toBeNull();
  });

  it('emits no provenance row when the PR is closed without merging', async () => {
    const { deps, metricCalls } = makeDeps({ registryHit: undefined });
    await handleWebhookPrClosed(
      deps,
      { ...CARD, column_id: 'col-done' },
      PROJECT,
      COLS,
      {
        action: 'closed',
        repository: { full_name: 'o/r', html_url: '' },
        sender: { login: 'human' },
        pull_request: {
          number: 42,
          title: 'feature',
          html_url: 'https://github.com/o/r/pull/42',
          merged: false,
        },
      } as never,
      'human',
    );
    const provRows = metricCalls.filter((c) => c.name === 'merged_pr_provenance');
    expect(provRows).toHaveLength(0);
  });
});
