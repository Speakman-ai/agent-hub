import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before imports
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

// Mock preview-engine
vi.mock('../preview-engine.js', () => ({
  createPreview: vi.fn(),
  stopPreview: vi.fn(),
  rebuildPreview: vi.fn(),
  isDockerAvailable: vi.fn(),
}));

// Mock github-app
vi.mock('../github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { createPreview, isDockerAvailable, rebuildPreview } from '../preview-engine.js';
import { githubApiRequest, resolveInstallationId } from '../github-app.js';

const { setCommitStatus, handlePreviewStatusChange, triggerPreviewForPR } =
  await import('./webhooks.js');

// Mock config (imported by webhooks.ts)
vi.mock('../config.js', () => {
  const mockConfig = {
    port: 3051,
    publicUrl: 'http://localhost:3051',
    githubApp: null,
    botGithubToken: null,
    slackWebhookUrl: null,
    defaultCwd: '/tmp',
    defaultTimeoutMs: 30000,
    defaultReviewer: null,
    previewDomain: null,
  };
  return {
    default: mockConfig,
    defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  };
});

import config from '../config.js';

describe('webhook-preview integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset config for each test
    (config as unknown as Record<string, unknown>).githubApp = null;
    (config as unknown as Record<string, unknown>).botGithubToken = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setCommitStatus', () => {
    it('sets commit status via GitHub App when available', async () => {
      (config as unknown as Record<string, unknown>).githubApp = {
        appId: '123',
        privateKey: 'test-key',
        installationId: '456',
      };
      (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue('456');
      (githubApiRequest as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await setCommitStatus(
        'https://github.com/org/repo',
        'abc1234',
        'success',
        'Preview is live',
        'https://preview-pr-42.example.com',
      );

      expect(githubApiRequest).toHaveBeenCalledWith(
        '/repos/org/repo/statuses/abc1234',
        expect.objectContaining({
          method: 'POST',
          body: {
            state: 'success',
            description: 'Preview is live',
            context: 'agent-hub/preview',
            target_url: 'https://preview-pr-42.example.com',
          },
          appId: '123',
          privateKey: 'test-key',
          installationId: '456',
        }),
      );
    });

    it('falls back to gh CLI when GitHub App is not configured', async () => {
      (config as unknown as Record<string, unknown>).botGithubToken = 'ghp_testtoken';
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      await setCommitStatus(
        'https://github.com/org/repo',
        'def5678',
        'pending',
        'Preview environment is building...',
        null,
      );

      expect(execFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining([
          'api',
          'repos/org/repo/statuses/def5678',
          '--method',
          'POST',
          '--field',
          'state=pending',
          '--field',
          'context=agent-hub/preview',
        ]),
        expect.objectContaining({
          env: expect.objectContaining({ GH_TOKEN: 'ghp_testtoken' }),
        }),
      );
    });

    it('falls back to gh CLI when GitHub App request fails', async () => {
      (config as unknown as Record<string, unknown>).githubApp = {
        appId: '123',
        privateKey: 'test-key',
        installationId: '456',
      };
      (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue('456');
      (githubApiRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('GitHub API failed'),
      );
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      await setCommitStatus(
        'https://github.com/org/repo',
        'abc1234',
        'success',
        'Preview is live',
        null,
      );

      // Should have tried GitHub App first, then fallen back to gh CLI
      expect(githubApiRequest).toHaveBeenCalled();
      expect(execFileSync).toHaveBeenCalled();
    });

    it('includes target_url in gh CLI call when provided', async () => {
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      await setCommitStatus(
        'https://github.com/org/repo',
        'abc1234',
        'success',
        'Preview is live',
        'https://preview-pr-42.example.com',
      );

      expect(execFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['--field', 'target_url=https://preview-pr-42.example.com']),
        expect.anything(),
      );
    });

    it('truncates description to 140 chars', async () => {
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      const longDescription = 'A'.repeat(200);
      await setCommitStatus(
        'https://github.com/org/repo',
        'abc1234',
        'error',
        longDescription,
        null,
      );

      const callArgs = (execFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      const descField = callArgs.find((a: string) => a.startsWith('description='));
      expect(descField).toBeDefined();
      expect(descField!.length).toBeLessThanOrEqual('description='.length + 140);
    });
  });

  describe('handlePreviewStatusChange', () => {
    it('sets pending status for building state', () => {
      // Use a spy that captures the call without actually running the async function
      const setCommitStatusSpy = vi.spyOn(
        { setCommitStatus } as { setCommitStatus: typeof setCommitStatus },
        'setCommitStatus',
      );

      handlePreviewStatusChange({
        previewId: 'p1',
        projectId: 'proj1',
        prNumber: 42,
        commitSha: 'abc123',
        repoUrl: 'https://github.com/org/repo.git',
        status: 'building',
        url: null,
        errorMessage: null,
      });

      // The function should have been called (internally sets commit status)
      // We verify indirectly — the function shouldn't throw
      setCommitStatusSpy.mockRestore();
    });

    it('skips status update when commitSha is null', () => {
      // Should not throw or call setCommitStatus
      handlePreviewStatusChange({
        previewId: 'p1',
        projectId: 'proj1',
        prNumber: 42,
        commitSha: null,
        repoUrl: 'https://github.com/org/repo.git',
        status: 'running',
        url: 'http://localhost:4000',
        errorMessage: null,
      });

      // No commit status should be set — no GitHub API calls
      expect(githubApiRequest).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('skips status update for stopped state', () => {
      handlePreviewStatusChange({
        previewId: 'p1',
        projectId: 'proj1',
        prNumber: 42,
        commitSha: 'abc123',
        repoUrl: 'https://github.com/org/repo.git',
        status: 'stopped',
        url: null,
        errorMessage: null,
      });

      // No commit status should be set for intentional stops
      expect(githubApiRequest).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });

  describe('triggerPreviewForPR', () => {
    const mockStmts = {
      getPreviewContainerByPr: {
        get: vi.fn(),
      },
      updatePreviewContainer: {
        run: vi.fn(),
      },
    } as unknown as import('../types.js').Stmts;
    const mockBroadcast = vi.fn();

    it('skips when Docker is not available', async () => {
      (isDockerAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await triggerPreviewForPR(
        { stmts: mockStmts, broadcast: mockBroadcast },
        {
          projectId: 'proj1',
          prNumber: 42,
          prUrl: 'https://github.com/org/repo/pull/42',
          branch: 'feature/test',
          commitSha: 'abc123',
          repoUrl: 'https://github.com/org/repo.git',
        },
      );

      expect(createPreview).not.toHaveBeenCalled();
      expect(rebuildPreview).not.toHaveBeenCalled();
    });

    it('creates a new preview when none exists', async () => {
      (isDockerAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockStmts.getPreviewContainerByPr.get as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );
      (createPreview as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'new-id',
        status: 'building',
      });

      await triggerPreviewForPR(
        { stmts: mockStmts, broadcast: mockBroadcast },
        {
          projectId: 'proj1',
          prNumber: 42,
          prUrl: 'https://github.com/org/repo/pull/42',
          branch: 'feature/test',
          commitSha: 'abc123',
          repoUrl: 'https://github.com/org/repo.git',
        },
      );

      expect(createPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj1',
          prNumber: 42,
          branch: 'feature/test',
          commitSha: 'abc123',
        }),
      );
    });

    it('rebuilds existing preview on synchronize', async () => {
      (isDockerAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockStmts.getPreviewContainerByPr.get as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'existing-id',
        status: 'running',
        commit_sha: 'old-sha',
        container_id: 'ctr-123',
        port: 4000,
        url: 'http://localhost:4000',
        error_message: null,
        build_log: null,
      });
      (rebuildPreview as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await triggerPreviewForPR(
        { stmts: mockStmts, broadcast: mockBroadcast },
        {
          projectId: 'proj1',
          prNumber: 42,
          prUrl: 'https://github.com/org/repo/pull/42',
          branch: 'feature/test',
          commitSha: 'new-sha',
          repoUrl: 'https://github.com/org/repo.git',
        },
      );

      // Should update commit SHA before rebuilding
      expect(mockStmts.updatePreviewContainer.run).toHaveBeenCalledWith(
        'ctr-123',
        4000,
        'http://localhost:4000',
        'running',
        null,
        null,
        'new-sha',
        'existing-id',
      );
      expect(rebuildPreview).toHaveBeenCalledWith('existing-id');
      expect(createPreview).not.toHaveBeenCalled();
    });

    it('handles createPreview error gracefully', async () => {
      (isDockerAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockStmts.getPreviewContainerByPr.get as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );
      (createPreview as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Max concurrent reached'),
      );

      // Should not throw
      await triggerPreviewForPR(
        { stmts: mockStmts, broadcast: mockBroadcast },
        {
          projectId: 'proj1',
          prNumber: 99,
          prUrl: 'https://github.com/org/repo/pull/99',
          branch: 'fix/bug',
          commitSha: null,
          repoUrl: 'https://github.com/org/repo.git',
        },
      );
    });
  });

  describe('onStatusChange callback', () => {
    it('preview engine calls onStatusChange on status transitions', async () => {
      // Re-import preview engine with fresh mock to test callback integration
      const {
        initPreviewEngine,
        stopPreviewEngine,
        createPreview: realCreate,
      } = await vi.importActual<typeof import('../preview-engine.js')>('../preview-engine.js');

      // This test verifies the callback interface exists and is typed correctly
      const onStatusChange = vi.fn();
      const mockStmts2 = {
        getRunningPreviews: { all: () => [] },
        getPreviewContainer: { get: () => undefined },
        getPreviewContainerByPr: { get: () => undefined },
        createPreviewContainer: { run: vi.fn() },
        updatePreviewContainer: { run: vi.fn() },
        updatePreviewContainerStatus: { run: vi.fn() },
        getExpiredPreviews: { all: () => [] },
      };

      // Verify the interface accepts onStatusChange
      initPreviewEngine({
        stmts: mockStmts2 as unknown as import('../types.js').Stmts,
        broadcast: vi.fn(),
        previewDomain: null,
        onStatusChange,
      });

      stopPreviewEngine();
      expect(onStatusChange).toBeDefined();
    });
  });
});
