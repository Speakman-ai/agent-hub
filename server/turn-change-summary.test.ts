import { describe, it, expect, vi } from 'vitest';
import {
  buildChangedFilesStat,
  renderTurnChangeSummaryMarkdown,
  emitTurnChangeSummary,
  TURN_CHANGE_SUMMARY_KIND,
  MAX_TURN_STAT_FILES,
  type TurnChangeSummaryPayload,
} from './turn-change-summary.js';
import type { SessionChangeFile, SessionChangesSummary } from './session-changes.js';

function file(overrides: Partial<SessionChangeFile> = {}): SessionChangeFile {
  return {
    path: 'server/a.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    untracked: false,
    ...overrides,
  };
}

function changes(files: SessionChangeFile[]): SessionChangesSummary {
  return {
    baseBranch: 'main',
    baseSha: 'base',
    headSha: 'head',
    branch: 'agent-hub/dev/session-x',
    dirty: files.length > 0,
    files,
    truncated: false,
  };
}

describe('buildChangedFilesStat', () => {
  it('sums insertions/deletions and renders a totals line', () => {
    const stat = buildChangedFilesStat([
      file({ path: 'a.ts', additions: 3, deletions: 1 }),
      file({ path: 'b.ts', additions: 10, deletions: 0 }),
    ]);
    expect(stat.filesChanged).toBe(2);
    expect(stat.insertions).toBe(13);
    expect(stat.deletions).toBe(1);
    expect(stat.stat).toContain('a.ts | +3 -1');
    expect(stat.stat).toContain('2 files changed, +13, -1');
  });

  it('tags new, renamed, and binary files', () => {
    const stat = buildChangedFilesStat([
      file({ path: 'new.ts', status: 'added', untracked: true, additions: 5, deletions: 0 }),
      file({ path: 'img.png', binary: true, additions: 0, deletions: 0 }),
    ]);
    expect(stat.stat).toContain('new.ts | +5 -0 (added, new)');
    expect(stat.stat).toContain('img.png | bin (binary)');
  });

  it('caps the per-file lines but keeps full totals', () => {
    const many = Array.from({ length: MAX_TURN_STAT_FILES + 5 }, (_, i) =>
      file({ path: `f${i}.ts`, additions: 1, deletions: 0 }),
    );
    const stat = buildChangedFilesStat(many);
    expect(stat.filesChanged).toBe(MAX_TURN_STAT_FILES + 5);
    expect(stat.insertions).toBe(MAX_TURN_STAT_FILES + 5);
    expect(stat.stat).toContain('…and 5 more file(s)');
  });

  it('returns an empty stat for no files', () => {
    expect(buildChangedFilesStat([]).stat).toBe('');
  });
});

describe('renderTurnChangeSummaryMarkdown', () => {
  const base: TurnChangeSummaryPayload = {
    summary: 'Adds a toggle.',
    summarySource: 'llm',
    manualTesting: ['Flip the toggle on the settings page.'],
    filesChanged: 1,
    insertions: 3,
    deletions: 0,
  };

  it('renders both sections', () => {
    const md = renderTurnChangeSummaryMarkdown(base);
    expect(md).toContain('## Change summary');
    expect(md).toContain('Adds a toggle.');
    expect(md).toContain('### Manual testing');
    expect(md).toContain('- [ ] Flip the toggle on the settings page.');
  });

  it('renders an empty-state line when no manual testing was generated', () => {
    const md = renderTurnChangeSummaryMarkdown({ ...base, manualTesting: [] });
    expect(md).toContain('No manual testing steps were generated for this change.');
  });
});

function makeDeps(
  overrides: {
    openaiApiKey?: string | null;
    changes?: SessionChangesSummary;
    narrative?: { summary: string; manualTesting: string[] } | null;
  } = {},
) {
  const addRun = vi.fn();
  const touchRun = vi.fn();
  const inserted = { id: 'msg-1', role: 'system' };
  const getById = vi.fn().mockReturnValue(inserted);
  const broadcast = vi.fn();
  const computeChanges = vi.fn().mockResolvedValue(overrides.changes ?? changes([file()]));
  const generateNarrative = vi
    .fn()
    .mockResolvedValue(
      overrides.narrative === undefined
        ? { summary: 'Prose.', reviewNotes: '', manualTesting: ['Check the thing.'], followUps: [] }
        : overrides.narrative,
    );
  const deps = {
    stmts: {
      addMessage: { run: addRun },
      touchSession: { run: touchRun },
      getMessageById: { get: getById },
    },
    broadcast,
    getConfig: () => ({
      openaiApiKey: 'openaiApiKey' in overrides ? overrides.openaiApiKey! : 'sk-test',
    }),
    newId: () => 'msg-1',
    computeChanges: computeChanges as any,
    generateNarrative: generateNarrative as any,
  } as any;
  return {
    deps,
    addRun,
    touchRun,
    getById,
    broadcast,
    computeChanges,
    generateNarrative,
    inserted,
  };
}

const args = { sessionId: 's1', io: {} as any, baseBranch: null, card: null };

describe('emitTurnChangeSummary', () => {
  it('writes a turn_change_summary message and broadcasts it', async () => {
    const t = makeDeps();
    const id = await emitTurnChangeSummary(t.deps, args);
    expect(id).toBe('msg-1');
    expect(t.addRun).toHaveBeenCalledTimes(1);

    const metadata = t.addRun.mock.calls[0][7] as string;
    const parsed = JSON.parse(metadata);
    expect(parsed.kind).toBe(TURN_CHANGE_SUMMARY_KIND);
    expect(parsed.summary).toBe('Prose.');
    expect(parsed.manualTesting).toEqual(['Check the thing.']);
    expect(parsed.summarySource).toBe('llm');

    expect(t.broadcast).toHaveBeenCalledWith({
      type: 'message',
      sessionId: 's1',
      message: t.inserted,
    });
  });

  it('no-ops without an OpenAI key and never runs the change scan', async () => {
    const t = makeDeps({ openaiApiKey: null });
    const id = await emitTurnChangeSummary(t.deps, args);
    expect(id).toBeNull();
    expect(t.computeChanges).not.toHaveBeenCalled();
    expect(t.generateNarrative).not.toHaveBeenCalled();
    expect(t.addRun).not.toHaveBeenCalled();
  });

  it('no-ops when the worktree has no changed files', async () => {
    const t = makeDeps({ changes: changes([]) });
    const id = await emitTurnChangeSummary(t.deps, args);
    expect(id).toBeNull();
    expect(t.generateNarrative).not.toHaveBeenCalled();
    expect(t.addRun).not.toHaveBeenCalled();
  });

  // Regression: the Finalize summary diffs base...HEAD (committed only). A plain
  // turn usually leaves work UNCOMMITTED, so the summary must be built from the
  // working-tree change scan. Prove an uncommitted/untracked-only turn still
  // feeds a non-empty diff to the model and writes a summary.
  it('summarizes an uncommitted / untracked-only turn', async () => {
    const t = makeDeps({
      changes: changes([
        file({
          path: 'server/new.ts',
          status: 'added',
          untracked: true,
          additions: 20,
          deletions: 0,
        }),
        file({ path: 'server/edit.ts', additions: 4, deletions: 2 }),
      ]),
    });
    const id = await emitTurnChangeSummary(t.deps, args);
    expect(id).toBe('msg-1');
    const llmArgs = t.generateNarrative.mock.calls[0][0];
    expect(llmArgs.commits).toEqual([]);
    expect(llmArgs.diffStat).toContain('server/new.ts');
    expect(llmArgs.diffStat).toContain('2 files changed');
    expect(t.addRun).toHaveBeenCalledTimes(1);
  });

  it('no-ops when the LLM returns nothing usable', async () => {
    const t = makeDeps({ narrative: null });
    const id = await emitTurnChangeSummary(t.deps, args);
    expect(id).toBeNull();
    expect(t.addRun).not.toHaveBeenCalled();
  });

  it('no-ops when the narrative has neither prose nor testing steps', async () => {
    const t = makeDeps({ narrative: { summary: '', manualTesting: [] } });
    const id = await emitTurnChangeSummary(t.deps, args);
    expect(id).toBeNull();
    expect(t.addRun).not.toHaveBeenCalled();
  });

  it('never throws when the message insert fails', async () => {
    const t = makeDeps();
    t.addRun.mockImplementation(() => {
      throw new Error('db locked');
    });
    const id = await emitTurnChangeSummary(t.deps, args);
    expect(id).toBeNull();
    expect(t.broadcast).not.toHaveBeenCalled();
  });

  it('returns null for a missing session id', async () => {
    const t = makeDeps();
    const id = await emitTurnChangeSummary(t.deps, { ...args, sessionId: null });
    expect(id).toBeNull();
    expect(t.computeChanges).not.toHaveBeenCalled();
  });
});
