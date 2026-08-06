// Local cache for the sidebar's collapsed-project state.
//
// The AUTHORITATIVE store is per-user on the server
// (`GET/PUT /api/auth/me/sidebar-collapsed-projects`) — see
// `@shared/utils/sidebarProjectCollapse`. localStorage is only a first-paint
// cache so a reload doesn't flash every project open while the fetch is in
// flight. Treat a divergence between the two as "server wins".
//
// The cache is keyed per ACCOUNT. It is what renders before hydration resolves
// and what survives a failed fetch, so a shared key would show one user's
// collapsed projects to the next person who signs in on the same browser.
import {
  SIDEBAR_COLLAPSED_PROJECTS_KEY,
  collapsedProjectsCacheKey,
  isCollapsedProjectsCacheKey,
  parseCollapsedProjects,
} from '@shared/utils/sidebarProjectCollapse';
import { getAuthRecord } from './auth';

export { SIDEBAR_COLLAPSED_PROJECTS_KEY, collapsedProjectsCacheKey };

/**
 * localStorage key for the currently signed-in account. Resolved at call time
 * rather than cached, so a sign-out/sign-in on the same page never keeps
 * writing to the previous account's bucket.
 */
export function currentCollapsedProjectsKey(): string {
  try {
    return collapsedProjectsCacheKey(getAuthRecord()?.user ?? null);
  } catch {
    return collapsedProjectsCacheKey(null);
  }
}

/** Read the cached collapsed-project ids. Empty when storage is unavailable. */
export function readCollapsedProjects(): string[] {
  try {
    return parseCollapsedProjects(localStorage.getItem(currentCollapsedProjectsKey()));
  } catch {
    // Storage disabled / SSR — treat as nothing collapsed.
    return [];
  }
}

/**
 * Persist the cache for the current account and drop every other account's
 * bucket (plus the pre-scoping unkeyed one).
 *
 * Pruning keeps this from accumulating an entry per account that ever signed
 * in on the machine, and the cost of dropping a signed-out user's bucket is
 * one frame of "all expanded" on their next sign-in before hydration lands.
 */
export function writeCollapsedProjects(ids: readonly string[]): void {
  try {
    const key = currentCollapsedProjectsKey();
    pruneForeignCollapsedProjectKeys(key);
    if (!ids.length) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Best-effort persistence (private mode / quota).
  }
}

/** Remove every collapsed-projects cache entry except `keepKey`. */
function pruneForeignCollapsedProjectKeys(keepKey: string): void {
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key !== keepKey && isCollapsedProjectsCacheKey(key)) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
}
