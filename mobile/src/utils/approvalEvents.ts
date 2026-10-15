/**
 * In-process fan-out for `approval_requested` / `approval_resolved` WS
 * frames. AppContext publishes; the chat card and inbox rows subscribe.
 */
type Listener = (data: Record<string, unknown>) => void;

const listeners = new Set<Listener>();

export const approvalEvents = {
  emit(data: Record<string, unknown>): void {
    listeners.forEach((cb) => {
      try {
        cb(data);
      } catch {
        /* one listener throwing must not starve the others */
      }
    });
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
