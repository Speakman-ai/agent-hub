import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_HUB_BOT_SENTINEL, handleWebhookPrReview } from './webhooks.js';
import { lastDispatchedReviewId } from '../review-feedback-dedup.js';
import type { Project, KanbanCardRow, KanbanColumnRow, ChatMessage } from '../types.js';

// Regression coverage for `handleWebhookPrReview`'s self-trigger filter.
//
// Background: on single-maintainer Agent Hub deployments, the server's `gh`
// CLI is authed as the maintainer's personal account. The original filter
// skipped any review whose `sender.login` matched that account — which also
// silently dropped *manual* human CHANGES_REQUESTED reviews, leaving the
// author agent unable to wake up. The first fix added a body-sentinel gate
// for the CLI-user branch.
//
// A second bug (card 8303f269): the reviewer App now posts formal reviews
// via `POST /api/pr/review` under `${ghAppSlug}[bot]`, and the blanket
// bot-identity skip swallowed those `changes_requested` reviews too — same
// failure mode (card stranded in Review, autofix never dispatched). The
// fix narrows the bot-identity skip to non-actionable states only:
// `approved` and `commented` from bot identities are still suppressed (loop
// prevention), but `changes_requested` from bot identities now propagates
// so the kanban handler can move the card back to In Progress and call
// `dispatchReviewAutofix`.

const CARD: KanbanCardRow = {
  id: 'card-1',
  column_id: 'col-review',
  title: 'Implement feature X',
  description: '',
  priority: 'medium',
  assignee: 'Author Agent',
  labels: null,
  session_id: null,
  github_issue_url: null,
  pr_url: 'https://github.com/owner/repo/pull/42',
  epic_id: null,
  dispatched_by_autonomous: 0,
  position: 0,
  created_at: '',
  updated_at: '',
} as unknown as KanbanCardRow;

const COLS: KanbanColumnRow[] = [
  { id: 'col-review', name: 'Review' } as unknown as KanbanColumnRow,
  { id: 'col-in-progress', name: 'In Progress' } as unknown as KanbanColumnRow,
];

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Test',
  cwd: '/tmp',
  ahw: '',
  agents: [
    {
      id: 'author-1',
      name: 'Author Agent',
      role: 'author',
      engine: 'claude-code',
      model: 'claude-sonnet-4-20250514',
    },
  ],
} as unknown as Project;

function makeDeps(overrides: {
  ghAuthenticatedUser?: string | null;
  ghBotUser?: string | null;
  ghAppSlug?: string | null;
}) {
  const stmts = {
    moveKanbanCard: { run: vi.fn() },
    updateKanbanCard: { run: vi.fn() },
    createSession: { run: vi.fn() },
    getSession: { get: vi.fn(() => undefined) },
    getKanbanEpic: { get: vi.fn(() => undefined) },
    getRecentEscalationByTypeAndPr: { get: vi.fn(() => undefined) },
    createEscalation: { run: vi.fn() },
    acknowledgeEscalation: { run: vi.fn() },
    getEscalation: {
      get: vi.fn(() => ({
        id: 'esc-1',
        project_id: 'proj-1',
        type: 'review_needed',
        title: '',
        description: '',
        pr_number: 42,
        pr_url: null,
        card_id: 'card-1',
        source: 'webhook',
        acknowledged_at: null,
        created_at: '',
      })),
    },
  };
  return {
    stmts,
    broadcast: vi.fn(),
    getGhBotUser: vi.fn(() => overrides.ghBotUser ?? null),
    getGhAppSlug: vi.fn(() => overrides.ghAppSlug ?? null),
    getGhAuthenticatedUser: vi.fn(() => overrides.ghAuthenticatedUser ?? null),
    findAgent: vi.fn((id: string) => PROJECT.agents.find((a) => a.id === id) || null),
    handleChat: vi.fn(
      async (
        _ws: unknown,
        msg: ChatMessage & { _onUserMessagePersisted?: (ok: boolean) => void },
      ) => {
        msg._onUserMessagePersisted?.(true);
      },
    ),
  };
}

function payload(reviewOverrides: { state: string; body?: string; senderLogin: string }) {
  return {
    pull_request: {
      number: 42,
      title: 'Implement feature X',
      html_url: 'https://github.com/owner/repo/pull/42',
    },
    repository: {
      full_name: 'owner/repo',
      html_url: 'https://github.com/owner/repo',
    },
    review: {
      id: 9_009_001,
      state: reviewOverrides.state,
      body: reviewOverrides.body || '',
      user: { login: reviewOverrides.senderLogin },
    },
    sender: { login: reviewOverrides.senderLogin },
  };
}

describe('handleWebhookPrReview — self-filter narrowed to sentinel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastDispatchedReviewId.clear();
  });

  it("dispatches when a human on the auth'd account submits CHANGES_REQUESTED (no sentinel)", async () => {
    // This is the bug the fix closes: previously the sender-identity match
    // dropped the event, the author agent stayed asleep, PR sat idle.
    const deps = makeDeps({ ghAuthenticatedUser: 'ryan-human' });

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: 'Please address the null-pointer risk in foo.ts:42',
        senderLogin: 'ryan-human',
      }) as never,
      'ryan-human',
    );

    expect(handled).toBe(true);
    // Card moves to In Progress — workflow home for author follow-up; the poll
    // fallback also scans In Progress so missed webhooks still reach busy cards.
    expect(deps.stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-in-progress', 0, 'card-1');
    // A fresh author session is spawned (card.session_id was null).
    expect(deps.stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    expect(lastDispatchedReviewId.get('card-1')).toBe(9_009_001);
    const chatMsg = (deps.handleChat.mock.calls[0] as unknown as unknown[])?.[1] as {
      content: string;
    };
    expect(chatMsg.content).toContain('PR Review Feedback');
    expect(chatMsg.content).toContain('ryan-human');
  });

  it('does not record dedup when review prompt is not persisted (e.g. full queue)', async () => {
    const deps = makeDeps({ ghAuthenticatedUser: 'ryan-human' });
    deps.handleChat = vi.fn(
      async (
        _ws: unknown,
        msg: ChatMessage & { _onUserMessagePersisted?: (ok: boolean) => void },
      ) => {
        msg._onUserMessagePersisted?.(false);
      },
    );

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: 'Fix the bug',
        senderLogin: 'ryan-human',
      }) as never,
      'ryan-human',
    );

    expect(handled).toBe(true);
    expect(lastDispatchedReviewId.get('card-1')).toBeUndefined();
  });

  it('skips a CHANGES_REQUESTED review when the body carries the bot sentinel', async () => {
    // Defense-in-depth: if an agent ignores guidance and posts via `gh pr
    // review` under the CLI identity, the body sentinel still suppresses the
    // self-loop.
    const deps = makeDeps({ ghAuthenticatedUser: 'ryan-human' });

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: `${AGENT_HUB_BOT_SENTINEL}\n\nFound a null check missing.`,
        senderLogin: 'ryan-human',
      }) as never,
      'ryan-human',
    );

    expect(handled).toBe(false);
    expect(deps.stmts.moveKanbanCard.run).not.toHaveBeenCalled();
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('skips an APPROVED review from the bot PAT user (ghBotUser) — loop prevention', async () => {
    // `approved` from a bot identity is the canonical self-trigger loop:
    // bot pushes → synchronize → reviewer dispatches → bot posts approval
    // → suppress here so we don't auto-confirm our own work.
    const deps = makeDeps({ ghBotUser: 'agent-hub-bot' });

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'approved',
        body: 'Looks good to me.',
        senderLogin: 'agent-hub-bot',
      }) as never,
      'agent-hub-bot',
    );

    expect(handled).toBe(false);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('skips an APPROVED review from the GitHub App bot — loop prevention', async () => {
    const deps = makeDeps({ ghAppSlug: 'ryan-s-agent-hub-reviewer' });

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'approved',
        body: 'App-posted approval.',
        senderLogin: 'ryan-s-agent-hub-reviewer[bot]',
      }) as never,
      'ryan-s-agent-hub-reviewer[bot]',
    );

    expect(handled).toBe(false);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('dispatches a CHANGES_REQUESTED review from the bot PAT user (ghBotUser)', async () => {
    // Card 8303f269: the reviewer pipeline posts formal reviews under a bot
    // identity. CHANGES_REQUESTED from a bot is the signal that the author
    // agent needs to wake up — must propagate, not skip.
    const deps = makeDeps({ ghBotUser: 'agent-hub-bot' });

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: 'Bot-authored REQUEST_CHANGES — fix the null-pointer.',
        senderLogin: 'agent-hub-bot',
      }) as never,
      'agent-hub-bot',
    );

    expect(handled).toBe(true);
    expect(deps.stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-in-progress', 0, 'card-1');
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    expect(lastDispatchedReviewId.get('card-1')).toBe(9_009_001);
  });

  it('dispatches a CHANGES_REQUESTED review from the GitHub App bot (${ghAppSlug}[bot])', async () => {
    // This is the exact prod failure mode on mcsteen/surveytracker#678: the
    // reviewer App posted REQUEST_CHANGES via `POST /api/pr/review`, sender
    // was `${ghAppSlug}[bot]`, the old blanket-skip swallowed it, card sat
    // stranded in Review. After the fix the same payload must propagate.
    const deps = makeDeps({ ghAppSlug: 'ryan-s-agent-hub-reviewer' });

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: 'REQUEST_CHANGES — silent regression of MCS-2173 block-transform handling.',
        senderLogin: 'ryan-s-agent-hub-reviewer[bot]',
      }) as never,
      'ryan-s-agent-hub-reviewer[bot]',
    );

    expect(handled).toBe(true);
    expect(deps.stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-in-progress', 0, 'card-1');
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    expect(lastDispatchedReviewId.get('card-1')).toBe(9_009_001);
  });

  it('still dispatches for a different human reviewer not tied to any bot identity', async () => {
    // Nothing fancy — a teammate reviewed the PR. Must always flow through.
    const deps = makeDeps({
      ghAuthenticatedUser: 'ryan-human',
      ghBotUser: 'agent-hub-bot',
      ghAppSlug: 'ryan-s-agent-hub-reviewer',
    });

    const handled = await handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: 'Looks off to me — fix the error handling.',
        senderLogin: 'someone-else',
      }) as never,
      'someone-else',
    );

    expect(handled).toBe(true);
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    expect(lastDispatchedReviewId.get('card-1')).toBe(9_009_001);
  });
});
