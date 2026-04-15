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

  it('tells agent to run gh pr review when neither bot token nor GitHub App is configured', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({});
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/44', null, {
      id: 'dev-1',
    } as Agent);

    const prompt = getCapturedPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toMatch(/gh pr review/);
    expect(prompt).not.toContain('Do **NOT** run');
  });

  it('includes instruction not to create kanban cards during reviews', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps();
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
    const { mockDeps, getCapturedPrompt } = makeDeps();
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
    const { mockDeps, getCapturedPrompt } = makeDeps();
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/46', null, {
      id: 'dev-1',
      name: 'Dev',
    } as Agent);

    expect(getCapturedPrompt()).toBeTruthy();
    expect(mockDeps.handleChat).toHaveBeenCalled();
  });

  it('proceeds with review when subAgent is null (ad-hoc review)', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps();
    initAutonomous(mockDeps as unknown as Parameters<typeof initAutonomous>[0]);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/47', null, undefined);

    expect(getCapturedPrompt()).toBeTruthy();
    expect(mockDeps.handleChat).toHaveBeenCalled();
  });
});
