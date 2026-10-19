/**
 * Log unhandled promise rejections instead of letting Node exit.
 *
 * Node 15+ crashes the process on an unhandled rejection. The Hub is one
 * long-lived process carrying every chat turn, Finalize run, and runner lease,
 * so a single stray async throw in a request handler restarts all of it. Route
 * handlers should still catch their own errors; this is the backstop.
 */
interface RejectionSource {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

let installed = false;

export function installUnhandledRejectionLogger(
  proc: RejectionSource = process,
  log: (msg: string, reason: unknown) => void = (msg, reason) => console.error(msg, reason),
): void {
  if (proc === process) {
    if (installed) return;
    installed = true;
  }
  proc.on('unhandledRejection', (reason) => {
    log('[process] unhandled promise rejection (kept running):', reason);
  });
}
