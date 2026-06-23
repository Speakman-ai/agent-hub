/**
 * Save PDF bytes via a native OS save dialog — used from the main process
 * so Electron avoids renderer-only download quirks (anchor / blob paths).
 */

import { writeFile } from 'fs/promises';
import type { BrowserWindow, SaveDialogOptions, SaveDialogReturnValue } from 'electron';

interface SaveDesignPdfOptions {
  showSaveDialog: (win: BrowserWindow, opts: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
  mainWindow: BrowserWindow;
  defaultFilename: string;
  data: Buffer | Uint8Array;
}

export async function saveDesignPdfWithDialog({
  showSaveDialog,
  writeFileImpl = writeFile,
  mainWindow,
  defaultFilename,
  data,
}: SaveDesignPdfOptions) {
  try {
    const result = await showSaveDialog(mainWindow, {
      defaultPath: defaultFilename,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled) return { cancelled: true };
    const filePath = result.filePath;
    if (!filePath) return { cancelled: true };
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await writeFileImpl(filePath, buf);
    return { ok: true, filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}
