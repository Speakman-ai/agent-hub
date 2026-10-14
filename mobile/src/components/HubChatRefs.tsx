import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextInputProps,
} from 'react-native';
import Markdown, { MarkdownIt } from 'react-native-markdown-display';
import {
  addComposerMention,
  findMentionQuery,
  formatHubChatRefToken,
  insertMentionText,
  parseHubChatRefTokens,
  reconcileComposerMentions,
  refDisplay,
  type ComposerMention,
  type HubChatRefKind,
  type HubChatRefSuggestion,
  type HubChatRefToken,
  type HubChatResolvedRef,
} from '@shared/utils/hubChatRefs';
import { api } from '../utils/api';
import { hubChatRefCache, locateChatMarkdownCode } from '../utils/hubChatInstance';
import {
  hubChatRefAtPlugin,
  chipTokenFor,
  markLiveTokens,
  refFromHref,
} from '../utils/hubChatMobile';
import { colors } from '../theme/colors';
import { createEditTracker, type EditTracker } from '../utils/composerEdit';

const KIND_LABEL: Record<HubChatRefKind, string> = {
  user: 'Person',
  agent: 'Agent',
  session: 'Session',
  card: 'Card',
  ticket: 'Ticket',
  pr: 'Pull request',
};

const SEARCH_DEBOUNCE_MS = 120;

/** The chat renderer's markdown-it, with the ref `@` pass installed. */
const chatMarkdownIt = MarkdownIt({ typographer: true }).use(hubChatRefAtPlugin);

export type HubChatRefOpenHandler = (ref: HubChatResolvedRef) => void;

function statusColor(kind: HubChatRefKind, status: string): string {
  const s = status.toLowerCase();
  if (kind === 'pr') {
    if (s === 'merged') return colors.purple400;
    if (s === 'closed') return colors.red400;
    return colors.emerald300;
  }
  if (s === 'done' || s === 'closed' || s === 'converted' || s === 'completed') {
    return colors.gray400;
  }
  return colors.sky300;
}

/** An inline chip for one ref. Hidden refs show their label only. */
export function HubChatRefChip({
  token,
  resolved,
  onOpen,
}: {
  token: HubChatRefToken;
  resolved: HubChatResolvedRef | null;
  onOpen?: HubChatRefOpenHandler;
}) {
  const visible = !!resolved?.visible;
  const label = refDisplay(token.kind, visible && resolved?.label ? resolved.label : token.label);
  if (!visible) {
    return (
      <Text testID="hub-chat-ref" style={[styles.chip, styles.chipHidden]}>
        {label}
      </Text>
    );
  }
  const status =
    resolved?.status && token.kind !== 'user' && token.kind !== 'agent' ? resolved.status : null;
  return (
    <Text
      testID="hub-chat-ref"
      style={[styles.chip, styles.chipVisible]}
      onPress={onOpen ? () => onOpen(resolved as HubChatResolvedRef) : undefined}
      accessibilityRole={onOpen ? 'link' : 'text'}
      accessibilityLabel={[KIND_LABEL[token.kind], resolved?.title || label, status]
        .filter(Boolean)
        .join(', ')}
    >
      {` ${label}`}
      {status ? (
        <Text style={{ color: statusColor(token.kind, status), fontSize: 11 }}>{` ${status}`}</Text>
      ) : null}{' '}
    </Text>
  );
}

/**
 * A message body with live ref tokens as chips. The body is rendered as
 * written apart from live tokens' link destinations, which `markLiveTokens`
 * replaces with an occurrence marker; only a marked link becomes a chip.
 */
export function HubChatMessageBody({
  body,
  onOpenRef,
  style,
}: {
  body: string;
  onOpenRef?: HubChatRefOpenHandler;
  style?: any;
}) {
  const tokens = useMemo(() => parseHubChatRefTokens(body, locateChatMarkdownCode), [body]);
  const version = hubChatRefCache.useRefs(tokens);
  const source = useMemo(() => markLiveTokens(body, tokens), [body, tokens]);
  const rules = useMemo(
    () => ({
      link: (node: any, children: React.ReactNode) => {
        const href: string | undefined = node.attributes?.href;
        const ref = refFromHref(href);
        const token = chipTokenFor(href, tokens);
        if (token) {
          return (
            <HubChatRefChip
              key={node.key}
              token={token}
              resolved={hubChatRefCache.get(token.kind, token.targetId)}
              onOpen={onOpenRef}
            />
          );
        }
        if (ref) {
          // A ref-shaped link the server did not keep (escaped, reference
          // style, plain): text as written, its `@` untouched.
          return <Text key={node.key}>{children}</Text>;
        }
        return (
          <Text
            key={node.key}
            style={styles.link}
            onPress={() => {
              if (href && /^https?:\/\//i.test(href)) void Linking.openURL(href);
            }}
          >
            {children}
          </Text>
        );
      },
    }),
    // `version` re-renders chips when resolved detail lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens, onOpenRef, version],
  );
  return (
    <Markdown markdownit={chatMarkdownIt} rules={rules} style={style ?? markdownStyles}>
      {source}
    </Markdown>
  );
}

type MentionQuery = NonNullable<ReturnType<typeof findMentionQuery>>;

/**
 * The `@`/`#` query at the caret, or null when the caret was measured on
 * other text than `value` (the draft was replaced) or the word there is
 * already a picked mention.
 */
export function mentionQueryAt(
  value: string,
  caretAt: { text: string; caret: number } | null,
  mentions: ComposerMention[],
): MentionQuery | null {
  if (!caretAt || caretAt.text !== value) return null;
  const found = findMentionQuery(value, caretAt.caret, locateChatMarkdownCode);
  return found && !mentions.some((m) => m.at === found.start) ? found : null;
}

function queryKey(q: MentionQuery): string {
  return `${q.start}:${q.trigger}${q.query}`;
}

export interface HubChatComposerProps extends Omit<
  TextInputProps,
  'value' | 'onChange' | 'onChangeText' | 'selection'
> {
  value: string;
  mentions: ComposerMention[];
  onChange: (value: string, mentions: ComposerMention[]) => void;
}

/**
 * A text box with `@` (people, agents) and `#` (cards, sessions, tickets, PRs)
 * autocomplete. A picked item is inserted as readable text and tracked in
 * `mentions` by position, so the caller can swap each for its token on send.
 */
export function HubChatComposer({
  value,
  mentions,
  onChange,
  ...inputProps
}: HubChatComposerProps) {
  // The caret, and the text it was measured on. The mention query is derived
  // from these and the current `value` on every render, never stored: when the
  // draft is replaced from outside (cleared after send, an edit opened or
  // cancelled), the caret no longer belongs to `value`, so there is no query,
  // no popup, and nothing a pick could insert into the wrong text.
  const [caretAt, setCaretAt] = useState<{ text: string; caret: number } | null>(null);
  const [results, setResults] = useState<{ key: string; items: HubChatRefSuggestion[] } | null>(
    null,
  );
  // A selection the composer placed itself, valid only for the text it was set on.
  const [placed, setPlaced] = useState<{ text: string; start: number; end: number } | null>(null);
  const selection =
    placed && placed.text === value ? { start: placed.start, end: placed.end } : undefined;
  const caretRef = useRef(value.length);
  // Locates each edit from the selection history (see composerEdit.ts).
  const trackerRef = useRef<EditTracker | null>(null);
  if (!trackerRef.current) trackerRef.current = createEditTracker();
  const tracker = trackerRef.current;
  useEffect(() => () => tracker.dispose(), [tracker]);
  // Latest props, for a correction that lands after this render.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const requestRef = useRef(0);

  const refreshQuery = (text: string, caret: number) => setCaretAt({ text, caret });

  const query = useMemo(() => mentionQueryAt(value, caretAt, mentions), [value, caretAt, mentions]);
  const currentKey = query ? queryKey(query) : null;
  const suggestions = results && results.key === currentKey ? results.items : [];

  useEffect(() => {
    if (!query) return undefined;
    const key = queryKey(query);
    const id = ++requestRef.current;
    const timer = setTimeout(() => {
      api.hubChat
        .searchRefs(query.trigger, query.query)
        .then((res: { suggestions?: HubChatRefSuggestion[] }) => {
          if (requestRef.current === id) setResults({ key, items: res?.suggestions ?? [] });
        })
        .catch(() => {
          if (requestRef.current === id) setResults({ key, items: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  const close = () => {
    requestRef.current += 1;
    setResults(null);
  };

  const pick = (s: HubChatRefSuggestion) => {
    // Re-derive against the text on screen now; a list for any other query
    // (or another draft) is never applied.
    const live = mentionQueryAt(latest.current.value, caretAt, mentions);
    if (!live || !results || results.key !== queryKey(live)) {
      close();
      return;
    }
    const token = formatHubChatRefToken(s.label, s.kind, s.targetId);
    if (!token) {
      close();
      return;
    }
    const display = refDisplay(s.kind, s.label);
    const end = live.start + 1 + live.query.length;
    const next = insertMentionText(latest.current.value, live.start, end, display);
    const carried = reconcileComposerMentions(
      latest.current.value,
      next.text,
      mentions,
      next.caret,
    );
    onChange(next.text, addComposerMention(carried, { display, token, at: live.start }));
    caretRef.current = next.caret;
    tracker.setCaret(next.caret, next.text);
    setPlaced({ text: next.text, start: next.caret, end: next.caret });
    setCaretAt({ text: next.text, caret: next.caret });
    close();
  };

  return (
    <View>
      {suggestions.length > 0 ? (
        <ScrollView
          testID="hub-chat-mention-popup"
          style={styles.popup}
          keyboardShouldPersistTaps="always"
        >
          {suggestions.map((s) => (
            <TouchableOpacity
              key={`${s.kind}:${s.targetId}`}
              style={styles.suggestion}
              onPress={() => pick(s)}
              accessibilityRole="button"
              accessibilityLabel={`${KIND_LABEL[s.kind]} ${s.label}`}
            >
              <Text style={styles.suggestionLabel} numberOfLines={1}>
                {s.label}
              </Text>
              {s.detail && s.detail !== s.label ? (
                <Text style={styles.suggestionDetail} numberOfLines={1}>
                  {s.detail}
                </Text>
              ) : null}
              <Text style={styles.suggestionKind}>{KIND_LABEL[s.kind]}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
      <TextInput
        {...inputProps}
        value={value}
        selection={selection}
        onChangeText={(text) => {
          const { caret, mentions: carried } = tracker.onText(value, text, mentions);
          caretRef.current = caret;
          setPlaced(null);
          onChange(text, carried);
          refreshQuery(text, caret);
        }}
        onSelectionChange={(e) => {
          const { start, end } = e.nativeEvent.selection;
          const fix = tracker.onSelection({ start, end }, latest.current.value);
          if (fix) {
            // The caret this edit produced shows another reading was right.
            caretRef.current = fix.caret;
            latest.current.onChange(latest.current.value, fix.mentions);
            refreshQuery(latest.current.value, fix.caret);
            return;
          }
          const caret = end;
          if (caret === caretRef.current) return;
          caretRef.current = caret;
          setPlaced(null);
          refreshQuery(latest.current.value, caret);
        }}
      />
    </View>
  );
}

const markdownStyles = {
  body: { color: colors.gray200, fontSize: 14 },
  paragraph: { marginTop: 0, marginBottom: 2 },
  code_inline: { backgroundColor: colors.gray800, color: colors.gray200 },
  fence: { backgroundColor: colors.gray900, color: colors.gray200, borderColor: colors.gray700 },
  link: { color: colors.blue400 },
};

const styles = StyleSheet.create({
  chip: { fontSize: 13, fontWeight: '500', borderRadius: 4 },
  chipVisible: { backgroundColor: colors.blue900_40, color: colors.blue300 },
  chipHidden: { backgroundColor: colors.gray700_40, color: colors.gray300 },
  link: { color: colors.blue400, textDecorationLine: 'underline' },
  popup: {
    maxHeight: 200,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    marginBottom: 6,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  suggestionLabel: { color: colors.gray100, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  suggestionDetail: { color: colors.gray500, fontSize: 12, flexShrink: 1 },
  suggestionKind: {
    marginLeft: 'auto',
    color: colors.gray500,
    fontSize: 10,
    textTransform: 'uppercase',
  },
});
