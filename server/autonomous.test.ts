import { vi, type Mock } from 'vitest';
import type { Agent, Project, KanbanCardRow } from './types.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(
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
  ),
}));

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
  schedule: vi.fn(),
}));

const { initAutonomous, leadReviewPR } = await import('./autonomous.js');

interface MockConfig {
  botGithubToken: string | null;
  githubApp: {
    appId: string;
    appSlug: string;
    privateKey: string;
    installationId: string;
    installations: Array<{ id: string; account: string; accountType: string }>;
  } | null;
}

interface MockStmts {
  createSession: { run: Mock };
  insertMessage: { run: Mock };
  getKanbanEpic: { get: Mock };
  setCardReviewStatus: { run: Mock };
  createReviewLog: { run: Mock };
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

function makeProject(): Project {
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
  } as Project;
}

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
});

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
});
