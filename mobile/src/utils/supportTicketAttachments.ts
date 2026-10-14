import { getApiBaseUrl, getAuthHeaders } from './config';

// Support-ticket attachments for React Native. The server reads the raw request
// body as the file, so the picked file's bytes go up with expo-file-system's
// BINARY_CONTENT upload. Deps are injectable so tests never load native modules.

export interface AttachmentUploadRef {
  uri: string;
  name: string;
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** POST one file; resolves with `{ attachment, ticket }`. */
export async function uploadSupportTicketAttachment(
  projectId: string,
  ticketId: string,
  fileRef: AttachmentUploadRef,
  deps: any = {},
): Promise<{ attachment: any; ticket: any }> {
  if (!fileRef?.uri) throw new Error('uploadSupportTicketAttachment: fileRef.uri is required');
  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');
  const FileSystem = deps.fileSystem || (await import('expo-file-system/legacy'));
  const uploadType =
    deps.uploadType !== undefined
      ? deps.uploadType
      : (FileSystem.FileSystemUploadType?.BINARY_CONTENT ?? 0);
  const result = await FileSystem.uploadAsync(
    `${base}/projects/${encodeURIComponent(projectId)}/support-tickets/${encodeURIComponent(ticketId)}/attachments`,
    fileRef.uri,
    {
      httpMethod: 'POST',
      uploadType,
      // octet-stream keeps the server from parsing a .json log as a JSON body.
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(fileRef.name || 'file'),
        ...getAuthHeaders(),
      },
    },
  );
  let body: any = {};
  try {
    body = JSON.parse(result?.body || '{}');
  } catch {
    /* non-JSON error page */
  }
  const status = result?.status ?? 0;
  if (status < 200 || status >= 300) {
    throw new Error(body?.error || `Upload failed (${status || 'unknown'})`);
  }
  return body;
}

/**
 * Upload picked files one at a time so a rejected file doesn't block the rest.
 * `onTicket` receives the updated ticket after each success; the result lists
 * per-file failures for the caller to show.
 */
export async function uploadSupportTicketAttachments(
  projectId: string,
  ticketId: string,
  files: AttachmentUploadRef[],
  opts: {
    onTicket?: (ticket: any) => void;
    onProgress?: (done: number, total: number) => void;
    upload?: typeof uploadSupportTicketAttachment;
  } = {},
): Promise<{ uploaded: number; failures: string[] }> {
  const upload = opts.upload || uploadSupportTicketAttachment;
  const failures: string[] = [];
  let uploaded = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    try {
      const res = await upload(projectId, ticketId, file);
      uploaded++;
      if (res?.ticket) opts.onTicket?.(res.ticket);
    } catch (err: any) {
      failures.push(`${file.name}: ${err?.message || 'upload failed'}`);
    }
    opts.onProgress?.(i + 1, files.length);
  }
  return { uploaded, failures };
}
