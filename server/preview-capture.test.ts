/**
 * preview-capture.test.ts — Tests for the preview screenshot/video capture engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock playwright before importing the module
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

// Mock fs operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    rmSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 1024 })),
    renameSync: vi.fn(),
  };
});

import { chromium } from 'playwright';
import { mkdirSync, existsSync, rmSync } from 'fs';
import {
  initCaptureEngine,
  capturePreview,
  getPreviewCaptures,
  deletePreviewCaptures,
  isPlaywrightAvailable,
  isCaptureInProgress,
} from './preview-capture.js';

// Helper to create mock stmts
function createMockStmts(overrides: Record<string, unknown> = {}) {
  return {
    getPreviewContainer: {
      get: vi.fn(() => ({
        id: 'preview-1',
        project_id: 'proj-1',
        pr_number: 42,
        url: 'http://localhost:4000',
        status: 'running',
        branch: 'feature/test',
      })),
    },
    getPreviewCaptures: {
      all: vi.fn(() => []),
    },
    createPreviewCapture: {
      run: vi.fn(),
    },
    deletePreviewCaptures: {
      run: vi.fn(),
    },
    ...overrides,
  } as any;
}

function createMockBrowser() {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { mockBrowser, mockContext, mockPage };
}

describe('preview-capture', () => {
  let mockStmts: ReturnType<typeof createMockStmts>;
  let mockBroadcast: (data: Record<string, unknown>) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStmts = createMockStmts();
    mockBroadcast = vi.fn();
  });

  describe('isPlaywrightAvailable', () => {
    it('returns true when chromium launches successfully', async () => {
      // Re-init to reset cache
      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
      (chromium.launch as any).mockResolvedValueOnce(mockBrowser);

      const result = await isPlaywrightAvailable();
      expect(result).toBe(true);
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('returns false when chromium fails to launch', async () => {
      // Re-init to reset cache
      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      (chromium.launch as any).mockRejectedValueOnce(new Error('No browser'));

      const result = await isPlaywrightAvailable();
      expect(result).toBe(false);
    });

    it('caches the result after first probe', async () => {
      // Re-init to reset cache
      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
      (chromium.launch as any).mockResolvedValueOnce(mockBrowser);

      const first = await isPlaywrightAvailable();
      const second = await isPlaywrightAvailable();

      expect(first).toBe(true);
      expect(second).toBe(true);
      // Should only launch once — second call uses cache
      expect(chromium.launch).toHaveBeenCalledTimes(1);
    });
  });

  describe('initCaptureEngine', () => {
    it('creates captures directory on init', () => {
      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      expect(mkdirSync).toHaveBeenCalledWith('/tmp/uploads/captures', { recursive: true });
    });
  });

  describe('capturePreview', () => {
    beforeEach(() => {
      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      // Mock global fetch for health check
      global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects preview IDs with path traversal characters', async () => {
      await expect(capturePreview('../etc/passwd')).rejects.toThrow('Invalid preview ID');
      await expect(capturePreview('../../foo')).rejects.toThrow('Invalid preview ID');
      await expect(capturePreview('id with spaces')).rejects.toThrow('Invalid preview ID');
    });

    it('throws when preview not found', async () => {
      mockStmts.getPreviewContainer.get.mockReturnValue(undefined);
      await expect(capturePreview('missing')).rejects.toThrow('Preview not found');
    });

    it('throws when preview is not running', async () => {
      mockStmts.getPreviewContainer.get.mockReturnValue({
        id: 'preview-1',
        status: 'stopped',
      });
      await expect(capturePreview('preview-1')).rejects.toThrow('Preview is not running');
    });

    it('throws when preview has no URL', async () => {
      mockStmts.getPreviewContainer.get.mockReturnValue({
        id: 'preview-1',
        status: 'running',
        url: null,
      });
      await expect(capturePreview('preview-1')).rejects.toThrow('Preview has no URL');
    });

    it('rejects concurrent captures for the same preview', async () => {
      // Start a capture that will take a while (health check mock delays)
      const slowFetch = vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500)),
        );
      global.fetch = slowFetch as any;

      const { mockBrowser } = createMockBrowser();
      (chromium.launch as any).mockResolvedValue(mockBrowser);

      // Start first capture (don't await)
      const first = capturePreview('preview-1', { skipVideo: true });

      // The preview should now be in-progress
      expect(isCaptureInProgress('preview-1')).toBe(true);

      // Second capture should be rejected immediately
      await expect(capturePreview('preview-1', { skipVideo: true })).rejects.toThrow(
        'Capture already in progress',
      );

      // Wait for first to complete
      await first;

      // Now it should be clear
      expect(isCaptureInProgress('preview-1')).toBe(false);
    });

    it('clears in-progress flag even on error', async () => {
      mockStmts.getPreviewContainer.get.mockReturnValue({
        id: 'preview-err',
        status: 'running',
        url: 'http://localhost:4000',
        project_id: 'proj-1',
      });

      const { mockBrowser } = createMockBrowser();
      (chromium.launch as any).mockResolvedValueOnce(mockBrowser);
      mockBrowser.newContext.mockRejectedValueOnce(new Error('Boom'));

      const result = await capturePreview('preview-err', { skipVideo: true });
      expect(result.error).toBe('Boom');
      expect(isCaptureInProgress('preview-err')).toBe(false);
    });

    it('captures screenshots for all routes', async () => {
      const { mockBrowser, mockPage } = createMockBrowser();
      (chromium.launch as any).mockResolvedValueOnce(mockBrowser);

      const result = await capturePreview('preview-1', { skipVideo: true });

      expect(result.previewId).toBe('preview-1');
      expect(result.screenshots.length).toBeGreaterThan(0);
      expect(result.error).toBeNull();

      // Should have navigated to each route
      expect(mockPage.goto).toHaveBeenCalled();
      expect(mockPage.screenshot).toHaveBeenCalled();

      // Should have saved to DB
      expect(mockStmts.createPreviewCapture.run).toHaveBeenCalled();

      // Should have broadcast capturing status and completion
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'preview_update' }),
      );
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'preview_capture_complete' }),
      );
    });

    it('cleans up previous captures before starting', async () => {
      (existsSync as any).mockReturnValue(true);
      const { mockBrowser } = createMockBrowser();
      (chromium.launch as any).mockResolvedValueOnce(mockBrowser);

      await capturePreview('preview-1', { skipVideo: true });

      expect(rmSync).toHaveBeenCalledWith(expect.stringContaining('captures/preview-1'), {
        recursive: true,
        force: true,
      });
      expect(mockStmts.deletePreviewCaptures.run).toHaveBeenCalledWith('preview-1');
    });

    it('reports duration_ms in result', async () => {
      const { mockBrowser } = createMockBrowser();
      (chromium.launch as any).mockResolvedValueOnce(mockBrowser);

      const result = await capturePreview('preview-1', { skipVideo: true });
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('closes browser even on error', async () => {
      const { mockBrowser } = createMockBrowser();
      (chromium.launch as any).mockResolvedValueOnce(mockBrowser);

      // Make health check pass but then screenshot fail
      mockBrowser.newContext.mockRejectedValueOnce(new Error('Context creation failed'));

      const result = await capturePreview('preview-1', { skipVideo: true });

      expect(result.error).toBe('Context creation failed');
      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });

  describe('getPreviewCaptures', () => {
    it('returns captures from database', () => {
      const mockCaptures = [
        { id: 'cap-1', type: 'screenshot', name: 'home' },
        { id: 'cap-2', type: 'video', name: 'walkthrough' },
      ];
      mockStmts.getPreviewCaptures.all.mockReturnValue(mockCaptures);

      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      const captures = getPreviewCaptures('preview-1');
      expect(captures).toEqual(mockCaptures);
      expect(mockStmts.getPreviewCaptures.all).toHaveBeenCalledWith('preview-1');
    });
  });

  describe('deletePreviewCaptures', () => {
    it('removes files and database records', () => {
      (existsSync as any).mockReturnValue(true);

      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      deletePreviewCaptures('preview-1');

      expect(rmSync).toHaveBeenCalledWith(expect.stringContaining('captures/preview-1'), {
        recursive: true,
        force: true,
      });
      expect(mockStmts.deletePreviewCaptures.run).toHaveBeenCalledWith('preview-1');
    });

    it('handles missing directory gracefully', () => {
      (existsSync as any).mockReturnValue(false);

      initCaptureEngine({
        stmts: mockStmts,
        broadcast: mockBroadcast,
        uploadsDir: '/tmp/uploads',
      });

      deletePreviewCaptures('preview-1');

      // rmSync should NOT be called for the capture dir
      expect(rmSync).not.toHaveBeenCalledWith(
        expect.stringContaining('captures/preview-1'),
        expect.anything(),
      );
      // DB cleanup still happens
      expect(mockStmts.deletePreviewCaptures.run).toHaveBeenCalledWith('preview-1');
    });
  });
});
