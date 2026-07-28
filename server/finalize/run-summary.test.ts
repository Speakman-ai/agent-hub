import { describe, it, expect, vi } from 'vitest';
import { emitFinalizeRunSummary } from './run-summary.js';
import type { EmitFinalizeRunSummaryDeps } from './run-summary.js';

interface Inserted {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata: string;
}

function makeDeps(overrides: Partial<EmitFinalizeRunSummaryDeps> & { messages?: unknown[] } = {}): {
  deps: EmitFinalizeRunSummaryDeps;
  inserted: Inserted[];
  broadcasts: unknown[];
} {
  const inserted: Inserted[] = [];
  const broadcasts: unknown[] = [];
  const messages = overrides.messages ?? [];

  const deps: EmitFinalizeRunSummaryDeps = {
    stmts: {
      getMessages: { all: vi.fn(() => messages) },
      addMessage: {
        run: vi.fn(
          (
            id: string,
            sessionId: string,
            role: string,
            content: string,
            _engine: unknown,
            _model: unknown,
            _attachments: unknown,
            metadata: string,
          ) => {
            inserted.push({ id, sessionId, role, content, metadata });
          },
        ),
      },
      touchSession: { run: vi.fn() },
      getMessageById: {
        get: vi.fn((id: string) => inserted.find((m) => m.id === id)),
      },
    } as unknown as EmitFinalizeRunSummaryDeps['stmts'],
    broadcast: ((event: unknown) => {
      broadcasts.push(event);
    }) as EmitFinalizeRunSummaryDeps['broadcast'],
    newId: (() => {
      let n = 0;
      return () => `msg-${++n}`;
    })(),
    collectCommits: vi.fn(async () => [{ subject: 'Add widget' }]),
    collectDiffStat: vi.fn(async () => ' 1 file changed, 3 insertions(+)'),
    generateNarrative: vi.fn(async () => ({
      summary: 'Adds a widget.',
      reviewNotes: 'One nit, fixed.',
      manualTesting: ['Open the widget page'],
    })),
    ...overrides,
  };

  return { deps, inserted, broadcasts };
}

const baseArgs = {
  sessionId: 'sess-1',
  runId: 'run-1',
  round: 2,
  worktreePath: '/tmp/wt',
  baseBranch: 'main',
  headSha: 'abc123',
  card: { title: 'Add widget', description: 'Users need a widget.' },
  config: { openaiApiKey: 'sk-test' },
  env: {} as NodeJS.ProcessEnv,
};

function reviewRoundMessage(runId: string, round: number, verdict: string, threads: unknown[]) {
  return {
    metadata: JSON.stringify({ kind: 'finalize_review_round', runId, round, verdict, threads }),
  };
}

describe('emitFinalizeRunSummary', () => {
  it('writes one system message carrying all three sections', async () => {
    const { deps, inserted, broadcasts } = makeDeps({
      messages: [
        reviewRoundMessage('run-1', 1, 'changes_requested', [
          { file_path: 'server/a.ts', line_start: 4, line_end: 9, body: 'guard null' },
        ]),
        reviewRoundMessage('run-1', 2, 'approved', []),
      ],
    });

    const id = await emitFinalizeRunSummary(deps, baseArgs);

    expect(id).toBe('msg-1');
    expect(inserted).toHaveLength(1);
    const message = inserted[0]!;
    expect(message.role).toBe('system');
    expect(message.content).toContain('### What changed');
    expect(message.content).toContain('### Review');
    expect(message.content).toContain('### Manual testing');

    const metadata = JSON.parse(message.metadata);
    expect(metadata.kind).toBe('finalize_run_summary');
    expect(metadata.runId).toBe('run-1');
    expect(metadata.headSha).toBe('abc123');
    expect(metadata.summary).toBe('Adds a widget.');
    expect(metadata.commits).toEqual(['Add widget']);
    expect(metadata.filesChanged).toBe(1);
    expect(metadata.finalVerdict).toBe('approved');
    expect(metadata.totalFindings).toBe(1);
    expect(metadata.manualTesting).toEqual(['Open the widget page']);
    expect(broadcasts).toHaveLength(1);
  });

  it('writes payload fields flat alongside kind, with no nested payload key', async () => {
    // Cross-boundary contract. `writeFinalizeTimelineMessage` spreads the
    // payload next to `kind`, and the CLIENT parser
    // (client/src/utils/finalizeTimeline.ts) reads `parsed.<field>` directly.
    // Nesting these under a `payload` key here would render an empty summary
    // card in the UI with no server-side failure, so pin the shape.
    const { deps, inserted } = makeDeps();

    await emitFinalizeRunSummary(deps, baseArgs);

    const metadata = JSON.parse(inserted[0]!.metadata);
    expect(metadata).not.toHaveProperty('payload');
    expect(metadata.kind).toBe('finalize_run_summary');
    for (const field of [
      'runId',
      'round',
      'headSha',
      'summary',
      'summarySource',
      'commits',
      'diffStat',
      'reviewRounds',
      'totalFindings',
      'manualTesting',
    ]) {
      expect(metadata).toHaveProperty(field);
    }
  });

  it('reports findings from an earlier round the reviewer already resolved', async () => {
    // Regression: reviewer_threads is wiped by deleteReviewerThreadsForRun on
    // every round, so a run that ends approved has an empty table. The summary
    // must still tell the operator what round 1 raised.
    const { deps, inserted } = makeDeps({
      messages: [
        reviewRoundMessage('run-1', 1, 'changes_requested', [
          { file_path: 'server/a.ts', line_start: 4, line_end: 9, body: 'guard null' },
          { file_path: 'server/b.ts', line_start: null, line_end: null, body: 'rename this' },
        ]),
        reviewRoundMessage('run-1', 2, 'approved', []),
      ],
    });

    await emitFinalizeRunSummary(deps, baseArgs);

    const metadata = JSON.parse(inserted[0]!.metadata);
    expect(metadata.totalFindings).toBe(2);
    expect(metadata.reviewRounds[0].findings).toHaveLength(2);
    expect(inserted[0]!.content).toContain('guard null');
    expect(inserted[0]!.content).toContain('rename this');
  });

  it('feeds the collected review history into the narrative call', async () => {
    const generateNarrative = vi.fn(async (_opts: unknown) => null);
    const { deps } = makeDeps({
      generateNarrative:
        generateNarrative as unknown as EmitFinalizeRunSummaryDeps['generateNarrative'],
      messages: [reviewRoundMessage('run-1', 1, 'changes_requested', [])],
    });

    await emitFinalizeRunSummary(deps, baseArgs);

    expect(generateNarrative).toHaveBeenCalledTimes(1);
    const passed = generateNarrative.mock.calls[0]?.[0] as {
      reviewRounds: unknown[];
      cardTitle: string;
      openaiApiKey: string;
    };
    expect(passed.reviewRounds).toHaveLength(1);
    expect(passed.cardTitle).toBe('Add widget');
    expect(passed.openaiApiKey).toBe('sk-test');
  });

  it('still writes the deterministic summary when the narrative is unavailable', async () => {
    const { deps, inserted } = makeDeps({ generateNarrative: vi.fn(async () => null) });

    const id = await emitFinalizeRunSummary(deps, baseArgs);

    expect(id).toBe('msg-1');
    const metadata = JSON.parse(inserted[0]!.metadata);
    expect(metadata.summarySource).toBe('none');
    expect(metadata.commits).toEqual(['Add widget']);
    expect(inserted[0]!.content).toContain('- Add widget');
    expect(inserted[0]!.content).toContain('No manual testing steps were generated');
  });

  it('degrades to a review-only summary when git reads fail', async () => {
    const { deps, inserted } = makeDeps({
      collectCommits: vi.fn(async () => {
        throw new Error('not a git repo');
      }),
      collectDiffStat: vi.fn(async () => {
        throw new Error('not a git repo');
      }),
      messages: [reviewRoundMessage('run-1', 1, 'approved', [])],
    });

    const id = await emitFinalizeRunSummary(deps, baseArgs);

    expect(id).toBe('msg-1');
    expect(inserted[0]!.content).toContain('No commits found on the branch.');
  });

  it('skips the git reads entirely when there is no worktree', async () => {
    const collectCommits = vi.fn(async () => []);
    const { deps, inserted } = makeDeps({ collectCommits });

    const id = await emitFinalizeRunSummary(deps, { ...baseArgs, worktreePath: null });

    expect(collectCommits).not.toHaveBeenCalled();
    expect(id).toBe('msg-1');
    expect(inserted[0]!.content).toContain('No commits found on the branch.');
  });

  it('returns null without writing when the run has no session', async () => {
    const { deps, inserted } = makeDeps();
    expect(await emitFinalizeRunSummary(deps, { ...baseArgs, sessionId: null })).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('never throws when the narrative call blows up', async () => {
    const { deps } = makeDeps({
      generateNarrative: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(emitFinalizeRunSummary(deps, baseArgs)).resolves.toBeNull();
  });

  it('still writes a summary when reading session messages throws', async () => {
    const { deps, inserted } = makeDeps();
    (deps.stmts.getMessages.all as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('db locked');
    });

    const id = await emitFinalizeRunSummary(deps, baseArgs);

    expect(id).toBe('msg-1');
    expect(JSON.parse(inserted[0]!.metadata).reviewRounds).toEqual([]);
  });
});
