import { getApiBaseUrl, getAuthHeaders } from './config';

// The artifact content endpoint is session-scoped and auth-gated, so mobile
// downloads bytes with auth headers into the app cache. Safe types can then be
// shown in the in-app viewer; Download hands the same cached file to the OS
// share sheet for Save to Files / external targets.

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

/** Download an artifact into the app cache without opening another app. */
export async function downloadArtifactToCache(
  sessionId: any,
  artifact: any,
  { download = false }: any = {},
  deps: any = {},
) {
  if (!sessionId) throw new Error('downloadArtifactToCache: sessionId is required');
  const artifactId = artifact?.id;
  if (!artifactId) throw new Error('downloadArtifactToCache: artifact.id is required');

  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');

  const FileSystem = deps.fileSystem || (await import('expo-file-system/legacy'));
  const cacheDir = deps.cacheDir ?? FileSystem.cacheDirectory ?? '';
  const target = `${cacheDir}${safeCacheName(artifact?.filename, artifactId)}`;
  const url = buildArtifactContentUrl(base, sessionId, artifactId, { download });
  const result = await FileSystem.downloadAsync(url, target, { headers: { ...getAuthHeaders() } });
  const status = result?.status ?? 0;
  if (status < 200 || status >= 300) {
    throw new Error(`Failed to fetch artifact (${status})`);
  }
  return { uri: result?.uri || target, fileSystem: FileSystem };
}

/** Load the cached URI and, for text documents, decoded contents for the viewer. */
export async function loadArtifactPreview(sessionId: any, artifact: any, deps: any = {}) {
  const downloaded = await downloadArtifactToCache(sessionId, artifact, {}, deps);
  const contentType = String(artifact?.contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const filename = String(artifact?.filename || '').toLowerCase();
  const textual =
    contentType === 'text/plain' ||
    contentType === 'text/markdown' ||
    contentType === 'text/csv' ||
    contentType === 'application/json' ||
    ['.txt', '.md', '.csv', '.json'].some((ext) => filename.endsWith(ext));
  if (!textual) return { uri: downloaded.uri, text: '' };

  const text = await downloaded.fileSystem.readAsStringAsync(downloaded.uri);
  if (contentType === 'application/json' || filename.endsWith('.json')) {
    try {
      return { uri: downloaded.uri, text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      // Preserve invalid JSON verbatim so the artifact remains inspectable.
    }
  }
  return { uri: downloaded.uri, text };
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

  const Sharing = deps.sharing || (await import('expo-sharing'));
  const result = await downloadArtifactToCache(sessionId, artifact, { download }, deps);

  const canShare = deps.canShare ?? (await Sharing.isAvailableAsync());
  if (!canShare) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(result.uri, {
    mimeType: artifact?.contentType || undefined,
    dialogTitle: artifact?.filename || 'Artifact',
  });
  return result.uri;
}
