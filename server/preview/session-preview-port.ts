import type {
  PreviewComposeRuntimeSync,
  PreviewRuntimeActiveLookup,
} from './preview-runtime-lookup.js';

export function getSessionPreviewPort(
  sessionId: string,
  deps: {
    getPreviewComposeRuntime?: () => PreviewComposeRuntimeSync | null;
    getPreviewRuntime?: () => PreviewRuntimeActiveLookup | null;
  },
): number | null {
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
