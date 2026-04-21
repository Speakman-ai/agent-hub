// Shared client-side validation for chat attachments (images, videos, files).
//
// The server enforces a 100 MB limit per upload (see server/routes/uploads.ts
// MAX_UPLOAD_SIZE). Anything over that is rejected with a 413 — before this
// helper existed, the failure was swallowed silently in handleSend and the
// user saw their text message go through without the attachment, with no
// explanation. We pre-flight on the client so the user gets a clear toast
// immediately and the broken file never reaches the composer.

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB — keep in sync with server

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes}B`;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * Validate a File (or File-like object with `size`, `name`, `type`) before
 * uploading to the chat attachment endpoint.
 *
 * Returns an error message string to surface to the user, or null if the
 * file is acceptable. Keep rules in sync with server/upload-validation.ts +
 * server/routes/uploads.ts.
 *
 * @param {{size: number, name?: string, type?: string}} file
 * @param {{maxBytes?: number}} [opts]
 * @returns {string|null}
 */
export function validateAttachmentFile(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (!file) return 'No file selected';
  const size = typeof file.size === 'number' ? file.size : Number(file.size);
  if (!Number.isFinite(size) || size <= 0) {
    return `${file.name || 'File'} is empty and cannot be uploaded`;
  }
  if (size > maxBytes) {
    return `${file.name || 'File'} is ${formatSize(size)} — max attachment size is ${formatSize(maxBytes)}. Compress or trim the video and try again.`;
  }
  return null;
}

/**
 * Validate a list of files. Returns { accepted, rejected } where `rejected`
 * is an array of { file, reason }. The composer uses `accepted` and surfaces
 * `rejected` as toast(s).
 *
 * @param {Array<{size: number, name?: string, type?: string}>} files
 * @param {{maxBytes?: number}} [opts]
 */
export function partitionAttachmentFiles(files, opts = {}) {
  const accepted = [];
  const rejected = [];
  for (const f of files) {
    const reason = validateAttachmentFile(f, opts);
    if (reason) rejected.push({ file: f, reason });
    else accepted.push(f);
  }
  return { accepted, rejected };
}
