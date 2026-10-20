import { useEffect, useRef } from 'react';
import { getAuthHeaders, getServerBase } from './connection';

/**
 * Identifies the connection an async request was issued against: the Server
 * URL plus the credential sent with it. A JWT is minted per account and active
 * Server, so a sign-out, account switch, or Server switch changes the key.
 */
export function currentRequestContextKey(): string {
  let credential = '';
  try {
    const headers = getAuthHeaders();
    credential = headers.Authorization || headers['X-API-Key'] || '';
  } catch {
    credential = '';
  }
  return `${getServerBase()}\n${credential}`;
}

export interface RequestTicket {
  /** False once the component unmounted, the connection changed, or a newer request of the same kind began. */
  isCurrent(): boolean;
}

/**
 * Hands out tickets for async work so late responses can be dropped instead of
 * acting on a context the user already left.
 */
export function useRequestScope(): (kind: string) => RequestTicket {
  const mountedRef = useRef(true);
  const generationsRef = useRef(new Map<string, number>());
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const beginRef = useRef((kind: string): RequestTicket => {
    const generation = (generationsRef.current.get(kind) ?? 0) + 1;
    generationsRef.current.set(kind, generation);
    const contextKey = currentRequestContextKey();
    return {
      isCurrent: () =>
        mountedRef.current &&
        generationsRef.current.get(kind) === generation &&
        currentRequestContextKey() === contextKey,
    };
  });
  return beginRef.current;
}
