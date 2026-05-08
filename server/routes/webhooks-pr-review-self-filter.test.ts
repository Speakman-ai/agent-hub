import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_HUB_BOT_SENTINEL, handleWebhookPrReview } from './webhooks.js';
import { lastDispatchedReviewId } from '../review-feedback-dedup.js';
import type { Project, KanbanCardRow, KanbanColumnRow } from '../types.js';

// Regression coverage for `handleWebhookPrReview`'s self-trigger filter.
//
// Background: on single-maintainer Agent Hub deployments, the server's `gh`
// CLI is authed as the maintainer's personal account. The original filter
// skipped any review whose `sender.login` matched that account — which also
// silently dropped *manual* human CHANGES_REQUESTED reviews, leaving the
// author agent unable to wake up.
//
// The fix: require a bot sentinel in the review body before treating a
// match-by-CLI-identity review as self-posted. Other bot identities
// (`ghBotUser` PAT, `${ghAppSlug}[bot]` App) are still blanket-filtered
// because they are unambiguously bots.

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
    handleChat: vi.fn(() => Promise.resolve()),
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

  it("dispatches when a human on the auth'd account submits CHANGES_REQUESTED (no sentinel)", () => {
    // This is the bug the fix closes: previously the sender-identity match
    // dropped the event, the author agent stayed asleep, PR sat idle.
    const deps = makeDeps({ ghAuthenticatedUser: 'ryan-human' });

    const handled = handleWebhookPrReview(
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

  it('skips a CHANGES_REQUESTED review when the body carries the bot sentinel', () => {
    // Defense-in-depth: if an agent ignores guidance and posts via `gh pr
    // review` under the CLI identity, the body sentinel still suppresses the
    // self-loop.
    const deps = makeDeps({ ghAuthenticatedUser: 'ryan-human' });

    const handled = handleWebhookPrReview(
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

  it('skips when sender is the bot PAT user (ghBotUser), regardless of body content', () => {
    const deps = makeDeps({ ghBotUser: 'agent-hub-bot' });

    const handled = handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: 'Plain bot-authored critique, no sentinel.',
        senderLogin: 'agent-hub-bot',
      }) as never,
      'agent-hub-bot',
    );

    expect(handled).toBe(false);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('skips when sender is the GitHub App bot (${ghAppSlug}[bot]), regardless of body content', () => {
    const deps = makeDeps({ ghAppSlug: 'ryan-s-agent-hub-reviewer' });

    const handled = handleWebhookPrReview(
      deps as never,
      CARD,
      PROJECT,
      COLS,
      payload({
        state: 'changes_requested',
        body: 'App-posted review body.',
        senderLogin: 'ryan-s-agent-hub-reviewer[bot]',
      }) as never,
      'ryan-s-agent-hub-reviewer[bot]',
    );

    expect(handled).toBe(false);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('still dispatches for a different human reviewer not tied to any bot identity', () => {
    // Nothing fancy — a teammate reviewed the PR. Must always flow through.
    const deps = makeDeps({
      ghAuthenticatedUser: 'ryan-human',
      ghBotUser: 'agent-hub-bot',
      ghAppSlug: 'ryan-s-agent-hub-reviewer',
    });

    const handled = handleWebhookPrReview(
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
