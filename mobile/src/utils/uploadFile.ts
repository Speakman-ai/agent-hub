import { getApiBaseUrl, getAuthHeaders } from './config';
// Upload a local file (video or arbitrary binary) to /api/upload/file.
//
// Mirrors the web client's `api.uploadFile(file)` helper. The web version
// sends a browser File object directly as the request body; React Native
// can't stream a Blob/File the same way, so we use expo-file-system's
// `uploadAsync` in BINARY_CONTENT mode to post the file's raw bytes.
//
// `fileRef` shape: { uri, name, type?, size? }
//   - uri:   local file:// or content:// URI from image-picker / document-picker
//   - name:  filename sent back to the server via X-Filename header
//   - type:  MIME type used for Content-Type (defaults to octet-stream)
//
// The server responds with { id, filename, originalName, contentType, url }.
// Injectable `deps.fileSystem` exists so tests can avoid loading the native
// expo-file-system module in a plain-node vitest environment.
export async function uploadFile(fileRef: any, deps: any = {}) {
    if (!fileRef || !fileRef.uri) {
        throw new Error('uploadFile: fileRef.uri is required');
    }
    const base = getApiBaseUrl();
    if (!base)
        throw new Error('No server configured');
    const FileSystem = deps.fileSystem || (await import('expo-file-system'));
    const uploadType = deps.uploadType !== undefined
        ? deps.uploadType
        : FileSystem.FileSystemUploadType?.BINARY_CONTENT ?? 'BINARY_CONTENT';
    const headers = {
        'Content-Type': fileRef.type || 'application/octet-stream',
        'X-Filename': fileRef.name || 'upload.bin',
        ...getAuthHeaders(),
    };
    const result = await FileSystem.uploadAsync(`${base}/upload/file`, fileRef.uri, {
        httpMethod: 'POST',
        uploadType,
        headers,
    });
    if (!result || typeof result.status !== 'number' || result.status < 200 || result.status >= 300) {
        throw new Error(`API error: ${result?.status ?? 'unknown'}`);
    }
    try {
        return JSON.parse(result.body || '{}');
    }
    catch {
        throw new Error('Invalid upload response');
    }
}
