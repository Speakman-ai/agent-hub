import { vi, type Mock } from 'vitest';
import fs from 'fs';
import type { Stmts, PrCaptureRow, PrCaptureArtifactRow, BroadcastFn } from './types.js';

// ─── Module-level mocks ────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('./config.js', () => ({
  default: {
    botGithubToken: null as string | null,
    publicUrl: null as string | null,
  },
}));

// ─── Helpers ───────────────────────────────────────────────────

function makeMockStmts(): Stmts {
  return {
    getPrCapture: { get: vi.fn() },
    updatePrCapture: { run: vi.fn() },
    updatePrCaptureStatus: { run: vi.fn() },
    createPrCaptureArtifact: { run: vi.fn() },
    getPrCaptureArtifacts: { all: vi.fn().mockReturnValue([]) },
    deletePrCaptureArtifacts: { run: vi.fn() },
    deletePrCapture: { run: vi.fn() },
  } as unknown as Stmts;
}

function makeCaptureRow(overrides: Partial<PrCaptureRow> = {}): PrCaptureRow {
  return {
    id: 'cap-1',
    project_id: 'proj-1',
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    branch: 'feat/cool',
    commit_sha: null,
    repo_url: 'https://github.com/owner/repo',
    status: 'queued',
    error_message: null,
    build_log: null,
    screenshot_count: 0,
    has_video: false,
    duration_ms: null,
    comment_url: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────

describe('capture-engine', () => {
  let mockStmts: Stmts;
  let mockBroadcast: Mock;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockStmts = makeMockStmts();
    mockBroadcast = vi.fn();
  });

  async function loadEngine() {
    const mod = await import('./capture-engine.js');
    mod.initCaptureEngine({
      stmts: mockStmts,
      broadcast: mockBroadcast as unknown as BroadcastFn,
      uploadsDir: '/tmp/test-uploads',
    });
    return mod;
  }

  // ── isPlaywrightAvailable ──────────────────────────────────────

  describe('isPlaywrightAvailable', () => {
    it('returns a boolean and caches the result', async () => {
      const engine = await loadEngine();
      const first = await engine.isPlaywrightAvailable();
      expect(typeof first).toBe('boolean');

      // Second call should return same cached value without re-importing
      const second = await engine.isPlaywrightAvailable();
      expect(second).toBe(first);
    });
  });

  // ── isCaptureInProgress ────────────────────────────────────────

  describe('isCaptureInProgress', () => {
    it('returns false for unknown capture', async () => {
      const engine = await loadEngine();
      expect(engine.isCaptureInProgress('nonexistent')).toBe(false);
    });
  });

  // ── getCaptureArtifacts ────────────────────────────────────────

  describe('getCaptureArtifacts', () => {
    it('returns artifacts from the DB statement', async () => {
      const fakeArtifacts: PrCaptureArtifactRow[] = [
        {
          id: 'art-1',
          capture_id: 'cap-1',
          type: 'screenshot',
          route: '/',
          name: 'home',
          label: 'Home',
          filename: 'screenshot-home.png',
          file_path: '/tmp/screenshot-home.png',
          file_size: 12345,
          console_errors: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ];
      (mockStmts.getPrCaptureArtifacts.all as Mock).mockReturnValue(fakeArtifacts);

      const engine = await loadEngine();
      const result = engine.getCaptureArtifacts('cap-1');

      expect(mockStmts.getPrCaptureArtifacts.all).toHaveBeenCalledWith('cap-1');
      expect(result).toEqual(fakeArtifacts);
    });
  });

  // ── deleteCaptureArtifacts ─────────────────────────────────────

  describe('deleteCaptureArtifacts', () => {
    it('removes directory from disk and DB rows', async () => {
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});

      const engine = await loadEngine();
      engine.deleteCaptureArtifacts('cap-1');

      expect(existsSpy).toHaveBeenCalledWith('/tmp/test-uploads/captures/cap-1');
      expect(rmSpy).toHaveBeenCalledWith('/tmp/test-uploads/captures/cap-1', {
        recursive: true,
        force: true,
      });
      expect(mockStmts.deletePrCaptureArtifacts.run).toHaveBeenCalledWith('cap-1');

      existsSpy.mockRestore();
      rmSpy.mockRestore();
    });

    it('skips disk removal when directory does not exist', async () => {
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});

      const engine = await loadEngine();
      engine.deleteCaptureArtifacts('cap-1');

      expect(rmSpy).not.toHaveBeenCalled();
      expect(mockStmts.deletePrCaptureArtifacts.run).toHaveBeenCalledWith('cap-1');

      existsSpy.mockRestore();
      rmSpy.mockRestore();
    });
  });

  // ── runCapture — error paths ───────────────────────────────────

  describe('runCapture', () => {
    it('throws when capture row is not found', async () => {
      (mockStmts.getPrCapture.get as Mock).mockReturnValue(undefined);
      const engine = await loadEngine();
      await expect(engine.runCapture('cap-missing')).rejects.toThrow('No capture row found');
    });

    it('throws when capture is not in queued status', async () => {
      (mockStmts.getPrCapture.get as Mock).mockReturnValue(makeCaptureRow({ status: 'building' }));
      const engine = await loadEngine();
      await expect(engine.runCapture('cap-1')).rejects.toThrow("expected 'queued'");
    });

    it('transitions to error status when git clone fails', async () => {
      const row = makeCaptureRow();
      (mockStmts.getPrCapture.get as Mock).mockReturnValue(row);

      // Mock mkdtempSync to return a predictable path
      const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockReturnValue('/tmp/pr-capture-test');
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});

      // Make execFile reject (git clone failure)
      const { execFile } = await import('child_process');
      (execFile as unknown as Mock).mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(new Error('clone failed: branch not found'), '', 'fatal: branch not found');
        },
      );

      const engine = await loadEngine();
      const result = await engine.runCapture('cap-1');

      expect(result.status).toBe('error');
      expect(result.error).toContain('clone failed');

      // Should have set status to building first, then error
      expect(mockStmts.updatePrCaptureStatus.run).toHaveBeenCalledWith('building', 'cap-1');

      // Should broadcast error
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'capture_complete',
          captureId: 'cap-1',
          result: expect.objectContaining({ error: expect.stringContaining('clone failed') }),
        }),
      );

      // Should clean up in-progress tracking
      expect(engine.isCaptureInProgress('cap-1')).toBe(false);

      mkdtempSpy.mockRestore();
      rmSpy.mockRestore();
    });
  });

  // ── postPrComment ──────────────────────────────────────────────

  describe('postPrComment', () => {
    it('returns null when capture row is not found', async () => {
      (mockStmts.getPrCapture.get as Mock).mockReturnValue(undefined);
      const engine = await loadEngine();
      expect(await engine.postPrComment('cap-missing')).toBeNull();
    });

    it('returns null when botGithubToken is not configured', async () => {
      const config = (await import('./config.js')).default;
      config.botGithubToken = null;
      (mockStmts.getPrCapture.get as Mock).mockReturnValue(makeCaptureRow());

      const engine = await loadEngine();
      expect(await engine.postPrComment('cap-1')).toBeNull();
    });

    it('posts a comment and returns the URL on success', async () => {
      const config = (await import('./config.js')).default;
      config.botGithubToken = 'ghp_test123';
      config.publicUrl = 'https://hub.example.com';

      const row = makeCaptureRow({ status: 'done', duration_ms: 15000 });
      (mockStmts.getPrCapture.get as Mock).mockReturnValue(row);

      const artifacts: PrCaptureArtifactRow[] = [
        {
          id: 'art-1',
          capture_id: 'cap-1',
          type: 'screenshot',
          route: '/',
          name: 'home',
          label: 'Home',
          filename: 'screenshot-home.png',
          file_path: '/tmp/screenshot-home.png',
          file_size: 50000,
          console_errors: JSON.stringify(['Uncaught TypeError: x is not a function']),
          created_at: '2026-01-01T00:00:00Z',
        },
      ];
      (mockStmts.getPrCaptureArtifacts.all as Mock).mockReturnValue(artifacts);

      const commentUrl = 'https://github.com/owner/repo/pull/42#issuecomment-123';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ html_url: commentUrl }),
      } as Response);

      const engine = await loadEngine();
      const result = await engine.postPrComment('cap-1');

      expect(result).toBe(commentUrl);

      // Verify the fetch call
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/issues/42/comments',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'token ghp_test123',
          }),
        }),
      );

      // Verify the comment body includes screenshot image URL and console errors
      const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(callBody.body).toContain('screenshot-home.png');
      expect(callBody.body).toContain('https://hub.example.com/uploads/captures/cap-1/');
      expect(callBody.body).toContain('Console errors');
      expect(callBody.body).toContain('Uncaught TypeError');

      // Should update the row with the comment URL
      expect(mockStmts.updatePrCapture.run).toHaveBeenCalledWith(
        'done',
        null,
        null,
        0,
        0,
        15000,
        commentUrl,
        'cap-1',
      );

      fetchSpy.mockRestore();
    });

    it('falls back to filename text when publicUrl is null', async () => {
      const config = (await import('./config.js')).default;
      config.botGithubToken = 'ghp_test456';
      config.publicUrl = null; // reset from previous test

      (mockStmts.getPrCapture.get as Mock).mockReturnValue(makeCaptureRow({ status: 'done' }));
      (mockStmts.getPrCaptureArtifacts.all as Mock).mockReturnValue([
        {
          id: 'art-1',
          capture_id: 'cap-1',
          type: 'screenshot',
          route: '/',
          name: 'home',
          label: 'Home',
          filename: 'screenshot-home.png',
          file_path: '/tmp/screenshot-home.png',
          file_size: 2048,
          console_errors: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ]);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ html_url: 'https://github.com/owner/repo/pull/42#issuecomment-456' }),
      } as Response);

      const engine = await loadEngine();
      await engine.postPrComment('cap-1');

      const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      // Without publicUrl, should show filename with size rather than image embed
      expect(callBody.body).toContain('`screenshot-home.png`');
      expect(callBody.body).toContain('2KB');
      expect(callBody.body).not.toContain('![');

      fetchSpy.mockRestore();
    });

    it('returns null when GitHub API returns an error', async () => {
      const config = (await import('./config.js')).default;
      config.botGithubToken = 'ghp_test123';

      (mockStmts.getPrCapture.get as Mock).mockReturnValue(makeCaptureRow({ status: 'done' }));
      (mockStmts.getPrCaptureArtifacts.all as Mock).mockReturnValue([]);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      } as Response);

      const engine = await loadEngine();
      const result = await engine.postPrComment('cap-1');

      expect(result).toBeNull();
      fetchSpy.mockRestore();
    });

    it('returns null when repo URL cannot be parsed', async () => {
      const config = (await import('./config.js')).default;
      config.botGithubToken = 'ghp_test123';

      (mockStmts.getPrCapture.get as Mock).mockReturnValue(
        makeCaptureRow({ repo_url: 'https://gitlab.com/owner/repo' }),
      );

      const engine = await loadEngine();
      expect(await engine.postPrComment('cap-1')).toBeNull();
    });
  });

  // ── validateCaptureInputs — argument-injection guard ───────────
  //
  // The capture pipeline shells out to `git clone`/`git checkout` with
  // webhook-supplied strings. These tests pin the strict allowlist so that
  // if someone relaxes the regex later, the suite catches it.
  describe('validateCaptureInputs', () => {
    it('accepts normal branches, SHAs, and GitHub URLs', async () => {
      const engine = await loadEngine();
      expect(() =>
        engine.validateCaptureInputs({
          branch: 'feat/my-branch',
          commit_sha: 'abc1234',
          repo_url: 'https://github.com/owner/repo',
        }),
      ).not.toThrow();
      expect(() =>
        engine.validateCaptureInputs({
          branch: 'release_1.2',
          commit_sha: 'abcdef0123456789abcdef0123456789abcdef01',
          repo_url: 'https://github.com/Owner-Name/repo.git',
        }),
      ).not.toThrow();
    });

    it('rejects branches that start with a dash (argument injection)', async () => {
      const engine = await loadEngine();
      expect(() =>
        engine.validateCaptureInputs({
          branch: '--upload-pack=malicious',
          commit_sha: null,
          repo_url: 'https://github.com/owner/repo',
        }),
      ).toThrow(/Invalid branch/);
    });

    it('rejects branches with shell metacharacters', async () => {
      const engine = await loadEngine();
      for (const bad of ['foo;rm -rf /', 'foo`id`', 'foo$(whoami)', 'foo bar', 'foo|ls']) {
        expect(() =>
          engine.validateCaptureInputs({
            branch: bad,
            commit_sha: null,
            repo_url: 'https://github.com/owner/repo',
          }),
        ).toThrow(/Invalid branch/);
      }
    });

    it('rejects non-hex commit SHAs', async () => {
      const engine = await loadEngine();
      expect(() =>
        engine.validateCaptureInputs({
          branch: 'main',
          commit_sha: 'HEAD; rm -rf /',
          repo_url: 'https://github.com/owner/repo',
        }),
      ).toThrow(/Invalid commit/);
    });

    it('rejects non-github repo URLs and non-https schemes', async () => {
      const engine = await loadEngine();
      for (const bad of [
        'file:///etc/passwd',
        'git@github.com:owner/repo.git',
        'https://evil.com/owner/repo',
        'https://github.com/owner/repo; rm -rf /',
        'http://github.com/owner/repo',
      ]) {
        expect(() =>
          engine.validateCaptureInputs({
            branch: 'main',
            commit_sha: null,
            repo_url: bad,
          }),
        ).toThrow(/Invalid repo/);
      }
    });
  });

  // ── runCapture — validation guard in the real flow ─────────────
  describe('runCapture validation', () => {
    it('refuses to execute git when the branch starts with a dash', async () => {
      const row = makeCaptureRow({ branch: '--upload-pack=x' });
      (mockStmts.getPrCapture.get as Mock).mockReturnValue(row);

      const engine = await loadEngine();
      await expect(engine.runCapture('cap-1')).rejects.toThrow(/Invalid branch/);

      // Critical: git must NOT have been spawned with the malicious branch.
      const { execFile } = await import('child_process');
      expect(execFile).not.toHaveBeenCalled();
    });
  });
});
