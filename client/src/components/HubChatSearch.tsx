import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { api } from '../utils/api';
import { authorLabel, channelLabel } from '../utils/hubChat';
import { formatDateTime } from '../utils/time';
import { refsToPlainText } from '@shared/utils/hubChatRefs';
import { hubChatSearchExcerpt, type HubChatSearchResult } from '@shared/utils/hubChatSearch';
import { locateChatMarkdownCode } from '../utils/hubChatMarkdown';

const DEBOUNCE_MS = 250;
const LIMIT = 30;

interface Props {
  usernames: ReadonlyMap<string, string>;
  viewerUserId: string | null;
  onPick: (result: HubChatSearchResult) => void;
  /** Shown in place of the results while the box is empty (the channel rail). */
  children: ReactNode;
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; results: HubChatSearchResult[]; hasMore: boolean }
  | { status: 'error'; error: string };

/** Message search box at the top of the chat rail; picking a hit jumps to it. */
export default function HubChatSearch({ usernames, viewerUserId, onPick, children }: Props) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  // Only the latest request may update the list.
  const requestRef = useRef(0);
  const trimmed = query.trim();

  useEffect(() => {
    const id = ++requestRef.current;
    if (!trimmed) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      api.hubChat
        .search(trimmed, { limit: LIMIT })
        .then((res: { results?: HubChatSearchResult[]; hasMore?: boolean }) => {
          if (requestRef.current !== id) return;
          setState({ status: 'done', results: res?.results ?? [], hasMore: !!res?.hasMore });
        })
        .catch((err: unknown) => {
          if (requestRef.current !== id) return;
          setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const clear = () => setQuery('');

  return (
    <>
      <div className="relative mx-2 mb-2">
        <Search
          size={13}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-500"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') clear();
          }}
          placeholder="Search messages"
          aria-label="Search messages"
          data-testid="hub-chat-search-input"
          className="w-full rounded border border-gray-700 bg-gray-900 py-1 pl-7 pr-7 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 hover:text-white"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {!trimmed ? (
        children
      ) : (
        <div data-testid="hub-chat-search-results" aria-live="polite">
          {state.status === 'loading' && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-gray-500">
              <Loader2 size={12} className="animate-spin" /> Searching…
            </div>
          )}
          {state.status === 'error' && (
            <p className="px-4 py-2 text-xs text-amber-300">Search failed: {state.error}</p>
          )}
          {state.status === 'done' && state.results.length === 0 && (
            <p className="px-4 py-2 text-xs text-gray-500">No messages found.</p>
          )}
          {state.status === 'done' &&
            state.results.map((r) => {
              const text = refsToPlainText(r.message.body, locateChatMarkdownCode);
              return (
                <button
                  key={r.message.id}
                  type="button"
                  data-testid="hub-chat-search-result"
                  onClick={() => {
                    clear();
                    onPick(r);
                  }}
                  className="block w-full px-4 py-1.5 text-left hover:bg-gray-800/60"
                >
                  <div className="flex items-baseline gap-2 text-[11px] text-gray-500">
                    <span className="min-w-0 truncate font-medium text-gray-300">
                      {channelLabel(r.channel, usernames, viewerUserId)}
                    </span>
                    <span className="ml-auto shrink-0">{formatDateTime(r.message.createdAt)}</span>
                  </div>
                  <div className="text-xs text-gray-400">
                    <span className="text-gray-300">{authorLabel(r.message, usernames)}: </span>
                    {hubChatSearchExcerpt(text, trimmed).map((part, i) =>
                      part.match ? (
                        <mark key={i} className="rounded-sm bg-yellow-500/30 text-yellow-100">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={i}>{part.text}</span>
                      ),
                    )}
                  </div>
                </button>
              );
            })}
          {state.status === 'done' && state.hasMore && (
            <p className="px-4 py-1 text-[11px] text-gray-600">
              Showing the newest {state.results.length}. Add words to narrow the search.
            </p>
          )}
        </div>
      )}
    </>
  );
}
