/**
 * The mobile composition root for Agent Hub chat: the one store, its account
 * gate, the chip cache and the markdown locator, each built from shared logic
 * with this app's platform pieces (API client, markdown parser) injected.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { createMarkdownLocator, type MarkdownNode } from '@shared/utils/hubChatRefTokens';
import { createHubChatRefCache } from '@shared/utils/hubChatRefCache';
import { api } from './api';
import { createHubChatStore } from './hubChatStore';
import { createHubChatAccountGate } from './hubChatAccountGate';

/**
 * The code locator for chat refs: the same parser and extensions as the
 * server and the web client, so a mention is live (stored, counted, shown as
 * a chip) under one rule on every surface.
 */
export const locateChatMarkdownCode = createMarkdownLocator(
  (body) =>
    fromMarkdown(body, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode,
);

/** Chip detail per viewer (logic in `@shared/utils/hubChatRefCache`). */
export const hubChatRefCache = createHubChatRefCache((refs) => api.hubChat.resolveRefs(refs), {
  useSyncExternalStore,
  useEffect,
  useRef,
});

/** The app's one Agent Hub chat store, fed by AppContext's WebSocket handler. */
export const hubChatStore = createHubChatStore(api.hubChat);

/** Resets and enables the store for the signed-in account (see hubChatAccountGate.ts). */
export const hubChatAccountGate = createHubChatAccountGate({
  reset: (enabled, viewerUserId) => hubChatStore.reset(enabled, viewerUserId),
  resync: () => hubChatStore.resync(),
  resetCaches: () => hubChatRefCache.reset(),
});
