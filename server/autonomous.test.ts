import { vi, type Mock } from 'vitest';
import type { Agent, Project, KanbanCardRow } from './types.js';

// ─── Module mocks (hoisted before imports) ────────────────────────────────

vi.mock('child_process', async () => {
  const { promisify } = await import('util');

  const fn = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (typeof _opts === 'function') {
        (_opts as (err: Error | null, stdout: string, stderr: string) => void)(null, '', '');
      } else if (cb) {
        cb(null, '', '');
      }
      return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
    },
  );

  // Attach custom promisify symbol so `promisify(execFile)` returns { stdout, stderr }
  (fn as unknown as Record<symbol, unknown>)[promisify.custom] = (
    ...args: unknown[]
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      fn(
        ...(args as [string, string[], unknown]),
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(Object.assign(err, { stdout, stderr }));
          else resolve({ stdout, stderr });
        },
      );
    });

  return {
    execFile: fn,
    spawn: vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    })),
  };
});

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
  schedule: vi.fn(),
}));

vi.mock('./routes/board.js', () => ({
  getOrCreateBoard: vi.fn(),
}));

vi.mock('./routes/webhooks.js', () => ({
  notifyDispatchFailure: vi.fn(),
  dispatchReviewFeedback: vi.fn(),
}));

vi.mock('./worktree.js', () => ({
  removeWorkspace: vi.fn(),
}));

vi.mock('./github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(() => null),
}));

const {
  initAutonomous,
  leadReviewPR,
  handleReviewOutcome,
  extractReviewBody,
  parsePrUrl,
  reviewSessionCards,
  submitGitHubReview,
  mergeApprovedPR,
  checkCIPassing,
  checkResolvedComments,
  checkPrMergeability,
  botGhEnv,
  triggerReviewForCard,
  addSelfAsReviewer,
} = await import('./autonomous.js');

const { getOrCreateBoard } = await import('./routes/board.js');
const { dispatchReviewFeedback } = await import('./routes/webhooks.js');
const { removeWorkspace } = await import('./worktree.js');
const { githubApiRequest, resolveInstallationId } = await import('./github-app.js');
const { execFile: mockExecFileRaw } = await import('child_process');

const mockGetOrCreateBoard = getOrCreateBoard as Mock;
const mockDispatchReviewFeedback = dispatchReviewFeedback as Mock;
const mockRemoveWorkspace = removeWorkspace as Mock;
const mockGithubApiRequest = githubApiRequest as Mock;
const mockResolveInstallationId = resolveInstallationId as Mock;

// ─── Types ────────────────────────────────────────────────────────────────

interface MockConfig {
  botGithubToken: string | null;
  githubApp: {
    appId: string;
    appSlug: string;
    privateKey: string;
    installationId: string;
    installations: Array<{ id: string; account: string; accountType: string }>;
  } | null;
  githubWorkflow?: {
    autoReview?: boolean;
    autoMerge?: boolean;
    waitForCI?: boolean;
    waitForResolvedComments?: boolean;
  };
}

interface MockStmts {
  createSession: { run: Mock };
  insertMessage: { run: Mock };
  getKanbanEpic: { get: Mock };
  setCardReviewStatus: { run: Mock };
  createReviewLog: { run: Mock };
  getSession: { get: Mock };
  getKanbanColumns: { all: Mock };
  getKanbanCard: { get: Mock };
  getKanbanCards: { all: Mock };
  moveKanbanCard: { run: Mock };
  createKanbanCardComment: { run: Mock };
  deleteSession: { run: Mock };
  getKanbanBoard: { get: Mock };
  getKanbanEpics: { all: Mock };
}

interface MockDeps {
  stmts: MockStmts;
  broadcast: Mock;
  findProject: Mock;
  findAgent: Mock;
  handleChat: Mock;
  handleCancel: Mock;
  getActiveProcesses: Mock;
  getProjects: Mock;
  getConfig: Mock;
  getGhAuthenticatedUser: Mock;
  getGhBotUser: Mock;
  getGhAppSlug: Mock;
  getWebhookHandlerDeps: Mock;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeDeps(configOverrides: Partial<MockConfig> = {}): {
  mockDeps: MockDeps;
  getCapturedPrompt: () => string | null;
} {
  const config: MockConfig = {
    botGithubToken: null,
    githubApp: null,
    ...configOverrides,
  };

  let capturedPrompt: string | null = null;

  const stmts: MockStmts = {
    createSession: { run: vi.fn() },
    insertMessage: { run: vi.fn() },
    getKanbanEpic: { get: vi.fn(() => null) },
    setCardReviewStatus: { run: vi.fn() },
    createReviewLog: { run: vi.fn() },
    getSession: { get: vi.fn(() => null) },
    getKanbanColumns: { all: vi.fn(() => []) },
    getKanbanCard: { get: vi.fn(() => null) },
    getKanbanCards: { all: vi.fn(() => []) },
    moveKanbanCard: { run: vi.fn() },
    createKanbanCardComment: { run: vi.fn() },
    deleteSession: { run: vi.fn() },
    getKanbanBoard: { get: vi.fn(() => null) },
    getKanbanEpics: { all: vi.fn(() => []) },
  };

  const mockDeps: MockDeps = {
    stmts,
    broadcast: vi.fn(),
    findProject: vi.fn(),
    findAgent: vi.fn(),
    handleChat: vi.fn((_ws: unknown, msg: { content: string }) => {
      capturedPrompt = msg.content;
      return Promise.resolve();
    }),
    handleCancel: vi.fn(),
    getActiveProcesses: vi.fn(() => new Map()),
    getProjects: vi.fn(() => []),
    getConfig: vi.fn(() => config),
    getGhAuthenticatedUser: vi.fn(() => 'test-user'),
    getGhBotUser: vi.fn(() => (configOverrides.botGithubToken ? 'bot-user' : null)),
    getGhAppSlug: vi.fn(() => configOverrides.githubApp?.appSlug || null),
    getWebhookHandlerDeps: vi.fn(() => ({})),
  };

  return { mockDeps, getCapturedPrompt: () => capturedPrompt };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    cwd: '/tmp',
    ahw: '',
    githubWorkflow: {},
    agents: [
      {
        id: 'lead-1',
        name: 'Lead',
        role: 'lead',
        engine: 'claude-code',
        model: 'claude-sonnet-4-20250514',
      },
      { id: 'dev-1', name: 'Dev', role: 'developer', engine: 'claude-code' },
    ],
    ...overrides,
  } as Project;
}

function makeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-review',
    title: 'Test Feature',
    description: 'A test card',
    position: 0,
    assignee: 'Dev',
    pr_url: 'https://github.com/owner/repo/pull/42',
    epic_id: null,
    review_status: null,
    session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    priority: 'medium',
    iterations: 0,
    ...overrides,
  } as KanbanCardRow;
}

const BOARD_COLS = [
  { id: 'col-todo', name: 'To Do' },
  { id: 'col-progress', name: 'In Progress' },
  { id: 'col-review', name: 'Review' },
  { id: 'col-done', name: 'Done' },
];

function setupBoardMock(card?: KanbanCardRow | null): void {
  mockGetOrCreateBoard.mockReturnValue({
    board: { id: 'board-1', project_id: 'proj-1' },
    columns: BOARD_COLS,
    cards: card ? [card] : [],
    epics: [],
  });
}

/** Seed reviewSessionCards and getSession for handleReviewOutcome tests */
function seedReviewSession(
  mockDeps: MockDeps,
  sessionId: string,
  opts: {
    card?: KanbanCardRow | null;
    prUrl?: string;
    reviewerAgent?: string;
    autoMergeOverride?: boolean;
    sessionName?: string;
  } = {},
): void {
  const prUrl = opts.prUrl ?? 'https://github.com/owner/repo/pull/42';
  const card = opts.card ?? null;

  reviewSessionCards.set(sessionId, {
    cardId: card?.id || null,
    prUrl,
    reviewerAgent: opts.reviewerAgent || 'Lead',
    autoMergeOverride: opts.autoMergeOverride,
  });

  mockDeps.stmts.getSession.get.mockReturnValue({
    name: opts.sessionName ?? `Review: ${card?.title || 'Test Feature'}`,
    worktree_path: null,
  });

  if (card) {
    mockDeps.stmts.getKanbanCard.get.mockReturnValue(card);
  }

  mockDeps.stmts.getKanbanColumns.all.mockReturnValue(BOARD_COLS);
  mockDeps.stmts.getKanbanCards.all.mockReturnValue(card ? [card] : []);
  setupBoardMock(card);
}

// ─── Clean up between tests ──────────────────────────────────────────────

const mockExecFile = mockExecFileRaw as unknown as Mock;

function defaultExecFileImpl(
  _cmd: string,
  _args: string[],
  _opts: unknown,
  cb?: (err: Error | null, stdout: string, stderr: string) => void,
): { stdout: string; stderr: string; on: Mock; kill: Mock } {
  if (typeof _opts === 'function') {
    (_opts as (err: Error | null, stdout: string, stderr: string) => void)(null, '', '');
  } else if (cb) {
    cb(null, '', '');
  }
  return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
}

/** Restore the default execFile mock (returns empty string, no error) */
function restoreExecFileMock(): void {
  mockExecFile.mockImplementation(defaultExecFileImpl);
}

beforeEach(() => {
  reviewSessionCards.clear();
  mockGetOrCreateBoard.mockReset();
  mockDispatchReviewFeedback.mockReset();
  mockRemoveWorkspace.mockReset();
  mockGithubApiRequest.mockReset();
  mockResolveInstallationId.mockReturnValue(null);
  restoreExecFileMock();
});

// ═══════════════════════════════════════════════════════════════════════════
//  parsePrUrl
// ═══════════════════════════════════════════════════════════════════════════

describe('parsePrUrl', () => {
  it('parses a standard GitHub PR URL', () => {
    expect(parsePrUrl('https://github.com/owner/repo/pull/42')).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: '42',
    });
  });

  it('parses PR URLs with org names containing hyphens', () => {
    expect(parsePrUrl('https://github.com/my-org/my-repo/pull/123')).toEqual({
      owner: 'my-org',
      repo: 'my-repo',
      number: '123',
    });
  });

  it('returns null for null input', () => {
    expect(parsePrUrl(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parsePrUrl(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePrUrl('')).toBeNull();
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parsePrUrl('https://gitlab.com/owner/repo/merge_requests/42')).toBeNull();
  });

  it('returns null for malformed PR URLs', () => {
    expect(parsePrUrl('https://github.com/owner/repo/issues/42')).toBeNull();
  });

  it('handles large PR numbers', () => {
    expect(parsePrUrl('https://github.com/owner/repo/pull/99999')).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: '99999',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  extractReviewBody
// ═══════════════════════════════════════════════════════════════════════════

describe('extractReviewBody', () => {
  it('returns default approval message for null content', () => {
    expect(extractReviewBody(null, 'approve')).toBe('Looks good — approved.');
  });

  it('returns default changes-requested message for null content', () => {
    expect(extractReviewBody(null, 'request_changes')).toBe('Changes requested.');
  });

  it('returns default approval message for undefined content', () => {
    expect(extractReviewBody(undefined, 'approve')).toBe('Looks good — approved.');
  });

  it('returns default approval message for empty string', () => {
    expect(extractReviewBody('', 'approve')).toBe('Looks good — approved.');
  });

  it('extracts body from gh pr review --body "..." syntax', () => {
    const content =
      'I reviewed the code.\ngh pr review 42 --approve --body "Great work, all tests pass"';
    expect(extractReviewBody(content, 'approve')).toBe('Great work, all tests pass');
  });

  it("extracts body from gh pr review --body '...' syntax", () => {
    const content = "gh pr review 42 --approve --body 'Clean implementation, approved'";
    expect(extractReviewBody(content, 'approve')).toBe('Clean implementation, approved');
  });

  it('extracts body from -f body="..." API syntax', () => {
    const content =
      'gh api repos/owner/repo/pulls/42/reviews --method POST -f event=APPROVE -f body="LGTM, no issues found"';
    expect(extractReviewBody(content, 'approve')).toBe('LGTM, no issues found');
  });

  it('extracts body after APPROVED marker', () => {
    const content = '**APPROVED**\nThe code looks correct. Good error handling and test coverage.';
    expect(extractReviewBody(content, 'approve')).toBe(
      'The code looks correct. Good error handling and test coverage.',
    );
  });

  it('extracts body after CHANGES REQUESTED marker', () => {
    const content =
      '**CHANGES REQUESTED**\nThere are two issues:\n1. Missing null check in handler\n2. No test for edge case';
    const result = extractReviewBody(content, 'request_changes');
    expect(result).toContain('Missing null check');
    expect(result).toContain('No test for edge case');
  });

  it('falls back to last 500 chars when no pattern matches', () => {
    const content = 'This is a review with no recognizable markers. '.repeat(20);
    const result = extractReviewBody(content, 'approve');
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('returns default when tail is empty after trimming', () => {
    // Content is all whitespace in the last 500 chars
    const content = '   ';
    expect(extractReviewBody(content, 'approve')).toBe('Looks good — approved.');
  });

  it('truncates long APPROVED/CHANGES REQUESTED bodies to 1000 chars', () => {
    const longBody = 'X'.repeat(1500);
    const content = `**APPROVED**\n${longBody}`;
    const result = extractReviewBody(content, 'approve');
    expect(result.length).toBeLessThanOrEqual(1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  botGhEnv
// ═══════════════════════════════════════════════════════════════════════════

describe('botGhEnv', () => {
  it('returns undefined when no bot token is configured', () => {
    const { mockDeps } = makeDeps({});
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);
    expect(botGhEnv()).toBeUndefined();
  });

  it('returns env with GH_TOKEN when bot token is configured', () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_test123' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);
    const env = botGhEnv();
    expect(env).toBeDefined();
    expect(env!.GH_TOKEN).toBe('ghp_test123');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  leadReviewPR — review prompt routing
// ═══════════════════════════════════════════════════════════════════════════

describe('leadReviewPR — review prompt routing', () => {
  it('tells agent NOT to run gh pr review when GitHub App is configured', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({
      githubApp: {
        appId: '12345',
        appSlug: 'agent-hub-reviewer',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        installationId: '67890',
        installations: [{ id: '67890', account: 'owner', accountType: 'User' }],
      },
    });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/42', null, {
      id: 'dev-1',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('Do **NOT** run');
    expect(prompt).toContain('GitHub App');
    expect(prompt).not.toMatch(/```bash\ngh pr review/);
  });

  it('tells agent NOT to run gh pr review when bot token is configured', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({
      botGithubToken: 'ghp_fake_token',
    });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/43', null, {
      id: 'dev-1',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('Do **NOT** run');
    expect(prompt).toContain('bot account');
    expect(prompt).not.toMatch(/```bash\ngh pr review/);
  });

  it('blocks review when neither bot token nor GitHub App is configured (no bot identity)', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({});
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/44', null, {
      id: 'dev-1',
    } as Agent);

    expect(getCapturedPrompt()).toBeNull();
    expect(mockDeps.handleChat).not.toHaveBeenCalled();
    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead_review_skipped',
        reason: 'no_bot_identity',
      }),
    );
  });

  it('includes instruction not to create kanban cards during reviews', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/50', null, {
      id: 'dev-1',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('Do NOT create kanban cards');
  });

  it('includes PR URL and author name in prompt', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/99', null, {
      id: 'dev-1',
      name: 'Dev Agent',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toContain('https://github.com/owner/repo/pull/99');
    expect(prompt).toContain('Dev Agent');
  });

  it('includes card description when card is provided', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ description: 'Refactor auth middleware' });
    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/55', card, {
      id: 'dev-1',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toContain('Refactor auth middleware');
  });

  it('skips review when autoReview is disabled', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const project = makeProject({ githubWorkflow: { autoReview: false } });
    await leadReviewPR(project, 'https://github.com/owner/repo/pull/60', null, {
      id: 'dev-1',
    } as Agent);

    expect(getCapturedPrompt()).toBeNull();
    expect(mockDeps.handleChat).not.toHaveBeenCalled();
  });

  it('skips duplicate review of the same PR URL', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    // First review — proceeds
    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/70', null, {
      id: 'dev-1',
    } as Agent);
    expect(mockDeps.handleChat).toHaveBeenCalledTimes(1);

    // Second review of same PR — skipped (reviewSessionCards still has it)
    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/70', null, {
      id: 'dev-1',
    } as Agent);
    expect(mockDeps.handleChat).toHaveBeenCalledTimes(1); // not called again
  });

  it('sets card review_status to reviewing when card is provided', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/71', card, {
      id: 'dev-1',
    } as Agent);

    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('reviewing', card.id);
  });

  it('broadcasts lead_review event on successful dispatch', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/72', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead_review',
        projectId: 'proj-1',
        prUrl: 'https://github.com/owner/repo/pull/72',
        authorAgent: 'Dev',
      }),
    );
  });

  it('includes CI wait instructions when waitForCI is enabled', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const project = makeProject({ githubWorkflow: { waitForCI: true } });
    await leadReviewPR(project, 'https://github.com/owner/repo/pull/73', null, {
      id: 'dev-1',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toContain('Wait for CI checks');
    expect(prompt).toContain('gh pr checks');
  });

  it('includes resolved comments instructions when waitForResolvedComments is enabled', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const project = makeProject({ githubWorkflow: { waitForResolvedComments: true } });
    await leadReviewPR(project, 'https://github.com/owner/repo/pull/74', null, {
      id: 'dev-1',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toContain('unresolved review');
  });

  it('creates a session with Review: prefix in title', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ title: 'Add search endpoint' });
    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/75', card, {
      id: 'dev-1',
    } as Agent);

    expect(mockDeps.stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'lead-1',
      'Review: Add search endpoint',
      expect.any(String),
      expect.any(String),
      1,
      0,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  leadReviewPR — self-review prevention
// ═══════════════════════════════════════════════════════════════════════════

describe('leadReviewPR — self-review prevention', () => {
  it('skips review when the lead agent is also the PR author', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/45', null, {
      id: 'lead-1',
      name: 'Lead',
    } as Agent);

    expect(getCapturedPrompt()).toBeNull();
    expect(mockDeps.handleChat).not.toHaveBeenCalled();

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead_review_skipped',
        reason: 'self-review',
      }),
    );
  });

  it('proceeds with review when the lead agent is NOT the PR author', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/46', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);

    expect(getCapturedPrompt()).toBeTruthy();
    expect(mockDeps.handleChat).toHaveBeenCalled();
  });

  it('proceeds with review when subAgent is null (ad-hoc review)', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/47', null, undefined);

    expect(getCapturedPrompt()).toBeTruthy();
    expect(mockDeps.handleChat).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  leadReviewPR — round-robin reviewer rotation
// ═══════════════════════════════════════════════════════════════════════════

describe('leadReviewPR — round-robin reviewer rotation', () => {
  it('rotates reviewers among eligible agents', async () => {
    const project = {
      id: 'proj-rr',
      name: 'Round Robin Test',
      cwd: '/tmp',
      ahw: '',
      githubWorkflow: {},
      agents: [
        { id: 'lead-1', name: 'Lead A', role: 'lead', engine: 'claude-code' },
        { id: 'lead-2', name: 'Lead B', role: 'lead', engine: 'claude-code' },
        { id: 'dev-1', name: 'Dev', role: 'developer', engine: 'claude-code' },
      ],
    } as Project;

    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    // First review — should pick Lead A (index 0)
    await leadReviewPR(project, 'https://github.com/owner/repo/pull/100', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);
    expect(mockDeps.handleChat).toHaveBeenCalled();
    const firstCall = mockDeps.handleChat.mock.calls[0];
    const firstAgentId = firstCall[1].agentId;

    // Second review — should pick Lead B (index 1)
    mockDeps.handleChat.mockClear();
    await leadReviewPR(project, 'https://github.com/owner/repo/pull/101', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);
    expect(mockDeps.handleChat).toHaveBeenCalled();
    const secondCall = mockDeps.handleChat.mock.calls[0];
    const secondAgentId = secondCall[1].agentId;

    expect(firstAgentId).not.toEqual(secondAgentId);
    expect([firstAgentId, secondAgentId].sort()).toEqual(['lead-1', 'lead-2']);
  });

  it('uses canReview flag for reviewer eligibility', async () => {
    const project = {
      id: 'proj-cr',
      name: 'canReview Test',
      cwd: '/tmp',
      ahw: '',
      githubWorkflow: {},
      agents: [
        { id: 'lead-1', name: 'Lead', role: 'lead', engine: 'claude-code' },
        {
          id: 'reviewer-1',
          name: 'Reviewer',
          role: 'developer',
          canReview: true,
          engine: 'claude-code',
        },
        { id: 'dev-1', name: 'Dev', role: 'developer', engine: 'claude-code' },
      ],
    } as Project;

    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(project, 'https://github.com/owner/repo/pull/102', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);

    expect(mockDeps.handleChat).toHaveBeenCalled();
    const agentId = mockDeps.handleChat.mock.calls[0][1].agentId;
    // Should be either lead-1 or reviewer-1, but NOT dev-1
    expect(['lead-1', 'reviewer-1']).toContain(agentId);
  });

  it('excludes leads with canReview set to false', async () => {
    const project = {
      id: 'proj-no-review',
      name: 'canReview false Test',
      cwd: '/tmp',
      ahw: '',
      githubWorkflow: {},
      agents: [
        { id: 'lead-1', name: 'Lead A', role: 'lead', engine: 'claude-code' },
        { id: 'lead-2', name: 'Lead B', role: 'lead', canReview: false, engine: 'claude-code' },
        { id: 'dev-1', name: 'Dev', role: 'developer', engine: 'claude-code' },
      ],
    } as Project;

    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    // Should always pick lead-1 since lead-2 has canReview: false
    await leadReviewPR(project, 'https://github.com/owner/repo/pull/200', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);

    expect(mockDeps.handleChat).toHaveBeenCalled();
    const agentId = mockDeps.handleChat.mock.calls[0][1].agentId;
    expect(agentId).toBe('lead-1');
  });

  it('excludes inactive agents from reviewer pool', async () => {
    const project = {
      id: 'proj-inactive',
      name: 'Inactive Test',
      cwd: '/tmp',
      ahw: '',
      githubWorkflow: {},
      agents: [
        { id: 'lead-1', name: 'Lead Active', role: 'lead', engine: 'claude-code' },
        { id: 'lead-2', name: 'Lead Inactive', role: 'lead', active: false, engine: 'claude-code' },
        { id: 'dev-1', name: 'Dev', role: 'developer', engine: 'claude-code' },
      ],
    } as Project;

    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(project, 'https://github.com/owner/repo/pull/201', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);

    expect(mockDeps.handleChat).toHaveBeenCalled();
    const agentId = mockDeps.handleChat.mock.calls[0][1].agentId;
    expect(agentId).toBe('lead-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — outcome detection regex
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — outcome detection', () => {
  it('detects "APPROVED" as approved', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-1', { card });

    await handleReviewOutcome(makeProject(), 'sess-1', '**APPROVED** — the code looks great.');

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'approved' }),
    );
  });

  it('detects "Looks good" as approved', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-2', { card });

    await handleReviewOutcome(makeProject(), 'sess-2', 'Looks good, no issues found.');

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'approved' }),
    );
  });

  it('detects "LGTM" as approved', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-lgtm', { card });

    await handleReviewOutcome(makeProject(), 'sess-lgtm', 'LGTM — ship it.');

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'approved' }),
    );
  });

  it('detects "gh pr review --approve" as approved', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-3', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-3',
      'I ran: gh pr review 42 --approve --body "Looks good"',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'approved' }),
    );
  });

  it('detects "changes needed" as changes_requested', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-4', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-4',
      'CHANGES NEEDED: Fix the null check on line 42.',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'changes_requested' }),
    );
  });

  it('detects "--request-changes" as changes_requested', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-5', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-5',
      'gh pr review 42 --request-changes --body "Missing error handling"',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'changes_requested' }),
    );
  });

  it('detects "needs fix" as changes_requested', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-needsfix', { card });

    await handleReviewOutcome(makeProject(), 'sess-needsfix', 'This needs a fix before merging.');

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'changes_requested' }),
    );
  });

  it('detects merge conflict with approval as merge_conflict outcome', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-6', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-6',
      'Code looks good, APPROVED. However merge conflict detected — could not merge automatically.',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'merge_conflict' }),
    );
  });

  it('detects ambiguous outcome when no patterns match', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-7', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-7',
      'I looked at the code but I am not sure what to think about it.',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'ambiguous' }),
    );
  });

  it('prioritizes merge_conflict over plain approved when both match', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-8', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-8',
      'APPROVED. Merge failed due to conflicts — cannot merge this PR.',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'merge_conflict' }),
    );
  });

  it('detects "Must fix" as changes_requested', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-mustfix', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-mustfix',
      'Must fix: Host header rewrite in proxy-server.ts',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'changes_requested' }),
    );
  });

  it('detects "Blocking:" as changes_requested', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-blocking', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-blocking',
      'Blocking: Rebase onto main and resolve merge conflicts so CI can run.',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'changes_requested' }),
    );
  });

  it('detects "Should fix" as changes_requested', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-shouldfix', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-shouldfix',
      'Should fix: add proxy request timeouts to prevent hung connections.',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'changes_requested' }),
    );
  });

  it('prioritizes changes_requested over approved when both match', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-priority', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-priority',
      'Blocking: Rebase onto main.\n\nMust fix:\n1. Host header rewrite\n\nThe code looks good overall but approved these changes cannot proceed without fixes.',
    );

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'changes_requested' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — approved path
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — approved', () => {
  it('sets card review_status to approved', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-app-1', { card });

    await handleReviewOutcome(makeProject(), 'sess-app-1', 'APPROVED — ship it.');

    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('approved', card.id);
  });

  it('creates a review log entry', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-app-2', { card, reviewerAgent: 'Lead' });

    await handleReviewOutcome(makeProject(), 'sess-app-2', 'APPROVED — looks clean.');

    expect(mockDeps.stmts.createReviewLog.run).toHaveBeenCalledWith(
      expect.any(String), // id
      'proj-1', // project_id
      card.id, // card_id
      'https://github.com/owner/repo/pull/42', // pr_url
      'Lead', // reviewer
      'Dev', // author (card.assignee)
      'sess-app-2', // sessionId
      'approved', // outcome
      expect.any(String), // content tail
      expect.any(String), // started_at
      expect.any(String), // completed_at
    );
  });

  it('does not auto-merge when autoMerge is disabled (default)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-app-3', { card });

    await handleReviewOutcome(makeProject(), 'sess-app-3', 'APPROVED — all good.');

    // mergeApprovedPR calls execFileAsync with 'gh pr merge' — since autoMerge is off, shouldn't happen
    // We verify by checking broadcast does NOT contain merge_conflict
    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'approved' }),
    );
  });

  it('cleans up review session after completion', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-app-4', { card });

    await handleReviewOutcome(makeProject(), 'sess-app-4', 'APPROVED.');

    expect(mockDeps.stmts.deleteSession.run).toHaveBeenCalledWith('sess-app-4');
    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_deleted', sessionId: 'sess-app-4' }),
    );
  });

  it('removes reviewSessionCards entry after completion', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-app-5', { card });

    expect(reviewSessionCards.has('sess-app-5')).toBe(true);
    await handleReviewOutcome(makeProject(), 'sess-app-5', 'APPROVED.');
    expect(reviewSessionCards.has('sess-app-5')).toBe(false);
  });

  it('cleans up worktree_path if session had one', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-app-wt', { card });
    // Override getSession to return a worktree_path
    mockDeps.stmts.getSession.get.mockReturnValue({
      name: 'Review: Test Feature',
      worktree_path: '/tmp/worktrees/review-branch',
    });

    await handleReviewOutcome(makeProject(), 'sess-app-wt', 'APPROVED.');

    expect(mockRemoveWorkspace).toHaveBeenCalledWith('/tmp/worktrees/review-branch');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — changes requested path
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — changes requested', () => {
  it('sets card review_status to changes_requested', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-cr-1', { card });

    await handleReviewOutcome(makeProject(), 'sess-cr-1', 'CHANGES NEEDED: Missing null check.');

    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith(
      'changes_requested',
      card.id,
    );
  });

  it('moves card back to In Progress', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-cr-2', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-cr-2',
      'Request changes: fix the validation bug.',
    );

    expect(mockDeps.stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-progress', 0, card.id);
    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kanban_update', projectId: 'proj-1' }),
    );
  });

  it('dispatches feedback to the author agent', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-cr-3', { card });

    await handleReviewOutcome(makeProject(), 'sess-cr-3', 'Request changes: add error handling.');

    expect(mockDispatchReviewFeedback).toHaveBeenCalledWith(
      expect.anything(), // webhookHandlerDeps
      card,
      expect.objectContaining({ id: 'proj-1' }),
      expect.stringContaining('PR Review Feedback'),
    );
  });

  it('broadcasts changes_requested outcome', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-cr-4', { card });

    await handleReviewOutcome(makeProject(), 'sess-cr-4', 'CHANGES NEEDED: missing tests.');

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead_review_complete',
        outcome: 'changes_requested',
        cardTitle: 'Test Feature',
      }),
    );
  });

  it('does not dispatch feedback if card is null', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    // No card — simulate missing card scenario
    seedReviewSession(mockDeps, 'sess-cr-5', { card: null });
    mockDeps.stmts.getKanbanCard.get.mockReturnValue(null);
    mockDeps.stmts.getKanbanCards.all.mockReturnValue([]);

    await handleReviewOutcome(makeProject(), 'sess-cr-5', 'Request changes: needs more tests.');

    // When card is null, the changes_requested branch doesn't execute (it checks `changesRequested && card`)
    // so outcome falls through to ambiguous
    expect(mockDispatchReviewFeedback).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — merge conflict path
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — merge conflict', () => {
  it('sets card review_status to approved (code was good)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-mc-1', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-mc-1',
      'Code approved, but merge conflict — cannot merge.',
    );

    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('approved', card.id);
  });

  it('moves card back to In Progress', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-mc-2', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-mc-2',
      'Approved, but merge failed due to conflicts.',
    );

    expect(mockDeps.stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-progress', 0, card.id);
  });

  it('dispatches conflict resolution feedback', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-mc-3', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-mc-3',
      'Code approved but merge conflict detected.',
    );

    expect(mockDispatchReviewFeedback).toHaveBeenCalledWith(
      expect.anything(),
      card,
      expect.anything(),
      expect.stringContaining('Merge Conflict Resolution Needed'),
    );
  });

  it('broadcasts merge_conflict outcome', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-mc-4', { card });

    await handleReviewOutcome(makeProject(), 'sess-mc-4', 'Approved but merge conflict.');

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead_review_complete',
        outcome: 'merge_conflict',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — ambiguous path
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — ambiguous', () => {
  it('sets card review_status to awaiting_review', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-amb-1', { card });

    await handleReviewOutcome(
      makeProject(),
      'sess-amb-1',
      'The code is interesting but I did not decide anything.',
    );

    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('awaiting_review', card.id);
  });

  it('adds a system comment to the kanban card', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-amb-2', { card });

    await handleReviewOutcome(makeProject(), 'sess-amb-2', 'I am unsure about this code.');

    expect(mockDeps.stmts.createKanbanCardComment.run).toHaveBeenCalledWith(
      expect.any(String),
      card.id,
      'system',
      expect.stringContaining('ambiguous'),
    );
  });

  it('broadcasts ambiguous outcome', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-amb-3', { card });

    await handleReviewOutcome(makeProject(), 'sess-amb-3', 'The code seems fine maybe.');

    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead_review_complete',
        outcome: 'ambiguous',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — early exit conditions
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — early exits', () => {
  it('returns early when session is not found', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockDeps.stmts.getSession.get.mockReturnValue(null);
    setupBoardMock();

    await handleReviewOutcome(makeProject(), 'nonexistent-session', 'APPROVED');

    expect(mockDeps.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete' }),
    );
  });

  it('returns early when session name does not match Review: prefix', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockDeps.stmts.getSession.get.mockReturnValue({
      name: 'Chat: Some random session',
      worktree_path: null,
    });
    setupBoardMock();

    await handleReviewOutcome(makeProject(), 'sess-no-prefix', 'APPROVED');

    expect(mockDeps.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete' }),
    );
  });

  it('returns early when board data is not found', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockDeps.stmts.getSession.get.mockReturnValue({
      name: 'Review: Test Feature',
      worktree_path: null,
    });
    mockGetOrCreateBoard.mockReturnValue(null);

    await handleReviewOutcome(makeProject(), 'sess-no-board', 'APPROVED');

    expect(mockDeps.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — card lookup
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — card lookup', () => {
  it('finds card via reviewSessionCards tracking (by cardId)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ id: 'tracked-card' });
    seedReviewSession(mockDeps, 'sess-lookup-1', { card });

    await handleReviewOutcome(makeProject(), 'sess-lookup-1', 'APPROVED.');

    expect(mockDeps.stmts.getKanbanCard.get).toHaveBeenCalledWith('tracked-card');
  });

  it('falls back to title match when cardId is not tracked', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ title: 'My Feature' });

    // Set up reviewSessionCards without a cardId
    reviewSessionCards.set('sess-lookup-2', {
      cardId: null,
      prUrl: 'https://github.com/owner/repo/pull/42',
      reviewerAgent: 'Lead',
    });

    mockDeps.stmts.getSession.get.mockReturnValue({
      name: 'Review: My Feature',
      worktree_path: null,
    });
    mockDeps.stmts.getKanbanColumns.all.mockReturnValue(BOARD_COLS);
    mockDeps.stmts.getKanbanCards.all.mockReturnValue([card]);
    setupBoardMock(card);

    await handleReviewOutcome(makeProject(), 'sess-lookup-2', 'APPROVED.');

    // Should still find card via title match and set status
    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('approved', card.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  handleReviewOutcome — server-side mergeability check
// ═══════════════════════════════════════════════════════════════════════════

describe('handleReviewOutcome — server-side mergeability check', () => {
  it('routes to conflict resolution when PR has merge conflicts (even if reviewer said approved)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard();
    seedReviewSession(mockDeps, 'sess-merge-1', { card });

    // Mock: gh pr view returns CONFLICTING
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        // Check if this is the mergeability check
        if (args?.includes('mergeable,mergeStateStatus')) {
          callback?.(
            null,
            JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
            '',
          );
        } else {
          callback?.(null, '', '');
        }
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    await handleReviewOutcome(makeProject(), 'sess-merge-1', 'APPROVED — all good.');

    // Should route to merge_conflict path
    expect(mockDeps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead_review_complete', outcome: 'merge_conflict' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  triggerReviewForCard
// ═══════════════════════════════════════════════════════════════════════════

describe('triggerReviewForCard', () => {
  it('does nothing when card is not found', () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockDeps.stmts.getKanbanCard.get.mockReturnValue(undefined);

    triggerReviewForCard('nonexistent', makeProject());

    expect(mockDeps.handleChat).not.toHaveBeenCalled();
  });

  it('marks card as awaiting_review even when no PR URL', () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ pr_url: null as unknown as string });
    mockDeps.stmts.getKanbanCard.get.mockReturnValue(card);

    triggerReviewForCard(card.id, makeProject());

    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('awaiting_review', card.id);
    expect(mockDeps.handleChat).not.toHaveBeenCalled();
  });

  it('triggers leadReviewPR when card has a PR URL', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ assignee: 'Dev' });
    mockDeps.stmts.getKanbanCard.get.mockReturnValue(card);

    triggerReviewForCard(card.id, makeProject());

    // leadReviewPR is called async via .catch, give it a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('awaiting_review', card.id);
    expect(mockDeps.handleChat).toHaveBeenCalled();
  });

  it('matches assignee name to project agent for subAgent', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ assignee: 'Dev' });
    mockDeps.stmts.getKanbanCard.get.mockReturnValue(card);

    triggerReviewForCard(card.id, makeProject());
    await new Promise((r) => setTimeout(r, 10));

    // The prompt should be sent — Dev is not the lead, so no self-review block
    expect(mockDeps.handleChat).toHaveBeenCalled();
  });

  it('passes autoMergeOverride options through to leadReviewPR', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ assignee: 'Dev' });
    mockDeps.stmts.getKanbanCard.get.mockReturnValue(card);

    // Call with autoMergeOverride: true
    triggerReviewForCard(card.id, makeProject(), { autoMergeOverride: true });
    await new Promise((r) => setTimeout(r, 10));

    // The review should be triggered (handleChat called)
    expect(mockDeps.handleChat).toHaveBeenCalled();
    expect(mockDeps.stmts.setCardReviewStatus.run).toHaveBeenCalledWith('awaiting_review', card.id);
  });

  it('works without options (backward compatibility)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const card = makeCard({ assignee: 'Dev' });
    mockDeps.stmts.getKanbanCard.get.mockReturnValue(card);

    // Call without options — should still work
    triggerReviewForCard(card.id, makeProject());
    await new Promise((r) => setTimeout(r, 10));

    expect(mockDeps.handleChat).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  checkCIPassing
// ═══════════════════════════════════════════════════════════════════════════

describe('checkCIPassing', () => {
  it('returns ok:true with no checks configured', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(null, '[]', '');
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkCIPassing('https://github.com/owner/repo/pull/1');
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('No CI checks');
  });

  it('returns ok:false when checks are pending', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(
          null,
          JSON.stringify([
            { name: 'build', state: 'PENDING', conclusion: null },
            { name: 'lint', state: 'COMPLETED', conclusion: 'SUCCESS' },
          ]),
          '',
        );
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkCIPassing('https://github.com/owner/repo/pull/2');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('build');
  });

  it('returns ok:false when checks are failing', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(
          null,
          JSON.stringify([{ name: 'test', state: 'COMPLETED', conclusion: 'FAILURE' }]),
          '',
        );
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkCIPassing('https://github.com/owner/repo/pull/3');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('test');
    expect(result.summary).toContain('FAILURE');
  });

  it('returns ok:true when all checks pass', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(
          null,
          JSON.stringify([
            { name: 'build', state: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'test', state: 'COMPLETED', conclusion: 'SUCCESS' },
          ]),
          '',
        );
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkCIPassing('https://github.com/owner/repo/pull/4');
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('2 check(s) passing');
  });

  it('treats NEUTRAL and SKIPPED conclusions as passing', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(
          null,
          JSON.stringify([
            { name: 'optional', state: 'COMPLETED', conclusion: 'NEUTRAL' },
            { name: 'skipped', state: 'COMPLETED', conclusion: 'SKIPPED' },
          ]),
          '',
        );
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkCIPassing('https://github.com/owner/repo/pull/5');
    expect(result.ok).toBe(true);
  });

  it('returns ok:false for invalid PR URL', async () => {
    const result = await checkCIPassing('not-a-url');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Invalid PR URL');
  });

  it('returns ok:true when gh CLI fails (graceful degradation)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(new Error('gh not found'), '', '');
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkCIPassing('https://github.com/owner/repo/pull/6');
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('proceeding');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  checkResolvedComments
// ═══════════════════════════════════════════════════════════════════════════

describe('checkResolvedComments', () => {
  it('returns ok:true when all threads are resolved', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(
          null,
          JSON.stringify({
            reviewThreads: [{ isResolved: true }, { isResolved: true }],
          }),
          '',
        );
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkResolvedComments('https://github.com/owner/repo/pull/10');
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
  });

  it('returns ok:false with unresolved thread count', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(
          null,
          JSON.stringify({
            reviewThreads: [{ isResolved: false }, { isResolved: true }, { isResolved: false }],
          }),
          '',
        );
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkResolvedComments('https://github.com/owner/repo/pull/11');
    expect(result.ok).toBe(false);
    expect(result.count).toBe(2);
    expect(result.summary).toContain('2 unresolved');
  });

  it('returns ok:false for invalid PR URL', async () => {
    const result = await checkResolvedComments('bad-url');
    expect(result.ok).toBe(false);
  });

  it('returns ok:true when no review threads exist', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(null, JSON.stringify({ reviewThreads: [] }), '');
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkResolvedComments('https://github.com/owner/repo/pull/12');
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  checkPrMergeability
// ═══════════════════════════════════════════════════════════════════════════

describe('checkPrMergeability', () => {
  it('returns true when PR has merge conflicts (CONFLICTING)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(
          null,
          JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
          '',
        );
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkPrMergeability({ owner: 'o', repo: 'r', number: '1' });
    expect(result).toBe(true);
  });

  it('returns false when PR is mergeable', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), '');
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkPrMergeability({ owner: 'o', repo: 'r', number: '1' });
    expect(result).toBe(false);
  });

  it('returns false when CLI fails (assumes no conflicts)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(new Error('gh not found'), '', '');
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await checkPrMergeability({ owner: 'o', repo: 'r', number: '1' });
    expect(result).toBe(false);
  });

  it('uses GitHub App when configured', async () => {
    const { mockDeps } = makeDeps({
      githubApp: {
        appId: '12345',
        appSlug: 'test-app',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        installationId: '67890',
        installations: [{ id: '67890', account: 'o', accountType: 'User' }],
      },
    });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockResolveInstallationId.mockReturnValue('67890');
    mockGithubApiRequest.mockResolvedValue({ mergeable: false, mergeable_state: 'dirty' });

    const result = await checkPrMergeability({ owner: 'o', repo: 'r', number: '1' });
    expect(result).toBe(true);
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      '/repos/o/r/pulls/1',
      expect.objectContaining({ appId: '12345' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  submitGitHubReview
// ═══════════════════════════════════════════════════════════════════════════

describe('submitGitHubReview', () => {
  it('returns false for invalid PR URL', async () => {
    const result = await submitGitHubReview('not-a-url', 'APPROVE', 'LGTM');
    expect(result).toBe(false);
  });

  it('uses GitHub App when configured and installation found', async () => {
    const { mockDeps } = makeDeps({
      githubApp: {
        appId: '12345',
        appSlug: 'test-app',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        installationId: '67890',
        installations: [{ id: '67890', account: 'owner', accountType: 'User' }],
      },
    });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockResolveInstallationId.mockReturnValue('67890');
    mockGithubApiRequest.mockResolvedValue({});

    const result = await submitGitHubReview(
      'https://github.com/owner/repo/pull/42',
      'APPROVE',
      'Looks good.',
    );
    expect(result).toBe(true);
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      '/repos/owner/repo/pulls/42/reviews',
      expect.objectContaining({
        method: 'POST',
        body: { event: 'APPROVE', body: 'Looks good.' },
      }),
    );
  });

  it('falls back to gh CLI when GitHub App has no installation for owner', async () => {
    const { mockDeps } = makeDeps({
      githubApp: {
        appId: '12345',
        appSlug: 'test-app',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        installationId: '67890',
        installations: [{ id: '67890', account: 'other-org', accountType: 'Organization' }],
      },
      botGithubToken: 'ghp_fallback',
    });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockResolveInstallationId.mockReturnValue(null);

    // The gh CLI (execFile) mock returns success
    const result = await submitGitHubReview(
      'https://github.com/owner/repo/pull/43',
      'APPROVE',
      'OK',
    );
    // Should succeed via gh CLI fallback
    expect(result).toBe(true);
  });

  it('falls back to comment+label when both App and CLI fail', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const { execFile } = await import('child_process');
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callCount++;
        // First call (gh api reviews) fails, subsequent calls (comment, label, etc.) succeed
        if (callCount === 1) {
          callback?.(new Error('API error'), '', '');
        } else {
          callback?.(null, '', '');
        }
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await submitGitHubReview(
      'https://github.com/owner/repo/pull/44',
      'APPROVE',
      'Approved.',
    );
    // Fallback returns false (not a formal review)
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  mergeApprovedPR
// ═══════════════════════════════════════════════════════════════════════════

describe('mergeApprovedPR', () => {
  it('returns false for invalid PR URL', async () => {
    const result = await mergeApprovedPR('not-a-url');
    expect(result).toBe(false);
  });

  it('returns true on successful merge via CLI', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const result = await mergeApprovedPR('https://github.com/owner/repo/pull/42');
    expect(result).toBe(true);
  });

  it('returns true when PR is already merged (idempotent)', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(new Error('already merged'), '', '');
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await mergeApprovedPR('https://github.com/owner/repo/pull/42');
    expect(result).toBe(true);
  });

  it('uses GitHub App when configured', async () => {
    const { mockDeps } = makeDeps({
      githubApp: {
        appId: '12345',
        appSlug: 'test-app',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        installationId: '67890',
        installations: [{ id: '67890', account: 'owner', accountType: 'User' }],
      },
    });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockResolveInstallationId.mockReturnValue('67890');
    mockGithubApiRequest.mockResolvedValueOnce({}); // merge
    mockGithubApiRequest.mockResolvedValueOnce({ head: { ref: 'feature-branch' } }); // get PR
    mockGithubApiRequest.mockResolvedValueOnce({}); // delete branch

    const result = await mergeApprovedPR('https://github.com/owner/repo/pull/42');
    expect(result).toBe(true);
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      '/repos/owner/repo/pulls/42/merge',
      expect.objectContaining({
        method: 'PUT',
        body: { merge_method: 'squash' },
      }),
    );
  });

  it('returns false when merge fails for non-"already merged" reason', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_fake' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(new Error('not mergeable due to conflicts'), '', '');
        return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
      },
    );

    const result = await mergeApprovedPR('https://github.com/owner/repo/pull/42');
    expect(result).toBe(false);
  });
});

describe('submitGitHubReview — personal profile guard', () => {
  it('refuses to submit review when no bot token is configured', async () => {
    const { mockDeps } = makeDeps({}); // no botGithubToken, no githubApp
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    const result = await submitGitHubReview(
      'https://github.com/owner/repo/pull/99',
      'APPROVE',
      'Looks good',
    );
    expect(result).toBe(false);
  });

  it('submits review when bot token is configured', async () => {
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_bot123' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    // execFile mock returns success, so this should succeed
    const result = await submitGitHubReview(
      'https://github.com/owner/repo/pull/99',
      'APPROVE',
      'Looks good',
    );
    expect(result).toBe(true);
  });
});

describe('addSelfAsReviewer — personal profile guard', () => {
  it('skips reviewer assignment when no bot token is configured', async () => {
    const { execFile } = await import('child_process');
    const { mockDeps } = makeDeps({}); // no botGithubToken, no githubApp
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    (execFile as unknown as Mock).mockClear();
    await addSelfAsReviewer('https://github.com/owner/repo/pull/99');

    // Should NOT have called execFile (would use personal profile)
    expect(execFile).not.toHaveBeenCalled();
  });

  it('adds reviewer when bot token is configured', async () => {
    const { execFile } = await import('child_process');
    const { mockDeps } = makeDeps({ botGithubToken: 'ghp_bot123' });
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    (execFile as unknown as Mock).mockClear();
    await addSelfAsReviewer('https://github.com/owner/repo/pull/99');

    // Should have called execFile with bot env
    expect(execFile).toHaveBeenCalled();
    const callArgs = (execFile as unknown as Mock).mock.calls[0];
    expect(callArgs[0]).toBe('gh');
    expect(callArgs[1]).toContain('--add-reviewer');
    expect(callArgs[1]).toContain('bot-user');
  });
});
