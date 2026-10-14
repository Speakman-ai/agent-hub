/**
 * When the chat store resets and when it is enabled, for the account the app
 * is signed in to.
 *
 * Chat state (channels, unread counts, retained channel ids, drafts, pending
 * requests, resolved chips) belongs to one account: server, user and org.
 * Leaving an account invalidates all of it at once, before anything else
 * happens. That includes an org switch, which changes the API configuration
 * while the socket may still be down. The store then stays empty and disabled
 * until the new account is connected, and only then loads. Waiting for the
 * connection to drive the reset left the previous org's chat on screen, and
 * its in-flight responses valid, for as long as reconnecting took.
 */
export interface HubChatAccountGateDeps {
  reset: (enabled: boolean, viewerUserId: string | null) => Promise<void> | void;
  resync: () => void;
  /** Forgets per-viewer caches outside the store (resolved chips). */
  resetCaches: () => void;
}

export interface HubChatAccountState {
  /** Server, user and org, or null when not signed in. */
  account: string | null;
  userId: string | null;
  connected: boolean;
}

export function createHubChatAccountGate(deps: HubChatAccountGateDeps) {
  // The account the store is loaded for; null while invalidated.
  let active: string | null = null;

  function invalidate() {
    active = null;
    deps.resetCaches();
    void deps.reset(false, null);
  }

  return {
    /** The account is going away (org switch, sign-out): drop its chat now. */
    invalidate,
    /** The latest identity and connection state. */
    update(state: HubChatAccountState) {
      if (state.account !== active && active !== null) invalidate();
      if (!state.account) return;
      if (state.account !== active) {
        // Load only once connected, so the first fetch and the live events
        // both belong to the new account.
        if (!state.connected) return;
        active = state.account;
        deps.resetCaches();
        void deps.reset(true, state.userId);
        return;
      }
      // Same account, (re)connected: events missed meanwhile are not replayed.
      if (state.connected) deps.resync();
    },
    activeAccount: () => active,
  };
}

export type HubChatAccountGate = ReturnType<typeof createHubChatAccountGate>;
