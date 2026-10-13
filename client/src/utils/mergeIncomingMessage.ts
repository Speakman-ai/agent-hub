/**
 * Fold a broadcast `message` event into the session's message list. New ids
 * append. A system row we already hold is replaced, because Finalize
 * re-broadcasts a timeline entry after annotating it (for example, naming the
 * jobs a base-drift round kept). Other roles keep the copy we have.
 */
export function mergeIncomingMessage(prev: any[], msg: any): any[] {
  const existing = prev.findIndex((m: any) => m.id === msg.id);
  if (existing === -1) return [...prev, msg];
  if (msg.role !== 'system') return prev;
  const next = prev.slice();
  next[existing] = msg;
  return next;
}
