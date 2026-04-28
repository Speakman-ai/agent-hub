import { describe, it, expect, vi } from 'vitest';
import {
  detectTriageBlock,
  parseTriageBlock,
  describeTriageMalformedReason,
  buildTriagedDescription,
  mergeLabels,
  pickTriageAgent,
  resolveTriageAssignee,
  applyTriageResult,
  buildTriageCommentBody,
  buildTriagePromptContext,
} from './triage.js';
import type { KanbanCardRow, Project } from './types.js';

// ─── Parser ──────────────────────────────────────────────────────────────────

describe('detectTriageBlock', () => {
  it('returns present:false when no block exists', () => {
    expect(detectTriageBlock('hello world')).toEqual({
      present: false,
      task: null,
      reason: null,
      rawBody: null,
    });
  });

  it('returns present:false for non-string input', () => {
    expect(detectTriageBlock(undefined as never).present).toBe(false);
    expect(detectTriageBlock(null as never).present).toBe(false);
  });

  it('parses a minimal valid block (assignee only)', () => {
    const text = `intro
<agenthub:triage>
{"assignee": "hub-frontend"}
</agenthub:triage>
trailer`;
    const result = detectTriageBlock(text);
    expect(result.present).toBe(true);
    expect(result.task).toEqual({ assignee: 'hub-frontend' });
    expect(result.reason).toBeNull();
  });

  it('parses a fully-populated block', () => {
    const text = `<agenthub:triage>
{
  "assignee": "hub-backend",
  "refinedDescription": "Add /api/foo endpoint",
  "acceptanceCriteria": ["returns 200", "writes to DB"],
  "labels": ["backend", "api"]
}
</agenthub:triage>`;
    const result = detectTriageBlock(text);
    expect(result.task).toEqual({
      assignee: 'hub-backend',
      refinedDescription: 'Add /api/foo endpoint',
      acceptanceCriteria: ['returns 200', 'writes to DB'],
      labels: ['backend', 'api'],
    });
  });

  it('rejects invalid JSON', () => {
    const text = '<agenthub:triage>not json</agenthub:triage>';
    const result = detectTriageBlock(text);
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('invalid-json');
  });

  it('rejects array payload', () => {
    const text = '<agenthub:triage>[1,2,3]</agenthub:triage>';
    const result = detectTriageBlock(text);
    expect(result.reason).toBe('not-object');
  });

  it('rejects missing assignee', () => {
    const text = '<agenthub:triage>{"labels":["x"]}</agenthub:triage>';
    expect(detectTriageBlock(text).reason).toBe('missing-assignee');
  });

  it('rejects empty assignee', () => {
    const text = '<agenthub:triage>{"assignee":"   "}</agenthub:triage>';
    expect(detectTriageBlock(text).reason).toBe('empty-assignee');
  });

  it('rejects non-string assignee', () => {
    const text = '<agenthub:triage>{"assignee":42}</agenthub:triage>';
    expect(detectTriageBlock(text).reason).toBe('invalid-assignee-type');
  });

  it('rejects non-string description', () => {
    const text = '<agenthub:triage>{"assignee":"a","refinedDescription":42}</agenthub:triage>';
    expect(detectTriageBlock(text).reason).toBe('invalid-description-type');
  });

  it('rejects non-array acceptanceCriteria', () => {
    const text = '<agenthub:triage>{"assignee":"a","acceptanceCriteria":"oops"}</agenthub:triage>';
    expect(detectTriageBlock(text).reason).toBe('invalid-acceptance-criteria-type');
  });

  it('rejects acceptanceCriteria with non-string entries', () => {
    const text =
      '<agenthub:triage>{"assignee":"a","acceptanceCriteria":["ok",42]}</agenthub:triage>';
    expect(detectTriageBlock(text).reason).toBe('invalid-acceptance-criteria-type');
  });

  it('rejects non-array labels', () => {
    const text = '<agenthub:triage>{"assignee":"a","labels":"single"}</agenthub:triage>';
    expect(detectTriageBlock(text).reason).toBe('invalid-labels-type');
  });

  it('only considers the first block in the text', () => {
    const text = `<agenthub:triage>{"assignee":"first"}</agenthub:triage>
later
<agenthub:triage>{"assignee":"second"}</agenthub:triage>`;
    expect(detectTriageBlock(text).task?.assignee).toBe('first');
  });

  it('drops empty / whitespace-only AC entries', () => {
    const text =
      '<agenthub:triage>{"assignee":"a","acceptanceCriteria":["one","   ","two"]}</agenthub:triage>';
    expect(detectTriageBlock(text).task?.acceptanceCriteria).toEqual(['one', 'two']);
  });

  it('drops acceptanceCriteria field entirely when all entries are blank', () => {
    const text =
      '<agenthub:triage>{"assignee":"a","acceptanceCriteria":["   ",""]}</agenthub:triage>';
    expect(detectTriageBlock(text).task?.acceptanceCriteria).toBeUndefined();
  });

  it('treats explicit null optional fields as absent', () => {
    const text =
      '<agenthub:triage>{"assignee":"a","refinedDescription":null,"labels":null}</agenthub:triage>';
    const task = detectTriageBlock(text).task;
    expect(task).toEqual({ assignee: 'a' });
  });
});

describe('parseTriageBlock', () => {
  it('returns null for malformed payloads (lossy convenience wrapper)', () => {
    expect(parseTriageBlock('<agenthub:triage>oops</agenthub:triage>')).toBeNull();
    expect(parseTriageBlock('no block here')).toBeNull();
  });

  it('returns the task for valid payloads', () => {
    expect(parseTriageBlock('<agenthub:triage>{"assignee":"x"}</agenthub:triage>')).toEqual({
      assignee: 'x',
    });
  });
});

describe('describeTriageMalformedReason', () => {
  it('returns a human-readable string for every malformed reason', () => {
    const reasons = [
      'invalid-json',
      'not-object',
      'missing-assignee',
      'empty-assignee',
      'invalid-assignee-type',
      'invalid-description-type',
      'invalid-acceptance-criteria-type',
      'invalid-labels-type',
    ] as const;
    for (const r of reasons) {
      expect(describeTriageMalformedReason(r)).toMatch(/.+/);
    }
  });
});

// ─── Description merge ──────────────────────────────────────────────────────

describe('buildTriagedDescription', () => {
  it('returns null when nothing is provided and existing is null', () => {
    expect(buildTriagedDescription({ existing: null })).toBeNull();
  });

  it('preserves existing description when no refinedDescription is provided', () => {
    expect(buildTriagedDescription({ existing: 'Original body' })).toBe('Original body');
  });

  it('replaces description when refinedDescription is provided', () => {
    expect(buildTriagedDescription({ existing: 'Old', refinedDescription: 'New' })).toBe('New');
  });

  it('appends an Acceptance Criteria section when AC is provided', () => {
    const out = buildTriagedDescription({
      existing: 'Body',
      acceptanceCriteria: ['One', 'Two'],
    });
    expect(out).toBe('Body\n\n## Acceptance Criteria\n- [ ] One\n- [ ] Two');
  });

  it('replaces an existing AC section rather than appending a second one (idempotent re-triage)', () => {
    const original = 'Body\n\n## Acceptance Criteria\n- [ ] Old1\n- [ ] Old2';
    const out = buildTriagedDescription({
      existing: original,
      acceptanceCriteria: ['New'],
    });
    expect(out).toBe('Body\n\n## Acceptance Criteria\n- [ ] New');
  });

  it('emits AC section even when description is empty', () => {
    expect(
      buildTriagedDescription({
        existing: '',
        acceptanceCriteria: ['Only'],
      }),
    ).toBe('## Acceptance Criteria\n- [ ] Only');
  });
});

// ─── Label merge ────────────────────────────────────────────────────────────

describe('mergeLabels', () => {
  it('returns null when both inputs are empty', () => {
    expect(mergeLabels(null, undefined)).toBeNull();
    expect(mergeLabels('', [])).toBeNull();
  });

  it('preserves existing labels when no new ones are provided', () => {
    expect(mergeLabels('frontend,ui', undefined)).toBe('frontend,ui');
  });

  it('merges and deduplicates case-insensitively', () => {
    expect(mergeLabels('frontend,ui', ['UI', 'urgent'])).toBe('frontend,ui,urgent');
  });

  it('trims whitespace around labels', () => {
    expect(mergeLabels('  one ,  two  ', ['three'])).toBe('one,two,three');
  });
});

// ─── Roster helpers ─────────────────────────────────────────────────────────

function makeProject(agents: Array<{ id: string; name: string; role?: string }>): Project {
  return {
    id: 'p',
    name: 'P',
    cwd: '/tmp',
    ahw: '',
    agents: agents as never,
  } as Project;
}

describe('pickTriageAgent', () => {
  it('returns the intake agent when present', () => {
    const p = makeProject([
      { id: 'lead-1', name: 'Lead', role: 'lead' },
      { id: 'intake-1', name: 'Intake', role: 'intake' },
      { id: 'sub-1', name: 'Sub', role: 'sub' },
    ]);
    expect(pickTriageAgent(p)?.id).toBe('intake-1');
  });

  it('falls back to the lead when no intake exists', () => {
    const p = makeProject([
      { id: 'lead-1', name: 'Lead', role: 'lead' },
      { id: 'sub-1', name: 'Sub', role: 'sub' },
    ]);
    expect(pickTriageAgent(p)?.id).toBe('lead-1');
  });

  it('returns null when neither intake nor lead exists', () => {
    const p = makeProject([
      { id: 'sub-1', name: 'Sub', role: 'sub' },
      { id: 'sub-2', name: 'Sub2', role: 'sub' },
    ]);
    expect(pickTriageAgent(p)).toBeNull();
  });

  it('returns null for an empty roster', () => {
    expect(pickTriageAgent(makeProject([]))).toBeNull();
  });
});

describe('resolveTriageAssignee', () => {
  const project = makeProject([
    { id: 'lead-1', name: 'Lead', role: 'lead' },
    { id: 'intake-1', name: 'Intake', role: 'intake' },
    { id: 'sub-1', name: 'Sub', role: 'sub' },
    { id: 'docs-1', name: 'Docs', role: 'docs' },
    { id: 'rev-1', name: 'Reviewer', role: 'reviewer' },
  ]);

  it('resolves a valid sub-agent', () => {
    expect(resolveTriageAssignee(project, 'sub-1')?.id).toBe('sub-1');
  });

  it('returns null for unknown id', () => {
    expect(resolveTriageAssignee(project, 'ghost')).toBeNull();
  });

  it('rejects out-of-band roles (docs/intake/reviewer)', () => {
    expect(resolveTriageAssignee(project, 'intake-1')).toBeNull();
    expect(resolveTriageAssignee(project, 'docs-1')).toBeNull();
    expect(resolveTriageAssignee(project, 'rev-1')).toBeNull();
  });

  it('allows the lead as a routing target', () => {
    expect(resolveTriageAssignee(project, 'lead-1')?.id).toBe('lead-1');
  });
});

// ─── applyTriageResult ──────────────────────────────────────────────────────

interface MockStmt {
  run?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
}

function makeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-1',
    board_id: 'board-1',
    title: 'Card',
    description: 'Original body',
    priority: 'medium',
    assignee: null,
    labels: 'existing',
    session_id: null,
    github_issue_url: null,
    pr_url: null,
    review_status: null,
    created_by: null,
    position: 0,
    epic_id: 'epic-1',
    documented: 0,
    autonomous_iterations: 0,
    dispatched_by_autonomous: 0,
    triaged_at: null,
    triaged_by: null,
    suggested_assignee: null,
    created_at: '2020-01-01',
    updated_at: '2020-01-01',
    ...overrides,
  } as KanbanCardRow;
}

function makeApplyDeps(overrides: { card?: KanbanCardRow | undefined; failApply?: boolean } = {}) {
  const stmts = {
    getKanbanCardBySession: { get: vi.fn(() => overrides.card) } as MockStmt,
    getKanbanCard: {
      get: vi.fn(() => ({ ...overrides.card, triaged_at: 1700000000000 })),
    } as MockStmt,
    setCardTriage: {
      run: vi.fn(() => {
        if (overrides.failApply) throw new Error('boom');
      }),
    } as MockStmt,
    createKanbanCardComment: { run: vi.fn() } as MockStmt,
  };
  const broadcast = vi.fn();
  const projectAgents = [
    { id: 'sub-1', name: 'Sub', role: 'sub' },
    { id: 'intake-1', name: 'Intake', role: 'intake' },
  ] as never;
  return {
    stmts,
    broadcast,
    deps: {
      stmts: stmts as never,
      broadcast,
      projectId: 'p',
      triagedByAgentId: 'intake-1',
      projectAgents,
    },
  };
}

describe('applyTriageResult', () => {
  it('returns no_linked_card when no session-linked card is found', () => {
    const { deps } = makeApplyDeps({ card: undefined });
    const out = applyTriageResult('sess-1', { assignee: 'sub-1' }, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no_linked_card');
  });

  it('returns unknown_assignee when triage points to an unknown agent', () => {
    const card = makeCard();
    const { deps } = makeApplyDeps({ card });
    const out = applyTriageResult('sess-1', { assignee: 'ghost' }, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('unknown_assignee');
      expect(out.detail).toBe('ghost');
    }
  });

  it('returns unknown_assignee when triage points to an out-of-band role', () => {
    const card = makeCard();
    const { deps } = makeApplyDeps({ card });
    const out = applyTriageResult('sess-1', { assignee: 'intake-1' }, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('unknown_assignee');
  });

  it('returns update_failed when setCardTriage throws', () => {
    const card = makeCard();
    const { deps } = makeApplyDeps({ card, failApply: true });
    const out = applyTriageResult('sess-1', { assignee: 'sub-1' }, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('update_failed');
  });

  it('writes triage atomically and broadcasts kanban_update on success', () => {
    const card = makeCard();
    const { stmts, broadcast, deps } = makeApplyDeps({ card });
    const out = applyTriageResult(
      'sess-1',
      {
        assignee: 'sub-1',
        refinedDescription: 'New body',
        acceptanceCriteria: ['A', 'B'],
        labels: ['x'],
      },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(stmts.setCardTriage.run).toHaveBeenCalledTimes(1);
    const args = stmts.setCardTriage.run!.mock.calls[0];
    // description, labels, suggested_assignee, triaged_by, card.id
    expect(args[0]).toBe('New body\n\n## Acceptance Criteria\n- [ ] A\n- [ ] B');
    expect(args[1]).toBe('existing,x');
    expect(args[2]).toBe('sub-1');
    expect(args[3]).toBe('intake-1');
    expect(args[4]).toBe('card-1');

    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'p' });
    expect(out.result.suggestedAssignee).toBe('sub-1');
  });

  it('still reports ok when comment insert fails (best-effort)', () => {
    const card = makeCard();
    const { stmts, deps } = makeApplyDeps({ card });
    stmts.createKanbanCardComment.run = vi.fn(() => {
      throw new Error('comment fail');
    });
    const out = applyTriageResult('sess-1', { assignee: 'sub-1' }, deps);
    expect(out.ok).toBe(true);
  });
});

// ─── Surface helpers ────────────────────────────────────────────────────────

describe('buildTriageCommentBody', () => {
  it('mentions the assignee, the triager, and the session id', () => {
    const body = buildTriageCommentBody({
      task: { assignee: 'sub-1' },
      assigneeName: 'Sub Agent',
      assigneeId: 'sub-1',
      triagedByAgentId: 'intake-1',
      sessionId: 'sess-abc',
    });
    expect(body).toContain('Sub Agent');
    expect(body).toContain('intake-1');
    expect(body).toContain('sess-abc');
  });

  it('notes when description / AC / labels were touched', () => {
    const body = buildTriageCommentBody({
      task: {
        assignee: 'sub-1',
        refinedDescription: 'New',
        acceptanceCriteria: ['x', 'y'],
        labels: ['a', 'b'],
      },
      assigneeName: 'S',
      assigneeId: 'sub-1',
      triagedByAgentId: 'intake-1',
      sessionId: 's',
    });
    expect(body).toContain('Description was refined');
    expect(body).toMatch(/Acceptance criteria added \(2\)/);
    expect(body).toContain('Labels added');
  });
});

describe('buildTriagePromptContext', () => {
  it('lists the available specialists by id', () => {
    const card = makeCard({ title: 'Big Task' });
    const out = buildTriagePromptContext({
      card,
      specialists: [
        { id: 'fe-1', name: 'Front', role: 'sub' } as never,
        { id: 'be-1', name: 'Back', role: 'sub' } as never,
      ],
    });
    expect(out).toContain('Big Task');
    expect(out).toContain('`fe-1`');
    expect(out).toContain('`be-1`');
    expect(out).toContain('<agenthub:triage>');
    expect(out).toContain('Triage only.');
  });

  it('handles an empty specialist roster gracefully', () => {
    const card = makeCard();
    const out = buildTriagePromptContext({ card, specialists: [] });
    expect(out).toContain('Card'); // still emits the body
    expect(out).not.toContain('## Available Specialists');
  });
});
