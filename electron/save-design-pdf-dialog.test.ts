import type { BrowserWindow } from 'electron';
import { describe, it, expect, vi } from 'vitest';
import { saveDesignPdfWithDialog } from './save-design-pdf-dialog.js';

const mockWindow = {} as BrowserWindow;

describe('saveDesignPdfWithDialog', () => {
  it('returns cancelled when the user dismisses the save dialog', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({ canceled: true });
    const writeFileImpl = vi.fn();

    const out = await saveDesignPdfWithDialog({
      showSaveDialog,
      writeFileImpl,
      mainWindow: mockWindow,
      defaultFilename: 'x.pdf',
      data: Buffer.from('%PDF'),
    });

    expect(out).toEqual({ cancelled: true });
    expect(writeFileImpl).not.toHaveBeenCalled();
  });

  it('writes bytes to the chosen path', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/tmp/out.pdf',
    });
    const writeFileImpl = vi.fn().mockResolvedValue(undefined);

    const out = await saveDesignPdfWithDialog({
      showSaveDialog,
      writeFileImpl,
      mainWindow: mockWindow,
      defaultFilename: 'design.pdf',
      data: new Uint8Array([1, 2, 3]),
    });

    expect(out).toEqual({ ok: true, filePath: '/tmp/out.pdf' });
    expect(writeFileImpl).toHaveBeenCalledTimes(1);
    expect(writeFileImpl.mock.calls[0][0]).toBe('/tmp/out.pdf');
    expect([...writeFileImpl.mock.calls[0][1]]).toEqual([1, 2, 3]);
  });

  it('surfaces write failures as { error }', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/tmp/out.pdf',
    });
    const writeFileImpl = vi.fn().mockRejectedValue(new Error('EACCES'));

    const out = await saveDesignPdfWithDialog({
      showSaveDialog,
      writeFileImpl,
      mainWindow: mockWindow,
      defaultFilename: 'design.pdf',
      data: Buffer.from('x'),
    });

    expect(out.error).toMatch(/EACCES/);
  });
});
