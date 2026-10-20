import { OrganizationController, type OrganizationApi } from '../utils/organizations';

type ReactHooks = {
  useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void;
  useMemo: <T>(factory: () => T, dependencies: readonly unknown[]) => T;
  useSyncExternalStore: <T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
};

// Each renderer supplies its own React version (web 18, mobile 19).
export function createUseOrganizations({ useEffect, useMemo, useSyncExternalStore }: ReactHooks) {
  return function useOrganizations(
    api: OrganizationApi,
    getScope: () => string,
    refreshKey?: unknown,
  ) {
    const scope = getScope();
    const controller = useMemo(
      () => new OrganizationController(api, getScope, scope),
      [api, getScope, scope],
    );
    const state = useSyncExternalStore(
      controller.subscribe,
      controller.snapshot,
      controller.snapshot,
    );
    useEffect(() => {
      return controller.cancel;
    }, [controller]);
    useEffect(() => {
      controller.refresh();
    }, [controller, refreshKey]);
    return { state, controller };
  };
}
