import type { OrganizationAgentApi } from '../utils/organization-agents';
import {
  OrganizationPortfolioController,
  type OrganizationPortfolioApi,
} from '../utils/organization-portfolio';

type ReactHooks = {
  useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void;
  useMemo: <T>(factory: () => T, dependencies: readonly unknown[]) => T;
  useSyncExternalStore: <T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
};

/** Refresh cadence while any request is pending or running. */
export const PORTFOLIO_POLL_MS = 5000;
/** Idle refresh, so project unlinks and lost project access drop stale data without a reload. */
export const PORTFOLIO_IDLE_POLL_MS = 30000;

export function createUseOrganizationPortfolio({
  useEffect,
  useMemo,
  useSyncExternalStore,
}: ReactHooks) {
  return function useOrganizationPortfolio(
    api: OrganizationPortfolioApi,
    agentsApi: OrganizationAgentApi,
    getScope: () => string,
    organizationId: string,
    refreshKey?: unknown,
  ) {
    const scope = getScope();
    // A new controller per Server scope and organization keeps each portfolio isolated.
    const controller = useMemo(
      () => new OrganizationPortfolioController(api, agentsApi, getScope, organizationId, scope),
      [api, agentsApi, getScope, organizationId, scope],
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
    const live = controller.hasLiveDispatches();
    useEffect(() => {
      const timer = setInterval(
        () => void controller.poll(),
        live ? PORTFOLIO_POLL_MS : PORTFOLIO_IDLE_POLL_MS,
      );
      return () => clearInterval(timer);
    }, [controller, live]);
    return { state, controller };
  };
}
