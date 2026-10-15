import { api } from './api';
import { focusHubChatMessage } from './hubChatSession';

/**
 * Opens the caller's Summaries channel in Hub Chat, creating it on first use.
 * Links to the removed Daily Summary pane land here. A failed lookup leaves
 * the Chat pane on whatever channel it would have opened anyway.
 */
export async function openSummariesChannel(
  open: () => Promise<{ channel?: { id?: string } }> = () => api.hubChat.openSummaryChannel(),
): Promise<string | null> {
  try {
    const id = (await open())?.channel?.id;
    if (!id) return null;
    focusHubChatMessage(id, null);
    return id;
  } catch {
    return null;
  }
}
