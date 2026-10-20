import {
  OrganizationAgentsController,
  type OrganizationAgentApi,
} from '../utils/organization-agents';

type ReactHooks = {
  useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void;
  useMemo: <T>(factory: () => T, dependencies: readonly unknown[]) => T;
  useSyncExternalStore: <T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
};

export function createUseOrganizationAgents({
  useEffect,
  useMemo,
  useSyncExternalStore,
}: ReactHooks) {
  return function useOrganizationAgents(
    api: OrganizationAgentApi,
    getScope: () => string,
    organizationId: string,
    refreshKey?: unknown,
  ) {
    const scope = getScope();
    // A new controller per Server scope and organization keeps each roster isolated.
    const controller = useMemo(
      () => new OrganizationAgentsController(api, getScope, organizationId, scope),
      [api, getScope, organizationId, scope],
    );
    const state = useSyncExternalStore(
      controller.subscribe,
      controller.snapshot,
      controller.snapshot,
    );
    useEffect(() => controller.cancel, [controller]);
    useEffect(() => {
      void controller.load();
    }, [controller, refreshKey]);
    return { state, controller };
  };
}
