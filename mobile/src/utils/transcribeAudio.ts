import { getApiBaseUrl, getAuthHeaders } from './config';
/**
 * Map an uploadAsync result to either `{ transcript }` or a user-facing error
 * message. Mirrors the status handling in client MessageInput.jsx.
 */
export function parseTranscribeUploadResult(status: any, bodyText: any) {
  let body: any = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      /* non-JSON body */
    }
  }
  if (status === 501) {
    return {
      ok: false,
      message:
        body.hint ||
        'Voice transcription not configured. Ask your admin to set the API key in Account settings.',
    };
  }
  if (status === 415) {
    return {
      ok: false,
      message:
        body.hint ||
        "This audio format isn't supported by the selected transcription provider. Switch the provider in Settings → Account.",
    };
  }
  if (status === 413) {
    return { ok: false, message: 'Recording is too long. Try a shorter clip.' };
  }
  if (status < 200 || status >= 300) {
    const detail = body.error || body.detail || '';
    return {
      ok: false,
      message: `Transcription failed (HTTP ${status})${detail ? ': ' + detail : ''}. Tap mic to retry.`,
    };
  }
  if (typeof body.transcript !== 'string' || !body.transcript.trim()) {
    return { ok: false, message: "Couldn't hear anything — try again." };
  }
  return { ok: true, transcript: body.transcript };
}
/**
 * POST raw audio bytes to /api/transcribe (not multipart). Injectable
 * `deps.fileSystem` keeps vitest from loading the native expo module.
 */
export async function transcribeAudio(uri: any, contentType: any, deps: any = {}) {
  if (!uri) throw new Error('transcribeAudio: uri is required');
  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');
  // `uploadAsync` is deprecated on the main `expo-file-system` module as of
  // SDK 54 and THROWS at runtime there — it must be imported from the
  // `/legacy` entry point (or replaced with expo/fetch). We keep the legacy
  // binary-upload path since the server expects a raw-bytes POST, not
  // multipart. Docs: https://docs.expo.dev/versions/latest/sdk/filesystem/
  const FileSystem = deps.fileSystem || (await import('expo-file-system/legacy'));
  const uploadType =
    deps.uploadType !== undefined
      ? deps.uploadType
      : (FileSystem.FileSystemUploadType?.BINARY_CONTENT ?? 'BINARY_CONTENT');
  const result = await FileSystem.uploadAsync(`${base}/transcribe`, uri, {
    httpMethod: 'POST',
    uploadType,
    headers: {
      'Content-Type': contentType,
      ...getAuthHeaders(),
    },
  });
  const parsed = parseTranscribeUploadResult(result?.status, result?.body);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return { transcript: parsed.transcript };
}
