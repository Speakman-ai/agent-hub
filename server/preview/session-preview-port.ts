import type { DevServerPortLookup } from './preview-runtime-lookup.js';

/**
 * Resolve the loopback host port the preview proxy should dial for a
 * session.
 *
 * `internalPort` selects the `/preview/proxy/p/<internalPort>` sub-mount;
 * omitting it resolves the primary host port.
 */
export function getSessionPreviewPort(
  sessionId: string,
  deps: { getDevServerRuntime?: () => DevServerPortLookup | null },
  internalPort?: number,
): number | null {
  const devServerPort = deps
    .getDevServerRuntime?.()
    ?.getSessionUpstreamPort(sessionId, internalPort);
  if (typeof devServerPort === 'number' && devServerPort > 0) {
    return devServerPort;
  }
  return null;
}
