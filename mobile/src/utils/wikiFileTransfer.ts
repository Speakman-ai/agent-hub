import { getApiBaseUrl, getAuthHeaders } from './config';
import {
  wikiFileUploadUrl,
  wikiUploadRetryDelayMs,
  WIKI_UPLOAD_MAX_ATTEMPTS,
  type WikiFileWire,
} from '@shared/utils/wikiFiles';
import { safeCacheName } from './artifactContent';

// Wiki file upload/download for React Native. The server reads the raw request
// body as the file, so we post the picked file's bytes with expo-file-system's
// BINARY_CONTENT upload. Deps are injectable so tests never load native modules.

export interface WikiUploadRef {
  uri: string;
  name: string;
}

export async function uploadWikiFile(
  projectId: string,
  folder: string,
  fileRef: WikiUploadRef,
  deps: any = {},
): Promise<{ replaced: boolean; file: WikiFileWire; page: { slug: string } }> {
  if (!fileRef?.uri) throw new Error('uploadWikiFile: fileRef.uri is required');
  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');
  const FileSystem = deps.fileSystem || (await import('expo-file-system/legacy'));
  const uploadType =
    deps.uploadType !== undefined
      ? deps.uploadType
      : (FileSystem.FileSystemUploadType?.BINARY_CONTENT ?? 0);
  const sleep = deps.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let result: any;
  for (let attempt = 0; ; attempt++) {
    result = await FileSystem.uploadAsync(
      wikiFileUploadUrl(base, projectId, folder, fileRef.name || 'upload'),
      fileRef.uri,
      {
        httpMethod: 'POST',
        uploadType,
        // octet-stream keeps the server from parsing a .json document as JSON.
        headers: { 'Content-Type': 'application/octet-stream', ...getAuthHeaders() },
      },
    );
    // 503 means the server's upload slots are full; wait and retry.
    if (result?.status !== 503 || attempt + 1 >= WIKI_UPLOAD_MAX_ATTEMPTS) break;
    const headers = result.headers || {};
    await sleep(wikiUploadRetryDelayMs(headers['Retry-After'] ?? headers['retry-after'], attempt));
  }
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

/** Download a wiki file into the cache and open the OS share sheet. */
export async function shareWikiFile(projectId: string, file: WikiFileWire, deps: any = {}) {
  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');
  const FileSystem = deps.fileSystem || (await import('expo-file-system/legacy'));
  const Sharing = deps.sharing || (await import('expo-sharing'));
  const target = `${deps.cacheDir ?? FileSystem.cacheDirectory ?? ''}${safeCacheName(file.filename, file.id)}`;
  const url = `${base}/projects/${encodeURIComponent(projectId)}/wiki-files/${file.id}/download`;
  const result = await FileSystem.downloadAsync(url, target, { headers: { ...getAuthHeaders() } });
  const status = result?.status ?? 0;
  if (status < 200 || status >= 300) throw new Error(`Download failed (${status})`);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available.');
  await Sharing.shareAsync(result.uri || target, {
    mimeType: file.content_type || undefined,
    dialogTitle: file.filename,
  });
}
