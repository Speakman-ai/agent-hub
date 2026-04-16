import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before imports
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import type { Stmts, PreviewContainerRow, BroadcastFn } from './types.js';

// We need to dynamically import after mocking
const {
  initPreviewEngine,
  stopPreviewEngine,
  isDockerAvailable,
  createPreview,
  stopPreview,
  cleanupExpiredPreviews,
  DEFAULT_TTL_MINUTES,
  MAX_CONCURRENT_PREVIEWS,
} = await import('./preview-engine.js');

function mockExecFileAsync(impl: (...args: unknown[]) => { stdout: string; stderr?: string }) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // Handle both callback and promise styles
      if (typeof _opts === 'function') {
        cb = _opts as typeof cb;
      }
      try {
        const result = impl(_cmd, _args, _opts);
        if (cb) {
          cb(null, { stdout: result.stdout, stderr: result.stderr || '' });
        }
      } catch (err) {
        if (cb) {
          cb(err as Error, { stdout: '', stderr: '' });
        }
      }
    },
  );
}

function createMockStmts(): Partial<Stmts> {
  const store = new Map<string, PreviewContainerRow>();

  return {
    getRunningPreviews: {
      all: () =>
        [...store.values()].filter((r) => r.status === 'building' || r.status === 'running'),
    } as unknown as Stmts['getRunningPreviews'],

    getPreviewContainer: {
      get: (id: string) => store.get(id) || undefined,
    } as unknown as Stmts['getPreviewContainer'],

    getPreviewContainerByPr: {
      get: (projectId: string, prNumber: number) =>
        [...store.values()].find(
          (r) =>
            r.project_id === projectId &&
            r.pr_number === prNumber &&
            r.status !== 'stopped' &&
            r.status !== 'error',
        ) || undefined,
    } as unknown as Stmts['getPreviewContainerByPr'],

    getPreviewContainersByProject: {
      all: (projectId: string) => [...store.values()].filter((r) => r.project_id === projectId),
    } as unknown as Stmts['getPreviewContainersByProject'],

    createPreviewContainer: {
      run: (
        id: string,
        projectId: string,
        prNumber: number,
        prUrl: string | null,
        branch: string,
        commitSha: string | null,
        repoUrl: string,
        ttl: number,
      ) => {
        store.set(id, {
          id,
          project_id: projectId,
          pr_number: prNumber,
          pr_url: prUrl,
          branch,
          commit_sha: commitSha,
          repo_url: repoUrl,
          container_id: null,
          port: null,
          url: null,
          status: 'building',
          error_message: null,
          build_log: null,
          ttl_minutes: ttl,
          expires_at: new Date(Date.now() + ttl * 60_000).toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      },
    } as unknown as Stmts['createPreviewContainer'],

    updatePreviewContainer: {
      run: (
        containerId: string | null,
        port: number | null,
        url: string | null,
        status: string,
        errorMessage: string | null,
        buildLog: string | null,
        id: string,
      ) => {
        const row = store.get(id);
        if (row) {
          row.container_id = containerId;
          row.port = port;
          row.url = url;
          row.status = status as PreviewContainerRow['status'];
          row.error_message = errorMessage;
          row.build_log = buildLog;
          row.updated_at = new Date().toISOString();
        }
      },
    } as unknown as Stmts['updatePreviewContainer'],

    updatePreviewContainerStatus: {
      run: (status: string, id: string) => {
        const row = store.get(id);
        if (row) {
          row.status = status as PreviewContainerRow['status'];
          row.updated_at = new Date().toISOString();
        }
      },
    } as unknown as Stmts['updatePreviewContainerStatus'],

    deletePreviewContainer: {
      run: (id: string) => {
        store.delete(id);
      },
    } as unknown as Stmts['deletePreviewContainer'],

    getExpiredPreviews: {
      all: () =>
        [...store.values()].filter(
          (r) => r.status === 'running' && r.expires_at && new Date(r.expires_at) < new Date(),
        ),
    } as unknown as Stmts['getExpiredPreviews'],

    _store: store,
  } as unknown as Partial<Stmts> & { _store: Map<string, PreviewContainerRow> };
}

describe('preview-engine', () => {
  let mockStmts: ReturnType<typeof createMockStmts>;
  let mockBroadcast: BroadcastFn;

  beforeEach(() => {
    mockStmts = createMockStmts();
    mockBroadcast = vi.fn();
    initPreviewEngine({
      stmts: mockStmts as unknown as Stmts,
      broadcast: mockBroadcast,
      previewDomain: null,
    });
  });

  afterEach(() => {
    stopPreviewEngine();
    vi.restoreAllMocks();
  });

  describe('isDockerAvailable', () => {
    it('returns true when docker info succeeds', async () => {
      mockExecFileAsync(() => ({ stdout: '24.0.7' }));
      const result = await isDockerAvailable();
      expect(result).toBe(true);
    });

    it('returns false when docker is not available', async () => {
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          if (callback) (callback as (err: Error) => void)(new Error('docker not found'));
        },
      );
      const result = await isDockerAvailable();
      expect(result).toBe(false);
    });
  });

  describe('createPreview', () => {
    it('creates a preview record in building state', async () => {
      mockExecFileAsync(() => ({ stdout: 'abc123\n' }));

      const preview = await createPreview({
        id: 'test-id',
        projectId: 'my-project',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        branch: 'feature/test',
        commitSha: 'abc123',
        repoUrl: 'https://github.com/org/repo.git',
      });

      expect(preview).toBeDefined();
      expect(preview.id).toBe('test-id');
      expect(preview.status).toBe('building');
      expect(preview.pr_number).toBe(42);
      expect(preview.branch).toBe('feature/test');
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'preview_update',
          projectId: 'my-project',
        }),
      );
    });

    it('rejects duplicate previews for same PR', async () => {
      mockExecFileAsync(() => ({ stdout: 'abc123\n' }));

      await createPreview({
        id: 'test-1',
        projectId: 'my-project',
        prNumber: 42,
        prUrl: null,
        branch: 'feature/test',
        commitSha: null,
        repoUrl: 'https://github.com/org/repo.git',
      });

      await expect(
        createPreview({
          id: 'test-2',
          projectId: 'my-project',
          prNumber: 42,
          prUrl: null,
          branch: 'feature/test',
          commitSha: null,
          repoUrl: 'https://github.com/org/repo.git',
        }),
      ).rejects.toThrow('Preview already exists for PR #42');
    });

    it('uses default TTL when not specified', async () => {
      mockExecFileAsync(() => ({ stdout: 'abc123\n' }));

      const preview = await createPreview({
        id: 'test-ttl',
        projectId: 'my-project',
        prNumber: 99,
        prUrl: null,
        branch: 'main',
        commitSha: null,
        repoUrl: 'https://github.com/org/repo.git',
      });

      expect(preview.ttl_minutes).toBe(DEFAULT_TTL_MINUTES);
    });
  });

  describe('stopPreview', () => {
    it('stops a running container', async () => {
      mockExecFileAsync(() => ({ stdout: '' }));

      // Create a preview first
      await createPreview({
        id: 'stop-test',
        projectId: 'proj',
        prNumber: 1,
        prUrl: null,
        branch: 'test',
        commitSha: null,
        repoUrl: 'https://github.com/org/repo.git',
      });

      // Manually set it to running with a container ID
      const store = (mockStmts as unknown as { _store: Map<string, PreviewContainerRow> })._store;
      const row = store.get('stop-test')!;
      row.status = 'running';
      row.container_id = 'container123';

      const result = await stopPreview('stop-test');
      expect(result).toBeDefined();
      expect(result!.status).toBe('stopped');
    });

    it('returns null for non-existent preview', async () => {
      const result = await stopPreview('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('cleanupExpiredPreviews', () => {
    it('stops expired previews', async () => {
      mockExecFileAsync(() => ({ stdout: '' }));

      // Create a preview
      await createPreview({
        id: 'expired-test',
        projectId: 'proj',
        prNumber: 5,
        prUrl: null,
        branch: 'test',
        commitSha: null,
        repoUrl: 'https://github.com/org/repo.git',
        ttlMinutes: 1,
      });

      // Set to running and expired
      const store = (mockStmts as unknown as { _store: Map<string, PreviewContainerRow> })._store;
      const row = store.get('expired-test')!;
      row.status = 'running';
      row.container_id = 'expired-container';
      row.expires_at = new Date(Date.now() - 60_000).toISOString(); // expired 1 min ago

      const count = await cleanupExpiredPreviews();
      expect(count).toBe(1);
      expect(row.status).toBe('stopped');
    });

    it('returns 0 when no previews are expired', async () => {
      const count = await cleanupExpiredPreviews();
      expect(count).toBe(0);
    });
  });

  describe('constants', () => {
    it('exports expected defaults', () => {
      expect(DEFAULT_TTL_MINUTES).toBe(60);
      expect(MAX_CONCURRENT_PREVIEWS).toBe(10);
    });
  });
});
