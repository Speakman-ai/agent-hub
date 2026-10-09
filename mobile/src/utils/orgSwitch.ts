/**
 * Org switching for AppContext, split into a connection transition and a
 * background data reload.
 *
 * Callers (the login-screen server picker in particular) await only the
 * connection transition. The reload hits the new server with untimed fetches,
 * so awaiting it would let one hung endpoint freeze whatever UI started the
 * switch, including the escape hatch for choosing a different server.
 */

export interface OrgSwitcherDeps {
  /** Persist the active org and point the connection at its server. */
  switchOrg: (orgId: string) => Promise<void> | void;
  /** Reset per-org state and reconnect the WebSocket. Runs synchronously. */
  onConnectionChanged: () => void;
  /**
   * Reload data from the new server. `isCurrent()` turns false once a newer
   * switch has started, so a slow response can't overwrite the newer org.
   */
  loadData: (isCurrent: () => boolean) => Promise<void>;
  onLoadError?: (err: unknown) => void;
}

export function createOrgSwitcher(deps: OrgSwitcherDeps) {
  let generation = 0;
  return async function switchToOrg(orgId: string): Promise<void> {
    const gen = ++generation;
    await deps.switchOrg(orgId);
    deps.onConnectionChanged();
    const isCurrent = () => gen === generation;
    void Promise.resolve()
      .then(() => deps.loadData(isCurrent))
      .catch((err) => {
        if (isCurrent()) deps.onLoadError?.(err);
      });
  };
}
