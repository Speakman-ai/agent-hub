// AsyncStorage cache for the drawer's collapsed-project state.
//
// The AUTHORITATIVE store is per-user on the server
// (`GET/PUT /api/auth/me/sidebar-collapsed-projects`) — see
// `@shared/utils/sidebarProjectCollapse`. AsyncStorage only avoids a flash of
// every-project-expanded on cold start while the hydration GET is in flight,
// which matters more here than on web because the drawer often renders before
// the network settles. Server wins on divergence.
//
// The cache is keyed per ACCOUNT: it is what renders before hydration resolves
// and what survives a failed fetch, so a shared key would show one user's
// collapsed projects to the next person who signs in on the same device.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SIDEBAR_COLLAPSED_PROJECTS_KEY,
  collapsedProjectsCacheKey,
  parseCollapsedProjects,
} from '@shared/utils/sidebarProjectCollapse';
import { getAuthRecord } from './auth';

/** Namespace prefix, matching the app's other AsyncStorage keys. */
export const COLLAPSED_PROJECTS_STORAGE_PREFIX = `agent-hub-${SIDEBAR_COLLAPSED_PROJECTS_KEY}`;

/**
 * True for any key this feature owns — the per-account keys plus the unkeyed
 * one written before the cache was account-scoped. Used to prune other
 * accounts' buckets; deliberately strict so it can't reap a neighbouring key
 * that merely shares a prefix.
 */
function ownsKey(key: string): boolean {
  if (key === COLLAPSED_PROJECTS_STORAGE_PREFIX) return true;
  return key.startsWith(`${COLLAPSED_PROJECTS_STORAGE_PREFIX}:`);
}

/**
 * AsyncStorage key for the currently signed-in account. Resolved at call time
 * so a sign-out/sign-in never keeps writing to the previous account's bucket.
 */
export function currentCollapsedProjectsKey(): string {
  const scoped = collapsedProjectsCacheKey(getAuthRecord()?.user ?? null);
  return `agent-hub-${scoped}`;
}

async function writeCollapsedProjects(
  ids: readonly string[],
  key: string,
  pruneOtherAccounts = true,
): Promise<void> {
  if (pruneOtherAccounts) {
    const stale = (await AsyncStorage.getAllKeys()).filter((k) => k !== key && ownsKey(k));
    if (stale.length) await AsyncStorage.multiRemove(stale as string[]);
  }
  if (!ids.length) {
    await AsyncStorage.removeItem(key);
    return;
  }
  await AsyncStorage.setItem(key, JSON.stringify([...ids]));
}

/** Load the cached collapsed-project ids. Best-effort — empty on failure. */
export async function loadCollapsedProjects(): Promise<string[]> {
  try {
    return parseCollapsedProjects(await AsyncStorage.getItem(currentCollapsedProjectsKey()));
  } catch {
    return [];
  }
}

export interface CollapsedProjectsCacheSaver {
  save(ids: readonly string[]): Promise<void>;
  cancel(): void;
}

/**
 * Serialize and coalesce cache writes for one account lifetime.
 *
 * AsyncStorage writes are asynchronous. Independent writes can complete out
 * of order, so a rapid collapse/expand sequence could leave the cache holding
 * the stale collapsed value. The account key is captured when save() is
 * called, and cancel() retires queued work when the drawer changes accounts.
 */
export function createCollapsedProjectsCacheSaver(): CollapsedProjectsCacheSaver {
  let retired = false;
  let draining = false;
  let pending: {
    ids: string[];
    key: string;
    waiters: Array<() => void>;
  } | null = null;

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (pending && !retired) {
      const item = pending;
      pending = null;
      try {
        // An in-flight write may settle after the account changes. It must
        // never prune the new account's bucket, even though its key is
        // intentionally captured for the old account.
        await writeCollapsedProjects(item.ids, item.key, false);
      } catch {
        // Best-effort cache; a storage failure must not strand later writes.
      }
      item.waiters.forEach((resolve) => resolve());
    }
    if (pending) {
      pending.waiters.forEach((resolve) => resolve());
      pending = null;
    }
    draining = false;
  };

  return {
    save(ids) {
      if (retired) return Promise.resolve();
      const key = currentCollapsedProjectsKey();
      const value = [...ids];
      const promise = new Promise<void>((resolve) => {
        if (pending && pending.key === key) {
          pending.ids = value;
          pending.waiters.push(resolve);
        } else {
          pending?.waiters.forEach((waiter) => waiter());
          pending = { ids: value, key, waiters: [resolve] };
        }
      });
      void drain();
      return promise;
    },
    cancel() {
      retired = true;
      pending?.waiters.forEach((resolve) => resolve());
      pending = null;
    },
  };
}

/**
 * Persist the cache for the current account and drop every other account's
 * bucket, so this can't accumulate an entry per account that ever signed in.
 * Removes the key entirely when nothing is collapsed. Best-effort.
 */
export async function saveCollapsedProjects(ids: readonly string[]): Promise<void> {
  try {
    const key = currentCollapsedProjectsKey();
    await writeCollapsedProjects(ids, key);
  } catch {
    // Best-effort — ignore storage failures.
  }
}
