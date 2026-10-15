import type { HubChatMentionNotice } from '@shared/utils/hubChat';

/**
 * Adds notices not already shown. The post response and the live
 * `hub_chat_notice` event both carry each refused mention.
 */
export function mergeNotices(
  current: HubChatMentionNotice[],
  added: HubChatMentionNotice[],
): HubChatMentionNotice[] {
  const keys = new Set(current.map((n) => n.key));
  const fresh = added.filter((n) => {
    if (keys.has(n.key)) return false;
    keys.add(n.key);
    return true;
  });
  return fresh.length ? [...current, ...fresh] : current;
}
