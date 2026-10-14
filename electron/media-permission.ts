/**
 * Renderer permission requests. Electron grants everything when no handler is
 * installed; this keeps that for non-media permissions, but routes mic/camera
 * requests on macOS through the system privacy prompt.
 *
 * Without that, a packaged macOS app that has not been granted microphone
 * access still gets a "working" MediaStream from getUserMedia, but TCC feeds
 * it zeros, so a Notes recording runs to the end and captures nothing.
 * Asking first shows the OS prompt, and a refusal now rejects getUserMedia,
 * which the renderer reports as a permission error instead of a silent take.
 */

export type MediaAccessType = 'microphone' | 'camera';
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface MediaAccessDeps {
  platform: NodeJS.Platform;
  getMediaAccessStatus: (type: MediaAccessType) => MediaAccessStatus | string;
  askForMediaAccess: (type: MediaAccessType) => Promise<boolean>;
}

function requestedAccess(details: unknown): MediaAccessType[] {
  const mediaTypes = (details as { mediaTypes?: unknown } | null)?.mediaTypes;
  // Electron omits mediaTypes for some requests; treat that as audio, the
  // only media the app captures.
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return ['microphone'];
  const out: MediaAccessType[] = [];
  if (mediaTypes.includes('audio')) out.push('microphone');
  if (mediaTypes.includes('video')) out.push('camera');
  return out;
}

async function ensureAccess(type: MediaAccessType, deps: MediaAccessDeps): Promise<boolean> {
  const status = deps.getMediaAccessStatus(type);
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  try {
    return await deps.askForMediaAccess(type);
  } catch {
    return false;
  }
}

export async function resolvePermissionRequest(
  permission: string,
  details: unknown,
  deps: MediaAccessDeps,
): Promise<boolean> {
  if (permission !== 'media' || deps.platform !== 'darwin') return true;
  for (const type of requestedAccess(details)) {
    if (!(await ensureAccess(type, deps))) return false;
  }
  return true;
}
