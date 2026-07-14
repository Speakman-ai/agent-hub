import type {
  DevServerPortLookup,
  PreviewComposeRuntimeSync,
  PreviewRuntimeActiveLookup,
} from './preview-runtime-lookup.js';

/**
 * Resolve the loopback host port the preview proxy should dial for a
 * session.
 *
 * The dev-server pivot repoints the proxy upstream onto the managed
 * dev-server host ports, so the dev-server runtime is consulted FIRST. It
 * is also the only runtime with multi-port support: when `internalPort` is
 * given (the `/preview/proxy/p/<internalPort>` sub-mount), resolution is
 * dev-server-only — compose/legacy previews have a single entry port, so a
 * sub-port request must NOT fall back to their primary port (that would
 * forward an extra-port request to the wrong upstream).
 */
export function getSessionPreviewPort(
  sessionId: string,
  deps: {
    getDevServerRuntime?: () => DevServerPortLookup | null;
    getPreviewComposeRuntime?: () => PreviewComposeRuntimeSync | null;
    getPreviewRuntime?: () => PreviewRuntimeActiveLookup | null;
  },
  internalPort?: number,
): number | null {
  const devServerPort = deps
    .getDevServerRuntime?.()
    ?.getSessionUpstreamPort(sessionId, internalPort);
  if (typeof devServerPort === 'number' && devServerPort > 0) {
    return devServerPort;
  }
  // An extra-port sub-mount only ever resolves against the dev server.
  if (internalPort !== undefined) return null;

  const compose = deps.getPreviewComposeRuntime?.()?.getActiveBySessionId(sessionId);
  if (compose?.status === 'ready' && compose.port > 0) {
    return compose.port;
  }
  const legacy = deps.getPreviewRuntime?.()?.getActiveBySessionId(sessionId);
  if (legacy?.status === 'ready' && legacy.port > 0) {
    return legacy.port;
  }
  return null;
}
