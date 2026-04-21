/**
 * Save PDF bytes via a native OS save dialog — used from the main process
 * so Electron avoids renderer-only download quirks (anchor / blob paths).
 */

import { writeFile } from 'fs/promises';

/** @typedef {{ canceled: boolean, filePath?: string }} SaveDialogResult */

/**
 * @param {object} opts
 * @param {(win: unknown, opts: object) => Promise<SaveDialogResult>} opts.showSaveDialog
 * @param {(path: string, data: Buffer) => Promise<void>} [opts.writeFileImpl]
 * @param {unknown} opts.mainWindow
 * @param {string} opts.defaultFilename
 * @param {Buffer | Uint8Array} opts.data
 */
export async function saveDesignPdfWithDialog({
  showSaveDialog,
  writeFileImpl = writeFile,
  mainWindow,
  defaultFilename,
  data,
}) {
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
