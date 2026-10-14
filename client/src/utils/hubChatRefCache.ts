import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createHubChatRefCache, REFRESH_TICK_MS } from '@shared/utils/hubChatRefCache';
import { api } from './api';

/** The web client's chip cache (logic in `@shared/utils/hubChatRefCache`). */
const cache = createHubChatRefCache((refs) => api.hubChat.resolveRefs(refs), {
  useSyncExternalStore,
  useEffect,
  useRef,
});

export { REFRESH_TICK_MS };
export const requestHubChatRefs = cache.request;
export const getHubChatRef = cache.get;
export const useHubChatRefs = cache.useRefs;
export const resetHubChatRefCacheForTests = cache.reset;
