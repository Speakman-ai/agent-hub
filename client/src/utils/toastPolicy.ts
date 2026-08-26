import { isFetchTimeoutMessage } from './api';

/**
 * Returns true when a toast message is a structured `fetchJSON` request-timeout
 * string (`Request timed out after <n>ms: <METHOD> <path>`) that a caller
 * should drop rather than surface.
 *
 * This is NOT applied globally — a timeout on an action whose only failure
 * feedback is a toast must still show. It is used at call sites that already
 * record the failure inline (e.g. the workspace-ensure flow, which keeps the
 * composer gated and offers a Retry), where the raw timeout toast is pure
 * noise. Domain-specific timeout copy (e.g. "Preview health check timed out")
 * does not match the structured shape and returns false regardless.
 */
export function shouldSuppressToast(message: unknown): boolean {
  return isFetchTimeoutMessage(message);
}
