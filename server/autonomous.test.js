import { describe, it, expect, vi } from 'vitest';

// Mock child_process.execFile before autonomous.js imports it
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd, _args, _opts, cb) => {
    if (typeof _opts === 'function') {
      _opts(null, '', '');
    } else if (cb) {
      cb(null, '', '');
    }
    return { stdout: '', stderr: '', on: vi.fn(), kill: vi.fn() };
  }),
}));

// Mock node-cron to avoid scheduling side effects
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
  schedule: vi.fn(),
}));

const { initAutonomous, leadReviewPR } = await import('./autonomous.js');

/**
 * Test that the review prompt correctly routes through the server
 * (instead of using `gh pr review` via the CLI) when a GitHub App
 * or bot token is configured.
 *
 * Bug: Previously only `hasBotToken` was checked when building the
 * review prompt. When a GitHub App was configured (no bot token),
 * the agent was told to run `gh pr review` directly — which used the
 * user's personal gh CLI auth, causing reviews under their account.
 */

function makeDeps(configOverrides = {}) {
  const config = {
    botGithubToken: null,
    githubApp: null,
    ...configOverrides,
  };

  let capturedPrompt = null;

  const stmts = {
    createSession: { run: vi.fn() },
    insertMessage: { run: vi.fn() },
    getKanbanEpic: { get: vi.fn(() => null) },
  };

  const mockDeps = {
    stmts,
    broadcast: vi.fn(),
    findProject: vi.fn(),
    findAgent: vi.fn(),
    handleChat: vi.fn((_ws, msg) => {
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

function makeProject() {
  return {
    id: 'proj-1',
    name: 'Test Project',
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
  };
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
    initAutonomous(mockDeps);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/42', null, {
      id: 'dev-1',
    });

    const prompt = getCapturedPrompt();
    expect(prompt).toBeTruthy();
    // Should tell agent NOT to run gh pr review
    expect(prompt).toContain('Do **NOT** run');
    expect(prompt).toContain('GitHub App');
    // Should NOT contain gh pr review bash command instructions
    expect(prompt).not.toMatch(/```bash\ngh pr review/);
  });

  it('tells agent NOT to run gh pr review when bot token is configured', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({
      botGithubToken: 'ghp_fake_token',
    });
    initAutonomous(mockDeps);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/43', null, {
      id: 'dev-1',
    });

    const prompt = getCapturedPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('Do **NOT** run');
    expect(prompt).toContain('bot account');
    expect(prompt).not.toMatch(/```bash\ngh pr review/);
  });

  it('tells agent to run gh pr review when neither bot token nor GitHub App is configured', async () => {
    const { mockDeps, getCapturedPrompt } = makeDeps({
      // no botGithubToken, no githubApp
    });
    initAutonomous(mockDeps);

    await leadReviewPR(makeProject(), 'https://github.com/owner/repo/pull/44', null, {
      id: 'dev-1',
    });

    const prompt = getCapturedPrompt();
    expect(prompt).toBeTruthy();
    // Should contain gh pr review command since there's no server-side handler
    expect(prompt).toMatch(/gh pr review/);
    // Should NOT contain the "Do NOT run" restriction
    expect(prompt).not.toContain('Do **NOT** run');
  });
});
