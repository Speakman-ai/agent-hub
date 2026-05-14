import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bumpAutofixDispatchCount,
  buildAutofixRoundBanner,
  composeAutofixMessage,
  dispatchAutofixFeedback,
  logAutofixDispatch,
  type AutofixDispatchKind,
} from './autofix-dispatch.js';
import type { KanbanCardRow, Project } from './types.js';

/**
 * `bumpCardAutofixDispatchCount` is the only stmt the wrapper touches.
 * We feed it a fake that simulates the SQLite UPDATE…RETURNING shape.
 */
function makeStmts(counts: Record<string, number> = {}) {
  return {
    bumpCardAutofixDispatchCount: {
      get: vi.fn((cardId: string) => {
        counts[cardId] = (counts[cardId] ?? 0) + 1;
        return { autofix_dispatch_count: counts[cardId] };
      }),
    },
    getCardAutofixDispatchCount: {
      get: vi.fn((cardId: string) => ({ autofix_dispatch_count: counts[cardId] ?? 0 })),
    },
  } as unknown as Parameters<typeof bumpAutofixDispatchCount>[0]['stmts'];
}

function makeCard(id = 'card-1'): KanbanCardRow {
  return {
    id,
    board_id: 'b',
    column_id: 'col',
    title: 'Test card',
    description: '',
    priority: 'medium',
    assignee: null,
    labels: '',
    session_id: 'sess-1',
    position: 0,
    documented: 0,
    dispatched_by_autonomous: 0,
    created_at: '',
    updated_at: '',
  } as KanbanCardRow;
}

const project: Project = { id: 'p', name: 'P', agents: [] } as unknown as Project;

describe('bumpAutofixDispatchCount', () => {
  it('returns the 1-indexed new round number from the UPDATE…RETURNING row', () => {
    const stmts = makeStmts();
    expect(bumpAutofixDispatchCount({ stmts }, 'card-1')).toBe(1);
    expect(bumpAutofixDispatchCount({ stmts }, 'card-1')).toBe(2);
    expect(bumpAutofixDispatchCount({ stmts }, 'card-1')).toBe(3);
  });

  it('falls back to round 1 when the UPDATE…RETURNING row is missing (card deleted)', () => {
    const stmts = {
      bumpCardAutofixDispatchCount: { get: vi.fn().mockReturnValue(undefined) },
      getCardAutofixDispatchCount: { get: vi.fn() },
    } as unknown as Parameters<typeof bumpAutofixDispatchCount>[0]['stmts'];
    expect(bumpAutofixDispatchCount({ stmts }, 'card-1')).toBe(1);
  });

  it('returns round 1 (no crash) when stmts.bumpCardAutofixDispatchCount is absent', () => {
    // Tests / plugin entry points may pass a stubbed Stmts table that
    // doesn't wire every column-bump statement. The wrapper must degrade
    // to a coherent banner instead of throwing.
    expect(bumpAutofixDispatchCount({ stmts: {} }, 'card-1')).toBe(1);
  });
});

describe('buildAutofixRoundBanner', () => {
  it('renders the round number in bold', () => {
    expect(buildAutofixRoundBanner(2, 'ci-failure')).toMatch(
      /\*\*Autofix round 2 — CI failure\.\*\*/,
    );
  });

  it('coerces non-positive rounds up to 1', () => {
    expect(buildAutofixRoundBanner(0, 'review-changes-requested')).toMatch(/round 1/);
    expect(buildAutofixRoundBanner(-5, 'review-changes-requested')).toMatch(/round 1/);
  });

  it('coerces non-integer rounds via floor', () => {
    expect(buildAutofixRoundBanner(3.7, 'ci-failure')).toMatch(/round 3/);
  });

  it('uses a human-readable label per dispatch kind', () => {
    const kinds: AutofixDispatchKind[] = [
      'review-changes-requested',
      'review-commented',
      'review-batch-comments',
      'review-missed-poll',
      'ci-failure',
      'inline-comment-poll',
      'conflict-resolve',
    ];
    for (const kind of kinds) {
      // Banner must never echo the raw kebab-case kind back at the agent.
      expect(buildAutofixRoundBanner(1, kind)).not.toContain(kind);
    }
  });

  it('includes the anti-disengagement guidance the prompt fix depends on', () => {
    const banner = buildAutofixRoundBanner(1, 'review-changes-requested');
    // Don't pin exact wording, but assert the three semantic pieces are present.
    expect(banner.toLowerCase()).toContain('multiple rounds');
    expect(banner.toLowerCase()).toContain('not silently disengage');
    expect(banner.toLowerCase()).toContain('pr comment');
  });
});

describe('composeAutofixMessage', () => {
  it('places the banner before the original body separated by ---', () => {
    const composed = composeAutofixMessage(2, 'ci-failure', 'BODY GOES HERE');
    const bannerIdx = composed.indexOf('Autofix round 2');
    const sepIdx = composed.indexOf('\n---\n');
    const bodyIdx = composed.indexOf('BODY GOES HERE');
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(sepIdx).toBeGreaterThan(bannerIdx);
    expect(bodyIdx).toBeGreaterThan(sepIdx);
  });

  it('preserves the original body byte-for-byte (no rewrite, no trim)', () => {
    const body = '# Original\nLine 1\nLine 2 with `code` and **bold**\n\n```bash\nls -la\n```\n';
    const composed = composeAutofixMessage(1, 'review-commented', body);
    expect(composed.endsWith(body)).toBe(true);
  });
});

describe('logAutofixDispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a single fixed-shape line greppable as [Autofix] event=dispatch', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logAutofixDispatch('ci-failure', 'card-abc', 3, 'sess-xyz', true);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0];
    expect(line).toBe(
      '[Autofix] event=dispatch card=card-abc kind=ci-failure round=3 session=sess-xyz persisted=true',
    );
  });

  it('writes session=none when the dispatcher returned null', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logAutofixDispatch('review-changes-requested', 'card-1', 1, null, false);
    expect(spy.mock.calls[0][0]).toContain('session=none');
    expect(spy.mock.calls[0][0]).toContain('persisted=false');
  });
});

describe('dispatchAutofixFeedback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('increments the counter, prepends the banner, and forwards the composed body', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stmts = makeStmts();
    const card = makeCard();
    const forward = vi.fn().mockResolvedValue({ sessionId: 'sess-1', userMessagePersisted: true });

    const result = await dispatchAutofixFeedback(
      { stmts },
      card,
      project,
      'ci-failure',
      'Body content',
      forward,
    );

    expect(result.round).toBe(1);
    expect(result.sessionId).toBe('sess-1');
    expect(result.userMessagePersisted).toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
    const dispatched = forward.mock.calls[0][2] as string;
    expect(dispatched).toContain('Autofix round 1');
    expect(dispatched).toContain('Body content');
    expect(dispatched.indexOf('Autofix round 1')).toBeLessThan(dispatched.indexOf('Body content'));
  });

  it('numbers consecutive dispatches monotonically', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stmts = makeStmts();
    const card = makeCard();
    const forward = vi.fn().mockResolvedValue({ sessionId: 'sess-1', userMessagePersisted: true });

    const r1 = await dispatchAutofixFeedback({ stmts }, card, project, 'ci-failure', 'a', forward);
    const r2 = await dispatchAutofixFeedback({ stmts }, card, project, 'ci-failure', 'b', forward);
    const r3 = await dispatchAutofixFeedback({ stmts }, card, project, 'ci-failure', 'c', forward);
    expect([r1.round, r2.round, r3.round]).toEqual([1, 2, 3]);
  });

  it('still increments the counter when persistence fails (queue full / no agent)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stmts = makeStmts();
    const card = makeCard();
    const forward = vi.fn().mockResolvedValue({ sessionId: null, userMessagePersisted: false });

    const result = await dispatchAutofixFeedback(
      { stmts },
      card,
      project,
      'review-changes-requested',
      'body',
      forward,
    );
    expect(result.round).toBe(1);
    expect(result.userMessagePersisted).toBe(false);

    // Next round still gets a fresh number — failed attempts are visible in
    // the log row but do not skip the counter.
    const next = await dispatchAutofixFeedback(
      { stmts },
      card,
      project,
      'review-changes-requested',
      'body',
      forward,
    );
    expect(next.round).toBe(2);
  });

  it('emits the structured log line with the round assigned to this dispatch', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stmts = makeStmts();
    const card = makeCard('card-zzz');
    const forward = vi.fn().mockResolvedValue({ sessionId: 'sess-9', userMessagePersisted: true });

    await dispatchAutofixFeedback({ stmts }, card, project, 'inline-comment-poll', 'body', forward);

    const autofixLines = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[Autofix] event=dispatch'));
    expect(autofixLines).toHaveLength(1);
    expect(autofixLines[0]).toBe(
      '[Autofix] event=dispatch card=card-zzz kind=inline-comment-poll round=1 session=sess-9 persisted=true',
    );
  });
});
