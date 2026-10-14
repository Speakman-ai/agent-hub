import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { authorLabel, channelLabel } from '@shared/utils/hubChat';
import { refsToPlainText } from '@shared/utils/hubChatRefs';
import { hubChatSearchExcerpt, type HubChatSearchResult } from '@shared/utils/hubChatSearch';
import { api } from '../utils/api';
import { locateChatMarkdownCode } from '../utils/hubChatInstance';
import { formatDateTime } from '../utils/time';
import HubIcon from './HubIcon';
import { colors } from '../theme/colors';

export const SEARCH_DEBOUNCE_MS = 250;
const LIMIT = 30;

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; results: HubChatSearchResult[]; hasMore: boolean }
  | { status: 'error'; error: string };

/**
 * Message search at the top of the chat rail. While the box is empty the rail
 * (`children`) shows; otherwise the results do, and picking one jumps to it.
 * Peer of the web `HubChatSearch`.
 */
export default function HubChatSearch({
  account,
  usernames,
  viewerUserId,
  onPick,
  children,
}: {
  /** The account results belong to; a switch drops the query, results and any request out. */
  account: number;
  usernames: ReadonlyMap<string, string>;
  viewerUserId: string | null;
  onPick: (result: HubChatSearchResult) => void;
  children: React.ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  // Only the latest request may update the list.
  const requestRef = useRef(0);
  const accountRef = useRef(account);
  const trimmed = query.trim();

  useEffect(() => {
    if (accountRef.current === account) return;
    accountRef.current = account;
    requestRef.current++;
    setQuery('');
    setState({ status: 'idle' });
  }, [account]);

  useEffect(() => {
    const id = ++requestRef.current;
    const live = () => requestRef.current === id && accountRef.current === account;
    if (!trimmed) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      api.hubChat
        .search(trimmed, { limit: LIMIT })
        .then((res: { results?: HubChatSearchResult[]; hasMore?: boolean }) => {
          if (!live()) return;
          setState({ status: 'done', results: res?.results ?? [], hasMore: !!res?.hasMore });
        })
        .catch((err: unknown) => {
          if (!live()) return;
          setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, account]);

  return (
    <>
      <View style={styles.box}>
        <HubIcon name="Search" size={14} color={colors.gray500} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search messages"
          placeholderTextColor={colors.gray500}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search messages"
          testID="hub-chat-search-input"
        />
        {query ? (
          <TouchableOpacity
            onPress={() => setQuery('')}
            accessibilityLabel="Clear search"
            testID="hub-chat-search-clear"
          >
            <HubIcon name="X" size={14} color={colors.gray500} />
          </TouchableOpacity>
        ) : null}
      </View>
      {!trimmed ? (
        children
      ) : (
        <ScrollView
          style={styles.flex}
          keyboardShouldPersistTaps="handled"
          testID="hub-chat-search-results"
        >
          {state.status === 'loading' ? (
            <View style={styles.status}>
              <ActivityIndicator size="small" color={colors.gray400} />
              <Text style={styles.muted}>Searching…</Text>
            </View>
          ) : null}
          {state.status === 'error' ? (
            <Text style={[styles.warn, styles.status]}>Search failed: {state.error}</Text>
          ) : null}
          {state.status === 'done' && state.results.length === 0 ? (
            <Text style={[styles.muted, styles.status]}>No messages found.</Text>
          ) : null}
          {state.status === 'done'
            ? state.results.map((r) => (
                <TouchableOpacity
                  key={r.message.id}
                  testID={`hub-chat-search-result-${r.message.id}`}
                  style={styles.result}
                  accessibilityRole="button"
                  onPress={() => {
                    setQuery('');
                    onPick(r);
                  }}
                >
                  <View style={styles.resultHeader}>
                    <Text style={styles.channel} numberOfLines={1}>
                      {channelLabel(r.channel, usernames, viewerUserId)}
                    </Text>
                    <Text style={styles.time}>{formatDateTime(r.message.createdAt)}</Text>
                  </View>
                  <Text style={styles.excerpt} numberOfLines={3}>
                    <Text style={styles.author}>{authorLabel(r.message, usernames)}: </Text>
                    {hubChatSearchExcerpt(
                      refsToPlainText(r.message.body, locateChatMarkdownCode),
                      trimmed,
                    ).map((part, i) => (
                      <Text key={i} style={part.match ? styles.match : undefined}>
                        {part.text}
                      </Text>
                    ))}
                  </Text>
                </TouchableOpacity>
              ))
            : null}
          {state.status === 'done' && state.hasMore ? (
            <Text style={[styles.time, styles.status]}>
              Showing the newest {state.results.length}. Add words to narrow the search.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minHeight: 0 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  input: { flex: 1, color: colors.white, fontSize: 14, paddingVertical: 8 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12 },
  muted: { color: colors.gray400, fontSize: 12 },
  warn: { color: colors.amber400, fontSize: 12 },
  result: { paddingHorizontal: 12, paddingVertical: 8 },
  resultHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 2 },
  channel: { flex: 1, color: colors.gray300, fontSize: 12, fontWeight: '600' },
  time: { color: colors.gray500, fontSize: 11 },
  excerpt: { color: colors.gray400, fontSize: 13 },
  author: { color: colors.gray300 },
  match: { color: colors.white, fontWeight: '700', backgroundColor: 'rgba(234,179,8,0.3)' },
});
