/**
 * Ties one live browser session to the owner's saved browser profile.
 *
 * At launch the binding takes the profile's write lease and loads the saved
 * storageState so the new context starts signed in. While the session is
 * open it renews the lease and saves every few minutes; on close (idle,
 * explicit, shutdown) it does a final save and releases the lease.
 *
 * A session that cannot get the lease (another session holds it) still gets
 * the saved state as a read-only copy. Nothing it does is written back, and
 * the agent is told so once through {@link BrowserProfileBinding.takeNotice}.
 * A writable session whose lease lapses becomes read-only for good: taking
 * the lease back later would let its stale copy overwrite logins another
 * session saved in between.
 */
import {
  acquireBrowserProfileLease,
  BrowserProfileDecryptError,
  BrowserProfileLeaseError,
  DEFAULT_BROWSER_PROFILE_LEASE_TTL_MS,
  loadBrowserProfileState,
  releaseBrowserProfileLease,
  renewBrowserProfileLease,
  saveBrowserProfileState,
  type BrowserProfileKey,
  type BrowserStorageState,
} from './browser-profiles-store.js';

export const BROWSER_PROFILE_SAVE_INTERVAL_MS = 5 * 60 * 1000;
/** Renew well inside the lease TTL so a busy event loop does not drop it. */
export const BROWSER_PROFILE_LEASE_RENEW_MS = Math.floor(DEFAULT_BROWSER_PROFILE_LEASE_TTL_MS / 3);

export const BROWSER_PROFILE_READ_ONLY_NOTICE =
  'Browser profile is read-only for this session: another session is using the saved logins, so cookies and storage changes made here will not be saved.';
export const BROWSER_PROFILE_LEASE_LOST_NOTICE =
  'Browser profile write access was lost (another session took over the saved logins). Changes made from now on will not be saved.';

/** The slice of a Playwright BrowserContext the binding needs. */
export interface StorageStateSource {
  storageState: (opts: { indexedDB: boolean }) => Promise<unknown>;
}

export interface BrowserProfileBinding {
  readonly key: BrowserProfileKey;
  readonly holder: string;
  /** Saved state to pass to `newContext({ storageState })`, or null for a fresh context. */
  readonly initialState: BrowserStorageState | null;
  readonly writable: boolean;
  /** One-shot observation line for the agent, or null when there is nothing to say. */
  takeNotice(): string | null;
  /** Start periodic lease renewal and saves against the live context. */
  attach(context: StorageStateSource): void;
  /** Save now. Resolves false when nothing was written. */
  save(): Promise<boolean>;
  /** Final save (when attached and writable), stop timers, release the lease. Idempotent. */
  close(): Promise<void>;
}

export interface BrowserProfileBindingOptions {
  saveIntervalMs?: number;
  renewIntervalMs?: number;
}

/**
 * Open a binding for `holder` (the browser session id). Returns null when the
 * profile store is unavailable, so browsing still works without saved logins.
 */
export function openBrowserProfileBinding(
  key: BrowserProfileKey,
  holder: string,
  opts: BrowserProfileBindingOptions = {},
): BrowserProfileBinding | null {
  let writable: boolean;
  try {
    writable = acquireBrowserProfileLease(key, holder).acquired;
  } catch (err) {
    console.warn(`[browser-profile] lease acquire failed for ${holder}: ${errorName(err)}`);
    return null;
  }

  let initialState: BrowserStorageState | null = null;
  try {
    initialState = loadBrowserProfileState(key);
  } catch (err) {
    // Unreadable blob: start fresh. A writable session will overwrite it on save.
    const why =
      err instanceof BrowserProfileDecryptError ? 'unreadable saved state' : errorName(err);
    console.warn(`[browser-profile] load failed for ${holder}: ${why}`);
  }

  let notice: string | null = writable ? null : BROWSER_PROFILE_READ_ONLY_NOTICE;
  let context: StorageStateSource | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  let saveTimer: NodeJS.Timeout | null = null;
  let renewTimer: NodeJS.Timeout | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const stopTimers = (): void => {
    if (saveTimer) clearInterval(saveTimer);
    if (renewTimer) clearInterval(renewTimer);
    saveTimer = null;
    renewTimer = null;
  };

  const loseLease = (): void => {
    if (!writable) return;
    writable = false;
    notice = BROWSER_PROFILE_LEASE_LOST_NOTICE;
    stopTimers();
  };

  const doSave = async (): Promise<boolean> => {
    if (!writable || !context) return false;
    let state: unknown;
    try {
      state = await context.storageState({ indexedDB: true });
    } catch (err) {
      console.warn(`[browser-profile] storageState failed for ${holder}: ${errorName(err)}`);
      return false;
    }
    if (!writable) return false;
    try {
      saveBrowserProfileState(key, holder, state as BrowserStorageState);
      return true;
    } catch (err) {
      if (err instanceof BrowserProfileLeaseError) {
        loseLease();
      } else {
        console.warn(`[browser-profile] save failed for ${holder}: ${errorName(err)}`);
      }
      return false;
    }
  };

  // Serialize saves so a periodic save and the close save never interleave.
  const save = (): Promise<boolean> => {
    const run = chain.then(doSave, doSave);
    chain = run.catch(() => {});
    return run;
  };

  return {
    key,
    holder,
    initialState,
    get writable() {
      return writable;
    },
    takeNotice() {
      const n = notice;
      notice = null;
      return n;
    },
    attach(ctx) {
      if (closed) return;
      context = ctx;
      if (!writable) return;
      saveTimer = setInterval(() => {
        void save();
      }, opts.saveIntervalMs ?? BROWSER_PROFILE_SAVE_INTERVAL_MS);
      renewTimer = setInterval(() => {
        try {
          if (!renewBrowserProfileLease(key, holder)) loseLease();
        } catch (err) {
          console.warn(`[browser-profile] lease renew failed for ${holder}: ${errorName(err)}`);
        }
      }, opts.renewIntervalMs ?? BROWSER_PROFILE_LEASE_RENEW_MS);
      saveTimer.unref?.();
      renewTimer.unref?.();
    },
    save,
    close() {
      // Every caller waits on the same final save so none tears the context
      // down while storageState() is still reading it.
      if (closing) return closing;
      closed = true;
      stopTimers();
      closing = (async () => {
        const wasWritable = writable;
        if (wasWritable) await save();
        writable = false;
        if (wasWritable) {
          try {
            releaseBrowserProfileLease(key, holder);
          } catch (err) {
            console.warn(`[browser-profile] lease release failed for ${holder}: ${errorName(err)}`);
          }
        }
      })();
      return closing;
    },
  };
}

/** Error class name only: messages from storage/crypto layers can quote state. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name || 'Error' : 'non-error thrown';
}
