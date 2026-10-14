import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hubChatStore } from '../utils/hubChatInstance';
import { hubChatBadge, type HubChatSnapshot } from '../utils/hubChatStore';

export function useHubChatSnapshot(): HubChatSnapshot {
  return useSyncExternalStore(
    hubChatStore.subscribe,
    hubChatStore.getSnapshot,
    hubChatStore.getSnapshot,
  );
}

/**
 * The Chat badge: Agent Hub unread under the web rail rule. Google Chat is
 * web-only on mobile, so it contributes nothing here. A mute that expires
 * lifts its channel's count without a server event, hence the minute tick.
 */
export function useHubChatBadge(): number {
  const snapshot = useHubChatSnapshot();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => hubChatBadge(snapshot, now), [snapshot, now]);
}

/** A value that belongs to one account: the account it was set under, or null if set while none was active. */
export interface AccountScoped<T> {
  value: T | null;
  account: number | null;
}

type AccountView = Pick<HubChatSnapshot, 'account' | 'active'>;

export function scopeValue<T>(value: T | null, view: AccountView): AccountScoped<T> {
  // Bound to the active account even before its list loads; unassigned only
  // when no account is active (a push tapped on a cold start).
  return { value, account: view.active ? view.account : null };
}

/**
 * The value as it applies to the current account. A value set under another
 * account is dropped. A value set while no account was active (a cold start
 * from a push) is adopted by the next account that becomes active. Returns the
 * same object when nothing changes.
 */
export function scopeToAccount<T>(s: AccountScoped<T>, view: AccountView): AccountScoped<T> {
  if (s.value === null) return s;
  if (s.account === null) return view.active ? { ...s, account: view.account } : s;
  return s.account === view.account ? s : { value: null, account: view.account };
}

/**
 * useState for anything identifying chat data of one account (an open or
 * retained channel id): it reads as null as soon as the account changes, even
 * if the component that holds it was not mounted when the switch happened.
 */
export function useAccountScoped<T>(initial: T | null): [T | null, (value: T | null) => void] {
  const { account, active } = useHubChatSnapshot();
  const viewRef = useRef<AccountView>({ account, active });
  viewRef.current = { account, active };
  const [state, setState] = useState<AccountScoped<T>>(() =>
    scopeValue(initial, { account, active }),
  );
  const current = scopeToAccount(state, { account, active });
  useEffect(() => {
    if (current !== state) setState(current);
  }, [current, state]);
  const set = useCallback((value: T | null) => setState(scopeValue(value, viewRef.current)), []);
  return [current.value, set];
}
