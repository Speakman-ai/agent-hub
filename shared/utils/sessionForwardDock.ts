import type { ExtractedForward } from './extractForwardBlocks.js';

/**
 * Session forward cards that are waiting on the person, pinned to the end of
 * their chat until they are launched or dismissed.
 *
 * The timeline slot that owns a card pins it here instead of rendering it in
 * its message, and the chat renders the pinned cards after the last message.
 * Entries are not dropped when the slot unmounts: a virtualized list (mobile)
 * unmounts old rows while their card is still open. They leave the dock only
 * when the card is resolved.
 */
export interface DockedSessionForward {
  /** Card identity, the same key the dispatch store uses. */
  identity: string;
  /** Chat the card was posted in. */
  chatSessionId: string;
  messageId: string | number;
  forward: ExtractedForward;
  occurrence: number;
}

export interface SessionForwardDock {
  pin(entry: DockedSessionForward): void;
  unpin(identity: string): void;
  /** Every pinned card in pin order. Stable until the next change. */
  snapshot(): readonly DockedSessionForward[];
  subscribe(listener: () => void): () => void;
  clear(): void;
}

const FORWARD_FIELDS: Array<keyof ExtractedForward> = [
  'forwardId',
  'projectId',
  'agentId',
  'name',
  'summary',
  'prompt',
  'mode',
];

function sameEntry(a: DockedSessionForward, b: DockedSessionForward): boolean {
  return (
    a.chatSessionId === b.chatSessionId &&
    a.messageId === b.messageId &&
    a.occurrence === b.occurrence &&
    FORWARD_FIELDS.every((field) => a.forward[field] === b.forward[field])
  );
}

export function createSessionForwardDock(): SessionForwardDock {
  const entries = new Map<string, DockedSessionForward>();
  const listeners = new Set<() => void>();
  let snapshot: readonly DockedSessionForward[] = [];

  const changed = () => {
    snapshot = [...entries.values()];
    for (const listener of [...listeners]) listener();
  };

  return {
    pin(entry) {
      const current = entries.get(entry.identity);
      if (current && sameEntry(current, entry)) return;
      entries.set(entry.identity, entry);
      changed();
    },
    unpin(identity) {
      if (entries.delete(identity)) changed();
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      if (entries.size === 0) return;
      entries.clear();
      changed();
    },
  };
}

/** Pinned cards for one chat, oldest first. */
export function dockedForwardsFor(
  snapshot: readonly DockedSessionForward[],
  chatSessionId: string | null | undefined,
): DockedSessionForward[] {
  if (!chatSessionId) return [];
  return snapshot.filter((entry) => entry.chatSessionId === chatSessionId);
}

/** What a card's saved storage value says about it. */
export function parseSavedForwardState(raw: string | null): 'dismissed' | 'forwarded' | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      dismissed?: unknown;
      sessionId?: unknown;
      agentId?: unknown;
    };
    if (parsed?.dismissed === true) return 'dismissed';
    if (parsed?.sessionId && parsed?.agentId) return 'forwarded';
  } catch {
    /* unreadable values count as nothing saved */
  }
  return null;
}

/** Storage value written when a card is dismissed. */
export const DISMISSED_FORWARD_VALUE = JSON.stringify({ dismissed: true });
