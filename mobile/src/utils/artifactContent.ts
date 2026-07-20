import { getApiBaseUrl, getAuthHeaders } from './config';

// The artifact content endpoint is session-scoped and auth-gated, so we can't
// just hand a bare URL to `Linking.openURL` (no way to carry the bearer token,
// and no inline blob-URL trick like the web client). Instead we download the
// bytes with auth headers into the app cache and hand the local file to the OS
// share sheet, which previews inline-viewable types and offers "Save to Files"
// / share targets for everything else. This is the mobile analogue of the web
// viewArtifact / downloadArtifact helpers in client/src/utils/artifactContent.

/** Build the auth-gated content URL for an artifact. Pure + testable. */
export function buildArtifactContentUrl(
  base: any,
  sessionId: any,
  artifactId: any,
  { download = false }: any = {},
) {
  const qs = download ? '?download=1' : '';
  return `${base}/sessions/${sessionId}/artifacts/${artifactId}/content${qs}`;
}

/**
 * A filesystem-safe local basename for the cached copy. Strips any path
 * separators the (agent-controlled) filename might contain so we can't escape
 * the cache dir, and falls back to the artifact id when there's nothing usable.
 */
export function safeCacheName(filename: any, artifactId: any) {
  const base = typeof filename === 'string' ? filename.split(/[\\/]/).pop() || '' : '';
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').trim();
  // Reject empty and the reserved relative-path basenames ('.' / '..'). Dots
  // are allowed in real names (report.pdf), but a bare '.'/'..' concatenated
  // onto the cache dir would target the cache directory (or its parent), not a
  // file inside it — a path-escape with agent-controlled filenames.
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return `artifact-${artifactId || 'file'}`;
  }
  return cleaned;
}

/**
 * Download an artifact's bytes to the app cache and open the OS share sheet.
 * `download` toggles the server's attachment disposition (matches web). Deps
 * are injectable so unit tests never touch the native expo modules.
 */
export async function shareArtifact(
  sessionId: any,
  artifact: any,
  { download = false }: any = {},
  deps: any = {},
) {
  if (!sessionId) throw new Error('shareArtifact: sessionId is required');
  const artifactId = artifact?.id;
  if (!artifactId) throw new Error('shareArtifact: artifact.id is required');

  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');

  const FileSystem = deps.fileSystem || (await import('expo-file-system/legacy'));
  const Sharing = deps.sharing || (await import('expo-sharing'));

  const cacheDir = deps.cacheDir ?? FileSystem.cacheDirectory ?? '';
  const target = `${cacheDir}${safeCacheName(artifact?.filename, artifactId)}`;
  const url = buildArtifactContentUrl(base, sessionId, artifactId, { download });

  const result = await FileSystem.downloadAsync(url, target, { headers: { ...getAuthHeaders() } });
  const status = result?.status ?? 0;
  if (status < 200 || status >= 300) {
    throw new Error(`Failed to fetch artifact (${status})`);
  }

  const canShare = deps.canShare ?? (await Sharing.isAvailableAsync());
  if (!canShare) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(result?.uri || target, {
    mimeType: artifact?.contentType || undefined,
    dialogTitle: artifact?.filename || 'Artifact',
  });
  return result?.uri || target;
}
