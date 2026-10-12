/**
 * HEAD-probe a published desktop installer URL from the main process.
 *
 * The hub's version is bumped before the DMG for that version is uploaded, so
 * the renderer checks the installer exists before announcing an update. S3
 * answers a missing key with 403 (no ListBucket grant), never 404, so any
 * non-2xx means "not published". The probe runs here because the release
 * bucket sends no CORS headers to the renderer.
 *
 * This is a privileged request on behalf of the renderer, so it only goes to a
 * public S3 endpoint for a versioned `.dmg` key, on the default https port,
 * and never follows redirects. Anything else is not fetched at all.
 */

const S3_HOST = /^[a-z0-9][a-z0-9.-]*\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const INSTALLER_PATH = /^\/v\d+\.\d+\.\d+[^/]*\/[^/]+\.dmg$/i;

export function isProbeableInstallerUrl(rawUrl: unknown): URL | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  if (url.search || url.hash) return null;
  if (!S3_HOST.test(url.hostname)) return null;
  if (!INSTALLER_PATH.test(url.pathname)) return null;
  return url;
}

/**
 * `true` published, `false` missing or unreachable, `null` when the URL is not
 * an S3 release key this probe will touch (the renderer then announces the
 * update unverified, as builds without the probe do).
 */
export async function probeInstallerUrl(
  rawUrl: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<boolean | null> {
  const url = isProbeableInstallerUrl(rawUrl);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.href, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
