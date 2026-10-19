import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { AtSign, Bot, GitPullRequest, LifeBuoy, MessageSquare, SquareKanban } from 'lucide-react';
import { api } from '../utils/api';
import { isImeComposing } from '../utils/keyboard';
import { getHubChatRef, useHubChatRefs } from '../utils/hubChatRefCache';
import { locateChatMarkdownCode } from '../utils/hubChatMarkdown';
import { MarkdownContent, markdownComponentsCompact } from './MarkdownRenderer';
import {
  addComposerMention,
  reconcileComposerMentions,
  findMentionQuery,
  formatHubChatRefToken,
  hubChatRefHref,
  insertMentionText,
  refDisplay,
  hubRefIndexFromProps,
  markHubChatRefLinks,
  parseHubChatRefTokens,
  type ComposerMention,
  type HubChatRefKind,
  type MarkableNode,
  type HubChatRefSuggestion,
  type HubChatRefToken,
  type HubChatResolvedRef,
} from '@shared/utils/hubChatRefs';

const KIND_ICON: Record<HubChatRefKind, typeof AtSign> = {
  user: AtSign,
  agent: Bot,
  session: MessageSquare,
  card: SquareKanban,
  ticket: LifeBuoy,
  pr: GitPullRequest,
};

const KIND_LABEL: Record<HubChatRefKind, string> = {
  user: 'Person',
  agent: 'Agent',
  session: 'Session',
  card: 'Card',
  ticket: 'Ticket',
  pr: 'Pull request',
};

const SEARCH_DEBOUNCE_MS = 120;

type MentionQuery = NonNullable<ReturnType<typeof findMentionQuery>>;

function queryKey(q: MentionQuery): string {
  return `${q.start}:${q.trigger}${q.query}`;
}

export interface HubChatRefPickerOptions {
  value: string;
  /** Mentions currently in `value`, each tracked by its offset. */
  mentions: ComposerMention[];
  /** Every edit reports the new text and the mentions carried through it. */
  onChange: (value: string, mentions: ComposerMention[]) => void;
  textareaRef: { current: HTMLTextAreaElement | null };
  /** Triggers this picker answers. Defaults to both `@` and `#`. */
  triggers?: readonly ('@' | '#')[];
}

export interface HubChatRefPicker {
  /** Call from the textarea's onChange with the new text and caret. */
  handleChange: (text: string, caret: number | null) => void;
  /** Call from onSelect so moving the caret opens or closes the picker. */
  refresh: (text: string, caret: number | null) => void;
  /** Returns true when the key belonged to the picker (the caller must stop). */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  close: () => void;
  open: boolean;
  /** The suggestion list, positioned above the textarea's relative wrapper. */
  popup: ReactNode;
}

/**
 * `@` (people, agents) and `#` (cards, sessions, tickets, PRs) autocomplete
 * for any textarea. The picked item is inserted as readable text (`@alice`,
 * `#WEB-12`) and tracked in `mentions` by position, so the caller can swap
 * each one for its token when sending (`encodeComposerMentions`).
 */
export function useHubChatRefPicker({
  value,
  mentions,
  onChange,
  textareaRef,
  triggers,
}: HubChatRefPickerOptions): HubChatRefPicker {
  const [query, setQuery] = useState<MentionQuery | null>(null);
  // Results remember the query that produced them. They are offered only while
  // that exact query (trigger, text and position) is still the one at the
  // caret, so a stale list can never be picked into a newer query's span.
  const [results, setResults] = useState<{ key: string; items: HubChatRefSuggestion[] } | null>(
    null,
  );
  const [index, setIndex] = useState(0);
  const requestRef = useRef(0);

  const allowed = (q: MentionQuery | null) => !!q && (!triggers || triggers.includes(q.trigger));

  const refresh = (text: string, caret: number | null, tracked: ComposerMention[] = mentions) => {
    const found = caret == null ? null : findMentionQuery(text, caret, locateChatMarkdownCode);
    // Text that is already a picked mention is not a new query.
    const next = allowed(found) && !tracked.some((m) => m.at === found!.start) ? found : null;
    setQuery((cur) => (cur && next && queryKey(cur) === queryKey(next) ? cur : next));
  };

  const currentKey = query ? queryKey(query) : null;
  const suggestions = results && results.key === currentKey ? results.items : [];

  useEffect(() => {
    if (!query) return;
    const key = queryKey(query);
    const id = ++requestRef.current;
    const timer = setTimeout(() => {
      api.hubChat
        .searchRefs(query.trigger, query.query)
        .then((res: { suggestions?: HubChatRefSuggestion[] }) => {
          if (requestRef.current !== id) return;
          setResults({ key, items: res?.suggestions ?? [] });
          setIndex(0);
        })
        .catch(() => {
          if (requestRef.current === id) setResults({ key, items: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `currentKey` identifies `query`; the object itself is replaced on every match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  const close = () => {
    requestRef.current += 1;
    setQuery(null);
    setResults(null);
  };

  const pick = (s: HubChatRefSuggestion) => {
    const el = textareaRef.current;
    if (!el || !results) return;
    const caret = el.selectionStart ?? value.length;
    // Re-derive the query from the live text: the list must belong to it.
    const live = findMentionQuery(value, caret, locateChatMarkdownCode);
    if (!live || queryKey(live) !== results.key) {
      refresh(value, caret);
      return;
    }
    const token = formatHubChatRefToken(s.label, s.kind, s.targetId);
    if (!token) {
      close();
      return;
    }
    const display = refDisplay(s.kind, s.label);
    const next = insertMentionText(value, live.start, caret, display);
    const carried = reconcileComposerMentions(value, next.text, mentions, next.caret);
    onChange(next.text, addComposerMention(carried, { display, token, at: live.start }));
    close();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const open = suggestions.length > 0;
  // A query whose results have not arrived yet: Enter/Tab must neither pick an
  // old list nor send the half-typed `@al`.
  const pending = !!query && (!results || results.key !== currentKey);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // Keys that confirm or navigate an IME composition belong to the IME, not
    // the picker; the caller's own guards (isSubmitEnter) see them unchanged.
    if (isImeComposing(e)) return false;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + step + suggestions.length) % suggestions.length);
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[index] ?? suggestions[0]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return true;
      }
    }
    if (pending && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
      e.preventDefault();
      return true;
    }
    return false;
  };

  const handleChange = (text: string, caret: number | null) => {
    const carried = reconcileComposerMentions(value, text, mentions, caret);
    onChange(text, carried);
    refresh(text, caret, carried);
  };

  const popup = open ? (
    <ul
      role="listbox"
      aria-label="Mention suggestions"
      data-testid="hub-chat-mention-popup"
      className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-full min-w-[16rem] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl"
    >
      {suggestions.map((s, i) => {
        const Icon = KIND_ICON[s.kind];
        return (
          <li
            key={`${s.kind}:${s.targetId}`}
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(s);
            }}
            onMouseEnter={() => setIndex(i)}
            className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
              i === index ? 'bg-blue-600/30 text-white' : 'text-gray-200'
            }`}
          >
            <Icon size={14} className="shrink-0 text-gray-400" aria-hidden />
            <span className="truncate font-medium">{s.label}</span>
            {s.detail && s.detail !== s.label && (
              <span className="truncate text-xs text-gray-500">{s.detail}</span>
            )}
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-gray-500">
              {KIND_LABEL[s.kind]}
            </span>
          </li>
        );
      })}
    </ul>
  ) : null;

  return { handleChange, refresh, handleKeyDown, close, open, popup };
}

export interface HubChatMentionInputProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> {
  value: string;
  /** Mentions currently in `value`, each tracked by its offset. */
  mentions: ComposerMention[];
  /** Every edit reports the new text and the mentions carried through it. */
  onChange: (value: string, mentions: ComposerMention[]) => void;
  wrapperClassName?: string;
}

/** A textarea with `@` / `#` autocomplete (see `useHubChatRefPicker`). */
export function HubChatMentionInput({
  value,
  mentions,
  onChange,
  onKeyDown,
  wrapperClassName,
  ...textareaProps
}: HubChatMentionInputProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const picker = useHubChatRefPicker({ value, mentions, onChange, textareaRef: ref });

  return (
    <div className={`relative ${wrapperClassName ?? ''}`}>
      {picker.popup}
      <textarea
        {...textareaProps}
        ref={ref}
        value={value}
        onChange={(e) => picker.handleChange(e.target.value, e.target.selectionStart)}
        onSelect={(e) => picker.refresh(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={(e) => {
          textareaProps.onBlur?.(e);
          picker.close();
        }}
        onKeyDown={(e) => {
          if (picker.handleKeyDown(e)) return;
          onKeyDown?.(e);
        }}
        aria-autocomplete="list"
        aria-expanded={picker.open}
      />
    </div>
  );
}

function statusTone(kind: HubChatRefKind, status: string | null): string {
  const s = (status ?? '').toLowerCase();
  if (kind === 'pr') {
    if (s === 'merged') return 'text-violet-300';
    if (s === 'closed') return 'text-red-300';
    return 'text-emerald-300';
  }
  if (s === 'done' || s === 'closed' || s === 'converted' || s === 'completed') {
    return 'text-gray-400';
  }
  return 'text-cyan-300';
}

/** Where a clicked chip should take the user. */
export type HubChatRefOpenHandler = (ref: HubChatResolvedRef) => void;

/** Opens chips rendered without an explicit `onOpen` (e.g. in a session transcript). */
export const HubChatRefOpenContext = createContext<HubChatRefOpenHandler | undefined>(undefined);

export function HubChatRefChip({
  token,
  resolved,
  onOpen,
}: {
  token: HubChatRefToken;
  resolved: HubChatResolvedRef | null;
  onOpen?: HubChatRefOpenHandler;
}) {
  const contextOpen = useContext(HubChatRefOpenContext);
  const open = onOpen ?? contextOpen;
  const Icon = KIND_ICON[token.kind];
  const visible = !!resolved?.visible;
  const label = refDisplay(token.kind, visible && resolved?.label ? resolved.label : token.label);
  const href = resolved ? hubChatRefHref(resolved) : null;
  const status = visible ? resolved?.status : null;
  const tooltip = visible
    ? [KIND_LABEL[token.kind], resolved?.title, status].filter(Boolean).join(' · ')
    : undefined;
  const base =
    'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-px align-baseline text-[0.85em] font-medium no-underline';

  if (!visible) {
    // Unknown or not visible to this viewer: label only, no link or status.
    return (
      <span
        data-testid="hub-chat-ref"
        data-visible="false"
        className={`${base} bg-gray-700/50 text-gray-300`}
      >
        {label}
      </span>
    );
  }

  const content = (
    <>
      <Icon size={12} className="shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
      {status && token.kind !== 'user' && token.kind !== 'agent' && (
        <span className={`shrink-0 text-[0.8em] font-normal ${statusTone(token.kind, status)}`}>
          {status}
        </span>
      )}
    </>
  );

  if (!href) {
    return (
      <span
        data-testid="hub-chat-ref"
        data-visible="true"
        title={tooltip}
        className={`${base} bg-blue-500/20 text-blue-200`}
      >
        {content}
      </span>
    );
  }

  return (
    <a
      href={href}
      data-testid="hub-chat-ref"
      data-visible="true"
      title={tooltip}
      className={`${base} bg-blue-500/20 text-blue-200 hover:bg-blue-500/30`}
      onClick={(e) => {
        if (!open || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(resolved as HubChatResolvedRef);
      }}
    >
      {content}
    </a>
  );
}

/**
 * A message body with live ref tokens rendered as chips. The original body is
 * rendered as written; `markHubChatRefLinks` tags each live token's link node
 * in that same parse, so what becomes a chip is exactly what the server
 * stored, and nothing around a token can change what it renders as.
 */
export function HubChatMessageBody({
  body,
  onOpenRef,
  baseComponents = markdownComponentsCompact,
  rehypePlugins = [],
}: {
  body: string;
  onOpenRef?: HubChatRefOpenHandler;
  /** Markdown components for everything that is not a chip. */
  baseComponents?: typeof markdownComponentsCompact;
  rehypePlugins?: unknown[];
}) {
  const tokens = useMemo(() => parseHubChatRefTokens(body, locateChatMarkdownCode), [body]);
  const remarkPlugins = useMemo(
    () => [() => (tree: MarkableNode) => markHubChatRefLinks(tree, tokens)],
    [tokens],
  );
  const version = useHubChatRefs(tokens);
  const components = useMemo(
    () => ({
      ...baseComponents,
      a(props: Record<string, unknown>) {
        const i = hubRefIndexFromProps(props);
        const token = i == null ? undefined : tokens[i];
        if (token) {
          return (
            <HubChatRefChip
              token={token}
              resolved={getHubChatRef(token.kind, token.targetId)}
              onOpen={onOpenRef}
            />
          );
        }
        return baseComponents.a(props);
      },
    }),
    // `version` re-renders chips when resolved detail lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens, onOpenRef, version, baseComponents],
  );
  return (
    <MarkdownContent
      content={body}
      components={components}
      rehypePlugins={rehypePlugins}
      remarkPlugins={remarkPlugins}
    />
  );
}

/** True when `text` holds at least one ref token outside code. */
export function hasHubChatRefTokens(text: string): boolean {
  return text.includes('@[') && parseHubChatRefTokens(text, locateChatMarkdownCode).length > 0;
}

/**
 * Plain text (no Markdown) with live ref tokens shown as chips, for bubbles
 * that render the user's text verbatim. Line breaks are kept by the caller's
 * `whitespace-pre-wrap`.
 */
export function HubChatPlainTextWithRefs({ text }: { text: string }) {
  const tokens = useMemo(() => parseHubChatRefTokens(text, locateChatMarkdownCode), [text]);
  // Re-renders the chips when resolved detail lands.
  useHubChatRefs(tokens);
  if (tokens.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  tokens.forEach((t, i) => {
    if (t.index > cursor) parts.push(text.slice(cursor, t.index));
    parts.push(
      <HubChatRefChip key={`ref-${i}`} token={t} resolved={getHubChatRef(t.kind, t.targetId)} />,
    );
    cursor = t.index + t.raw.length;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
